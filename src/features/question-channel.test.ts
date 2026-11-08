import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { QuestionChannel, type UserQuestionRequest, type UserQuestionResult, type QuestionChannelContext } from './question-channel.ts';
import { buildKeyboard, formatQuestion } from './question-renderer.ts';
import { parseAnswer } from './answer-parser.ts';
import { decodeButtonData } from './button-utils.ts';
import type { TaskRecord } from './task-registry.ts';

const question = (id = 'q') => ({ id, question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] });
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
function setup(group = false, interactive = false) {
  const scope = group ? 'group' as const : 'c2c' as const;
  const peer = group ? 'group1' : 'user1';
  const agent = { id: 'root', session: {} };
  const record = { sessionKey: 'key', scope, senderId: 'user1', generation: 1, agent,
    replyTarget: { scope, targetId: peer, msgId: 'm1' } };
  const manager = {
    findBySessionId: vi.fn((id: string) => id === 'root' ? record : undefined),
    getSessionRecord: vi.fn((s: string, p: string) => s === scope && p === peer ? record : undefined),
    holdActivity: vi.fn(() => vi.fn()),
    taskRegistry: { actorFor: vi.fn((): string | undefined => 'trusted-owner'), noteQuestionAnswer: vi.fn(() => vi.fn()),
      noteQuestionOpenAnswer: vi.fn(() => vi.fn()),
      get: vi.fn((_id: string, _scope: string, _peer: string): TaskRecord | undefined => undefined) },
  };
  const sender = { sendMarkdown: vi.fn(async (..._args: unknown[]) => ({ id: 'card1' })) };
  const callbacks = new Map<string, (...args: unknown[]) => unknown>();
  let active: Array<{ callId: string; state: 'open' | 'continued'; questions: ReturnType<typeof question>[] }> = [];
  const service = { ask: vi.fn(), answer: vi.fn(() => true) };
  const projection = { snapshot: vi.fn(() => ({ values: { userQuestions: { active } } })) };
  const dispose = vi.fn();
  const ctx: QuestionChannelContext = {
    get: name => name === 'userQuestions' ? service : name === 'sessionProjections' ? projection : undefined,
    on: vi.fn((event, callback) => { callbacks.set(event, callback); return dispose; }),
  };
  const channel = new QuestionChannel(manager, sender, {
    requireMention: true, askTimeoutMs: 1000, conversation: { mode: interactive ? 'interactive' : 'serial', taskAdmins: ['admin'] },
  }, logger());
  channel.install(ctx);
  const ask = (overrides: Partial<UserQuestionRequest> = {}) => callbacks.get('user-questions/request')!(
    { agent, questions: [question()], ...overrides }, vi.fn()) as Promise<UserQuestionResult>;
  const cardData = (index = sender.sendMarkdown.mock.calls.length - 1) => {
    const opts = sender.sendMarkdown.mock.calls[index]![2] as { keyboard: ReturnType<typeof buildKeyboard> };
    return opts.keyboard!.content.rows[0]!.buttons[0]!.action.data;
  };
  const event = (data: string, actor = 'user1'): InteractionEvent => ({
    ...(group ? { group_openid: peer, group_member_openid: actor } : { user_openid: actor }),
    data: { resolved: { button_data: data } },
  }) as InteractionEvent;
  return { channel, manager, sender, record, agent, service, callbacks, ctx, dispose, ask, cardData, event,
    project: (value: typeof active) => { active = value; }, scope, peer };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('QQ native question answerer', () => {
  it('registers a global waterfall without replacing host validation and delegates non-QQ questions', async () => {
    const s = setup();
    const original = s.service.ask;
    const next = vi.fn(async () => ({ answers: [] }));
    await s.callbacks.get('user-questions/request')!({ agent: { id: 'web' }, questions: [question()] }, next);
    expect(next).toHaveBeenCalledOnce();
    expect(s.service.ask).toBe(original);
    expect(s.ctx.on).toHaveBeenCalledWith('user-questions/request', expect.any(Function), { global: true, prepend: true });
    s.channel.uninstall();
    expect(s.dispose).toHaveBeenCalledTimes(2);
  });

  it('ordinary text keeps chatting; a matching card or explicit request collects the complete batch', async () => {
    const s = setup();
    const result = s.ask({ questions: [question('first'), question('second')], wait: { callId: 'call1', timed: true } });
    expect(s.channel.tryAnswer(s.scope, s.peer, '进度怎样', 'user1')).toBe(false);
    expect(s.channel.handleInteraction(s.event(s.cardData()))).toBe(true);
    expect(s.channel.answerText(s.scope, s.peer, 'user1', 'call1', '2').ok).toBe(true);
    expect(await result).toEqual({ answers: [{ id: 'first', selected: ['A'] }, { id: 'second', selected: ['B'] }] });
    expect(s.channel.hasPending('key')).toBe(false);
  });

  it('two calls sharing a question id keep distinct cards, and stale or foreign buttons cannot answer', async () => {
    const s = setup();
    const one = s.ask({ wait: { callId: 'call1', timed: true } });
    const old = s.cardData();
    const two = s.ask({ wait: { callId: 'call2', timed: true } });
    expect(s.channel.handleInteraction(s.event(old, 'other'))).toBe(false);
    expect(s.channel.handleInteraction(s.event(JSON.stringify({ t: 'question', q: 'q', i: 0 })))).toBe(false);
    expect(s.channel.handleInteraction(s.event(old))).toBe(true);
    await one;
    expect(s.channel.handleInteraction(s.event(old))).toBe(false);
    expect(s.channel.handleInteraction(s.event(s.cardData()))).toBe(true);
    await two;
  });

  it('pins group actor and generation; another sender or a reset cannot consume a card', async () => {
    const s = setup(true);
    const result = s.ask();
    const rejection = result.catch(error => error);
    s.record.senderId = 'other';
    expect(s.channel.handleInteraction(s.event(s.cardData(), 'other'))).toBe(false);
    expect(s.channel.handleInteraction(s.event(s.cardData(), 'user1'))).toBe(true);
    await result;
    const another = s.ask();
    const aborted = another.catch(error => error);
    s.record.generation++;
    expect(s.channel.handleInteraction(s.event(s.cardData(), 'admin'))).toBe(false);
    s.channel.cancelPending('key');
    expect((await aborted).code).toBe('ASK_ABORTED');
    await rejection;
  });

  it('interactive group ownership comes from the claimed actor, and ambiguous input requires an admin', async () => {
    const s = setup(true, true);
    const first = s.ask();
    expect(s.channel.handleInteraction(s.event(s.cardData(), 'user1'))).toBe(false);
    expect(s.channel.handleInteraction(s.event(s.cardData(), 'trusted-owner'))).toBe(true);
    await first;
    s.manager.taskRegistry.actorFor.mockReturnValue(undefined);
    const second = s.ask();
    expect(s.channel.handleInteraction(s.event(s.cardData(), 'trusted-owner'))).toBe(false);
    expect(s.channel.handleInteraction(s.event(s.cardData(), 'admin'))).toBe(true);
    await second;
  });

  it('native foreground timeout rejects promptly, preserves the question, and queues a late batch once', async () => {
    const s = setup();
    const controller = new AbortController();
    const result = s.ask({ signal: controller.signal, wait: { callId: 'call1', timed: true } });
    const rejected = result.catch(error => error);
    const data = s.cardData();
    // The plugin's legacy timeout does not cancel the host's timed question.
    await vi.advanceTimersByTimeAsync(1500);
    expect(s.channel.hasPending('key')).toBe(true);
    controller.abort(Object.assign(new Error('deadline'), { code: 'ASK_TIMED_OUT' }));
    expect((await rejected).code).toBe('ASK_TIMED_OUT');
    // Answer arrives between foreground abort and durable pending result.
    expect(s.channel.handleInteraction(s.event(data))).toBe(true);
    expect(s.channel.handleInteraction(s.event(data))).toBe(false);
    expect(s.channel.answerText(s.scope, s.peer, 'user1', 'call1', '2').ok).toBe(false);
    expect(s.service.answer).not.toHaveBeenCalled();
    s.project([{ callId: 'call1', state: 'continued', questions: [question()] }]);
    s.callbacks.get('session/event')!();
    await vi.runAllTicks();
    expect(s.manager.taskRegistry.noteQuestionAnswer).toHaveBeenCalledExactlyOnceWith('root', 'call1', 'user1', undefined);
    expect(s.service.answer).toHaveBeenCalledExactlyOnceWith(s.agent, 'call1', { answers: [{ id: 'q', selected: ['A'] }] });
    expect(s.channel.handleInteraction(s.event(data))).toBe(false);
  });

  it('routes simultaneous relayed task questions to their actual owners even in a mixed-author step', async () => {
    const s = setup(true, true);
    s.manager.taskRegistry.actorFor.mockReturnValue(undefined);
    s.manager.taskRegistry.get.mockImplementation((id, scope, peer) => ({ taskId: id, rootSessionId: 'root', scope,
      peerId: peer, runId: 'run1', ownerId: id === 'task-one' ? 'alice' : 'bob' }) as TaskRecord);
    const first = s.ask({ questions: [question('task-one:choice')], wait: { callId: 'call1', timed: true } });
    const firstData = s.cardData();
    const second = s.ask({ questions: [question('task-two:choice')], wait: { callId: 'call2', timed: true } });
    const secondData = s.cardData();
    expect(s.sender.sendMarkdown.mock.calls[0]![1]).toContain('任务 task-one');
    expect(s.channel.handleInteraction(s.event(firstData, 'bob'))).toBe(false);
    expect(s.channel.handleInteraction(s.event(secondData, 'alice'))).toBe(false);
    expect(s.channel.handleInteraction(s.event(firstData, 'alice'))).toBe(true);
    expect(s.channel.handleInteraction(s.event(secondData, 'bob'))).toBe(true);
    await Promise.all([first, second]);
    expect(s.manager.taskRegistry.noteQuestionOpenAnswer).toHaveBeenCalledWith('root', 'call1', 'alice', ['task-one']);
    expect(s.manager.taskRegistry.noteQuestionOpenAnswer).toHaveBeenCalledWith('root', 'call2', 'bob', ['task-two']);
    await expect(s.ask({ questions: [question('task-one:a'), question('task-two:b')] }))
      .rejects.toMatchObject({ code: 'MIXED_TASK_OWNERS' });
    await expect(s.ask({ questions: [question('task-one:a'), question('ordinary')] }))
      .rejects.toMatchObject({ code: 'MIXED_TASK_OWNERS' });
    const stale = s.ask({ questions: [question('task-one:stale')], wait: { callId: 'stale', timed: true } }).catch(error => error);
    s.manager.taskRegistry.get.mockReturnValue({ taskId: 'task-one', rootSessionId: 'root', scope: s.scope,
      peerId: s.peer, ownerId: 'alice', runId: 'run2' } as TaskRecord);
    expect(s.channel.handleInteraction(s.event(s.cardData(), 'alice'))).toBe(false);
    s.channel.cancelPending('key');
    expect((await stale).code).toBe('ASK_ABORTED');
    s.manager.taskRegistry.get.mockReturnValue({ taskId: 'task-foreign', rootSessionId: 'foreign',
      scope: 'group', peerId: s.peer, ownerId: 'alice' } as TaskRecord);
    await expect(s.ask({ questions: [question('task-foreign:q')] })).rejects.toMatchObject({ code: 'BAD_TASK_QUESTION' });
    expect(s.sender.sendMarkdown).toHaveBeenCalledTimes(3);
  });

  it('normal cancellation and unload terminate all calls, including during a pending send', async () => {
    const s = setup();
    s.sender.sendMarkdown.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const first = s.ask({ signal: controller.signal }).catch(error => error);
    const second = s.ask().catch(error => error);
    controller.abort();
    expect((await first).code).toBe('ASK_ABORTED');
    s.channel.uninstall();
    expect((await second).code).toBe('ASK_ABORTED');
    expect(s.channel.hasPending('key')).toBe(false);
  });

  it('retains a continued question and its owner if card delivery fails after the foreground deadline', async () => {
    const s = setup(true, true);
    let failSend!: (error: Error) => void;
    s.sender.sendMarkdown.mockImplementation(() => new Promise((_resolve, reject) => { failSend = reject; }));
    const controller = new AbortController();
    const foreground = s.ask({ signal: controller.signal, wait: { callId: 'late', timed: true } }).catch(error => error);
    controller.abort(Object.assign(new Error('timeout'), { code: 'ASK_TIMED_OUT' }));
    await foreground;
    s.sender.sendMarkdown.mockRejectedValue(new Error('offline'));
    failSend(new Error('offline'));
    await vi.runAllTimersAsync();
    expect(s.channel.hasPending('key')).toBe(true);
    s.project([{ callId: 'late', state: 'continued', questions: [question()] }]);
    expect(s.channel.answerText(s.scope, s.peer, 'trusted-owner', 'late', '2').ok).toBe(true);
    expect(s.service.answer).toHaveBeenCalledOnce();
  });

  it('restores continued calls from host projection for explicit answers and handles queued replies', () => {
    const s = setup();
    s.project([{ callId: 'saved', state: 'continued', questions: [question()] }]);
    expect(s.channel.listPending(s.scope, s.peer, 'user1')).toContain('选哪个');
    s.service.answer.mockImplementation(() => { throw Object.assign(new Error('queued'), { code: 'REPLY_QUEUED' }); });
    expect(s.channel.answerText(s.scope, s.peer, 'user1', 'saved', '2')).toEqual({ ok: false, message: '该问题的答案已在队列中。' });
    expect(s.manager.taskRegistry.noteQuestionAnswer.mock.results[0]!.value).toHaveBeenCalledOnce();
  });

  it('stopping a freshly restored session dismisses projected questions before the first card interaction', () => {
    const s = setup();
    s.project([{ callId: 'saved', state: 'continued', questions: [question()] }]);
    s.channel.cancelPending('key', s.record);
    expect(s.channel.answerText(s.scope, s.peer, 'user1', 'saved', '2').ok).toBe(false);
    expect(s.service.answer).not.toHaveBeenCalled();
  });

  it('supports replies to a known delivered card but ignores guessed unrelated references', async () => {
    const s = setup();
    const result = s.ask();
    await Promise.resolve();
    expect(s.channel.tryAnswer(s.scope, s.peer, '2', 'user1', 'unknown')).toBe(false);
    expect(s.channel.tryAnswer(s.scope, s.peer, '2', 'user1', 'card1')).toBe(true);
    await result;
  });

  it('renders approval intent detail and refuses a freeform answer to its fixed actions', async () => {
    const s = setup();
    const q = { ...question(), detail: '只允许读取 /tmp/example', intent: { kind: 'approval' as const, approve: 'A', reject: 'B' } };
    const result = s.ask({ questions: [q], wait: { callId: 'approval-call' } });
    expect(s.sender.sendMarkdown.mock.calls[0]![1]).toContain(q.detail);
    expect(s.channel.answerText(s.scope, s.peer, 'user1', 'approval-call', '随便').ok).toBe(false);
    expect(s.channel.handleInteraction(s.event(s.cardData()))).toBe(true);
    await result;
  });
});

describe('question formatting and parsing', () => {
  it('keeps original option labels while cards include call and nonce', () => {
    const keyboard = buildKeyboard(question(), { callId: 'call', nonce: 'nonce' });
    expect(decodeButtonData(keyboard!.content.rows[0]!.buttons[1]!.action.data)).toEqual({ t: 'question', q: 'q', i: 1, c: 'call', n: 'nonce' });
    expect(formatQuestion(question(), true, true, 'nonce')).toContain('/answer nonce');
    expect(buildKeyboard({ ...question(), multiSelect: true })).toBeUndefined();
  });
  it('maps numbers, labels and free text, and rejects malformed button indices', () => {
    expect(parseAnswer(question(), '2')).toEqual({ id: 'q', selected: ['B'] });
    expect(parseAnswer(question(), 'something')).toEqual({ id: 'q', selected: [], custom: 'something' });
    expect(parseAnswer({ ...question(), multiSelect: true }, '1,2')).toEqual({ id: 'q', selected: ['A', 'B'] });
    expect(decodeButtonData('{"t":"question","q":"q","i":1.2}')).toBeUndefined();
    expect(decodeButtonData('{"t":"approval","d":"maybe"}')).toBeUndefined();
  });
});
