/** SessionManager drives real native root teardown and history-preserving resume. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SubagentRuntime from '@deepseek-ai/dsh-subagent';
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { MockAdapter, textResponse } from '@native-test/packages/core/agent-loop/tests/mock-adapter.ts';
import { TestSessionQuery } from '@native-test/packages/subagent/subagent/tests/test-session-query.ts';
import { ConfigSchema } from '../src/config.ts';
import type { DshAgentRegistry } from '../src/session/types.ts';
import { legacyDerivedSessionId } from '../src/session/session-id.ts';
import { TaskRegistry } from '../src/features/task-registry.ts';

const env = vi.hoisted(() => ({ home: '' }));
vi.mock('../src/shared/dirs.ts', () => ({
  get PLUGIN_HOME() { return env.home; },
  resolveAgentCwd: (cwd: string | undefined) => cwd ?? `${env.home}/workspace`,
}));
const { SessionManager } = await import('../src/session/session-manager.ts');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

class HeldWorker extends MockAdapter {
  readonly entered = Promise.withResolvers<void>();
  constructor() { super([]); }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason); return; }
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    });
    yield* textResponse('worker result');
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'qq-native-manager-'));
  env.home = directory;
  const ctx = new Context();
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); });
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions'), compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(TestSessionQuery);
  await ctx.plugin(SubagentRuntime);
  await ctx.plugin(Spawn, { providerName: 'spawn' });
  const rootAdapter = new MockAdapter([textResponse('history saved'), textResponse('new root ready'), textResponse('ready')]);
  const workers = new HeldWorker();
  ctx.llm.registerAdapter(['mock'], rootAdapter);
  ctx.llm.registerAdapter(['worker'], workers);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const config = ConfigSchema({ appId: 'native-app', appSecret: 'secret', provider: 'mock', model: 'mock',
    cwd: directory, sessionIdleTimeout: 0, conversation: { mode: 'interactive', mainTimeoutMs: 0, taskTimeoutMs: 0 } });
  const manager = new SessionManager(ctx, ctx.agents as unknown as DshAgentRegistry, config, logger);
  const tasks = new TaskRegistry({ appId: config.appId, manager, getService: name => ctx.get(name), logger, storagePath: false, timeoutMs: 0 });
  manager.taskRegistry = tasks;
  tasks.install(ctx);
  cleanups.push(async () => { await manager.disposeAll(); tasks.dispose(); });
  const open = () => manager.getOrCreate('c2c', 'user', 'user', { scope: 'c2c', targetId: 'user', msgId: 'message' });
  return { ctx, manager, tasks, workers, open };
}

describe('native SessionManager lifecycle', () => {
  it('a borrowed host root can stop and reset its QQ binding without losing host history or delegation', async () => {
    const f = await fixture();
    const host = await f.ctx.agents.create({
      sessionId: SessionId(legacyDerivedSessionId('qqbot:native-app:c2c:user')),
      meta: { cwd: env.home },
      agentOptions: { provider: 'worker', model: 'mock' },
    });
    const borrowed = await f.open();
    expect(borrowed.agent).toBe(host.agent);
    expect(borrowed.ownsAgent).toBe(false);
    host.agent.steer(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'preserve borrowed history' }] }));
    await f.workers.entered.promise;

    expect(await f.manager.stop('c2c', 'user', 'main')).toEqual({ stopped: true, mode: 'main', backgroundActive: false });
    await host.agent.whenIdle();
    expect(f.ctx.agents.get(host.agent.id)).toBe(host.agent);
    expect(f.manager.getSessionRecord('c2c', 'user')).toBe(borrowed);

    expect(await f.manager.remove('c2c', 'user')).toEqual({ detached: true, backgroundActive: false });
    const fresh = await f.open();
    expect(fresh.ownsAgent).toBe(true);
    expect(fresh.sessionId).not.toBe(borrowed.sessionId);
    expect(fresh.agent).not.toBe(host.agent);
    expect(JSON.stringify(fresh.agent.session.snapshotEvents())).not.toContain('preserve borrowed history');
    expect(f.ctx.agents.get(host.agent.id)).toBe(host.agent);
    expect(JSON.stringify(host.agent.session.snapshotEvents())).toContain('preserve borrowed history');

    // The host still owns this root: QQ reset must not permanently drain it.
    const child = await f.ctx.subagents.startActivation({ parent: host.agent, provider: 'spawn', name: 'after-qq-reset', label: 'after-qq-reset',
      prompt: [{ type: 'text', text: 'host delegation still works' }], agentOptions: { provider: 'worker', model: 'mock' },
      signal: new AbortController().signal, delivery: 'parent' });
    expect(f.ctx.agents.get(child.childId)).toBeDefined();
    expect(f.tasks.resolveAgent(child.childId)).toBeUndefined();
    await f.manager.stop('c2c', 'user', 'all');
    expect(f.ctx.agents.get(fresh.agent.id as never)).toBeUndefined();
    expect(f.ctx.agents.get(host.agent.id)).toBe(host.agent);
    expect(f.ctx.agents.get(child.childId)).toBeDefined();
  });

  it('resetting a borrowed root keeps its active host task and records its QQ status as unverified', async () => {
    const f = await fixture();
    const host = await f.ctx.agents.create({
      sessionId: SessionId(legacyDerivedSessionId('qqbot:native-app:c2c:user')),
      meta: { cwd: env.home },
      agentOptions: { provider: 'mock', model: 'mock' },
    });
    const borrowed = await f.open();
    const child = await f.ctx.subagents.startActivation({ parent: host.agent, provider: 'spawn', name: 'host-task', label: 'host-task',
      prompt: [{ type: 'text', text: 'keep working in the host' }], agentOptions: { provider: 'worker', model: 'mock' },
      signal: new AbortController().signal, delivery: 'parent' });
    await f.workers.entered.promise;
    expect(f.tasks.hasActive(borrowed.sessionId)).toBe(true);
    expect(f.tasks.get(child.childId, 'c2c', 'user')).toMatchObject({ state: 'running', settled: false });

    expect(await f.manager.remove('c2c', 'user')).toEqual({ detached: true, backgroundActive: true });
    expect(f.ctx.agents.get(host.agent.id)).toBe(host.agent);
    expect(f.ctx.agents.get(child.childId)?.status).toBe('running');
    expect(f.tasks.get(child.childId, 'c2c', 'user')).toMatchObject({ state: 'unknown', settled: false });
    expect(f.tasks.resolveAgent(child.childId)).toBeUndefined();
    const fresh = await f.open();
    expect(fresh.ownsAgent).toBe(true);
    expect(fresh.sessionId).not.toBe(borrowed.sessionId);
    expect(f.tasks.hasActive(fresh.sessionId)).toBe(false);
  });

  it('stop all drains workers and retires the root; fresh input resumes history and can delegate again', async () => {
    const f = await fixture();
    const original = await f.open();
    original.agent.steer!(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'keep this history' }] }));
    await original.agent.whenIdle();
    const child = await f.ctx.subagents.startActivation({ parent: original.agent as never, provider: 'spawn', name: 'first', label: 'first',
      prompt: [{ type: 'text', text: 'long work' }], agentOptions: { provider: 'worker', model: 'mock' },
      signal: new AbortController().signal, delivery: 'parent' });
    await f.workers.entered.promise;
    expect(f.tasks.hasActive(original.sessionId)).toBe(true);
    const outcome = await f.manager.stop('c2c', 'user', 'all');
    expect(outcome.backgroundActive).toBe(false);
    expect(f.ctx.agents.get(original.agent.id as never)).toBeUndefined();
    expect(f.ctx.agents.get(child.childId)).toBeUndefined();
    const restored = await f.open();
    expect(restored.sessionId).toBe(original.sessionId);
    expect(restored.agent).not.toBe(original.agent);
    expect(JSON.stringify(restored.agent.session.snapshotEvents())).toContain('keep this history');
    const next = await f.ctx.subagents.startActivation({ parent: restored.agent as never, provider: 'spawn', name: 'after-stop', label: 'after-stop',
      prompt: [{ type: 'text', text: 'new work' }], agentOptions: { provider: 'worker', model: 'mock' },
      signal: new AbortController().signal, delivery: 'parent' });
    expect(f.tasks.resolveAgent(next.childId)?.record.agent).toBe(restored.agent);
    expect(f.tasks.hasActive(restored.sessionId)).toBe(true);
  });

  it('an externally disposed root is removed from the manager before the next message resumes it', async () => {
    const f = await fixture();
    const original = await f.open();
    original.agent.steer!(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'external close history' }] }));
    await original.agent.whenIdle();
    await original.handle.dispose();
    expect(f.manager.getSessionRecord('c2c', 'user')).toBeUndefined();
    const restored = await f.open();
    expect(restored.agent).not.toBe(original.agent);
    expect(restored.sessionId).toBe(original.sessionId);
    expect(JSON.stringify(restored.agent.session.snapshotEvents())).toContain('external close history');
  });
});
