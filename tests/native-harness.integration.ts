/** Real local Harness loop, native subagents, persistence, and QQ task projection. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SubagentRuntime from '@deepseek-ai/dsh-subagent';
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import * as Control from '@deepseek-ai/dsh-tool-subagent-control';
import * as Present from '@deepseek-ai/dsh-tool-present';
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MockAdapter, textResponse, toolCallResponse } from '@native-test/packages/core/agent-loop/tests/mock-adapter.ts';
import { TestSessionQuery } from '@native-test/packages/subagent/subagent/tests/test-session-query.ts';
import { TaskRegistry } from '../src/features/task-registry.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class WorkerAdapter extends MockAdapter {
  readonly entered = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  private calls = 0;
  constructor() { super([]); }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    this.calls++;
    if (this.calls === 2) this.entered.resolve();
    await new Promise<void>((resolve, reject) => {
      const abort = () => { reject(options.signal?.reason ?? new Error('aborted')); };
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener('abort', abort, { once: true });
      this.release.promise.then(() => { options.signal?.removeEventListener('abort', abort); resolve(); });
    });
    for (const chunk of textResponse('worker result')) yield chunk;
  }
}

async function fixture(rootScript: ConstructorParameters<typeof MockAdapter>[0], suppliedAdapter?: MockAdapter) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-native-tasks-'));
  const ctx = new Context();
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  await ctx.plugin(JsonlSessionPersistence, { root: directory });
  await ctx.plugin(AgentLoop, { agents: [] });
  // Production point reads and catalog traversal; full-text search is unused.
  await ctx.plugin(TestSessionQuery);
  await ctx.plugin(SubagentRuntime);
  await ctx.plugin(Spawn, { providerName: 'spawn' });
  await ctx.plugin(Control);
  const adapter = suppliedAdapter ?? new MockAdapter(rootScript);
  const workers = new WorkerAdapter();
  ctx.llm.registerAdapter(['mock'], adapter);
  ctx.llm.registerAdapter(['worker'], workers);
  const handle = await ctx.agents.create({ sessionId: SessionId('qq-root'), meta: { cwd: directory },
    agentOptions: { provider: 'mock', model: 'mock' } });
  const record = { sessionKey: 'qqbot:app:group:peer', sessionId: handle.agent.id, agent: handle.agent,
    handle, scope: 'group' as const, peerId: 'peer', senderId: 'network-arrival', generation: 0,
    replyTarget: { scope: 'group' as const, targetId: 'peer', msgId: 'qq-message' }, lastActivity: Date.now() };
  const registry = new TaskRegistry({ appId: 'app', storagePath: false, timeoutMs: 60000, conversationMode: 'interactive',
    manager: { findBySessionId: id => id === record.agent.id ? record : undefined,
      getSessionRecord: (scope, peer) => scope === 'group' && peer === 'peer' ? record : undefined },
    getService: name => ctx.get(name), taskAdmins: ['admin'],
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  registry.install(ctx);
  cleanups.push(async () => { registry.dispose(); });
  const input = (sender: string, text: string) => {
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
    registry.noteInput(message.id, sender, { rootSessionId: record.agent.id, generation: record.generation });
    record.agent.steer(message);
    return message;
  };
  const start = (name: string) => ctx.subagents.startActivation({ parent: record.agent, provider: 'spawn', name, label: `task ${name}`,
    prompt: [{ type: 'text', text: `work ${name}` }], agentOptions: { provider: 'worker', model: 'mock' },
    signal: new AbortController().signal, delivery: 'parent' });
  return { ctx, directory, handle, record, registry, adapter, workers, input, start };
}

describe('native Harness task composition', () => {
  it('uses a verified open-answer result to forward only to its task while denying interruption from a mixed-author step', async () => {
    const controls = [
      toolCallResponse('not-authorized-stop', 'interrupt_agent', { agent: 'worker-one' }),
      toolCallResponse('authorized-answer', 'send_message', { agent: 'worker-one', message: '来自任务作者的答案' }),
    ].flatMap((chunks, index) => chunks.filter(chunk => chunk.type !== 'finish' && chunk.type !== 'usage')
      .map(chunk => 'index' in chunk ? { ...chunk, index } : chunk));
    controls.push({ type: 'finish', reason: { kind: 'tool-calls' } });
    const f = await fixture([textResponse('ready'), toolCallResponse('answered-call', 'verified_answer', {}), controls, textResponse('转述完成')]);
    f.input('alice', '创建任务');
    await f.record.agent.whenIdle();
    const activation = await f.start('worker-one');
    const task = f.registry.get(activation.childId, 'group', 'peer')!;
    f.ctx.tools.register(defineTool({ name: 'verified_answer', description: 'verified QQ question completion', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'answered' }] },
      async execute(_args, exec) {
        f.registry.noteQuestionOpenAnswer(f.record.agent.id, exec.callId, 'alice', [task.taskId]);
        f.input('charlie', '同时到达的另一位群成员消息');
        return {};
      } }));
    f.input('bob', '收到后台问题');
    await f.record.agent.whenIdle();
    expect(f.registry.currentActor(f.record.agent.id)).toBeUndefined();
    const results = f.record.agent.session.snapshotEvents().filter(event => event.type === 'tool/result');
    expect(JSON.stringify(results.find(event => event.data.message.toolCallId === 'not-authorized-stop'))).toContain('无权');
    expect(JSON.stringify(results.find(event => event.data.message.toolCallId === 'authorized-answer'))).toContain('message delivered');
    expect(JSON.stringify(f.ctx.agents.get(activation.childId)?.inbox.nextStep)).toContain('来自任务作者的答案');
    expect(f.registry.hasActive(f.record.sessionId)).toBe(true);
  });

  it('wakes native wait_agent on steer and applies model selection only to the next model request while a worker stays active', async () => {
    const entered = Promise.withResolvers<GenerateOptions>();
    const release = Promise.withResolvers<void>();
    class HeldAdapter extends MockAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        entered.resolve(options);
        await Promise.race([release.promise, new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
        })]);
        yield* super.stream(options);
      }
    }
    const original = new HeldAdapter([toolCallResponse('wait-call', 'wait_agent', { timeout_ms: 10000 })]);
    const f = await fixture([], original);
    const replacement = new MockAdapter([textResponse('新模型处理追加要求')]);
    f.ctx.llm.registerAdapter(['replacement'], replacement);
    const waiting = Promise.withResolvers<void>();
    f.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'wait_agent') waiting.resolve();
      return next();
    });
    f.input('alice', '开始等待');
    const inFlight = await entered.promise;
    await f.start('worker-one');
    f.record.agent.model.select({ provider: 'replacement', model: 'new-model' });
    expect(inFlight.provider).toBe('mock');
    expect(inFlight.model).toBe('mock');
    release.resolve();
    await waiting.promise;
    f.input('alice', '不要等后台，先回答新问题');
    await f.record.agent.whenIdle();
    expect(f.registry.hasActive(f.record.sessionId)).toBe(true);
    expect(original.requests).toHaveLength(1);
    expect(replacement.requests).toHaveLength(1);
    expect(replacement.requests[0]).toMatchObject({ provider: 'replacement', model: 'new-model' });
    expect(JSON.stringify(replacement.requests[0])).toContain('不要等后台');
    const result = f.record.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'wait-call');
    expect(JSON.stringify(result)).toContain('timedOut\\\":false');
  });

  it('collects native presented files after the child has left the live registry', async () => {
    const f = await fixture([textResponse('ready'), textResponse('文件结果收到')]);
    await f.ctx.plugin(Present, { maxFiles: 8 });
    const file = join(f.directory, 'result.txt');
    await writeFile(file, 'native artifact');
    f.ctx.llm.registerAdapter(['present-worker'], new MockAdapter([
      toolCallResponse('present-call', 'present', { files: [{ path: file, description: 'native artifact' }] }),
      textResponse('已生成文件'),
    ]));
    f.input('alice', '产出文件');
    await f.record.agent.whenIdle();
    const activation = await f.ctx.subagents.startActivation({ parent: f.record.agent, provider: 'spawn', name: 'file-worker', label: '文件任务',
      prompt: [{ type: 'text', text: 'present artifact' }], agentOptions: { provider: 'present-worker', model: 'mock' },
      signal: new AbortController().signal, delivery: 'parent' });
    await activation.result;
    await f.record.agent.whenIdle();
    expect(f.ctx.agents.get(activation.childId)).toBeUndefined();
    expect(f.registry.get(activation.childId, 'group', 'peer')).toMatchObject({ state: 'completed', output: '已生成文件', files: [{ path: file, description: 'native artifact' }] });
  });

  it('keeps two workers running while the parent consumes steer and rejects another group author at the native tool gate', async () => {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await fixture([
      toolCallResponse('hold', 'hold_parent', {}),
      toolCallResponse('unauthorized-control', 'send_message', { agent: 'worker-one', message: 'unauthorized edit' }),
      textResponse('已收到第二位群用户的消息'), textResponse('收到后台结果'), textResponse('收到另一结果'),
    ]);
    f.ctx.tools.register(defineTool({ name: 'hold_parent', description: 'test step barrier', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'released' }] },
      async execute(_args, exec) {
        held.resolve();
        await Promise.race([release.promise, new Promise((_resolve, reject) => {
          exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true });
        })]);
        return {};
      } }));
    f.input('alice', '请并行执行两个任务');
    await held.promise;
    const one = await f.start('worker-one');
    const two = await f.start('worker-two');
    await f.workers.entered.promise;
    expect(f.registry.list('group', 'peer')).toHaveLength(2);
    expect(f.registry.list('group', 'peer').every(task => task.ownerId === 'alice' && !task.settled)).toBe(true);
    f.input('bob', '先聊另一件事，同时尝试改 alice 的任务');
    release.resolve();
    await f.record.agent.whenIdle();
    expect(f.registry.hasActive(f.record.sessionId)).toBe(true);
    expect(JSON.stringify(f.adapter.requests[1])).toContain('先聊另一件事');
    const rejected = f.record.agent.session.snapshotEvents().find(event => event.type === 'tool/result'
      && event.data.message.toolCallId === 'unauthorized-control');
    expect(JSON.stringify(rejected)).toContain('无权');
    expect(f.ctx.agents.get(one.childId)?.inbox.nextStep).toHaveLength(0);
    expect(f.ctx.agents.get(two.childId)?.status).toBe('running');
    f.workers.release.resolve();
    await Promise.all([one.result, two.result]);
    await vi.waitFor(() => expect(f.registry.hasActive(f.record.sessionId)).toBe(false));
    await f.record.agent.whenIdle();
    expect(f.registry.list('group', 'peer').every(task => task.state === 'completed' && task.output === 'worker result')).toBe(true);
    expect(f.registry.list('group', 'peer').every(task => task.delivery === 'unconfirmed')).toBe(true);
  });

  it('drains the exact root permanently then resumes history under a new root instance that can start tasks', async () => {
    const f = await fixture([textResponse('ready'), textResponse('settlement'), textResponse('restored settlement')]);
    f.input('alice', '建立会话历史');
    await f.record.agent.whenIdle();
    const child = await f.start('worker-one');
    const originalRoot = f.record.agent;
    await f.ctx.subagents.drainDescendants([originalRoot]);
    f.registry.closeRoot(originalRoot.id);
    await expect(f.start('closed-root-worker')).rejects.toThrow();
    await f.handle.dispose();
    const resumed = await f.ctx.agents.resume({ resumeSessionId: originalRoot.id, agentOptions: { provider: 'mock', model: 'mock' } });
    f.record.agent = resumed.agent;
    f.record.handle = resumed;
    expect(resumed.agent).not.toBe(originalRoot);
    expect(JSON.stringify(resumed.agent.session.snapshotEvents())).toContain('建立会话历史');
    f.input('alice', '新任务');
    await resumed.agent.whenIdle();
    const fresh = await f.start('worker-after-resume');
    expect(fresh.childId).not.toBe(child.childId);
    expect(f.registry.resolveAgent(fresh.childId)?.record.agent).toBe(resumed.agent);
    await f.ctx.subagents.drainDescendants([resumed.agent]);
    f.registry.closeRoot(resumed.agent.id);
    await resumed.dispose();
    expect(f.registry.hasActive(resumed.agent.id)).toBe(false);
  });
});
