/**
 * QQ 问答的文本渲染与按钮键盘构建（纯函数，便于单测）。
 *
 * 逐题渲染：一次只渲染一个问题（多题时由状态机逐题推进）。
 */
import type { InlineKeyboard } from '@tencent-connect/qqbot-nodejs';
import type { UserQuestion } from './question-channel.ts';
import { BUTTONS_PER_ROW, buttonLabel, encodeButtonData } from './button-utils.ts';

/**
 * 为「单选、带选项」的问题构建内联键盘；不适用时返回 undefined。
 *
 * 多行多列布局：每行 BUTTONS_PER_ROW 个按钮，减少选项多时的刷屏。
 *
 * 实际卡片同时编码调用 id、nonce、题目 id 和选项下标，隔离并发调用及旧题按钮。
 */
export function buildKeyboard(question: UserQuestion, request?: { callId: string; nonce: string }): InlineKeyboard | undefined {
  const opts = question.options ?? [];
  if (opts.length === 0 || question.multiSelect) return undefined;

  const rows: InlineKeyboard['content']['rows'] = [];
  for (let i = 0; i < opts.length; i += BUTTONS_PER_ROW) {
    rows.push({
      buttons: opts.slice(i, i + BUTTONS_PER_ROW).map((o, offset) => {
        const idx = i + offset;
        return {
          id: `q-${question.id}-opt-${idx}`,
          render_data: {
            label: buttonLabel(o.label),
            visited_label: '✓ 已选',
            style: 1,
          },
          action: {
            type: 1,
            permission: { type: 2 },
            click_limit: 1,
            data: encodeButtonData({ t: 'question', q: question.id, i: idx,
              ...(request ? { c: request.callId, n: request.nonce } : {}) }),
          },
          // 同一题的选项共享分组：点一个后其余变灰（单选互斥）
          group_id: `q-${question.id}`,
        };
      }),
    });
  }
  return { content: { rows } };
}

/** 把单个问题渲染成 QQ 文本 */
export function formatQuestion(
  question: UserQuestion,
  requireMentionHint: boolean,
  withButtons: boolean,
  requestId?: string,
): string {
  const lines: string[] = [];
  if (question.header) lines.push(`**${question.header}**`);

  const opts = question.options ?? [];
  const multi = question.multiSelect === true;

  // 问题行：多选标记前置，用户第一眼就知道作答方式
  lines.push(multi ? `${question.question}（可多选）` : question.question);
  if (question.detail) lines.push('', question.detail);

  // 选项列表：保留完整 label + description（按钮 label 截断时 description 靠正文展示）
  opts.forEach((o, i) => {
    lines.push(`${i + 1}. ${o.label}${o.description ? ` · ${o.description}` : ''}`);
  });

  // 底部引导：用引用块（>）与正文区分；mention 放在「回复」动作后（点按钮无需 @）
  if (requestId) {
    const mention = requireMentionHint ? '（需 @机器人）' : '';
    lines.push('', `> ${withButtons ? '点击按钮，或' : ''}使用 /answer ${requestId} <答案>${mention}`);
    if (multi) lines.push('> 多选可输入多个编号，例如 1,3。');
  } else if (opts.length > 0) {
    lines.push('');
    const mention = requireMentionHint ? '（需 @机器人）' : '';
    if (withButtons) {
      lines.push(`> 👇 点击下方按钮选择，或回复编号${mention}`);
    } else if (multi) {
      lines.push(`> 💡 回复多个编号即可多选（如 1,3）${mention}，或直接输入你的想法`);
    } else {
      lines.push(`> 💡 回复编号选择${mention}，或直接输入你的想法`);
    }
  }

  return lines.join('\n');
}
