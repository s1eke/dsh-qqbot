/**
 * QQ 入站登记。
 *
 * followup 进去的 user 消息和桌面输入都是 kind=user，靠 source 区分不开。
 * 宿主契约保证 Message.id 跨所有表示边界保持不变（dsh-llm `Message.id`），
 * 所以入站时登记本插件铸造的消息 id，出站在 user/message 上按 id 认领。
 *
 * - 查询不消费：同一条消息可能被事件重放重复读取；
 * - 正常释放由回合结束驱动（TurnTracker.end → release）；
 * - TTL 与条数上限只是兜底，防止丢失 turn/end 时无界增长。
 */
/** 兜底 TTL 下限：至少覆盖一次默认处理超时 */
const MIN_TTL_MS = 30 * 60 * 1000;
/** TTL 相对处理超时的倍数：排队 + 处理都要覆盖到 */
const TTL_PROCESSING_FACTOR = 2;
const DEFAULT_MAX_ENTRIES = 4096;
/** 按处理超时推导兜底 TTL：排队等待 + 一次完整处理都不应让登记过期 */
export function inputOriginTtlMs(processingTimeoutMs) {
    const derived = Number.isFinite(processingTimeoutMs) ? processingTimeoutMs * TTL_PROCESSING_FACTOR : 0;
    return Math.max(MIN_TTL_MS, derived);
}
export class QqInputRegistry {
    entries = new Map();
    ttlMs;
    maxEntries;
    now;
    constructor(options = {}) {
        this.ttlMs = options.ttlMs ?? MIN_TTL_MS;
        this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
        this.now = options.now ?? Date.now;
    }
    /** 登记一条本插件入站的消息 id */
    register(messageId, input) {
        this.prune();
        if (input && this.entries.size >= this.maxEntries)
            throw new Error('QQ 输入登记已满，请稍后重试');
        this.entries.delete(messageId);
        this.entries.set(messageId, { expiresAt: this.now() + this.ttlMs, sessionId: input?.sessionId,
            bytes: input?.bytes ?? 0, pending: !!input, pinned: !!input });
        this.evictOverflow();
    }
    /** 是否为本插件登记过且未过期的消息。不删除登记。 */
    has(messageId) {
        if (!messageId)
            return false;
        const entry = this.entries.get(messageId);
        if (entry === undefined)
            return false;
        if (entry.pinned || entry.expiresAt > this.now())
            return true;
        this.entries.delete(messageId);
        return false;
    }
    /** 回合结束后释放登记 */
    release(messageId) {
        this.entries.delete(messageId);
    }
    canAccept(sessionId, bytes, maxCount, maxBytes) {
        let count = 0;
        let size = bytes;
        for (const entry of this.entries.values()) {
            if (entry.sessionId !== sessionId || !entry.pending)
                continue;
            count++;
            size += entry.bytes;
        }
        return count < maxCount && size <= maxBytes;
    }
    claimed(messageId, turn) {
        const entry = this.entries.get(messageId);
        if (!entry)
            return;
        entry.pending = false;
        entry.turn = turn;
    }
    /** Includes claimed inputs rejected before user/message was committed. */
    releaseTurn(sessionId, turn) {
        for (const [id, entry] of this.entries) {
            if (entry.sessionId === sessionId && entry.turn === turn)
                this.entries.delete(id);
        }
    }
    releaseSession(sessionId) {
        for (const [id, entry] of this.entries) {
            if (entry.sessionId === sessionId)
                this.entries.delete(id);
        }
    }
    hasSession(sessionId) {
        return [...this.entries.values()].some(entry => entry.sessionId === sessionId);
    }
    get size() {
        return this.entries.size;
    }
    prune() {
        const now = this.now();
        for (const [id, entry] of this.entries) {
            if (!entry.pinned && entry.expiresAt <= now)
                this.entries.delete(id);
        }
    }
    evictOverflow() {
        while (this.entries.size > this.maxEntries) {
            const oldest = [...this.entries].find(([, entry]) => !entry.pinned)?.[0];
            if (oldest === undefined)
                return;
            this.entries.delete(oldest);
        }
    }
}
//# sourceMappingURL=qq-input-origin.js.map