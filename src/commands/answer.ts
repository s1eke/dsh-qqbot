/** Explicit question answers never consume unrelated conversational input. */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer } from '../shared/scope.ts';
import { cacheMsgId } from '../transport/msgid-cache.ts';

export function answerCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'answer', category: 'agent', scope: 'all', description: '查看待答问题，或 /answer <请求编号> <答案>',
    handler: async (ctx) => {
      const channel = manager.questionChannel;
      if (!channel) return '当前宿主未启用 QQ 问答通道。';
      const { scope, peerId } = getScopePeer(ctx);
      if (!manager.getSessionRecord(scope, peerId)) {
        await manager.getOrCreate(scope, peerId, ctx.message.senderId,
          { scope, targetId: peerId, msgId: ctx.message.messageId });
      }
      const args = (ctx.command?.raw ?? '').trim();
      if (!args) return channel.listPending(scope, peerId, ctx.message.senderId);
      const match = /^(\S+)\s+([\s\S]+)$/.exec(args);
      if (!match) return '用法: /answer <请求编号> <答案>；发送 /answer 查看问题。';
      cacheMsgId(scope, peerId, ctx.message.messageId);
      return channel.answerText(scope, peerId, ctx.message.senderId, match[1]!, match[2]!).message;
    },
  };
}
