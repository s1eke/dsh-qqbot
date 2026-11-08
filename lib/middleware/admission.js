import { conversationConfig } from "../config.js";
export function admissionTicket(ctx) {
    return ctx.state.qqAdmission;
}
/** Ordered, bounded admission only. Control middleware runs before this queue. */
export function interactiveAdmission(config, manager) {
    const queues = new Map();
    manager.onInvalidate?.((_record, key) => {
        for (const controller of queues.get(key)?.tickets ?? [])
            controller.abort(new Error('消息已随会话操作取消'));
    });
    const settings = conversationConfig(config);
    return async (ctx, next) => {
        const scope = ctx.message.kind === 'group' ? 'group' : 'c2c';
        const peerId = scope === 'group' ? (ctx.message.groupOpenid ?? ctx.message.senderId) : ctx.message.senderId;
        const key = `qqbot:${config.appId}:${scope}:${peerId}`;
        let queue = queues.get(key);
        if (!queue) {
            queue = { tail: Promise.resolve(), count: 0, tickets: new Set() };
            queues.set(key, queue);
        }
        if (queue.count >= Math.max(1, config.maxQueue)) {
            await ctx.bot.sendMarkdown(ctx.replyTarget, '消息接入队列已满，请稍后重试；停止和查询命令仍可使用。');
            return;
        }
        const generation = manager.generation(scope, peerId);
        const controller = new AbortController();
        queue.tickets.add(controller);
        ctx.state.qqAdmission = { generation, signal: controller.signal, receivedAt: Date.now() };
        const releaseActivity = manager.holdActivity(scope, peerId, 'input', generation);
        const predecessor = queue.tail;
        let finish;
        queue.tail = new Promise(resolve => { finish = resolve; });
        queue.count++;
        let timer;
        const expired = new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
            timer = setTimeout(() => {
                controller.abort(new Error('消息接入超时，请重试。'));
            }, settings.admissionTimeoutMs);
            timer.unref?.();
        });
        try {
            await Promise.race([predecessor, expired]);
            if (!manager.isCurrent(scope, peerId, generation))
                return;
            await Promise.race([next(), expired]);
        }
        catch (err) {
            // Never let a late download/create commit after the admission deadline.
            controller.abort(err);
            if (manager.isCurrent(scope, peerId, generation)) {
                await ctx.bot.sendMarkdown(ctx.replyTarget, controller.signal.reason instanceof Error
                    ? `⚠️ ${controller.signal.reason.message}` : '⚠️ 消息接入失败，请重试。');
            }
        }
        finally {
            clearTimeout(timer);
            releaseActivity();
            queue.tickets.delete(controller);
            // Preserve predecessor order even when a waiting ticket expires first.
            void predecessor.finally(finish);
            queue.count--;
            if (queue.count === 0 && queues.get(key) === queue)
                queues.delete(key);
        }
    };
}
//# sourceMappingURL=admission.js.map