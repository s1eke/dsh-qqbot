import { installQQPrompt, type QQPromptHandle } from '../prompt/install.ts';
/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * sessionKey → sessionId 的映射存于 prefs（`model-prefs.json`），新会话 id 由
 * `mintSessionId()` 铸造（`session-` + UUID，与宿主一致）。0.5.x 的 SHA-256 确定性
 * 派生 id 仅用于探测存量会话并迁移，不再用于新建——确定性 id 跨进程必然相同，
 * 两个进程各自新建会把同一 id 写入不同 project 目录。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { legacyDerivedSessionId, mintSessionId } from './session-id.ts';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import { createHostAdapter, type HostAdapter } from '../host/adapter.ts';
import { mkdirSync } from 'node:fs';
import { resolveAgentCwd } from '../shared/dirs.ts';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import type { ImQQBotConfig } from '../config.ts';
import { ModelResolver } from '../model/model-resolver.ts';
import type { ModelRoute, ModelEntry } from '../model/types.ts';
import { IdleEvictor } from './idle-evictor.ts';
import type { QuestionChannel } from '../features/question-channel.ts';
import type { ApprovalChannel } from '../features/approval-channel.ts';
import type { TaskRegistry } from '../features/task-registry.ts';
import type {
  SessionEventLike,
  DshAgent,
  DshAgentHandle,
  DshAgentRegistry,
  AgentPresetsLike,
  PresetComposition,
  PresetEntry,
  PresetSwitchOutcome,
  SessionRecord,
  SessionStatus,
  TokenUsageStats,
  CompactionServiceLike,
  CompactOutcome,
  StopOutcome,
  ResetOutcome,
  ModelSwitchOutcome,
} from './types.ts';

/** 预处理、恢复或创建晚于停止/重置完成时，拒绝旧输入而不是重新启动会话。 */
export class StaleSessionGenerationError extends Error {
  constructor(public readonly cleanupError?: unknown) {
    super('消息所属会话已停止或重置');
    this.name = 'StaleSessionGenerationError';
  }
}

type ActivityKind = 'input' | 'maintenance' | 'question' | 'approval';
type InvalidationReason = 'main' | 'all' | 'reset' | 'dispose' | 'evict';
type InvalidationListener = (record: SessionRecord | undefined, key: string, reason: InvalidationReason) => void;

/** ManualCompactionError 各 code 的友好提示 */
const COMPACTION_ERROR_HINTS: Record<string, string> = {
  busy: '压缩服务忙，请稍后重试',
  cancelled: '压缩已取消',
  changed: '历史在压缩过程中发生变化，请重试',
  commit: '压缩提交失败',
  persistence: '压缩完成但保存失败',
};

/** 复刻宿主 latestCompletedPrefixBoundary：最后一个 turn/end 起到下一 turn 开始前的边界 */
export function latestCompletedPrefixBoundary(events: readonly unknown[]): number | undefined {
  const list = events as Array<{ type?: string; seq?: number; surfaceOp?: string }>;
  let lastTurnEndSeq: number | undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const candidate = list[i];
    if (candidate?.type === 'turn/end') {
      lastTurnEndSeq = candidate.seq;
      break;
    }
  }
  if (lastTurnEndSeq === undefined) return undefined;
  let boundary = lastTurnEndSeq;
  for (const next of list.slice(boundary + 1)) {
    if (next.type === 'turn/start'
      || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced') break;
    if (next.seq !== undefined) boundary = next.seq;
  }
  return boundary;
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  /**
   * 同 key 正在进行的 getOrCreate（singleflight）。
   *
   * 斜杠命令与待答问题截获位于 concurrencyGuard 之前（见 gateway/middleware-setup），
   * 与普通消息不串行：同 key 并发进入会各自 resume/create，产出两个 agent，
   * 后写入 sessions 的覆盖前者且前者无人 dispose（泄漏）。
   */
  private inflight = new Map<string, { generation: number; task: Promise<SessionRecord>; controller: AbortController }>();
  private readonly generations = new Map<string, number>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly retiredAgents = new WeakSet<DshAgent>();
  private readonly evictionCandidates = new WeakSet<DshAgent>();
  private readonly activities = new Map<string, Map<symbol, ActivityKind>>();
  private readonly invalidateListeners = new Set<InvalidationListener>();
  private disposed = false;
  private disposeAgentListener?: () => void;
  private readonly evictor: IdleEvictor;
  private readonly modelResolver: ModelResolver;
  private readonly ctx: Context;
  private readonly host: HostAdapter;
  private readonly agents: DshAgentRegistry;
  private readonly config: ImQQBotConfig;
  private readonly logger: Logger;
  /** 由 bootstrap 注入的问答通道（ask_user_question → QQ），会话回收时清理其待答问题 */
  public questionChannel?: QuestionChannel;
  /** 由 bootstrap 注入的审批通道（approval/request → QQ），会话回收时清理其待批审批 */
  public approvalChannel?: ApprovalChannel;
  public taskRegistry?: TaskRegistry;
  public hasTransportActivity?: (record: SessionRecord) => boolean;

  constructor(
    ctx: Context,
    agents: DshAgentRegistry,
    config: ImQQBotConfig,
    logger: Logger,
  ) {
    this.ctx = ctx;
    this.agents = agents;
    this.config = config;
    this.logger = logger;
    this.host = createHostAdapter(ctx, logger);
    this.logger.info(`host adapter capabilities: ${this.host.capabilities.join(', ')}`);
    this.modelResolver = new ModelResolver(ctx, config, logger);

    this.evictor = new IdleEvictor(
      this.sessions,
      config.sessionIdleTimeout,
      (key, record) => this.evictWhenIdle(key, record),
      (key, record) => this.isBusy(key, record),
    );
    const bus = ctx as unknown as {
      on(name: string, listener: (event: { agent: DshAgent }) => void, options: { global: boolean }): unknown;
    };
    const disposeListener = bus.on('agent/disposed', ({ agent }) => this.onAgentDisposed(agent), { global: true });
    if (typeof disposeListener === 'function') this.disposeAgentListener = disposeListener as () => void;
  }

  /** Public idle status also covers native maintenance; whenIdle observes its actual completion. */
  private evictWhenIdle(key: string, record: SessionRecord): void {
    if (this.evictionCandidates.has(record.agent)) return;
    this.evictionCandidates.add(record.agent);
    const lastActivity = record.lastActivity;
    const generation = record.generation;
    void (async () => {
      await record.agent.whenIdle();
      if (this.disposed || this.sessions.get(key) !== record || record.generation !== generation
        || record.lastActivity !== lastActivity || this.isBusy(key, record)
        || Date.now() - record.lastActivity <= this.config.sessionIdleTimeout) return;
      this.logger.info(`evicting idle session: key=${key}`);
      this.invalidate(key, 'evict');
      if (record.ownsAgent === false) {
        this.releasePrompt(record.agent);
        this.sessions.delete(key);
        return;
      }
      await this.closeRecord(key, record);
    })().catch((err) => {
      this.logger.warn(`idle session close failed: key=${key} err=${errorText(err)}`);
    }).finally(() => this.evictionCandidates.delete(record.agent));
  }

  /** 宿主也可能关闭根；保留磁盘映射，但不能向已经释放的缓存实例提交新输入。 */
  private onAgentDisposed(agent: DshAgent): void {
    if (this.disposed) return;
    const record = this.findByAgent(agent);
    if (!record || this.closing.has(record.sessionKey)) return;
    this.invalidate(record.sessionKey, 'dispose');
    this.retiredAgents.add(agent);
    this.questionChannel?.cancelPending(record.sessionKey, record);
    this.approvalChannel?.cancelPending(record.sessionKey);
    this.taskRegistry?.forgetRoot(agent);
    this.releasePrompt(agent);
    this.sessions.delete(record.sessionKey);
  }

  /** 已装 prompt 的 agent → 句柄。释放时须同步 delete：live 复用的 agent 要能重装，否则 prompt 永久丢失。 */
  private readonly promptHandles = new WeakMap<DshAgent, QQPromptHandle>();

  /**
   * 在 agent.ctx 上安装 QQ prompt（幂等、fail-soft）：失败仅 warn，不打断会话建立。
   * TODO(split-2): personaCard / turnContext 由 inbound 接线，当前恒空。
   */
  private attachPrompt(agent: DshAgent, scope: ChatScope): void {
    if (this.promptHandles.has(agent)) return;
    if (!agent.ctx.get?.('systemPrompt')) return;
    try {
      this.promptHandles.set(agent, installQQPrompt(agent.ctx, {
        scope,
        personaCard: () => '',
        extraPrompts: () => ({ group: this.config.groupPrompt, direct: this.config.directPrompt }),
        conversationContext: () => this.config.conversation?.mode === 'interactive'
          ? this.taskRegistry?.capabilityText(agent) ?? '' : '',
      }));
    } catch (err) {
      this.logger.warn(`qq prompt install failed (session keeps working without it): ${errorText(err)}`);
    }
  }

  /** 释放 prompt 注册项；须在 handle.dispose() 之前（agent 销毁后 ctx 可能失效）。 */
  private releasePrompt(agent: DshAgent): void {
    const handle = this.promptHandles.get(agent);
    if (!handle) return;
    this.promptHandles.delete(agent);
    try {
      handle.dispose();
    } catch (err) {
      this.logger.warn(`qq prompt dispose failed: ${errorText(err)}`);
    }
  }

  /**
   * 动态获取 agentPresets 服务（可选，未注入时返回 undefined）
   */
  private getPresetsService(): AgentPresetsLike | undefined {
    try {
      return this.ctx.get('agentPresets') as AgentPresetsLike | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 从 session 持久化 header 读 session 当初的 preset（started 锁定语义）。
   * 读不到（服务缺失 / session 不存在 / 未记录 agentPreset）返回 undefined。
   */
  private async resolvePersistedPreset(sessionId: string): Promise<string | undefined> {
    return (await this.host.sessionHeader(sessionId))?.agentPreset;
  }

  // ── 模型相关（委托给 ModelResolver） ──

  getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute | undefined {
    const agent = this.getSessionRecord(scope, peerId)?.agent;
    const current = agent?.model?.current();
    if (current) return { provider: current.provider, model: current.model };
    if (agent?.options?.provider && agent.options.model) {
      return { provider: agent.options.provider, model: agent.options.model };
    }
    return this.modelResolver.getEffectiveRoute(this.sessionKey(scope, peerId));
  }

  /**
   * 获取指定 peer 的生效 preset（per-peer 覆盖 > config.preset）
   */
  getEffectivePreset(scope: ChatScope, peerId: string): string | undefined {
    return this.getEffectivePresetByKey(this.sessionKey(scope, peerId));
  }

  /** 按 sessionKey 解析生效 preset */
  private getEffectivePresetByKey(key: string): string | undefined {
    return this.modelResolver.getPreset(key) ?? this.config.preset;
  }

  /**
   * 列出所有可用 preset（/preset 命令用）
   */
  async listPresets(): Promise<PresetEntry[]> {
    const presets = this.getPresetsService();
    if (!presets) return [];
    try {
      const list = await presets.list();
      return list.map((p) => ({ id: p.id, name: p.name, description: p.description }));
    } catch (err) {
      this.logger.warn(`list presets failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * 新宿主原地选择下一步骤模型；旧宿主保存为下次会话默认。
   */
  async setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<ModelSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);
    const generation = this.generation(scope, peerId);
    await this.validateModel(route);
    this.assertCurrent(key, generation);
    const closing = this.closing.get(key);
    if (closing) await closing;
    this.assertCurrent(key, generation);
    const record = this.sessions.get(key);
    if (!record) {
      this.modelResolver.setOverride(key, route);
      this.logger.info(`model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
      return { mode: 'next-session' };
    }
    if (typeof record.agent.model?.select === 'function') {
      record.agent.model.select(route);
      this.modelResolver.setOverride(key, route);
      record.lastActivity = Date.now();
      return { mode: 'next-step' };
    }
    this.modelResolver.setOverride(key, route);
    this.logger.info(`model preference saved for new session (host lacks model.select): key=${key}`);
    return { mode: 'next-session' };
  }

  private async validateModel(route: ModelRoute): Promise<void> {
    const llm = this.host.globalService('llm') as {
      resolveModelInfo?: (provider: string, model: string) => Promise<{ inputModalities?: readonly string[]; outputModalities?: readonly string[] }>;
    } | undefined;
    if (typeof llm?.resolveModelInfo === 'function') {
      const model = await llm.resolveModelInfo(route.provider, route.model);
      if (model.inputModalities && !model.inputModalities.includes('text')) throw new Error('所选模型不支持文本输入');
      if (model.outputModalities && !model.outputModalities.includes('text')) throw new Error('所选模型不支持文本输出');
      return;
    }
    const models = await this.listAvailableModels();
    if (!models.some((model) => model.provider === route.provider && model.id === route.model)) {
      throw new Error(`无法验证模型 ${route.provider}/${route.model} 是否可用`);
    }
  }

  /**
   * 切换指定 peer 的 agent preset（per-peer 覆盖）
   *
   * 已开始的会话保持锁定（blank-session contract）：只持久化为新会话默认，
   * 不 fork/rebuild 当前会话，避免历史工具调用与新 preset 工具集冲突。
   */
  async setPresetOverride(scope: ChatScope, peerId: string, presetId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);

    // 1. 校验 preset 存在 + 可加载（broken 拒绝）
    const presets = this.getPresetsService();
    if (!presets) return { ok: false, reason: 'unavailable' };
    let resolved: { id: string; broken?: string };
    try {
      resolved = await presets.resolve(presetId);
    } catch (err) {
      return { ok: false, reason: 'unknown-preset', message: err instanceof Error ? err.message : String(err) };
    }
    if (resolved.broken !== undefined) {
      return { ok: false, reason: 'broken', message: resolved.broken };
    }

    // 2. 持久化 per-peer 覆盖（新会话生效）
    this.modelResolver.setPreset(key, presetId);

    const hasActive = this.sessions.has(key);
    this.logger.info(
      `preset pref saved: key=${key} → ${presetId}${hasActive ? ' (active session locked, next session applies)' : ''}`,
    );
    return { ok: true, presetId };
  }

  /**
   * 清除 per-peer preset 覆盖，回到 config.preset / 默认（新会话生效）
   */
  async clearPresetOverride(scope: ChatScope, peerId: string): Promise<PresetSwitchOutcome> {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearPreset(key);
    this.logger.info(`preset pref cleared: key=${key} (next session applies)`);
    return { ok: true };
  }

  clearModelOverride(scope: ChatScope, peerId: string): void {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearOverride(key);
    this.modelResolver.clearSessionId(key);
  }

  async listAvailableModels(): Promise<ModelEntry[]> {
    return this.modelResolver.listModels();
  }

  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  // ── 会话状态 / 统计 ──

  getSessionRecord(scope: ChatScope, peerId: string): SessionRecord | undefined {
    return this.sessions.get(this.sessionKey(scope, peerId));
  }

  getStatus(scope: ChatScope, peerId: string): SessionStatus {
    const record = this.getSessionRecord(scope, peerId);
    const route = this.getEffectiveModel(scope, peerId);

    return {
      active: !!record,
      sessionId: record?.sessionId,
      provider: route?.provider,
      model: route?.model,
      preset: record?.agentPreset,
      lastActivity: record?.lastActivity,
      messageCount: this.countMessages(record),
    };
  }

  getTokenUsage(scope: ChatScope, peerId: string): TokenUsageStats {
    const record = this.getSessionRecord(scope, peerId);
    const stats: TokenUsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    if (!record) return stats;

    const events = this.host.sessionEvents(record.agent.session) as readonly SessionEventLike[];
    if (!events) return stats;

    for (const event of events) {
      if (event.type !== 'assistant/message' || !event.usage) continue;
      stats.input += event.usage.input ?? 0;
      stats.output += event.usage.output ?? 0;
      stats.cacheRead += event.usage.cacheRead ?? 0;
      stats.cacheWrite += event.usage.cacheWrite ?? 0;
    }

    return stats;
  }

  exportMarkdown(scope: ChatScope, peerId: string): string {
    const record = this.getSessionRecord(scope, peerId);
    if (!record) return '';

    const events = this.host.sessionEvents(record.agent.session) as readonly SessionEventLike[];
    if (!events || events.length === 0) return '';

    const lines: string[] = [`# QQ 会话导出\n`, `> session: ${record.sessionId}\n`];

    for (const event of events) {
      if (event.type === 'user/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 用户\n\n${text}\n`);
      } else if (event.type === 'assistant/message') {
        const text = extractMessageText(event.message);
        if (text) lines.push(`## 助手\n\n${text}\n`);
      }
    }

    return lines.join('\n');
  }

  private countMessages(record: SessionRecord | undefined): number {
    if (!record) return 0;
    const events = this.host.sessionEvents(record.agent.session) as readonly SessionEventLike[];
    if (!events) return 0;

    let count = 0;
    for (const event of events) {
      if (event.type === 'user/message' || event.type === 'assistant/message') {
        count += 1;
      }
    }
    return count;
  }

  // ── Session 生命周期管理 ──

  private sessionKey(scope: ChatScope, peerId: string): string {
    return `qqbot:${this.config.appId}:${scope}:${peerId}`;
  }

  generation(scope: ChatScope, peerId: string): number {
    return this.generations.get(this.sessionKey(scope, peerId)) ?? 0;
  }

  isCurrent(scope: ChatScope, peerId: string, generation: number): boolean {
    return this.isCurrentKey(this.sessionKey(scope, peerId), generation);
  }

  private isCurrentKey(key: string, generation: number): boolean {
    return !this.disposed && (this.generations.get(key) ?? 0) === generation;
  }

  private assertCurrent(key: string, generation: number): void {
    if (!this.isCurrentKey(key, generation)) throw new StaleSessionGenerationError();
  }

  onInvalidate(listener: InvalidationListener): () => void {
    this.invalidateListeners.add(listener);
    return () => { this.invalidateListeners.delete(listener); };
  }

  private invalidate(key: string, reason: InvalidationReason): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    this.inflight.get(key)?.controller.abort(new StaleSessionGenerationError());
    const record = this.sessions.get(key);
    if (record) record.generation = next;
    for (const listener of this.invalidateListeners) {
      try { listener(record, key, reason); }
      catch (err) { this.logger.warn(`session invalidation listener failed: ${errorText(err)}`); }
    }
    return next;
  }

  /** 预处理、维护和交互等待显式保活。释放幂等，旧代释放不影响新代计数。 */
  holdActivity(scope: ChatScope, peerId: string, kind: ActivityKind, expectedGeneration = this.generation(scope, peerId)): () => void {
    const key = this.sessionKey(scope, peerId);
    this.assertCurrent(key, expectedGeneration);
    const token = Symbol(kind);
    const active = this.activities.get(key) ?? new Map<symbol, ActivityKind>();
    this.activities.set(key, active);
    active.set(token, kind);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active.delete(token);
      if (active.size === 0 && this.activities.get(key) === active) this.activities.delete(key);
      const record = this.sessions.get(key);
      if (record && this.isCurrentKey(key, expectedGeneration)) record.lastActivity = Date.now();
    };
  }

  private isBusy(key: string, record: SessionRecord): boolean {
    return this.closing.has(key)
      || record.agent.status !== 'idle'
      || (record.agent.inbox?.nextStep.length ?? 0) > 0
      || (record.agent.inbox?.nextTurn.length ?? 0) > 0
      || (this.activities.get(key)?.size ?? 0) > 0
      || this.hasTransportActivity?.(record) === true
      || this.taskRegistry?.hasActive(record.sessionId) === true;
  }

  /** prefs 命中沿用；miss 返回 0.5.x 派生候选，由 getOrCreate 按 resume 结果迁移或铸造 */
  private currentSessionId(sessionKey: string): string {
    return this.modelResolver.getSessionId(sessionKey) ?? legacyDerivedSessionId(sessionKey);
  }

  /** 候选命中后落盘，后续永远走 prefs */
  private persistSessionId(sessionKey: string, sessionId: string): void {
    if (this.modelResolver.getSessionId(sessionKey) !== sessionId) {
      this.modelResolver.setSessionId(sessionKey, sessionId);
    }
  }

  private async composePreset(presetId?: string): Promise<PresetComposition> {
    const presets = this.getPresetsService();
    if (!presets) return {};

    try {
      const resolved = await presets.resolve(presetId);
      const resolvedId = resolved.id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedId);
        },
      };
    } catch (err) {
      this.logger.warn(
        `im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`,
      );
      return {};
    }
  }

  /** 获取或恢复或创建会话（get → resume → create）；同 key 并发合并为一次 */
  async getOrCreate(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
    expectedGeneration = this.generation(scope, peerId),
  ): Promise<SessionRecord> {
    const key = this.sessionKey(scope, peerId);
    this.assertCurrent(key, expectedGeneration);
    const closing = this.closing.get(key);
    if (closing) await closing;
    this.assertCurrent(key, expectedGeneration);
    const existing = this.sessions.get(key);

    if (existing) {
      existing.replyTarget = replyTarget;
      existing.senderId = senderId;
      existing.lastActivity = Date.now();
      return existing;
    }

    // singleflight：同 key 并发复用同一次 resume/create，后到者只更新回复目标
    const pending = this.inflight.get(key);
    if (pending && pending.generation !== expectedGeneration) {
      await pending.task.catch(() => {});
      this.assertCurrent(key, expectedGeneration);
      return this.getOrCreate(scope, peerId, senderId, replyTarget, expectedGeneration);
    }
    if (pending?.generation === expectedGeneration) {
      const shared = await pending.task;
      this.assertCurrent(key, expectedGeneration);
      shared.replyTarget = replyTarget;
      shared.senderId = senderId;
      shared.lastActivity = Date.now();
      return shared;
    }

    const controller = new AbortController();
    const task = this.openSession(key, scope, peerId, senderId, replyTarget, expectedGeneration, controller.signal);
    const flight = { generation: expectedGeneration, task, controller };
    this.inflight.set(key, flight);
    try {
      return await task;
    } finally {
      if (this.inflight.get(key) === flight) this.inflight.delete(key);
    }
  }

  /** getOrCreate 的实际打开流程（已通过 singleflight 保证同 key 串行） */
  private async openSession(
    key: string,
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
    generation: number,
    signal: AbortSignal,
  ): Promise<SessionRecord> {
    const route = this.modelResolver.getEffectiveRoute(key);
    // prefs 命中 = 已知存量会话；miss 时取 0.5.x 派生 id 仅作存量探测候选，不用于新建
    const candidateIsLegacy = this.modelResolver.getSessionId(key) === undefined;
    let sessionId = SessionId(this.currentSessionId(key));
    this.logger.info(`getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    const live = this.agents.get(sessionId);
    if (live && this.retiredAgents.has(live)) throw new Error('旧会话实例尚未释放，暂时无法恢复');
    if (live?.id === sessionId) {
      agent = live;
      this.persistSessionId(key, sessionId);
      this.logger.info(`reusing live agent: key=${key}`);
    } else {
      // preset 只解析一次：resume/create 共用同一组合，避免重复 resolve/mount 目录。
      // 优先 session 当初的 preset（started 锁定语义），无则用当前 effective preset。
      const presetId = (await this.resolvePersistedPreset(sessionId)) ?? this.getEffectivePresetByKey(key);
      this.assertCurrent(key, generation);
      const composed = await this.composePreset(presetId);
      this.assertCurrent(key, generation);
      agentPreset = composed.agentPreset;
      try {
        const resumeRoute = this.modelResolver.getResumeRoute(key);
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          signal,
          ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        if (!this.isCurrentKey(key, generation)) {
          return this.disposeStale(resumed);
        }
        agent = resumed.agent;
        handle = resumed;
        // 0.5.x 迁移：候选命中老会话，沿用并落盘
        this.persistSessionId(key, sessionId);
        this.logger.info(`resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
      } catch (err) {
        if (err instanceof StaleSessionGenerationError) throw err;
        this.assertCurrent(key, generation);
        if (!(await this.mayCreateAfterResumeFailure(key, sessionId, err))) throw err;
        this.assertCurrent(key, generation);
        sessionId = this.resolveCreateId(key, sessionId, candidateIsLegacy);
        const created = await this.agents.create({
          sessionId,
          signal,
          meta: {
            cwd: this.workspaceDir(),
            ...(agentPreset ? { agentPreset } : {}),
          },
          ...(route ? { agentOptions: route } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        if (!this.isCurrentKey(key, generation)) {
          return this.disposeStale(created);
        }
        agent = created.agent;
        handle = created;
        this.persistSessionId(key, sessionId);
        this.logger.info(`created new session: key=${key} sessionId=${sessionId} preset=${agentPreset ?? 'none'}`);
      }
    }

    const record: SessionRecord = {
      sessionKey: key,
      generation,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      ownsAgent: handle !== undefined,
      replyTarget,
      scope,
      peerId,
      senderId,
      lastActivity: Date.now(),
      agentPreset,
    };

    this.attachPrompt(agent, scope);
    this.sessions.set(key, record);

    // 挂载到对应工作区（侧边栏可见性）；fail-soft、异步执行，不阻塞消息处理。
    // 宿主只在客户端 session.create RPC 时挂载会话，插件会话不走那条路径，
    // 闲置回收后会从侧边栏消失（详见 host/adapter.ts 的 attachSessionToWorkspace）。
    // cwd 必须与 meta.cwd 同源（workspaceDir()），否则 attachSession 的
    // header.cwd 校验（realpath 后须等于工作区 path）会失败。
    void this.host.attachSessionToWorkspace(sessionId, this.workspaceDir());

    return record;
  }

  /**
   * resume 失败后是否允许首次创建。
   *
   * 只有「会话确实不在盘上」才可创建：损坏/占用/后端故障沿用同一 id 重建，会把
   * 同一 sessionId 写进多个 project 目录，宿主 `list()` 随后报 duplicate，会话
   * 列表整体打不开（对齐宿主 `restoreOrCreateConfigured` 的 fail-loud 语义）。
   *
   * @returns 允许创建返回 true；拒绝时已记录 warn，调用方应抛出原 resume 错误。
   */
  private async mayCreateAfterResumeFailure(key: string, sessionId: string, resumeError: unknown): Promise<boolean> {
    const context = `key=${key} sessionId=${sessionId} resumeErr=${errorText(resumeError)}`;
    let exists: boolean | undefined;
    try {
      exists = await this.host.sessionExists(sessionId);
    } catch (probeError) {
      // 求证本身失败（持久化后端故障）：无法断言不在盘上，按存在处理
      this.logger.warn(`refusing to recreate session, existence unknown: ${context} probeErr=${errorText(probeError)}`);
      return false;
    }
    if (exists === true) {
      this.logger.warn(`refusing to recreate existing session: ${context}`);
      return false;
    }
    if (exists === undefined) {
      // 宿主无 sessionPersistence.stat：没有求证手段，只能按 resume 结果创建（= 修复前行为）
      this.logger.warn(`creating session without existence check (host lacks sessionPersistence.stat): ${context}`);
    }
    return true;
  }

  /**
   * 确认候选会话缺失后决定用哪个 id 新建。
   *
   * - resume 等待期间 prefs 被并发改写（`/new` 换新会话）：采用 prefs 的最新 id，
   *   否则内存与 prefs 指向不同会话，重启后用户被切走；
   * - 候选来自 0.5.x 确定性派生：一律铸造新 id，确定性 id 不进入新建路径；
   * - 候选来自 prefs 且确认缺失：沿用该 id 新建，prefs 无需改写。
   */
  private resolveCreateId(key: string, candidate: SessionId, candidateIsLegacy: boolean): SessionId {
    const latest = this.modelResolver.getSessionId(key);
    if (latest !== undefined && latest !== candidate) {
      this.logger.info(`adopting concurrently written session id: key=${key} sessionId=${latest}`);
      return SessionId(latest);
    }
    if (candidateIsLegacy) {
      const minted = SessionId(mintSessionId());
      this.logger.info(`migrated to minted session id: key=${key} sessionId=${minted}`);
      return minted;
    }
    return candidate;
  }

  findBySessionId(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return undefined;
  }

  /**
   * 这条 session 对应的 QQ 地址。只读：不把宿主里的 agent 收进会话表，也不拥有它的生命周期。
   * 内存里有记录时沿用它的 replyTarget（含 msgId）；否则按 prefs 的 sessionId 反查对端。
   */
  deliveryAddress(sessionId: string): ReplyTarget | undefined {
    const existing = this.findBySessionId(sessionId);
    if (existing) return existing.replyTarget;

    const key = this.modelResolver.findSessionKey(sessionId);
    if (key === undefined || this.sessions.has(key)) return undefined;
    const parsed = this.parseSessionKey(key);
    if (parsed === undefined) return undefined;
    return { scope: parsed.scope, targetId: parsed.peerId };
  }

  /** `qqbot:${appId}:${scope}:${peerId}` → scope + peer。只认本机器人的 key。 */
  private parseSessionKey(key: string): { scope: ChatScope; peerId: string } | undefined {
    const match = /^qqbot:([^:]+):(c2c|group):(.+)$/.exec(key);
    if (match === null || match[1] !== this.config.appId) return undefined;
    const scope = match[2];
    const peerId = match[3];
    if ((scope !== 'c2c' && scope !== 'group') || peerId === undefined || peerId === '') return undefined;
    return { scope, peerId };
  }

  findByAgent(agent: DshAgent): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record;
    }
    return undefined;
  }

  /** 群控制使用已领取步骤的权限主体；最新网络发送者不能接管别人正在执行的任务。 */
  canControl(scope: ChatScope, peerId: string, senderId: string, mode: 'main' | 'all'): boolean {
    if (scope === 'c2c') return senderId === peerId;
    if (!senderId) return false;
    if (this.config.conversation?.taskAdmins?.includes(senderId)) return true;
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return !this.inflight.has(key) && !this.activities.has(key);
    const activeMain = record.agent.status !== 'idle'
      || (record.agent.inbox?.nextStep.length ?? 0) > 0
      || (record.agent.inbox?.nextTurn.length ?? 0) > 0;
    if (activeMain && this.taskRegistry?.currentActor(record.sessionId) !== senderId) return false;
    if (mode === 'all') {
      const tasks = this.taskRegistry?.list(scope, peerId) ?? [];
      if (tasks.some((task) => task.rootSessionId === record.sessionId
        && (!task.settled || task.state === 'unknown') && task.ownerId !== senderId)) return false;
    }
    return true;
  }

  async remove(scope: ChatScope, peerId: string): Promise<ResetOutcome> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    const detached = record?.ownsAgent === false;
    const backgroundActive = detached && this.taskRegistry?.hasActive(record.sessionId) === true;
    this.invalidate(key, 'reset');
    await this.closeRecord(key, record, { reset: true });
    this.logger.info(`session removed: key=${key}`);
    return { detached, backgroundActive };
  }

  /** 主回合停止保留后台树；全部停止释放根实例，下次从原历史恢复。 */
  async stop(scope: ChatScope, peerId: string, mode: 'main' | 'all' = 'main'): Promise<StopOutcome> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (mode === 'all') this.assertOwned(record);
    const hadInput = this.inflight.has(key) || (this.activities.get(key)?.size ?? 0) > 0;
    const stopped = hadInput || !!record && (mode === 'all' || record.agent.status !== 'idle'
      || (record.agent.inbox?.nextStep.length ?? 0) > 0 || (record.agent.inbox?.nextTurn.length ?? 0) > 0);
    this.invalidate(key, mode);
    if (mode === 'all') {
      await this.closeRecord(key, record);
    } else if (record) {
      this.questionChannel?.cancelPending(key, record);
      record.agent.cancel({ kind: 'user' });
      record.lastActivity = Date.now();
    }
    return { stopped, mode, backgroundActive: !!record && this.taskRegistry?.hasActive(record.sessionId) === true };
  }

  private assertOwned(record: SessionRecord | undefined): void {
    if (record?.ownsAgent === false) {
      throw new Error('当前会话由宿主持有，插件无法释放整个会话；可用 /stop 停止主回复、/new 切换新会话，或在宿主关闭旧会话');
    }
  }

  private async disposeStale(handle: DshAgentHandle): Promise<never> {
    this.retiredAgents.add(handle.agent);
    try { await handle.dispose(); }
    catch (err) {
      this.logger.error(`stale session cleanup failed: sessionId=${handle.agent.id} err=${errorText(err)}`);
      throw new StaleSessionGenerationError(err);
    }
    throw new StaleSessionGenerationError();
  }

  private async settleOpening(task: Promise<SessionRecord>): Promise<void> {
    try { await task; }
    catch (err) {
      if (err instanceof StaleSessionGenerationError && err.cleanupError !== undefined) throw err.cleanupError;
    }
  }

  /** 关闭屏障覆盖释放/解绑及新 ID 提交；失败保留屏障，防止复用已经关闭接入的根。 */
  private closeRecord(key: string, record: SessionRecord | undefined, options: { reset?: boolean } = {}): Promise<void> {
    const previous = this.closing.get(key);
    const opening = this.inflight.get(key)?.task;
    // 先发布屏障再触发 cancel/dispose；宿主生命周期监听器可能同步回调。
    const task = Promise.resolve().then(async () => {
      if (previous) await previous.catch(() => {});
      if (opening) await this.settleOpening(opening);
      if (!record || this.sessions.get(key) !== record) return;
      const detachBorrowed = record.ownsAgent === false && options.reset === true;
      if (!detachBorrowed) this.assertOwned(record);
      this.questionChannel?.cancelPending(key, record);
      this.approvalChannel?.cancelPending(key);
      record.agent.cancel({ kind: 'user' });
      if (detachBorrowed) {
        // /new 只需切换 QQ 关联。宿主仍持有旧根，不能 drain 封死它的后代接入，
        // 也不能把请求取消主回复说成整树已结束；迟到输出由 reset 失效通知拦截。
        this.taskRegistry?.forgetRoot(record.agent);
        this.releasePrompt(record.agent);
        this.sessions.delete(key);
        this.activities.delete(key);
        return;
      }
      const subagents = this.host.globalService('subagents') as {
        drainDescendants?: (roots: readonly DshAgent[]) => Promise<void>;
      } | undefined;
      if (typeof subagents?.drainDescendants === 'function') {
        // drain 会永久关闭这个确切根的后代接入；即使 drain 失败也不可复用。
        this.retiredAgents.add(record.agent);
        await subagents.drainDescendants([record.agent]);
      } else if (this.taskRegistry?.hasActive(record.sessionId)) {
        throw new Error('当前宿主无法收束后台任务，未释放会话');
      }
      this.retiredAgents.add(record.agent);
      this.releasePrompt(record.agent);
      await record.handle.dispose();
      this.taskRegistry?.closeRoot(record.sessionId, record.agent);
      if (this.sessions.get(key) === record) this.sessions.delete(key);
      this.activities.delete(key);
    }).then(() => {
      // 接受的重置必须完成 ID 切换。并发 /stop 可使旧输入失效，但不能让已解绑
      // 的宿主根因旧 ID 残留再次被复用；并发重置由 previous 屏障依次提交。
      if (options.reset) this.modelResolver.setSessionId(key, mintSessionId());
    });
    this.closing.set(key, task);
    // 仅成功时撤销屏障；失败继续拒绝输入，显式重试 stop all/new 才重试关闭。
    void task.then(() => {
      if (this.closing.get(key) === task) this.closing.delete(key);
    }, () => {});
    return task;
  }

  /** Agent 工作目录：显式配置优先，缺省独立目录 ~/.dsh-qqbot/workspace（不随宿主进程 cwd） */
  private workspaceCache: string | undefined;
  private workspaceDir(): string {
    if (this.workspaceCache) return this.workspaceCache;
    const dir = resolveAgentCwd(this.config.cwd);
    mkdirSync(dir, { recursive: true });
    this.workspaceCache = dir;
    return dir;
  }

  /**
   * 原地压缩当前会话历史（保留 sessionId，用摘要替换旧历史）。
   *
   * compaction 是 preset 作用域服务，经 host adapter 从会话 preset 解析，
   * 全局注册的部署再兜底。这是「压缩上下文」的语义，区别于 remove() 的「换新会话」。
   */
  async compact(
    scope: ChatScope,
    peerId: string,
    revive?: { senderId: string; replyTarget: ReplyTarget },
  ): Promise<CompactOutcome> {
    const key = this.sessionKey(scope, peerId);
    let record = this.sessions.get(key);
    if (!record) {
      // 无活跃会话（重启/闲置回收）时从磁盘拉起，历史在磁盘上仍可压缩
      if (!revive) return { ok: false, reason: 'no-session' };
      record = await this.getOrCreate(scope, peerId, revive.senderId, revive.replyTarget);
    }
    if (record.agent.status !== 'idle') return { ok: false, reason: 'busy' };
    const generation = this.generation(scope, peerId);
    if (this.closing.has(key) || (this.activities.get(key)?.size ?? 0) > 0) return { ok: false, reason: 'busy' };
    const release = this.holdActivity(scope, peerId, 'maintenance', generation);
    try {
      const compaction = (await this.host.serviceFor(record.agent, 'compaction')
        ?? this.host.globalService('compaction')) as CompactionServiceLike | undefined;
      this.assertCurrent(key, generation);
      if (!compaction) return { ok: false, reason: 'unavailable' };

      const route = this.modelResolver.getEffectiveRoute(key);
      const agentCtx = {
        session: record.agent.session,
        options: { provider: route?.provider, model: route?.model },
        runMaintenance: record.agent.runMaintenance.bind(record.agent),
      };

      const result = await compaction.compactNow(agentCtx, new AbortController().signal);
      if (result === null) return { ok: true, shadowed: 0, tokens: 0 };
      return { ok: true, shadowed: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      // summary = 摘要没有更小 = 历史不足以压缩，属正常结果而非失败
      if (code === 'summary') {
        return { ok: true, shadowed: 0, tokens: 0 };
      }
      // 其他 ManualCompactionError 预期失败，给友好文案（debug 记录，不 warn 刷屏）
      if (code !== undefined && code in COMPACTION_ERROR_HINTS) {
        this.logger.debug(`compact declined: key=${key} code=${code}`);
        return { ok: false, reason: 'failed', message: COMPACTION_ERROR_HINTS[code] };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`compact failed: key=${key} err=${message}`);
      return { ok: false, reason: 'failed', message };
    } finally {
      release();
    }
  }

  async disposeAll(): Promise<void> {
    this.evictor.dispose();
    if (this.disposed) return;
    this.disposeAgentListener?.();
    this.disposeAgentListener = undefined;
    const records = [...this.sessions.values()];
    const opening = [...this.inflight.values()].map(({ task }) => this.settleOpening(task));
    for (const key of new Set([...this.sessions.keys(), ...this.inflight.keys(), ...this.activities.keys()])) {
      this.invalidate(key, 'dispose');
    }
    this.disposed = true;
    const results = await Promise.allSettled([...opening, ...records.map(async (record) => {
      if (record.ownsAgent === false) {
        this.questionChannel?.cancelPending(record.sessionKey, record);
        this.approvalChannel?.cancelPending(record.sessionKey);
        this.releasePrompt(record.agent);
        this.sessions.delete(record.sessionKey);
        return;
      }
      await this.closeRecord(record.sessionKey, record);
    })]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    this.logger.info(`all sessions disposed (count=${records.length})`);
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** 错误文案（日志用） */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 从消息对象中提取纯文本（用于导出/统计） */
function extractMessageText(
  message: SessionEventLike['message'],
): string {
  const blocks = message?.content;
  if (!blocks || !Array.isArray(blocks)) return '';

  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}
