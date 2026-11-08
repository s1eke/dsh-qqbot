import { cacheMsgId } from "../transport/msgid-cache.js";
/** Read only platform-provided reply metadata, never message text. */
function quotedMessageId(message) {
    const value = message;
    const id = value.refMsgIdx ?? value.message_reference?.message_id ?? value.quoteMessageId ?? value.reference?.messageId;
    return typeof id === 'string' ? id : undefined;
}
export function questionAnswer(manager) {
    return async (ctx, next) => {
        const channel = manager.questionChannel;
        if (channel?.tryAnswer(ctx.replyTarget.scope, ctx.replyTarget.targetId, ctx.message.content.trim(), ctx.message.senderId, quotedMessageId(ctx.message))) {
            cacheMsgId(ctx.replyTarget.scope, ctx.replyTarget.targetId, ctx.replyTarget.msgId);
            ctx.stop('question-answer');
            return;
        }
        await next();
    };
}
//# sourceMappingURL=question-answer.js.map