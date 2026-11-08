import { describe, expect, it, vi } from 'vitest';
import type { MessageResponse, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { QuestionChannel, type UserQuestionResult } from '../features/question-channel.ts';
import type { SessionManager } from '../session/index.ts';
import { getCachedReplyIds } from '../transport/msgid-cache.ts';
import { questionAnswer } from './question-answer.ts';

/** Shapes below follow QQBot.sendMarkdown() and the SDK's normalized inbound message. */
function setup() {
  const agent = { id: 'root', session: {} };
  const record = { sessionKey: 'key', scope: 'c2c' as const, generation: 0, agent,
    replyTarget: { scope: 'c2c' as const, targetId: 'quote-owner', msgId: 'initial-input' } };
  const manager = {
    findBySessionId: (id: string) => id === agent.id ? record : undefined,
    getSessionRecord: (scope: string, peer: string) => scope === 'c2c' && peer === 'quote-owner' ? record : undefined,
    questionChannel: undefined as QuestionChannel | undefined,
  };
  const receipt: MessageResponse = { id: 'rest-message-id', timestamp: 1, ext_info: { ref_idx: 'qq-quote-index' } };
  const sender = { sendMarkdown: vi.fn(async () => receipt) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const channel = new QuestionChannel(manager, sender, { requireMention: false, askTimeoutMs: 0 }, logger);
  manager.questionChannel = channel;
  let request!: (...args: unknown[]) => unknown;
  channel.install({ get: () => undefined, on: (event, callback) => {
    if (event === 'user-questions/request') request = callback;
    return () => {};
  } });
  const pending = request({ agent, wait: { callId: 'question-call', timed: true },
    questions: [{ id: 'choice', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] }, () => {}) as Promise<UserQuestionResult>;
  void pending.catch(() => {});
  const context = (reference?: string, senderId = 'quote-owner') => ({
    message: { kind: 'c2c', content: '2', senderId, refMsgIdx: reference, messageId: 'answer-input' },
    replyTarget: { scope: 'c2c', targetId: 'quote-owner', msgId: 'answer-input' }, stop: vi.fn(),
  }) as unknown as MiddlewareContext;
  return { channel, pending, context, middleware: questionAnswer(manager as unknown as SessionManager) };
}

describe('question card references from the QQ SDK', () => {
  it.each(['qq-quote-index', 'rest-message-id'])('accepts the stored %s reference and leaves unrelated messages in ordinary admission', async (reference) => {
    const f = setup();
    try {
      await Promise.resolve();
      const next = vi.fn(async () => {});
      const ordinary = f.context();
      await f.middleware(ordinary, next);
      await f.middleware(f.context('unrelated-message'), next);
      await f.middleware(f.context(reference, 'different-user'), next);
      expect(next).toHaveBeenCalledTimes(3);
      expect(ordinary.stop).not.toHaveBeenCalled();
      const reply = f.context(reference);
      await f.middleware(reply, next);
      expect(reply.stop).toHaveBeenCalledExactlyOnceWith('question-answer');
      expect(next).toHaveBeenCalledTimes(3);
      expect(await f.pending).toEqual({ answers: [{ id: 'choice', selected: ['B'] }] });
      expect(getCachedReplyIds('c2c', 'quote-owner')).toContainEqual({ kind: 'msg', id: 'answer-input' });
    } finally { f.channel.uninstall(); }
  });
});
