/**
 * 状态命令：/bot-status（QQBot 特有）
 */
import type { CommandDeps, CategorizedCommand } from './types.ts';
import { getScopePeer, formatRelativeTime } from '../shared/index.ts';

/** /bot-status — 查看当前会话状态 */
export function statusCommand({ manager, config }: CommandDeps): CategorizedCommand {
  return {
    name: 'bot-status',
    category: 'qqbot',
    scope: 'all',
    description: '查看当前会话状态',
    handler: (cmdCtx) => {
      const { scope, peerId } = getScopePeer(cmdCtx);
      const status = manager.getStatus(scope, peerId);
      if (!status.active) return '当前无活跃会话';
      const modelInfo = status.model ? `${status.provider}/${status.model}` : '宿主默认';
      const record = manager.getSessionRecord(scope, peerId);
      const interactive = config.conversation?.mode === 'interactive';
      const background = record && manager.taskRegistry?.capabilityText(record.agent);
      return [
        '📊 会话状态',
        `会话: ${status.sessionId ? status.sessionId.slice(0, 8) : '—'}`,
        `模型: ${modelInfo}`,
        `Preset: ${status.preset ?? '无'}`,
        `对话模式: ${interactive ? 'interactive' : 'serial'}`,
        ...(interactive ? [
          `执行中补充: ${typeof record?.agent.steer === 'function' ? '可用（下一步骤读取）' : '宿主缺少 steer，请升级或切回 serial'}`,
          `后台委派: ${background ? '已检测到可见工具；/tasks 查看执行事实' : '当前 preset 未提供本地委派工具'}`,
          `模型原地切换: ${record?.agent.model?.select ? '可用' : '当前宿主仅保存新会话偏好'}`,
        ] : []),
        `消息数: ${status.messageCount ?? 0}`,
        `最后活动: ${formatRelativeTime(status.lastActivity)}`,
      ].join('\n');
    },
  };
}
