import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskRegistry } from './task-registry.ts';
import type { DshAgent, SessionRecord, SessionEventLike } from '../session/types.ts';
import type { ChatScope } from '../types.ts';

const registries: TaskRegistry[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

function agent(id: string): DshAgent {
  return {
    id, status: 'running', ctx: {} as DshAgent['ctx'],
    session: { id, snapshotEvents: () => [] }, cancel: vi.fn(), followup: vi.fn(), steer: vi.fn(),
    whenIdle: vi.fn(async () => {}), runMaintenance: async fn => fn(new AbortController().signal),
  };
}

function setup(options: { scope?: ChatScope; storagePath?: string; timeoutMs?: number } = {}) {
  let root = agent('root');
  const scope = options.scope ?? 'group';
  const record: SessionRecord = {
    sessionKey: `qqbot:app:${scope}:peer`, sessionId: root.id, agent: root,
    handle: { agent: root, dispose: async () => {} }, scope, peerId: 'peer', senderId: 'latest-arrival',
    replyTarget: { scope, targetId: 'peer', msgId: 'qq-1' }, lastActivity: Date.now(),
  };
  const agents = new Map<string, DshAgent>([[root.id, root]]);
  const runtime = {
    rootOf: vi.fn((_child: DshAgent) => root),
    namesOf: (child: DshAgent) => ({ self: `worker-${child.id}` }),
    resolveName: vi.fn(async (_sender: DshAgent, name: string) => name === 'lead' ? root.id : name.replace(/^worker-/, '')),
    listDescendants: vi.fn(async () => [...agents.values()].filter(item => item.id !== root.id)
      .map(item => ({ id: item.id, kind: 'child', path: `worker-${item.id}`, label: `任务 ${item.id}` }))),
    interrupt: vi.fn(),
    startActivation: vi.fn(), drainDescendants: vi.fn(),
  };
  const manager = {
    findBySessionId: (id: string) => id === root.id ? record : undefined,
    getSessionRecord: (chat: ChatScope, peer: string) => chat === scope && peer === 'peer' ? record : undefined,
  };
  const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  const registry = new TaskRegistry({ appId: 'app', manager, logger, taskAdmins: ['admin'],
    timeoutMs: options.timeoutMs ?? 60000, storagePath: options.storagePath ?? false,
    getService: name => name === 'subagents' ? runtime : name === 'agents' ? { get: (id: string) => agents.get(id) } : undefined,
  });
  registries.push(registry);
  const input = (sender: string) => {
    const id = `input-${sender}-${Math.random()}`;
    registry.noteInput(id, sender);
    registry.noteStep(root, [{ id, source: { kind: 'user' } }]);
  };
  const start = (id = 'child', runId = 'run-1', local = true) => {
    if (local && !agents.has(id)) agents.set(id, agent(id));
    const event = { id, runId, parentSessionId: root.id, provider: local ? 'spawn' : 'codex', local };
    registry.onStart(event);
    return event;
  };
  const replaceRoot = () => {
    root = agent('root');
    record.agent = root;
    record.handle = { agent: root, dispose: async () => {} };
    agents.set(root.id, root);
  };
  return { registry, record, agents, runtime, logger, input, start, replaceRoot, root: () => root };
}

describe('native task lifecycle and execution identity', () => {
  it('tracks independent runs, output and delivery without treating idle as success', () => {
    const f = setup();
    f.input('alice');
    const one = f.start('one', 'run-one');
    const two = f.start('two', 'run-two');
    expect(f.registry.list('group', 'peer')).toHaveLength(2);
    expect(f.registry.hasActive('root')).toBe(true);
    f.registry.onEnd({ ...one, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '报告已写好' }] });
    const completed = f.registry.get('one', 'group', 'peer')!;
    expect(completed).toMatchObject({ state: 'completed', settled: true, output: '报告已写好', delivery: 'unconfirmed', ownerId: 'alice' });
    f.registry.markDelivery(completed.taskId, 'old-run', 'sent');
    expect(f.registry.get('one', 'group', 'peer')!.delivery).toBe('unconfirmed');
    f.registry.markDelivery(completed.taskId, completed.runId, 'failed', 'offline');
    expect(f.registry.get('one', 'group', 'peer')!.delivery).toBe('failed');
    expect(f.registry.hasActive('root')).toBe(true);
    f.registry.onEnd({ ...two, stopReason: 'error' });
    expect(f.registry.hasActive('root')).toBe(false);
  });

  it('keeps old end events and timeouts away from a resumed child', async () => {
    vi.useFakeTimers();
    const f = setup({ timeoutMs: 1000 });
    f.input('alice');
    const first = f.start('child', 'first');
    const taskId = f.registry.get('child', 'group', 'peer')!.taskId;
    vi.advanceTimersByTime(500);
    const second = f.start('child', 'second');
    f.registry.onEnd({ ...first, stopReason: 'aborted' });
    expect(f.registry.get(taskId, 'group', 'peer')).toMatchObject({ runId: 'second', state: 'running' });
    expect((await f.registry.interrupt(taskId, { scope: 'group', peerId: 'peer', senderId: 'alice' }, 'first')).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.runtime.interrupt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(f.runtime.interrupt).toHaveBeenCalledTimes(1);
    expect(f.registry.get(taskId, 'group', 'peer')!.runId).toBe(second.runId);
  });

  it('does not route approvals or cancel through a same-id replacement root', async () => {
    const f = setup();
    f.input('alice');
    f.start();
    expect(f.registry.resolveAgent('child')?.ownerId).toBe('alice');
    f.replaceRoot();
    expect(f.registry.resolveAgent('child')).toBeUndefined();
    const task = f.registry.get('child', 'group', 'peer')!;
    expect((await f.registry.interrupt(task.taskId, { scope: 'group', peerId: 'peer', senderId: 'alice' })).ok).toBe(false);
    expect(f.runtime.interrupt).not.toHaveBeenCalled();
  });

  it('retains an interrupted child with parked work until native settlement or drain', async () => {
    const f = setup();
    f.input('alice');
    f.start();
    const task = f.registry.get('child', 'group', 'peer')!;
    const result = await f.registry.interrupt(task.taskId, { scope: 'group', peerId: 'peer', senderId: 'alice' });
    expect(result.message).toContain('等待');
    await Promise.resolve();
    expect(f.registry.get(task.taskId, 'group', 'peer')!.state).toBe('stopped');
    expect(f.registry.hasActive('root')).toBe(true);
    f.registry.closeRoot('root');
    expect(f.registry.hasActive('root')).toBe(false);
    expect(f.registry.resolveAgent('child')).toBeUndefined();
  });

  it('keeps external results despite the absence of a child agent', () => {
    const f = setup({ scope: 'c2c' });
    const external = f.start('external', 'outside-run', false);
    expect(f.registry.get('external', 'c2c', 'peer')!.local).toBe(false);
    expect(f.registry.resolveAgent('external')).toBeUndefined();
    f.registry.onEnd({ ...external, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '外部结果' }] });
    expect(f.registry.get('external', 'c2c', 'peer')!.output).toBe('外部结果');
  });

  it('retains explicit child reports and scans only the current run when closing text is omitted', () => {
    const f = setup();
    f.registry.noteInput('dsh-input', 'alice', { rootSessionId: 'root', qqMessageId: 'qq-origin', generation: 3 });
    f.registry.noteStep(f.root(), [{ id: 'dsh-input' }]);
    const events = [{ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'old result' }] } } }];
    const child = agent('child');
    child.session.snapshotEvents = () => events;
    f.agents.set(child.id, child);
    const run = f.start();
    events.push({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '仍在处理的较早说明' }] } } });
    f.registry.noteProgress(f.root(), { id: 'child-report', source: { kind: 'agent-message', senderSessionId: 'child' }, content: [{ type: 'text', text: '本轮发送的结果' }] });
    f.registry.onEnd({ ...run, stopReason: 'completed' });
    expect(f.registry.get('child', 'group', 'peer')).toMatchObject({ output: '本轮发送的结果', originMessageId: 'qq-origin', generation: 3, evidence: { messageId: 'child-report' } });
    const resumed = f.start('child', 'run-2');
    events.push({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '本轮最终结果' }] } } });
    f.registry.onEnd({ ...resumed, stopReason: 'completed' });
    expect(f.registry.get('child', 'group', 'peer')).toMatchObject({ output: '本轮最终结果', evidence: { sessionId: 'child', seq: 2 } });
  });

  it('does not overwrite a synchronous native terminal event with stopping', async () => {
    const f = setup();
    f.input('alice');
    const run = f.start();
    f.runtime.interrupt.mockImplementationOnce(() => { f.registry.onEnd({ ...run, stopReason: 'aborted' }); });
    const result = await f.registry.interrupt('child', { scope: 'group', peerId: 'peer', senderId: 'alice' });
    expect(result.ok).toBe(true);
    expect(f.registry.get('child', 'group', 'peer')).toMatchObject({ state: 'cancelled', settled: true });
  });

  it('bounds a delayed old end to that activation rather than a newer result and files', () => {
    const f = setup();
    f.input('alice');
    const events: SessionEventLike[] = [];
    const child = agent('child');
    child.session.snapshotEvents = () => events;
    f.agents.set(child.id, child);
    const old = f.start();
    events.push({ type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'first run result' }] } } });
    const fresh = f.start('child', 'new-run');
    events.push({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'second run result' }] } } });
    events.push({ type: 'deliverables/presented', seq: 3, data: { files: [{ path: '/tmp/second.txt', description: 'second run only' }] } });
    f.registry.onEnd({ ...old, stopReason: 'completed' });
    const active = f.registry.get('child', 'group', 'peer')!;
    expect(active.attempts[0]).toMatchObject({ output: 'first run result' });
    expect(active.attempts[0]?.files ?? []).toEqual([]);
    expect(active.state).toBe('running');
    f.registry.onEnd({ ...fresh, stopReason: 'completed' });
    expect(f.registry.get('child', 'group', 'peer')).toMatchObject({ output: 'second run result', files: [{ path: '/tmp/second.txt' }] });
  });

  it('does not hold a replacement root alive for detached tasks with unknown status', () => {
    const f = setup();
    f.input('alice');
    f.start();
    f.registry.forgetRoot(f.root());
    f.replaceRoot();
    f.registry.closeRoot('root', f.root());
    expect(f.registry.get('child', 'group', 'peer')).toMatchObject({ state: 'unknown', settled: false });
    expect(f.registry.hasActive('root')).toBe(false);
  });
});

describe('QQ task authority', () => {
  it('forwards parallel verified answers only once to each owned task after their successful native results', async () => {
    const f = setup();
    const events: SessionEventLike[] = [];
    f.root().session.snapshotEvents = () => events;
    f.input('alice');
    f.start('alice-task', 'alice-run');
    f.input('bob');
    f.start('bob-task', 'bob-run');
    const alice = f.registry.get('alice-task', 'group', 'peer')!;
    const bob = f.registry.get('bob-task', 'group', 'peer')!;
    f.registry.noteQuestionOpenAnswer('root', 'ask-alice', 'alice', [alice.taskId]);
    f.registry.noteQuestionOpenAnswer('root', 'ask-bob', 'bob', [bob.taskId]);
    f.registry.noteInput('mixed-alice', 'alice');
    f.registry.noteInput('mixed-bob', 'bob');
    f.registry.noteStep(f.root(), [{ id: 'mixed-alice' }, { id: 'mixed-bob' }]);
    const call = (name: string, target: string) => ({ name, agent: f.root(), arguments: { agent: target }, signal: new AbortController().signal });
    expect(await f.registry.authorizeTool(call('send_message', 'alice-task'))).toContain('无法确定');
    events.push({ type: 'tool/result', data: { message: { toolCallId: 'ask-alice', isError: false } } });
    events.push({ type: 'tool/result', data: { message: { toolCallId: 'ask-bob', isError: false } } });
    f.registry.noteStep(f.root(), []);
    expect(f.registry.currentActor('root')).toBeUndefined();
    expect(await f.registry.authorizeTool(call('interrupt_agent', 'alice-task'))).toContain('无权');
    expect(await f.registry.authorizeTool(call('send_message', 'alice-task'))).toBeUndefined();
    expect(await f.registry.authorizeTool(call('send_message', 'alice-task'))).toContain('无权');
    expect(await f.registry.authorizeTool(call('send_message', 'bob-task'))).toBeUndefined();
  });

  it('binds late native question answers to an exact root and registered responder', () => {
    const f = setup();
    f.input('alice');
    const rollback = f.registry.noteQuestionAnswer('root', 'call-1', 'admin');
    f.registry.noteStep(f.root(), [{ source: { kind: 'user-question-reply', callId: 'call-1', outcome: 'answered' } }]);
    expect(f.registry.currentActor('root')).toBe('admin');
    rollback();
    const failed = f.registry.noteQuestionAnswer('root', 'call-2', 'alice');
    failed();
    f.registry.noteStep(f.root(), [{ source: { kind: 'user-question-reply', callId: 'call-2', outcome: 'answered' } }]);
    expect(f.registry.currentActor('root')).toBeUndefined();
    f.registry.noteInput('obsolete', 'alice', { rootSessionId: 'root' });
    f.registry.forgetSession('root');
    f.registry.noteStep(f.root(), [{ id: 'obsolete', source: { kind: 'user' } }]);
    expect(f.registry.currentActor('root')).toBeUndefined();
  });
  it('uses the consumed author, ignores future arrivals and denies mixed-author control', async () => {
    const f = setup();
    f.input('alice');
    f.start();
    f.registry.noteInput('future', 'bob');
    expect(f.registry.currentActor('root')).toBe('alice');
    const signal = new AbortController().signal;
    const call = { name: 'send_message', agent: f.root(), arguments: { agent: 'worker-child', message: '修改' }, signal };
    expect(await f.registry.authorizeTool(call)).toBeUndefined();
    f.registry.noteStep(f.root(), [{ id: 'future', source: { kind: 'user' } }]);
    expect(await f.registry.authorizeTool(call)).toContain('无权');
    f.registry.noteInput('alice-2', 'alice');
    f.registry.noteInput('bob-2', 'bob');
    f.registry.noteStep(f.root(), [{ id: 'alice-2' }, { id: 'bob-2' }]);
    expect(f.registry.currentActor('root')).toBeUndefined();
    expect(await f.registry.authorizeTool(call)).toContain('无法确定');
    f.input('admin');
    expect(await f.registry.authorizeTool(call)).toBeUndefined();
  });

  it('enforces peer and task owner for explicit interruption', async () => {
    const f = setup();
    f.input('alice');
    f.start();
    const task = f.registry.get('child', 'group', 'peer')!;
    expect(f.registry.get(task.taskId, 'group', 'another-group')).toBeUndefined();
    expect((await f.registry.interrupt(task.taskId, { scope: 'group', peerId: 'peer', senderId: 'bob' })).ok).toBe(false);
    expect(f.runtime.interrupt).not.toHaveBeenCalled();
    expect((await f.registry.interrupt(task.taskId, { scope: 'group', peerId: 'peer', senderId: 'admin' })).ok).toBe(true);
  });

  it('guards native execution and delegates unrelated tools unchanged', async () => {
    const f = setup();
    f.input('alice');
    f.start();
    f.input('bob');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    f.registry.install({ on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); } });
    const next = vi.fn(async () => ({ kind: 'allow' }));
    const exec = { agent: f.root(), arguments: { agent: 'worker-child' }, signal: new AbortController().signal };
    expect(await handlers.get('tools/pre-execute')!({ ...exec, name: 'interrupt_agent' }, next)).toMatchObject({ kind: 'deny' });
    expect(next).not.toHaveBeenCalled();
    expect(await handlers.get('tools/pre-execute')!({ ...exec, name: 'read_file' }, next)).toEqual({ kind: 'allow' });
  });
});

describe('task records survive restarts without inventing ongoing execution', () => {
  it('restores unfinished work as unknown and retains final results and delivery failures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qq-task-registry-'));
    directories.push(directory);
    const storagePath = join(directory, 'tasks.json');
    const first = setup({ storagePath });
    first.input('alice');
    const completed = first.start('complete', 'complete-run');
    first.start('unfinished', 'unfinished-run');
    first.registry.onEnd({ ...completed, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '保留结果' }] });
    const task = first.registry.get('complete', 'group', 'peer')!;
    first.registry.markDelivery(task.taskId, task.runId, 'failed', 'QQ offline');
    first.registry.dispose();
    const restored = setup({ storagePath });
    expect(restored.registry.get('unfinished', 'group', 'peer')!.state).toBe('unknown');
    expect(restored.registry.resolveAgent('unfinished')).toBeUndefined();
    expect(restored.registry.get('complete', 'group', 'peer')).toMatchObject({ state: 'completed', output: '保留结果', delivery: 'failed' });
  });

  it('does not overwrite corrupt persisted data on subsequent observations', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qq-task-registry-corrupt-'));
    directories.push(directory);
    const storagePath = join(directory, 'tasks.json');
    writeFileSync(storagePath, '{broken');
    const f = setup({ storagePath });
    f.input('alice');
    f.start();
    expect(f.registry.storageError).toContain('读取失败');
    expect(readFileSync(storagePath, 'utf8')).toBe('{broken');
  });
});
