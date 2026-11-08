/** Only an explicit reply to a known question card bypasses ordinary admission. */
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { SessionManager } from '../session/index.ts';
import { cacheMsgId } from '../transport/msgid-cache.ts';

/** Read only platform-provided reply metadata, never message text. */
function quotedMessageId(message: object): string | undefined {
  const value = message as { refMsgIdx?: unknown; message_reference?: { message_id?: unknown }; quoteMessageId?: unknown; reference?: { messageId?: unknown } };
  const id = value.refMsgIdx ?? value.message_reference?.message_id ?? value.quoteMessageId ?? value.reference?.messageId;
  return typeof id === 'string' ? id : undefined;
}

export function questionAnswer(manager: SessionManager) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const channel = manager.questionChannel;
    if (channel?.tryAnswer(ctx.replyTarget.scope, ctx.replyTarget.targetId, ctx.message.content.trim(),
      ctx.message.senderId, quotedMessageId(ctx.message))) {
      cacheMsgId(ctx.replyTarget.scope, ctx.replyTarget.targetId, ctx.replyTarget.msgId);
      ctx.stop('question-answer');
      return;
    }
    await next();
  };
}
