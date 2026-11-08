import { randomUUID } from 'node:crypto';
import { decodeButtonData } from "./button-utils.js";
import { buildApprovalKeyboard, buildApprovalText } from "./approval-renderer.js";
const COMMAND_CLIP = 500;
/**
 * 从 session log 按 callId 找回被 gate 的命令（审批请求本身不重复携带 arguments）。
 * 对齐 TUI/web 的 `commandOf` 语义。
 */
function commandOf(req) {
    if (req.callId === undefined)
        return undefined;
    // 审批请求可能来自没有 live session 的上下文（例如跨进程/投影后的 Agent），
    // 此时只是拿不到命令原文，不能因此让整个审批失败。
    const events = req.agent.session?.snapshotEvents?.();
    if (!Array.isArray(events))
        return undefined;
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (!event || event.type !== 'tool/call')
            continue;
        const data = event.data;
        if (String(data?.callId) !== String(req.callId))
            continue;
        const raw = data?.arguments;
        if (typeof raw !== 'string')
            return undefined;
        try {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
                const command = parsed.command;
                if (typeof command === 'string')
                    return command;
            }
        }
        catch {
            // 非 JSON，回退到原始字符串
        }
        return raw.length <= COMMAND_CLIP ? raw : `${raw.slice(0, COMMAND_CLIP)}…`;
    }
    return undefined;
}
export class ApprovalChannel {
    manager;
    sender;
    config;
    logger;
    targets;
    pending = new Map();
    disposeListener;
    constructor(manager, sender, config, logger, targets) {
        this.manager = manager;
        this.sender = sender;
        this.config = config;
        this.logger = logger;
        this.targets = targets;
    }
    install(ctx) {
        if (this.disposeListener)
            return;
        this.disposeListener = ctx.on('approval/request', (raw, next) => {
            const request = raw;
            const direct = this.manager.findBySessionId(request.agent.id);
            const child = direct ? undefined : this.manager.taskRegistry?.resolveAgent(request.agent.id);
            const record = direct ?? child?.record;
            const target = direct
                ? (this.targets ? this.targets.targetFor(request.agent.id) : direct.replyTarget)
                : child?.record.replyTarget;
            if (!record || !target || (direct?.agent && direct.agent !== request.agent))
                return next();
            return this.park(record, target, request, child?.task.runId, child?.task.taskId, child?.ownerId);
        }, { global: true, prepend: true });
    }
    uninstall() {
        this.disposeListener?.();
        this.disposeListener = undefined;
        for (const entry of [...this.pending.values()])
            this.settle(entry, 'cancelled');
    }
    cancelPending(sessionKey) {
        for (const entry of [...this.pending.values()]) {
            if (entry.record.sessionKey === sessionKey)
                this.settle(entry, 'cancelled');
        }
    }
    hasPending(sessionKey) {
        return [...this.pending.values()].some(entry => entry.record.sessionKey === sessionKey);
    }
    listPending(scope, peerId, actor) {
        return [...this.pending.values()].filter(entry => entry.target.scope === scope && entry.target.targetId === peerId
            && this.authorized(entry, actor)).map(entry => `${entry.taskId ? `任务 ${entry.taskId}` : '当前对话'}：${entry.request.toolName} 等待审批，请使用对应审批卡片。`).join('\n');
    }
    handleInteraction(event) {
        const raw = event.data?.resolved?.button_data;
        const button = raw ? decodeButtonData(raw) : undefined;
        if (!button || button.t !== 'approval' || !button.n)
            return false;
        const entry = this.pending.get(button.n);
        if (!entry)
            return false;
        const scope = event.group_openid ? 'group' : 'c2c';
        const peerId = event.group_openid ?? event.user_openid;
        const actor = event.group_member_openid ?? event.user_openid;
        if (!actor || scope !== entry.target.scope || peerId !== entry.target.targetId)
            return false;
        if (!this.authorized(entry, actor))
            return false;
        this.settle(entry, button.d === 'allow' ? 'allowed-once' : 'rejected');
        return true;
    }
    authorized(entry, actor) {
        if (!actor)
            return false;
        const { scope, targetId: peerId } = entry.target;
        if (scope === 'group' && (this.config.access.groupMode === 'disabled'
            || (this.config.access.groupMode === 'allowlist' && !this.config.access.groupAllow?.includes(peerId))))
            return false;
        if (scope === 'c2c' && (actor !== peerId || this.config.access.c2cMode === 'disabled'
            || (this.config.access.c2cMode === 'allowlist' && !this.config.access.c2cAllow.includes(actor))))
            return false;
        const live = this.manager.getSessionRecord(scope, peerId);
        if (live !== entry.record || (!entry.childRunId && live.generation !== entry.generation))
            return false;
        if (entry.childRunId) {
            const route = this.manager.taskRegistry?.resolveAgent(entry.request.agent.id);
            if (!route || route.record !== entry.record || route.task.runId !== entry.childRunId
                || !this.manager.taskRegistry?.canOperate(route.task, actor))
                return false;
        }
        else if (scope === 'group') {
            if (actor !== entry.ownerId && !this.config.conversation?.taskAdmins?.includes(actor))
                return false;
        }
        return true;
    }
    park(record, target, request, childRunId, taskId, ownerId) {
        if (request.signal?.aborted)
            return Promise.resolve('cancelled');
        return new Promise(resolve => {
            const nonce = randomUUID().replaceAll('-', '');
            const entry = {
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
    settle(entry, outcome) {
        if (!this.pending.delete(entry.nonce))
            return;
        if (entry.onAbort)
            entry.request.signal?.removeEventListener('abort', entry.onAbort);
        entry.release?.();
        entry.resolve(outcome);
    }
}
//# sourceMappingURL=approval-channel.js.map