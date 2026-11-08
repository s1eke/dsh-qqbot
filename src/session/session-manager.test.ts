/**
 * SessionManager.getOrCreate 会话 id 迁移/铸造路径的回归用例
 *
 * - E1：resume 失败只在确认「会话不存在」时才首次创建，其余故障 warn 后向上抛
 * - E2：0.5.x 确定性 id 不进入新建路径；同 key 并发 getOrCreate 合并为一次
 * - E3 连带：prefs 损坏导致映射丢失时必须留下可见日志
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, type ImQQBotConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import type { DshAgent, DshAgentHandle, DshAgentRegistry } from './types.ts';

const env = vi.hoisted(() => ({ home: '' }));

vi.mock('../shared/dirs.ts', () => ({
  get PLUGIN_HOME() { return env.home; },
  resolveAgentCwd: (cwd: string | undefined) => cwd || `${env.home}/workspace`,
}));

const { SessionManager } = await import('./session-manager.ts');
const { PrefsStore } = await import('../model/prefs-store.ts');
const { legacyDerivedSessionId } = await import('./session-id.ts');

const APP_ID = 'app1';
const PEER = 'user1';
const KEY = `qqbot:${APP_ID}:c2c:${PEER}`;
const LEGACY_ID = legacyDerivedSessionId(KEY);
const MINTED = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPLY: ReplyTarget = { scope: 'c2c', targetId: PEER, msgId: 'm1' };

/** agents.resume 对不存在会话的报错 */
const notFound = (id: string): Error =>
  Object.assign(new Error(`session "${id}" not found`), { name: 'SessionPersistenceNotFoundError' });
/** 非「不存在」类失败：日志损坏 / 后端 IO / 同 id 未释放等 */
const corrupt = (id: string): Error => new Error(`EIO: corrupt session log for "${id}"`);

/**
 * 宿主 persistence 替身。
 *
 * 签名对齐宿主 `SessionPersistence.stat`：会话不存在返回 `undefined`（不抛），
 * 存在则返回快照。替身必须跟真实契约一致——此前替身带了宿主根本没有的
 * `load()`，用例全绿但线上直接 TypeError。
 */
function persistenceCtx(stat: (id: string) => Promise<{ header?: { agentPreset?: string } } | undefined>): Context {
  return {
    get: (name: string) => (name === 'sessionPersistence' ? { stat } : undefined),
    on: vi.fn(),
  } as unknown as Context;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeAgent(id: string): DshAgent {
  return {
    id,
    ctx: {} as Context,
    status: 'idle',
    session: { id, snapshotEvents: () => [] },
    cancel: vi.fn(),
    followup: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    runMaintenance: vi.fn(async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal)),
  } as unknown as DshAgent;
}

function fakeHandle(id: string): DshAgentHandle {
  return { agent: fakeAgent(id), dispose: vi.fn(async () => {}) };
}

type ResumeImpl = (options: { resumeSessionId: string }) => Promise<DshAgentHandle>;

function createRegistry(resumeImpl: ResumeImpl) {
  const handles: DshAgentHandle[] = [];
  const registry = {
    get: vi.fn(() => undefined),
    resume: vi.fn(resumeImpl),
    create: vi.fn(async (options: { sessionId: string }) => {
      const handle = fakeHandle(options.sessionId);
      handles.push(handle);
      return handle;
    }),
  };
  return { registry, handles };
}

function createLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

/** 所有日志调用参数拼接（断言某错误是否被记录） */
function allLogText(logger: Logger): string {
  return (['info', 'warn', 'error', 'debug'] as const)
    .flatMap((level) => vi.mocked(logger[level]).mock.calls.flat())
    .map(String)
    .join('\n');
}

const managers: Array<InstanceType<typeof SessionManager>> = [];

/** 无任何宿主服务的 ctx（无 sessionPersistence，存在性无法求证） */
function emptyCtx(): Context {
  return { get: () => undefined, on: vi.fn() } as unknown as Context;
}

/** 默认替身：磁盘上没有任何会话（stat 一律 undefined） */
function absentCtx(): Context {
  return persistenceCtx(async () => undefined);
}

/** 替身：指定 id 的会话在盘上 */
function onDiskCtx(...ids: string[]): Context {
  return persistenceCtx(async (id) => (ids.includes(id) ? { header: {} } : undefined));
}

function createManagerWithCtx(
  registry: Pick<DshAgentRegistry, 'get' | 'resume' | 'create'>,
  ctx: Context,
  logger: Logger = createLogger(),
  overrides: Partial<ImQQBotConfig> = {},
) {
  const config = ConfigSchema({
    appId: APP_ID,
    appSecret: 'secret',
    provider: 'p',
    model: 'm',
    cwd: join(env.home, 'workspace'),
    sessionIdleTimeout: 0,
    ...overrides,
  } as ImQQBotConfig);
  const manager = new SessionManager(ctx, registry as DshAgentRegistry, config, logger);
  managers.push(manager);
  return manager;
}

function createManager(registry: Pick<DshAgentRegistry, 'get' | 'resume' | 'create'>, logger: Logger = createLogger()) {
  return createManagerWithCtx(registry, absentCtx(), logger);
}

/** 模拟重启后读盘：prefs 中记录的 sessionId */
function persistedId(): string | undefined {
  return new PrefsStore().getSessionId(KEY);
}

function createdIds(registry: { create: { mock: { calls: Array<[{ sessionId: string }]> } } }): string[] {
  return registry.create.mock.calls.map(([options]) => String(options.sessionId));
}

beforeEach(() => {
  env.home = mkdtempSync(join(tmpdir(), 'im-qqbot-session-'));
  mkdirSync(join(env.home, 'workspace'), { recursive: true });
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disposeAll()));
  rmSync(env.home, { recursive: true, force: true });
});

describe('deliveryAddress', () => {
  it('内存里没有会话时，只按 prefs 返回 QQ 地址，不唤醒 agent', () => {
    const sessionId = 'session-live';
    new PrefsStore().setSessionId(KEY, sessionId);
    const { registry } = createRegistry(async () => { throw new Error('should not resume'); });

    const address = createManager(registry).deliveryAddress(sessionId);

    expect(address).toEqual({ scope: 'c2c', targetId: PEER });
    expect(registry.resume).not.toHaveBeenCalled();
    expect(registry.create).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
  });

  it('未知 session 返回 undefined', () => {
    const { registry } = createRegistry(async () => { throw new Error('should not resume'); });

    expect(createManager(registry).deliveryAddress('session-dead')).toBeUndefined();
    expect(registry.resume).not.toHaveBeenCalled();
    expect(registry.create).not.toHaveBeenCalled();
  });

  it('对端已经换成另一条活会话时，不为旧 id 返回地址', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManager(registry);
    const live = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    new PrefsStore().setSessionId(KEY, 'session-old');

    expect(manager.deliveryAddress('session-old')).toBeUndefined();
    expect(manager.deliveryAddress(live.sessionId)).toEqual(REPLY);
  });
});

describe('getOrCreate — 对照组（迁移主路径行为正确）', () => {
  it('全新用户：legacy 不存在 → 铸造 session- 前缀 id 创建并落盘', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });

    const record = await createManager(registry).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(registry.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: LEGACY_ID }));
    expect(record.sessionId).toMatch(MINTED);
    expect(createdIds(registry)).toEqual([record.sessionId]);
    expect(persistedId()).toBe(record.sessionId);
  });

  it('0.5.x 老用户：legacy 会话 resume 成功 → 沿用并落盘，不创建', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));

    const record = await createManager(registry).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toBe(LEGACY_ID);
    expect(registry.create).not.toHaveBeenCalled();
    expect(persistedId()).toBe(LEGACY_ID);
  });

  it('prefs 已记录：resume 该 id 成功 → 不再探测 legacy', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));

    const record = await createManager(registry).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toBe('session-current');
    expect(registry.resume).toHaveBeenCalledTimes(1);
    expect(registry.create).not.toHaveBeenCalled();
  });

  it('session 当初的 preset 锁定：优先 header.agentPreset，而非当前 effective preset', async () => {
    const prefs = new PrefsStore();
    prefs.setSessionId(KEY, 'session-current');
    prefs.setPreset(KEY, 'current-preset'); // 当前 effective 已被 /preset 换过
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const presets = {
      resolve: vi.fn(async (id?: string) => ({ id: id ?? 'default' })),
      mount: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    };
    const ctx = {
      get: (name: string) => {
        if (name === 'sessionPersistence') {
          return { stat: async (id: string) => (id === 'session-current' ? { header: { agentPreset: 'locked-preset' } } : undefined) };
        }
        return name === 'agentPresets' ? presets : undefined;
      },
      on: vi.fn(),
    } as unknown as Context;

    const record = await createManagerWithCtx(registry, ctx).getOrCreate('c2c', PEER, PEER, REPLY);

    // 此前 header 读取一直失败（调用了宿主没有的 load），preset 锁定语义实际失效
    expect(presets.resolve).toHaveBeenCalledWith('locked-preset');
    expect(record.agentPreset).toBe('locked-preset');
  });
});

describe('getOrCreate — E1 resume 失败按会话是否存在分流', () => {
  it('E1-1 会话在盘上但 resume 失败 → 不创建，错误记录后向上抛', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw corrupt(resumeSessionId); });
    const logger = createLogger();
    // 宿主自身（agent-loop restoreOrCreateConfigured）只在确认磁盘不存在时才 create
    const manager = createManagerWithCtx(registry, onDiskCtx('session-current'), logger);

    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY)).rejects.toThrow(/EIO/);

    expect(registry.create).not.toHaveBeenCalled();
    expect(persistedId()).toBe('session-current'); // 映射不被改写，故障恢复后仍指向原会话
    expect(allLogText(logger)).toContain('EIO');
  });

  it('E1-2 0.5.x 老会话在盘上但 resume 遇瞬时错误 → 不弃用，故障恢复后仍能恢复', async () => {
    const first = createRegistry(async ({ resumeSessionId }) => { throw corrupt(resumeSessionId); });

    await expect(
      createManagerWithCtx(first.registry, onDiskCtx(LEGACY_ID)).getOrCreate('c2c', PEER, PEER, REPLY),
    ).rejects.toThrow(/EIO/);
    expect(first.registry.create).not.toHaveBeenCalled();
    expect(persistedId()).toBeUndefined();

    // 重启：瞬时故障已恢复，legacy 会话正常 resume
    const second = createRegistry(async ({ resumeSessionId }) => {
      if (resumeSessionId === LEGACY_ID) return fakeHandle(resumeSessionId);
      throw notFound(resumeSessionId);
    });
    const record = await createManager(second.registry).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toBe(LEGACY_ID); // 老会话历史仍可恢复
    expect(persistedId()).toBe(LEGACY_ID);
  });

  it('E1-3 存在性求证本身失败（持久化后端故障）→ 按存在处理，不重建', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const logger = createLogger();
    const flaky = persistenceCtx(async () => { throw new Error('EIO: persistence backend unavailable'); });

    await expect(
      createManagerWithCtx(registry, flaky, logger).getOrCreate('c2c', PEER, PEER, REPLY),
    ).rejects.toThrow(/not found/); // 向上抛原 resume 错误，而非求证错误
    expect(registry.create).not.toHaveBeenCalled();
    expect(allLogText(logger)).toContain('existence unknown');
  });

  it('E1-4 确认磁盘无此会话 → 即使 resume 报的是 IO 错误也允许首次创建', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw corrupt(resumeSessionId); });

    const record = await createManager(registry).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toMatch(MINTED);
    expect(createdIds(registry)).toEqual([record.sessionId]);
  });

  it('E1-5 宿主无 sessionPersistence.stat → 无求证手段，按 resume 结果创建并留痕', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const logger = createLogger();

    const record = await createManagerWithCtx(registry, emptyCtx(), logger).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toMatch(MINTED);
    expect(createdIds(registry)).toEqual([record.sessionId]);
    expect(allLogText(logger)).toContain('host lacks sessionPersistence.stat');
  });

  it('E1-6 宿主 persistence 形态不含 stat → 不卡住全新会话的创建', async () => {
    // 回归：此前按不存在的 load() 求证，TypeError 被当成「后端故障」→ 拒绝创建，
    // 全新用户的第一条消息直接收到「处理消息时出现异常」
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const legacyShape = {
      get: (name: string) => (name === 'sessionPersistence' ? { open: async () => ({}) } : undefined),
      on: vi.fn(),
    } as unknown as Context;

    const record = await createManagerWithCtx(registry, legacyShape).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toMatch(MINTED);
    expect(createdIds(registry)).toEqual([record.sessionId]);
  });
});

describe('getOrCreate — E2 确定性 id 不进入新建路径', () => {
  it('E2-1 /new 使在途 resume 失效，旧请求不能创建或覆盖新映射', async () => {
    const pending = deferred<DshAgentHandle>();
    const { registry } = createRegistry(() => pending.promise);
    const manager = createManager(registry);

    const creating = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const rejected = expect(creating).rejects.toThrow(/已停止或重置/);
    await vi.waitFor(() => expect(registry.resume).toHaveBeenCalled());
    const resetting = manager.remove('c2c', PEER);
    pending.reject(notFound(LEGACY_ID));
    await Promise.all([rejected, resetting]);

    expect(registry.create).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
    expect(persistedId()).toMatch(MINTED);
    expect(persistedId()).not.toBe(LEGACY_ID);
  });

  it('E2-2 /compact 拉起与普通消息并发 getOrCreate → singleflight 合并为一次 resume/create，无 agent 泄漏', async () => {
    const resumes: Array<Deferred<DshAgentHandle>> = [];
    const { registry, handles } = createRegistry(() => {
      const d = deferred<DshAgentHandle>();
      resumes.push(d);
      return d.promise;
    });
    const manager = createManager(registry);

    // /compact 走 slashCommand（在 concurrencyGuard 之前），与普通消息不串行
    const compacting = manager.compact('c2c', PEER, { senderId: PEER, replyTarget: REPLY });
    const messaging = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await vi.waitFor(() => expect(resumes).toHaveLength(1));
    for (const d of resumes) d.reject(notFound(LEGACY_ID));
    const [, record] = await Promise.all([compacting, messaging]);

    expect(resumes).toHaveLength(1);
    expect(createdIds(registry)).toEqual([record.sessionId]);
    expect(record.sessionId).toMatch(MINTED);
    expect(handles).toHaveLength(1); // 不再产生无人回收的多余 agent
    expect(manager.getSessionRecord('c2c', PEER)?.handle).toBe(handles[0]);
  });

  it('E2-3 singleflight 失败时两个调用方都收到同一错误，且不残留在途记录', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw corrupt(resumeSessionId); });
    // 会话在盘上 → resume 失败不重建，整次调用以失败告终
    const manager = createManagerWithCtx(registry, onDiskCtx('session-current'));

    const first = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const second = manager.getOrCreate('c2c', PEER, PEER, REPLY);

    await expect(first).rejects.toThrow(/EIO/);
    await expect(second).rejects.toThrow(/EIO/);
    expect(registry.resume).toHaveBeenCalledTimes(1);

    // 在途记录已清理：下一次调用重新发起 resume
    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY)).rejects.toThrow(/EIO/);
    expect(registry.resume).toHaveBeenCalledTimes(2);
  });
});

describe('getOrCreate — E3 连带（prefs 损坏导致映射丢失）', () => {
  it('E3-4 prefs 文件损坏 → 回落 legacy 探测，且映射丢失留下可见日志', async () => {
    writeFileSync(join(env.home, 'model-prefs.json'), `{"overrides":{},"sessionIds":{"${KEY}":"session-cur`, 'utf8');
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const logger = createLogger();

    const record = await createManager(registry, logger).getOrCreate('c2c', PEER, PEER, REPLY);

    expect(registry.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: LEGACY_ID }));
    expect(record.sessionId).toBe(LEGACY_ID);
    expect(allLogText(logger)).toMatch(/model-prefs\.json/); // 不再静默
  });
});

describe('getOrCreate — 会话创建/恢复后挂载到对应工作区', () => {
  /** 带 workspaceRegistry 的 ctx（sessionPersistence 缺省为「磁盘无会话」） */
  function workspaceCtx(workspaceRegistry: unknown): Context {
    return {
      get: (name: string) => {
        if (name === 'sessionPersistence') return { stat: async () => undefined };
        if (name === 'workspaceRegistry') return workspaceRegistry;
        return undefined;
      },
      on: vi.fn(),
    } as unknown as Context;
  }

  it('创建会话后用 workspaceDir() 挂载（cwd 与 meta.cwd 同源，避免 attachSession 校验失败）', async () => {
    const ws = { path: join(env.home, 'workspace'), attachSession: vi.fn().mockResolvedValue(undefined) };
    const workspaceRegistry = { create: vi.fn().mockResolvedValue(ws) };
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManagerWithCtx(registry, workspaceCtx(workspaceRegistry));

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    // attach 是 fire-and-forget，等待其落到工作区
    await vi.waitFor(() => expect(ws.attachSession).toHaveBeenCalledWith(record.sessionId));
    // 关键回归：cwd 必须等于 meta.cwd（resolveAgentCwd(config.cwd)），而非 process.cwd()
    expect(workspaceRegistry.create).toHaveBeenCalledWith(join(env.home, 'workspace'), 'QQBot');
  });

  it('恢复会话时同样挂载（升级后老会话在下一次创建记录时补挂）', async () => {
    new PrefsStore().setSessionId(KEY, 'session-current');
    const ws = { path: join(env.home, 'workspace'), attachSession: vi.fn().mockResolvedValue(undefined) };
    const workspaceRegistry = { create: vi.fn().mockResolvedValue(ws) };
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, workspaceCtx(workspaceRegistry));

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    expect(record.sessionId).toBe('session-current');
    await vi.waitFor(() => expect(ws.attachSession).toHaveBeenCalledWith('session-current'));
    expect(workspaceRegistry.create).toHaveBeenCalledWith(join(env.home, 'workspace'), 'QQBot');
  });
});

describe('QQ prompt 注册生命周期（per-agent 安装 / 释放 / live 复用重装）', () => {
  /**
   * 带 systemPrompt 替身的 agent：section/context 注册进 Map，disposer 从 Map 删除，
   * 用于观察 QQ prompt sections/contexts 的安装与释放。
   */
  function promptAgent(id: string, opts: { failSection?: boolean } = {}) {
    const sections = new Map<string, { name: string }>();
    const contexts = new Map<string, { name: string }>();
    const service = {
      section: (s: { name: string }) => {
        if (opts.failSection) throw new Error('boom: section registration rejected');
        sections.set(s.name, s);
        return () => { sections.delete(s.name); };
      },
      context: (c: { name: string }) => {
        contexts.set(c.name, c);
        return () => { contexts.delete(c.name); };
      },
    };
    const agent = {
      ...fakeAgent(id),
      ctx: { get: (name: string) => (name === 'systemPrompt' ? service : undefined) },
    } as unknown as DshAgent;
    return { agent, sections, contexts };
  }

  /** registry：create 产出带 prompt 替身的 agent，并让后续 get() 能复用它（live 路径） */
  function promptRegistry(opts: { failSection?: boolean } = {}) {
    let live: DshAgent | undefined;
    const created: Array<{ agent: DshAgent; sections: Map<string, unknown>; contexts: Map<string, unknown> }> = [];
    const registry = {
      get: vi.fn((id: string) => live?.id === id ? live : undefined),
      resume: vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => { throw notFound(resumeSessionId); }),
      create: vi.fn(async (options: { sessionId: string }) => {
        const { agent, sections, contexts } = promptAgent(options.sessionId, opts);
        created.push({ agent, sections, contexts });
        live = agent;
        return { agent, dispose: vi.fn(async () => {}) } as DshAgentHandle;
      }),
    };
    return { registry, created };
  }

  it('会话建立注册 QQ 提示与交互上下文；remove() 全部释放', async () => {
    const { registry, created } = promptRegistry();
    const manager = createManager(registry);

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(created).toHaveLength(1);
    expect([...created[0].sections.keys()].sort()).toEqual(['qqbot:extra', 'qqbot:persona', 'qqbot:rules']);
    expect([...created[0].contexts.keys()].sort()).toEqual(['qqbot:background', 'qqbot:conversation', 'qqbot:turn-meta']);

    await manager.remove('c2c', PEER);
    expect(created[0].sections.size).toBe(0);
    expect(created[0].contexts.size).toBe(0);
  });

  it('extra section 惰性读取 config：改 directPrompt 即时生效，无需重装', async () => {
    const { registry, created } = promptRegistry();
    const config = ConfigSchema({
      appId: APP_ID, appSecret: 'secret', provider: 'p', model: 'm',
      cwd: join(env.home, 'workspace'), sessionIdleTimeout: 0,
      groupPrompt: 'OLD_GROUP', directPrompt: 'OLD_DIRECT',
    } as ImQQBotConfig);
    const manager = new SessionManager(absentCtx(), registry as unknown as DshAgentRegistry, config, createLogger());
    managers.push(manager);

    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const extra = created[0].sections.get('qqbot:extra') as { text: () => string };
    expect(extra.text()).toBe('OLD_DIRECT'); // c2c 会话读 directPrompt

    config.directPrompt = 'NEW_DIRECT'; // 热更新配置（Schema 代理可写）
    expect(extra.text()).toBe('NEW_DIRECT');
  });

  it('live 复用：释放后的 agent 再次被 get() 命中时重新安装 prompt（WeakSet 实现下会永久丢失）', async () => {
    const { registry, created } = promptRegistry();
    const manager = createManager(registry);

    // 第一次建立：create 产出 agent A 并注册 prompt
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const agent = created[0].agent;

    // 回收（releasePrompt 释放注册，但 registry 中 agent A 仍存活——宿主未必同步销毁）
    await manager.disposeAll();
    expect(created[0].sections.size).toBe(0);

    // 重新加载插件：prefs 仍指向原 id，registry.get 命中 A → live 复用
    const record = await createManager(registry).getOrCreate('c2c', PEER, PEER, REPLY);
    expect(record.agent).toBe(agent);
    expect(registry.create).toHaveBeenCalledTimes(1); // 未重建 agent，纯复用
    // 关键回归：prompt 必须重新注册，而不是因"已安装"标记被跳过
    expect(created[0].sections.size).toBe(3);
    expect(created[0].contexts.size).toBe(3);
  });

  it('disposeAll 同样释放 prompt 注册项', async () => {
    const { registry, created } = promptRegistry();
    const manager = createManager(registry);
    await manager.getOrCreate('c2c', PEER, PEER, REPLY);

    await manager.disposeAll();
    expect(created[0].sections.size).toBe(0);
    expect(created[0].contexts.size).toBe(0);
  });

  it('注册失败 fail-soft：会话仍可用，warn 留痕，下次同 agent 重试', async () => {
    const { registry, created } = promptRegistry({ failSection: true });
    const logger = createLogger();
    const manager = createManagerWithCtx(registry, absentCtx(), logger);

    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(record.agent).toBeDefined(); // 安装失败不阻断会话建立
    expect(allLogText(logger)).toContain('qq prompt install failed');

    // 失败不入表：同 agent 再次触发安装时重试（此处模拟再次 remove→复用）
    await expect(manager.remove('c2c', PEER)).resolves.toEqual({ detached: false, backgroundActive: false });
    expect(created[0].sections.size).toBe(0);
  });
});

describe('会话接入代次与关闭屏障', () => {
  function servicesCtx(services: Record<string, unknown>): Context {
    return {
      get: (name: string) => services[name] ?? (name === 'sessionPersistence' ? { stat: async () => undefined } : undefined),
      on: vi.fn(),
    } as unknown as Context;
  }

  it('下载后到达的旧输入在 /stop 后被拒绝，命令后的输入可接收', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    const manager = createManager(registry);
    const generation = manager.generation('c2c', PEER);
    const release = manager.holdActivity('c2c', PEER, 'input', generation);
    const outcome = await manager.stop('c2c', PEER);
    expect(outcome.stopped).toBe(true);
    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY, generation)).rejects.toThrow(/已停止或重置/);
    expect(registry.create).not.toHaveBeenCalled();
    release();
    release();
    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY)).resolves.toBeDefined();
  });

  it('/new 通过原生创建信号取消未完成的恢复，不必等预处理自行结束', async () => {
    let signal: AbortSignal | undefined;
    const { registry } = createRegistry((options) => new Promise((_resolve, reject) => {
      signal = (options as { signal?: AbortSignal }).signal;
      signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
    }));
    const manager = createManager(registry);
    const creating = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const rejected = expect(creating).rejects.toThrow(/已停止或重置/);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await manager.remove('c2c', PEER);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(registry.create).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it('宿主释放确切根后清掉旧缓存，下一条输入从保留历史恢复', async () => {
    const listeners = new Map<string, (event: { agent: DshAgent }) => void>();
    const ctx = servicesCtx({});
    vi.mocked(ctx.on as unknown as ReturnType<typeof vi.fn>).mockImplementation((name, listener) => {
      listeners.set(name, listener);
      return () => { listeners.delete(name); };
    });
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, ctx);
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const generation = manager.generation('c2c', PEER);
    const tasks = { forgetRoot: vi.fn(), hasActive: () => false, closeRoot: vi.fn() };
    manager.taskRegistry = tasks as unknown as NonNullable<typeof manager.taskRegistry>;
    listeners.get('agent/disposed')!({ agent: record.agent });
    expect(manager.getSessionRecord('c2c', PEER)).toBeUndefined();
    expect(manager.generation('c2c', PEER)).toBe(generation + 1);
    expect(tasks.forgetRoot).toHaveBeenCalledWith(record.agent);
    const restored = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(restored.sessionId).toBe(record.sessionId);
    expect(restored.agent).not.toBe(record.agent);
    // 旧实例晚到的重复事件不得清除新根。
    listeners.get('agent/disposed')!({ agent: record.agent });
    expect(manager.getSessionRecord('c2c', PEER)).toBe(restored);
  });

  it('create 迟到成功时释放旧句柄，reset 后新请求只创建新一代', async () => {
    const opening = deferred<DshAgentHandle>();
    const { registry } = createRegistry(async ({ resumeSessionId }) => { throw notFound(resumeSessionId); });
    registry.create.mockImplementationOnce(() => opening.promise);
    const manager = createManager(registry);
    const old = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const rejected = expect(old).rejects.toThrow(/已停止或重置/);
    await vi.waitFor(() => expect(registry.create).toHaveBeenCalledTimes(1));
    const resetting = manager.remove('c2c', PEER);
    const fresh = manager.getOrCreate('c2c', PEER, PEER, { ...REPLY, msgId: 'fresh' });
    const oldHandle = fakeHandle(createdIds(registry)[0]);
    opening.resolve(oldHandle);
    await Promise.all([rejected, resetting]);
    const record = await fresh;
    expect(oldHandle.dispose).toHaveBeenCalledOnce();
    expect(record.agent).not.toBe(oldHandle.agent);
    expect(record.replyTarget.msgId).toBe('fresh');
    expect(record.sessionId).toBe(persistedId());
  });

  it('/stop 主回复保留根实例和后台任务，不 drain；失效回调含原因', async () => {
    const drain = vi.fn(async () => {});
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, servicesCtx({ subagents: { drainDescendants: drain } }));
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const tasks = { hasActive: vi.fn(() => true), closeRoot: vi.fn() };
    manager.taskRegistry = tasks as unknown as NonNullable<typeof manager.taskRegistry>;
    const before = manager.generation('c2c', PEER);
    const listener = vi.fn();
    manager.onInvalidate(listener);
    const outcome = await manager.stop('c2c', PEER, 'main');
    expect(outcome.backgroundActive).toBe(true);
    expect(manager.getSessionRecord('c2c', PEER)).toBe(record);
    expect(manager.generation('c2c', PEER)).toBe(before + 1);
    expect(record.agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(drain).not.toHaveBeenCalled();
    expect(tasks.closeRoot).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(record, KEY, 'main');
  });

  it('/stop all 按 exact root drain → dispose，下一输入从同历史恢复新根', async () => {
    const draining = deferred<void>();
    const order: string[] = [];
    const drain = vi.fn(async () => { order.push('drain'); await draining.promise; });
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, servicesCtx({ subagents: { drainDescendants: drain } }));
    const old = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    vi.mocked(old.handle.dispose).mockImplementation(async () => { order.push('dispose'); });
    const tasks = { hasActive: vi.fn(() => true), closeRoot: vi.fn(() => { order.push('closed'); tasks.hasActive.mockReturnValue(false); }) };
    manager.taskRegistry = tasks as unknown as NonNullable<typeof manager.taskRegistry>;
    const stopping = manager.stop('c2c', PEER, 'all');
    const fresh = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await vi.waitFor(() => expect(drain).toHaveBeenCalledWith([old.agent]));
    expect(registry.resume).toHaveBeenCalledTimes(1);
    expect(old.handle.dispose).not.toHaveBeenCalled();
    draining.resolve();
    await stopping;
    const record = await fresh;
    expect(order).toEqual(['drain', 'dispose', 'closed']);
    expect(record.sessionId).toBe(old.sessionId);
    expect(record.agent).not.toBe(old.agent);
    expect(manager.findByAgent(old.agent)).toBeUndefined();
  });

  it('drain 失败不宣称成功，不复用关闭中的根；显式重试可恢复', async () => {
    const drain = vi.fn().mockRejectedValueOnce(new Error('drain failed')).mockResolvedValue(undefined);
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, servicesCtx({ subagents: { drainDescendants: drain } }));
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await expect(manager.stop('c2c', PEER, 'all')).rejects.toThrow('drain failed');
    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY)).rejects.toThrow('drain failed');
    expect(record.handle.dispose).not.toHaveBeenCalled();
    expect(persistedId()).toBe(record.sessionId);
    await manager.stop('c2c', PEER, 'all');
    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY)).resolves.toBeDefined();
  });

  it('registry 仍返回被释放的同一根时拒绝恢复，不能复用 drain 后的根', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManager(registry);
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    await manager.stop('c2c', PEER, 'all');
    registry.get.mockReturnValue(record.agent as never);
    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY)).rejects.toThrow(/尚未释放/);
  });

  it('借用 live agent 无 disposer 时可停主回复并切换新会话，但不能释放整树', async () => {
    const drain = vi.fn(async () => {});
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const agent = fakeAgent(LEGACY_ID);
    registry.get.mockReturnValue(agent as never);
    const manager = createManagerWithCtx(registry, servicesCtx({ subagents: { drainDescendants: drain } }));
    const old = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(old.ownsAgent).toBe(false);
    const dispose = vi.spyOn(old.handle, 'dispose');
    await expect(manager.stop('c2c', PEER, 'all')).rejects.toThrow(/\/new 切换新会话/);
    await manager.stop('c2c', PEER, 'main');
    expect(manager.getSessionRecord('c2c', PEER)).toBe(old);
    await expect(manager.remove('c2c', PEER)).resolves.toEqual({ detached: true, backgroundActive: false });
    expect(agent.cancel).toHaveBeenCalledTimes(2);
    expect(drain).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(manager.deliveryAddress(old.sessionId)).toBeUndefined();
    expect(manager.findByAgent(agent)).toBeUndefined();
    const fresh = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(fresh.sessionId).toBe(persistedId());
    expect(fresh.agent).not.toBe(agent);
    expect(fresh.ownsAgent).toBe(true);
  });

  it('借用根重置清理待决交互与旧输入，后台仅移交宿主而不伪称取消', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const agent = fakeAgent(LEGACY_ID);
    registry.get.mockReturnValue(agent as never);
    const manager = createManager(registry);
    const old = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const tasks = { hasActive: vi.fn(() => true), forgetRoot: vi.fn(), closeRoot: vi.fn() };
    manager.taskRegistry = tasks as unknown as NonNullable<typeof manager.taskRegistry>;
    const questions = { cancelPending: vi.fn() };
    const approvals = { cancelPending: vi.fn() };
    manager.questionChannel = questions as unknown as NonNullable<typeof manager.questionChannel>;
    manager.approvalChannel = approvals as unknown as NonNullable<typeof manager.approvalChannel>;
    const listener = vi.fn();
    manager.onInvalidate(listener);
    const generation = manager.generation('c2c', PEER);
    const release = manager.holdActivity('c2c', PEER, 'input', generation);

    await expect(manager.remove('c2c', PEER)).resolves.toEqual({ detached: true, backgroundActive: true });
    expect(listener).toHaveBeenCalledWith(old, KEY, 'reset');
    expect(questions.cancelPending).toHaveBeenCalledWith(KEY, old);
    expect(approvals.cancelPending).toHaveBeenCalledWith(KEY);
    expect(tasks.forgetRoot).toHaveBeenCalledWith(agent);
    expect(tasks.closeRoot).not.toHaveBeenCalled();
    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY, generation)).rejects.toThrow(/已停止或重置/);
    release();
    expect(manager.deliveryAddress(old.sessionId)).toBeUndefined();
  });

  it('借用根取消请求失败时不切换历史，重试重置可恢复', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const agent = fakeAgent(LEGACY_ID);
    registry.get.mockReturnValue(agent as never);
    const manager = createManager(registry);
    const old = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    vi.mocked(agent.cancel).mockImplementationOnce(() => { throw new Error('cancel failed'); });
    await expect(manager.remove('c2c', PEER)).rejects.toThrow('cancel failed');
    expect(persistedId()).toBe(old.sessionId);
    expect(manager.getSessionRecord('c2c', PEER)).toBe(old);
    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY)).rejects.toThrow('cancel failed');
    await expect(manager.remove('c2c', PEER)).resolves.toEqual({ detached: true, backgroundActive: false });
    expect(persistedId()).not.toBe(old.sessionId);
  });

  it('借用根 /new 与 /stop 并发时仍提交新 ID，等待中的输入不复用已解绑的旧根', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const agent = fakeAgent(LEGACY_ID);
    registry.get.mockReturnValue(agent as never);
    const manager = createManager(registry);
    const old = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const resetting = manager.remove('c2c', PEER);
    const stopping = manager.stop('c2c', PEER, 'main');
    const incoming = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const [reset, stop, next] = await Promise.allSettled([resetting, stopping, incoming]);
    expect(reset).toEqual({ status: 'fulfilled', value: { detached: true, backgroundActive: false } });
    expect(stop.status).toBe('fulfilled');
    expect(next.status).toBe('fulfilled');
    const fresh = await incoming;
    expect(fresh.agent).not.toBe(old.agent);
    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(fresh.sessionId).toBe(persistedId());
    expect(fresh.ownsAgent).toBe(true);
    expect(manager.deliveryAddress(old.sessionId)).toBeUndefined();
  });

  it('插件卸载等待在途 create 释放，迟到结果不能恢复会话', async () => {
    const opening = deferred<DshAgentHandle>();
    const { registry } = createRegistry(() => opening.promise);
    const manager = createManager(registry);
    const creating = manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const rejected = expect(creating).rejects.toThrow(/已停止或重置/);
    await vi.waitFor(() => expect(registry.resume).toHaveBeenCalled());
    const disposing = manager.disposeAll();
    const handle = fakeHandle(LEGACY_ID);
    opening.resolve(handle);
    await Promise.all([disposing, rejected]);
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(manager.size).toBe(0);
    await expect(manager.getOrCreate('c2c', PEER, PEER, REPLY)).rejects.toThrow(/已停止或重置/);
  });

  it('模型经过验证后原地 select，下步骤生效并保留根；无效选择不改偏好', async () => {
    const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text'] }));
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, servicesCtx({ llm: { resolveModelInfo } }));
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const select = vi.fn();
    Object.assign(record.agent, { model: { current: () => undefined, select } });
    expect(await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'next' })).toEqual({ mode: 'next-step' });
    expect(resolveModelInfo).toHaveBeenCalledWith('p', 'next');
    expect(select).toHaveBeenCalledWith({ provider: 'p', model: 'next' });
    expect(manager.getSessionRecord('c2c', PEER)).toBe(record);
    expect(record.handle.dispose).not.toHaveBeenCalled();
    resolveModelInfo.mockRejectedValueOnce(new Error('unknown model'));
    await expect(manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'bad' })).rejects.toThrow('unknown model');
    expect(manager.getEffectiveModel('c2c', PEER)).toEqual({ provider: 'p', model: 'next' });
    expect(select).toHaveBeenCalledOnce();
  });

  it('旧宿主保存下次新会话模型，不替换仍在运行的根', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, servicesCtx({ llm: { resolveModelInfo: async () => ({}) } }));
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    Object.assign(record.agent, { status: 'running', options: { provider: 'p', model: 'current' } });
    expect(await manager.setModelOverride('c2c', PEER, { provider: 'p', model: 'next' })).toEqual({ mode: 'next-session' });
    expect(manager.getEffectiveModel('c2c', PEER)).toEqual({ provider: 'p', model: 'current' });
    expect(manager.getSessionRecord('c2c', PEER)).toBe(record);
    expect(record.handle.dispose).not.toHaveBeenCalled();
    expect(record.agent.cancel).not.toHaveBeenCalled();
  });

  it('idle 回收同时核验输入、维护、问题、审批、收件箱、出站和后台活动', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, servicesCtx({}), createLogger(), { sessionIdleTimeout: 100 });
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const check = () => {
      record.lastActivity = Date.now() - 1000;
      (manager as unknown as { evictor: { check(): void } }).evictor.check();
    };
    for (const kind of ['input', 'maintenance', 'question', 'approval'] as const) {
      const release = manager.holdActivity('c2c', PEER, kind);
      check();
      expect(manager.size).toBe(1);
      expect(record.handle.dispose).not.toHaveBeenCalled();
      release();
    }
    Object.assign(record.agent, { inbox: { nextStep: [{}], nextTurn: [] } });
    check();
    expect(record.handle.dispose).not.toHaveBeenCalled();
    Object.assign(record.agent, { inbox: { nextStep: [], nextTurn: [] } });
    manager.hasTransportActivity = () => true;
    check();
    expect(record.handle.dispose).not.toHaveBeenCalled();
    manager.hasTransportActivity = () => false;
    const tasks = { hasActive: vi.fn(() => true), closeRoot: vi.fn() };
    manager.taskRegistry = tasks as unknown as NonNullable<typeof manager.taskRegistry>;
    check();
    expect(record.handle.dispose).not.toHaveBeenCalled();
    tasks.hasActive.mockReturnValue(false);
    check();
    await vi.waitFor(() => expect(manager.size).toBe(0));
    expect(record.handle.dispose).toHaveBeenCalledOnce();
  });

  it('宿主外部维护期间 status=idle 也不回收，真实空闲后再关闭', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, servicesCtx({}), createLogger(), { sessionIdleTimeout: 100 });
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const maintenance = deferred<void>();
    vi.mocked(record.agent.whenIdle).mockReturnValue(maintenance.promise);
    const check = () => (manager as unknown as { evictor: { check(): void } }).evictor.check();
    record.lastActivity = Date.now() - 1000;
    check();
    check();
    await Promise.resolve();
    expect(record.agent.whenIdle).toHaveBeenCalledOnce();
    expect(record.agent.cancel).not.toHaveBeenCalled();
    expect(manager.generation('c2c', PEER)).toBe(0);
    expect(record.handle.dispose).not.toHaveBeenCalled();
    maintenance.resolve();
    await vi.waitFor(() => expect(manager.size).toBe(0));
    expect(record.handle.dispose).toHaveBeenCalledOnce();
  });

  it('等待宿主空闲期间收到新输入，旧回收候选不能关闭更新后的会话', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, servicesCtx({}), createLogger(), { sessionIdleTimeout: 100 });
    const record = await manager.getOrCreate('c2c', PEER, PEER, REPLY);
    const maintenance = deferred<void>();
    vi.mocked(record.agent.whenIdle).mockReturnValue(maintenance.promise);
    record.lastActivity = Date.now() - 1000;
    (manager as unknown as { evictor: { check(): void } }).evictor.check();
    await manager.getOrCreate('c2c', PEER, PEER, { ...REPLY, msgId: 'new-message' });
    maintenance.resolve();
    await Promise.resolve();
    expect(record.agent.cancel).not.toHaveBeenCalled();
    expect(record.handle.dispose).not.toHaveBeenCalled();
    expect(manager.getSessionRecord('c2c', PEER)).toBe(record);
  });

  it('群停止/重置不能从最新发送者窃取主体，也不能关闭他人的任务', async () => {
    const { registry } = createRegistry(async ({ resumeSessionId }) => fakeHandle(resumeSessionId));
    const manager = createManagerWithCtx(registry, servicesCtx({}), createLogger(), {
      conversation: { mode: 'interactive', taskAdmins: ['admin'] } as ImQQBotConfig['conversation'],
    });
    const record = await manager.getOrCreate('group', 'group1', 'owner', { scope: 'group', targetId: 'group1' });
    Object.assign(record.agent, { status: 'running' });
    const tasks = {
      currentActor: vi.fn(() => 'owner'),
      list: vi.fn(() => [{ rootSessionId: record.sessionId, ownerId: 'another', settled: false, state: 'running' }]),
      hasActive: () => false, closeRoot: vi.fn(),
    };
    manager.taskRegistry = tasks as unknown as NonNullable<typeof manager.taskRegistry>;
    await manager.getOrCreate('group', 'group1', 'attacker', { scope: 'group', targetId: 'group1' });
    expect(record.senderId).toBe('attacker');
    expect(manager.canControl('group', 'group1', 'attacker', 'main')).toBe(false);
    expect(manager.canControl('group', 'group1', 'owner', 'main')).toBe(true);
    expect(manager.canControl('group', 'group1', 'owner', 'all')).toBe(false);
    expect(manager.canControl('group', 'group1', 'admin', 'all')).toBe(true);
    tasks.currentActor.mockReturnValue(undefined as unknown as string);
    expect(manager.canControl('group', 'group1', 'owner', 'main')).toBe(false);
  });
});
