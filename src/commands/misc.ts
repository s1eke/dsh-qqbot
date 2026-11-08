/**
 * 杂项命令
 *
 * - /bot-ping /bot-version /bot-me：QQBot 插件特有（连通性测试、版本、身份）
 * - /stop：中止当前生成（对应底层 agent cancel，通用能力）
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, PLUGIN_VERSION, sendMarkdownChunked } from '../shared/index.ts';

/** /bot-ping — 测试当前 dsh 与 QQ 连接的网络延迟 */
export function pingCommand(): CategorizedCommand {
  return {
    name: 'bot-ping',
    category: 'qqbot',
    scope: 'all',
    description: '测试当前 dsh 与 QQ 连接的网络延迟',
    usage: [
      '/bot-ping',
      '',
      '测试 dsh 主机与 QQ 服务器之间的网络延迟。',
      '返回网络传输耗时和插件处理耗时。',
    ].join('\n'),
    handler: (ctx) => {
      const now = Date.now();
      const ts = ctx.message.timestamp;
      const eventTime = ts ? new Date(ts).getTime() : NaN;
      if (Number.isNaN(eventTime)) {
        return '✅ pong!';
      }
      const totalMs = now - eventTime;
      const qqToPlugin = ctx.receivedAt - eventTime;
      const pluginProcess = now - ctx.receivedAt;
      return [
        '✅ pong！',
        `⏱ 延迟: ${totalMs}ms`,
        `  ├ 网络传输: ${qqToPlugin}ms`,
        `  └ 插件处理: ${pluginProcess}ms`,
      ].join('\n');
    },
  };
}

/** /bot-version — 查看版本信息 */
export function versionCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-version',
    category: 'qqbot',
    scope: 'all',
    description: '查看版本信息',
    handler: () => {
      const current = manager.getEffectiveModel('c2c', '');
      const modelInfo = current ? `${current.provider}/${current.model}` : '宿主默认';
      return `dsh-qqbot v${PLUGIN_VERSION} | model: ${modelInfo}`;
    },
  };
}

/**
 * /bot-me — 查看发送者身份标识
 *
 * 私聊返回 user openid、群聊返回群成员 openid 与群 openid
 * （分别对应 access.c2cAllow / groupAllow 的名单 key）。
 */
export function meCommand({ config }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-me',
    category: 'qqbot',
    scope: 'all',
    description: '查看你的 OpenID',
    handler: async (cmdCtx) => {
      const senderId = cmdCtx.message.senderId ?? 'unknown';
      const lines = [`🆔 你的 OpenID：**${senderId}**`];
      if (cmdCtx.message.groupOpenid) {
        lines.push(`👥 本群 OpenID：**${cmdCtx.message.groupOpenid}**`);
      }
      await sendMarkdownChunked(cmdCtx, lines.join('\n'), config.textChunkLimit);
      return { kind: 'noop' as const };
    },
  };
}

/** /stop — 主回复停止；all 收束后台树并释放根，保留历史。 */
export function stopCommand({ manager }: CommandDeps): CategorizedCommand {
  return {
    name: 'stop',
    category: 'agent',
    scope: 'all',
    description: '停止主回复；/stop <任务ID> 停止指定任务；/stop all 停止全部',
    handler: async (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const arg = (cmdCtx.command?.raw ?? '').trim();
      if (arg && arg !== 'all' && arg !== 'main') {
        if (!manager.taskRegistry) return '当前宿主未启用后台任务控制。';
        const result = await manager.taskRegistry.interrupt(arg, { scope, peerId, senderId: cmdCtx.message.senderId });
        return result.message;
      }
      if (!manager.canControl(scope, peerId, cmdCtx.message.senderId, arg === 'all' ? 'all' : 'main')) {
        return '只有任务发起者或任务管理员可以停止这些工作。';
      }
      try {
        const result = await manager.stop(scope, peerId, arg === 'all' ? 'all' : 'main');
        if (result.mode === 'all') return result.stopped ? '已停止全部任务，保留对话历史。' : '当前没有运行中的任务。';
        const main = result.stopped ? '已请求停止主回复。' : '当前没有进行中的主回复。';
        return result.backgroundActive ? `${main}后台任务仍在运行，可用 /tasks 查看或 /stop all 全部停止。` : main;
      } catch (err) {
        return `停止未完成：${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
