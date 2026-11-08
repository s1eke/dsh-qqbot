import { describe, expect, it, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { ApprovalChannel, type ApprovalChannelContext, type ApprovalRequest, type ApprovalOutcome } from './approval-channel.ts';
import { buildApprovalKeyboard, buildApprovalText } from './approval-renderer.ts';

function setup(group = false) {
  const scope = group ? 'group' as const : 'c2c' as const;
  const peer = group ? 'group1' : 'user1';
  const record = { sessionKey: 'key', senderId: 'user1', scope, generation: 1,
    replyTarget: { scope, targetId: peer, msgId: 'm1' }, agent: { id: 'root' } };
  const manager = { findBySessionId: (id: string) => id === 'root' ? record : undefined,
    getSessionRecord: (s: string, p: string) => s === scope && p === peer ? record : undefined,
    holdActivity: vi.fn(() => vi.fn()), taskRegistry: undefined as unknown };
  const sender = { sendMarkdown: vi.fn(async (..._args: unknown[]) => undefined) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = { access: { c2cMode: 'open' as 'open' | 'disabled' | 'allowlist', c2cAllow: [] as string[] },
    conversation: { taskAdmins: ['admin'] } };
  const channel = new ApprovalChannel(manager as never, sender, config, logger);
  let handler: (...args: unknown[]) => unknown = () => {};
  const dispose = vi.fn(() => true);
  const ctx: ApprovalChannelContext = { on: vi.fn((_event, callback) => { handler = callback; return dispose; }) };
  channel.install(ctx);
  const request = (overrides: Partial<ApprovalRequest> = {}) => handler({ agent: record.agent, toolName: 'bash',
    callId: 'call', ...overrides }, vi.fn(async () => 'unavailable')) as Promise<ApprovalOutcome>;
  const data = (index = sender.sendMarkdown.mock.calls.length - 1, allow = true) => {
    const opts = sender.sendMarkdown.mock.calls[index]![2] as { keyboard: ReturnType<typeof buildApprovalKeyboard> };
    return opts.keyboard.content.rows[0]!.buttons[allow ? 0 : 1]!.action.data;
  };
  const event = (button: string, actor = 'user1') => ({ ...(group ? { group_openid: peer, group_member_openid: actor } : { user_openid: actor }),
    data: { resolved: { button_data: button } } }) as InteractionEvent;
  return { channel, manager, record, sender, ctx, dispose, request, data, event, config };
}

describe('approval cards', () => {
  it('renders gated command and reason, and restricts button decisions', () => {
    expect(buildApprovalText({ agent: { id: 'a' }, toolName: 'bash', reason: '需要读取文件' }, 'cat a')).toContain('cat a');
    expect(JSON.parse(buildApprovalKeyboard('n').content.rows[0]!.buttons[0]!.action.data)).toEqual({ t: 'approval', d: 'allow', n: 'n' });
  });
  it('handles concurrent approvals independently without losing either waiter', async () => {
    const s = setup();
    const one = s.request({ callId: 'one' });
    const old = s.data();
    const two = s.request({ callId: 'two' });
    expect(s.channel.handleInteraction(s.event(old, 'other'))).toBe(false);
    expect(s.channel.handleInteraction(s.event(old))).toBe(true);
    expect(await one).toBe('allowed-once');
    expect(s.channel.handleInteraction(s.event(old))).toBe(false);
    expect(s.channel.handleInteraction(s.event(s.data(undefined, false)))).toBe(true);
    expect(await two).toBe('rejected');
  });
  it('pins group requester and generation and allows only configured task administrators', async () => {
    const s = setup(true);
    const one = s.request();
    s.record.senderId = 'other';
    expect(s.channel.handleInteraction(s.event(s.data(), 'other'))).toBe(false);
    expect(s.channel.handleInteraction(s.event(s.data(), 'admin'))).toBe(true);
    expect(await one).toBe('allowed-once');
    const two = s.request();
    s.record.generation++;
    expect(s.channel.handleInteraction(s.event(s.data(), 'admin'))).toBe(false);
    s.channel.cancelPending('key');
    expect(await two).toBe('cancelled');
  });
  it('cancels while a send is in flight and unload releases every pending approval', async () => {
    const s = setup();
    s.sender.sendMarkdown.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const one = s.request({ signal: controller.signal });
    const two = s.request();
    controller.abort();
    expect(await one).toBe('cancelled');
    s.channel.uninstall();
    expect(await two).toBe('cancelled');
    expect(s.dispose).toHaveBeenCalledOnce();
  });
  it('fails closed on delivery error and delegates unowned requests', async () => {
    const s = setup();
    s.sender.sendMarkdown.mockRejectedValue(new Error('offline'));
    expect(await s.request()).toBe('unavailable');
    expect(await s.request({ agent: { id: 'web' } })).toBe('unavailable');
    expect(s.sender.sendMarkdown).toHaveBeenCalledOnce();
  });
  it('routes a local child through verified task ownership and rechecks the activation on click', async () => {
    const s = setup(true);
    const task = { taskId: 'task1', runId: 'run1' };
    const route = { record: s.record, task, ownerId: 'worker-owner' };
    const registry = { resolveAgent: vi.fn((id: string) => id === 'child' ? route : undefined),
      canOperate: vi.fn((_task, actor) => actor === 'worker-owner') };
    s.manager.taskRegistry = registry;
    const one = s.request({ agent: { id: 'child' } });
    expect(s.sender.sendMarkdown.mock.calls[0]![1]).toContain('task1');
    expect(s.channel.listPending('group', 'group1', 'worker-owner')).toContain('任务 task1：bash');
    expect(s.channel.listPending('group', 'group1', 'user1')).toBe('');
    expect(s.channel.handleInteraction(s.event(s.data(), 'user1'))).toBe(false);
    s.record.generation++; // Stopping the foreground leaves the child approval active.
    expect(s.channel.handleInteraction(s.event(s.data(), 'worker-owner'))).toBe(true);
    expect(await one).toBe('allowed-once');
    const two = s.request({ agent: { id: 'child' } });
    route.task = { taskId: 'task1', runId: 'run2' };
    expect(s.channel.handleInteraction(s.event(s.data(), 'worker-owner'))).toBe(false);
    s.channel.cancelPending('key');
    expect(await two).toBe('cancelled');
  });
  it('applies private-channel access policy to child approvals as well as root approvals', async () => {
    const s = setup();
    s.manager.taskRegistry = { resolveAgent: () => ({ record: s.record, task: { taskId: 'task', runId: 'run' }, ownerId: 'user1' }),
      canOperate: () => true };
    const pending = s.request({ agent: { id: 'child' } });
    s.config.access.c2cMode = 'allowlist';
    expect(s.channel.handleInteraction(s.event(s.data()))).toBe(false);
    s.config.access.c2cAllow.push('user1');
    expect(s.channel.handleInteraction(s.event(s.data()))).toBe(true);
    expect(await pending).toBe('allowed-once');
  });
});
