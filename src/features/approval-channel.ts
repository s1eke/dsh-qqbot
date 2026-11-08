/**
 * ApprovalChannel — 把 dsh 的审批 seam（`approval/request` waterfall）桥接到 QQ。
 *
 * 接入方式：监听 `approval/request` waterfall，按 `request.agent.id` 路由到 QQ
 * 会话；非 QQ 会话委托链上其他 answerer（`next()`），多通道（Web/TUI）共存。
 *
 * 每个请求有独立 nonce；同一会话与后台子任务可同时等待审批。
 * outcome 沿用宿主协议，只提供「允许一次 / 拒绝」两个按钮。
 */
import type { EventOptions } from '@deepseek-ai/cordis';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { randomUUID } from 'node:crypto';
import type { ChatScope, Logger, ReplyTarget } from '../types.ts';
import { decodeButtonData } from './button-utils.ts';
import { buildApprovalKeyboard, buildApprovalText } from './approval-renderer.ts';
import type { DeliveryTargetResolver } from '../transport/turn-tracker.ts';
import type { TaskRegistry } from './task-registry.ts';

// ── 最小契约（对齐 dsh-user-approval，避免硬依赖） ──

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/** session log 中 tool/call 事件的最小结构（commandOf 回显命令用） */
interface ApprovalSessionEvent {
  type: string;
  data?: { callId?: unknown; arguments?: unknown; [key: string]: unknown };
}

export interface ApprovalRequest {
  agent: {
    id: string;
    /**
     * dsh-agent 的 `Agent.session` 在类型上是必选，但审批请求可能来自跨进程或
     * 投影后的上下文，运行时拿不到 live session（类型契约与运行时的 gap）。此时
     * 只是无法回显命令原文，不应让整个审批失败，故这里标为可选。
     */
    session?: { snapshotEvents?(): readonly ApprovalSessionEvent[] };
  };
  toolName: string;
  /** 关联的 tool/call 事件 id，用于从 session log 找回被 gate 的命令 */
  callId?: string;
  /** asker 的人类可读解释 */
  reason?: string;
  signal?: AbortSignal;
}

// ── 依赖接口（结构化，便于单测） ──

export interface ApprovalSessionRecordLike {
  sessionKey: string;
  scope: ChatScope;
  replyTarget: ReplyTarget;
  senderId?: string;
  generation?: number;
  agent?: { id: string };
}

export interface ApprovalChannelManagerLike {
  findBySessionId(sessionId: string): ApprovalSessionRecordLike | undefined;
  getSessionRecord(scope: ChatScope, peerId: string): ApprovalSessionRecordLike | undefined;
  taskRegistry?: TaskRegistry;
  holdActivity?(scope: ChatScope, peerId: string, kind: 'approval', generation?: number): () => void;
}

export interface ApprovalChannelSenderLike {
  sendMarkdown(target: ReplyTarget, content: string, opts?: { keyboard?: unknown }): Promise<unknown>;
}

/** 配置投影（审批按钮校验 allowlist 用） */
export interface ApprovalChannelConfigLike {
  conversation?: { mode?: 'serial' | 'interactive'; taskAdmins?: readonly string[] };
  access: {
    c2cMode: 'open' | 'allowlist' | 'disabled';
    c2cAllow: readonly string[];
    groupMode?: 'open' | 'allowlist' | 'disabled';
    groupAllow?: readonly string[];
  };
}

/** approval/request waterfall 的 answerer handler */
export interface ApprovalChannelContext {
  on(
    event: string,
    handler: (...args: unknown[]) => unknown,
    options?: EventOptions,
  ): () => boolean;
}

interface PendingApproval {
  record: ApprovalSessionRecordLike;
  target: ReplyTarget;
  request: ApprovalRequest;
  resolve: (outcome: ApprovalOutcome) => void;
  nonce: string;
  generation?: number;
  ownerId?: string;
  childRunId?: string;
  taskId?: string;
  onAbort?: () => void;
  release?: () => void;
}

const COMMAND_CLIP = 500;

/**
 * 从 session log 按 callId 找回被 gate 的命令（审批请求本身不重复携带 arguments）。
 * 对齐 TUI/web 的 `commandOf` 语义。
 */
function commandOf(req: ApprovalRequest): string | undefined {
  if (req.callId === undefined) return undefined;
  // 审批请求可能来自没有 live session 的上下文（例如跨进程/投影后的 Agent），
  // 此时只是拿不到命令原文，不能因此让整个审批失败。
  const events = req.agent.session?.snapshotEvents?.();
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.type !== 'tool/call') continue;
    const data = event.data;
    if (String(data?.callId) !== String(req.callId)) continue;
    const raw = data?.arguments;
    if (typeof raw !== 'string') return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
        const command = (parsed as { command?: unknown }).command;
        if (typeof command === 'string') return command;
      }
    } catch {
      // 非 JSON，回退到原始字符串
    }
    return raw.length <= COMMAND_CLIP ? raw : `${raw.slice(0, COMMAND_CLIP)}…`;
  }
  return undefined;
}

export class ApprovalChannel {
  private readonly pending = new Map<string, PendingApproval>();
  private disposeListener?: () => unknown;

  constructor(
    private readonly manager: ApprovalChannelManagerLike,
    private readonly sender: ApprovalChannelSenderLike,
    private readonly config: ApprovalChannelConfigLike,
    private readonly logger: Logger,
    private readonly targets?: DeliveryTargetResolver,
  ) {}

  install(ctx: ApprovalChannelContext): void {
    if (this.disposeListener) return;
    this.disposeListener = ctx.on('approval/request', (raw, next) => {
      const request = raw as ApprovalRequest;
      const direct = this.manager.findBySessionId(request.agent.id);
      const child = direct ? undefined : this.manager.taskRegistry?.resolveAgent(request.agent.id);
      const record = direct ?? child?.record;
      const target = direct
        ? (this.targets ? this.targets.targetFor(request.agent.id) : direct.replyTarget)
        : child?.record.replyTarget;
      if (!record || !target || (direct?.agent && direct.agent !== request.agent)) return (next as () => Promise<ApprovalOutcome>)();
      return this.park(record, target, request, child?.task.runId, child?.task.taskId, child?.ownerId);
    }, { global: true, prepend: true });
  }

  uninstall(): void {
    this.disposeListener?.();
    this.disposeListener = undefined;
    for (const entry of [...this.pending.values()]) this.settle(entry, 'cancelled');
  }

  cancelPending(sessionKey: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.record.sessionKey === sessionKey) this.settle(entry, 'cancelled');
    }
  }

  hasPending(sessionKey: string): boolean {
    return [...this.pending.values()].some(entry => entry.record.sessionKey === sessionKey);
  }

  listPending(scope: ChatScope, peerId: string, actor?: string): string {
    return [...this.pending.values()].filter(entry => entry.target.scope === scope && entry.target.targetId === peerId
      && this.authorized(entry, actor)).map(entry => `${entry.taskId ? `任务 ${entry.taskId}` : '当前对话'}：${entry.request.toolName} 等待审批，请使用对应审批卡片。`).join('\n');
  }

  handleInteraction(event: InteractionEvent): boolean {
    const raw = event.data?.resolved?.button_data;
    const button = raw ? decodeButtonData(raw) : undefined;
    if (!button || button.t !== 'approval' || !button.n) return false;
    const entry = this.pending.get(button.n);
    if (!entry) return false;
    const scope: ChatScope = event.group_openid ? 'group' : 'c2c';
    const peerId = event.group_openid ?? event.user_openid;
    const actor = event.group_member_openid ?? event.user_openid;
    if (!actor || scope !== entry.target.scope || peerId !== entry.target.targetId) return false;
    if (!this.authorized(entry, actor)) return false;
    this.settle(entry, button.d === 'allow' ? 'allowed-once' : 'rejected');
    return true;
  }

  private authorized(entry: PendingApproval, actor?: string): boolean {
    if (!actor) return false;
    const { scope, targetId: peerId } = entry.target;
    if (scope === 'group' && (this.config.access.groupMode === 'disabled'
      || (this.config.access.groupMode === 'allowlist' && !this.config.access.groupAllow?.includes(peerId)))) return false;
    if (scope === 'c2c' && (actor !== peerId || this.config.access.c2cMode === 'disabled'
      || (this.config.access.c2cMode === 'allowlist' && !this.config.access.c2cAllow.includes(actor)))) return false;
    const live = this.manager.getSessionRecord(scope, peerId);
    if (live !== entry.record || (!entry.childRunId && live.generation !== entry.generation)) return false;
    if (entry.childRunId) {
      const route = this.manager.taskRegistry?.resolveAgent(entry.request.agent.id);
      if (!route || route.record !== entry.record || route.task.runId !== entry.childRunId
        || !this.manager.taskRegistry?.canOperate(route.task, actor)) return false;
    } else if (scope === 'group') {
      if (actor !== entry.ownerId && !this.config.conversation?.taskAdmins?.includes(actor)) return false;
    }
    return true;
  }

  private park(record: ApprovalSessionRecordLike, target: ReplyTarget, request: ApprovalRequest,
    childRunId?: string, taskId?: string, ownerId?: string): Promise<ApprovalOutcome> {
    if (request.signal?.aborted) return Promise.resolve('cancelled');
    return new Promise(resolve => {
      const nonce = randomUUID().replaceAll('-', '');
      const entry: PendingApproval = {
        record, target: { ...target }, request, resolve, nonce, generation: record.generation,
        ownerId: ownerId ?? (target.scope === 'c2c' ? target.targetId
          : this.config.conversation?.mode === 'interactive' ? this.manager.taskRegistry?.actorFor(request.agent.id) : record.senderId),
        childRunId, taskId,
        release: this.manager.holdActivity?.(target.scope, target.targetId, 'approval', record.generation),
      };
      this.pending.set(nonce, entry);
      entry.onAbort = () => this.settle(entry, 'cancelled');
      request.signal?.addEventListener('abort', entry.onAbort, { once: true });
      const text = `${taskId ? `任务 ${taskId}\n\n` : ''}${buildApprovalText(request, commandOf(request))}`;
      void this.sender.sendMarkdown(target, text, { keyboard: buildApprovalKeyboard(nonce) }).catch(error => {
        this.logger.error(`QQ approval delivery failed: ${String(error)}`);
        this.settle(entry, 'unavailable');
      });
    });
  }

  private settle(entry: PendingApproval, outcome: ApprovalOutcome): void {
    if (!this.pending.delete(entry.nonce)) return;
    if (entry.onAbort) entry.request.signal?.removeEventListener('abort', entry.onAbort);
    entry.release?.();
    entry.resolve(outcome);
  }
}
