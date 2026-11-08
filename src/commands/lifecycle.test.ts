import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { slashCommand, type MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema } from '../config.ts';
import type { DshAgent, DshAgentRegistry } from '../session/types.ts';
import { legacyDerivedSessionId } from '../session/session-id.ts';

const env = vi.hoisted(() => ({ home: '' }));
vi.mock('../shared/dirs.ts', () => ({
  get PLUGIN_HOME() { return env.home; },
  resolveAgentCwd: (cwd: string | undefined) => cwd ?? `${env.home}/workspace`,
}));

const { SessionManager } = await import('../session/session-manager.ts');
const { stopCommand } = await import('./misc.ts');
const { newCommand } = await import('./session.ts');
const { modelCommand } = await import('./model.ts');
const managers: InstanceType<typeof SessionManager>[] = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(group = false, borrowed = false) {
  const drain = vi.fn(async (_roots: readonly DshAgent[]) => {});
  const selection = vi.fn();
  const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text'] }));
  const handles: Array<{ agent: DshAgent; dispose: ReturnType<typeof vi.fn> }> = [];
  const makeHandle = (sessionId: string) => {
    const agent = {
      id: sessionId, ctx: { get: () => undefined }, status: 'running',
      session: { id: sessionId, snapshotEvents: () => [] },
      cancel: vi.fn(), followup: vi.fn(), steer: vi.fn(), whenIdle: async () => {},
      model: { current: () => undefined, select: selection },
    } as unknown as DshAgent;
    const handle = { agent, dispose: vi.fn(async () => {}) };
    handles.push(handle);
    return handle;
  };
  const hostHandle = borrowed ? makeHandle(legacyDerivedSessionId(`qqbot:app:${group ? 'group:group' : 'c2c:user'}`)) : undefined;
  const registry = {
    get: vi.fn((sessionId: string) => hostHandle?.agent.id === sessionId ? hostHandle.agent : undefined),
    resume: vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => makeHandle(resumeSessionId)),
    create: vi.fn(),
  };
  const services: Record<string, unknown> = {
    subagents: { drainDescendants: drain },
    sessionPersistence: { stat: async () => ({ header: {} }) },
    llm: { resolveModelInfo },
  };
  const config = ConfigSchema({ appId: 'app', appSecret: 'secret', sessionIdleTimeout: 0,
    conversation: { mode: 'interactive', taskAdmins: ['admin'] } });
  const manager = new SessionManager({ get: (name: string) => services[name], on: vi.fn() } as unknown as Context,
    registry as unknown as DshAgentRegistry, config, { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() });
  managers.push(manager);
  const tasks = {
    currentActor: () => 'owner', list: () => [], hasActive: vi.fn(() => true),
    closeRoot: vi.fn(() => { tasks.hasActive.mockReturnValue(false); }),
    forgetRoot: vi.fn(() => { tasks.hasActive.mockReturnValue(false); }),
    interrupt: vi.fn(async () => ({ ok: true, message: '指定任务停止中' })),
    capabilityText: () => '',
  };
  manager.taskRegistry = tasks as unknown as NonNullable<typeof manager.taskRegistry>;
  const commands = slashCommand({ autoHelp: false,
    commands: [stopCommand({ manager, config }), newCommand({ manager, config }), modelCommand({ manager, config })],
  });
  const replies: string[] = [];
  const next = vi.fn(async () => {});
  const dispatch = (text: string, senderId = group ? 'owner' : 'user') => {
    const context = {
      message: { kind: group ? 'group' : 'c2c', groupOpenid: group ? 'group' : undefined,
        senderId, content: text, rawEventType: group ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE' },
      state: {}, replyTarget: { scope: group ? 'group' : 'c2c', targetId: group ? 'group' : 'user' },
      bot: { sendText: async (_target: unknown, value: string) => { replies.push(value); }, sendMarkdown: async () => {} },
      stop: vi.fn(), log: { error: vi.fn() },
    } as unknown as MiddlewareContext;
    return commands.middleware(context, next);
  };
  const open = () => manager.getOrCreate(group ? 'group' : 'c2c', group ? 'group' : 'user', group ? 'owner' : 'user',
    { scope: group ? 'group' : 'c2c', targetId: group ? 'group' : 'user', msgId: 'first' });
  return { manager, drain, handles, hostHandle, replies, next, dispatch, open, tasks, selection, resolveModelInfo };
}

beforeEach(() => { env.home = mkdtempSync(join(tmpdir(), 'qq-commands-')); });
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.disposeAll()));
  rmSync(env.home, { recursive: true, force: true });
});

describe('真实斜杠命令控制流程', () => {
  it('/stop 主回复立即响应，明确后台仍在运行，命令不进入普通消息链', async () => {
    const h = fixture();
    const record = await h.open();
    await h.dispatch('/stop');
    expect(record.agent.cancel).toHaveBeenCalledOnce();
    expect(h.drain).not.toHaveBeenCalled();
    expect(h.replies.join()).toContain('后台任务仍在运行');
    expect(h.next).not.toHaveBeenCalled();
  });

  it('/stop all 只在真实关闭后报告成功，下一输入保留历史并恢复新根', async () => {
    const h = fixture();
    const record = await h.open();
    const blocked = deferred();
    h.drain.mockImplementationOnce(() => blocked.promise);
    const stopping = h.dispatch('/stop all');
    await vi.waitFor(() => expect(h.drain).toHaveBeenCalled());
    expect(h.replies).toEqual([]);
    expect(record.handle.dispose).not.toHaveBeenCalled();
    blocked.resolve();
    await stopping;
    expect(h.replies.join()).toContain('已停止全部任务');
    const restored = await h.open();
    expect(restored.sessionId).toBe(record.sessionId);
    expect(restored.agent).not.toBe(record.agent);
    expect(h.next).not.toHaveBeenCalled();
  });

  it.each(['/new', '/reset', '/clear'])('宿主借用会话可先 /stop 再 %s 切换，后台任务不伪报结束', async (command) => {
    const h = fixture(false, true);
    const record = await h.open();
    expect(record.ownsAgent).toBe(false);
    await h.dispatch('/stop');
    expect(record.agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(h.manager.getSessionRecord('c2c', 'user')).toBe(record);
    expect(h.replies.at(-1)).toContain('已请求停止主回复');

    await h.dispatch(command);
    expect(h.replies.at(-1)).toContain('已开启新会话');
    expect(h.replies.at(-1)).toContain('宿主');
    expect(h.replies.at(-1)).toContain('保留');
    expect(h.replies.at(-1)).toContain('后台');
    expect(h.replies.at(-1)).not.toContain('已停止全部');
    expect(h.drain).not.toHaveBeenCalled();
    expect(h.hostHandle!.dispose).not.toHaveBeenCalled();
    expect(h.tasks.forgetRoot).toHaveBeenCalledWith(record.agent);
    expect(h.tasks.closeRoot).not.toHaveBeenCalled();
    const fresh = await h.open();
    expect(fresh.sessionId).not.toBe(record.sessionId);
    expect(fresh.agent).not.toBe(record.agent);
    expect(fresh.ownsAgent).toBe(true);
    expect(h.next).not.toHaveBeenCalled();
  });

  it('宿主借用会话 /stop all 拒绝释放后仍可按提示 /new 切换', async () => {
    const h = fixture(false, true);
    h.tasks.hasActive.mockReturnValue(false);
    const record = await h.open();
    await h.dispatch('/stop all');
    expect(h.replies.at(-1)).toContain('停止未完成');
    expect(h.replies.at(-1)).toContain('/new');
    expect(h.manager.getSessionRecord('c2c', 'user')).toBe(record);
    expect(h.drain).not.toHaveBeenCalled();
    await h.dispatch('/new');
    expect(h.replies.at(-1)).toContain('已开启新会话');
    expect(h.replies.at(-1)).toContain('宿主');
    expect(h.replies.at(-1)).toContain('保留');
    expect(h.hostHandle!.dispose).not.toHaveBeenCalled();
    expect(h.tasks.closeRoot).not.toHaveBeenCalled();
    expect((await h.open()).sessionId).not.toBe(record.sessionId);
  });

  it('/new 关闭失败只报告失败，不把历史切换成一个假新会话', async () => {
    const h = fixture();
    const record = await h.open();
    h.drain.mockRejectedValueOnce(new Error('drain unavailable'));
    await h.dispatch('/new');
    expect(h.replies.join()).toContain('新会话未开启');
    expect(h.replies.join()).not.toContain('已开启新会话');
    expect(h.manager.getSessionRecord('c2c', 'user')).toBe(record);
    expect(record.handle.dispose).not.toHaveBeenCalled();
  });

  it('群内其他成员不能停止或重置正在执行的主会话，管理员可以', async () => {
    const h = fixture(true);
    const record = await h.open();
    await h.dispatch('/stop', 'stranger');
    await h.dispatch('/new', 'stranger');
    expect(record.agent.cancel).not.toHaveBeenCalled();
    expect(h.drain).not.toHaveBeenCalled();
    expect(h.replies.join()).toContain('任务发起');
    await h.dispatch('/stop', 'admin');
    expect(record.agent.cancel).toHaveBeenCalledOnce();
  });

  it('/stop task-id 交给带发送者身份的定向控制，不取消主会话', async () => {
    const h = fixture(true);
    const record = await h.open();
    await h.dispatch('/stop task-123', 'owner');
    expect(h.tasks.interrupt).toHaveBeenCalledWith('task-123', { scope: 'group', peerId: 'group', senderId: 'owner' });
    expect(record.agent.cancel).not.toHaveBeenCalled();
    expect(h.replies).toEqual(['指定任务停止中']);
  });

  it('/model 明确下一步骤生效，失败不声称已切换', async () => {
    const h = fixture();
    const record = await h.open();
    await h.dispatch('/model p/next');
    expect(h.selection).toHaveBeenCalledWith({ provider: 'p', model: 'next' });
    expect(h.replies.join()).toContain('下一步骤');
    expect(record.handle.dispose).not.toHaveBeenCalled();
    h.resolveModelInfo.mockRejectedValueOnce(new Error('not available'));
    await h.dispatch('/model p/unknown');
    expect(h.replies.at(-1)).toContain('模型未切换');
    expect(h.selection).toHaveBeenCalledOnce();
  });
});
