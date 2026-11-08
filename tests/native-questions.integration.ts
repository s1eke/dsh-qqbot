/** Real host AgentLoop + native question service/tool + QQ answerer, with only model and QQ transport simulated. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import UserQuestionService from '@deepseek-ai/dsh-user-questions';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MockAdapter, textResponse, toolCallResponse } from '@native-test/packages/core/agent-loop/tests/mock-adapter.ts';
import { QuestionChannel } from '../src/features/question-channel.ts';
import { ApprovalChannel } from '../src/features/approval-channel.ts';
import type { InteractionEvent } from '@tencent-connect/qqbot-nodejs';

async function fixture(approval = false) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-native-questions-'));
  const ctx = new Context();
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  await ctx.plugin(JsonlSessionPersistence, { root: directory, compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(UserQuestionService);
  await ctx.plugin(ApprovalService);
  await ctx.plugin(ToolAskUser, { mode: 'timed', timeout: 1 });
  const adapter = new MockAdapter(approval ? [
    toolCallResponse('approval-tool', 'request_two_approvals', {}), textResponse('审批处理完成'),
  ] : [
    toolCallResponse('question-call', 'ask_user_question', { timeout: 1, questions: [{ id: 'choice', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] }),
    textResponse('继续处理普通聊天'), textResponse('已收到迟到回答'),
  ]);
  ctx.llm.registerAdapter(['mock'], adapter);
  const handle = await ctx.agents.create({ sessionId: SessionId('qq-question-root'), meta: { cwd: directory },
    agentOptions: { provider: 'mock', model: 'mock' } });
  const agent = handle.agent;
  const record = { sessionKey: 'qqbot:app:c2c:user1', scope: 'c2c' as const, senderId: 'user1', generation: 0, agent,
    replyTarget: { scope: 'c2c' as const, targetId: 'user1', msgId: 'qq1' } };
  const manager = {
    findBySessionId: (id: string) => id === agent.id ? record : undefined,
    getSessionRecord: (scope: string, peer: string) => scope === 'c2c' && peer === 'user1' ? record : undefined,
  };
  const delivered = Promise.withResolvers<void>();
  const sender = { sendMarkdown: vi.fn(async () => { delivered.resolve(); return { id: 'card1' }; }) };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const channel = new QuestionChannel(manager, sender, { requireMention: false, askTimeoutMs: 10,
    conversation: { mode: 'interactive', taskAdmins: [] } }, logger);
  channel.install(ctx);
  return { ctx, directory, agent, adapter, manager, sender, channel, delivered, handle, logger,
    async dispose() { channel.uninstall(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

const input = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });

describe('native timed questions through QQ', () => {
  it('keeps ordinary input distinct, returns pending at native timeout, and admits a late answer through the native projection', async () => {
    const f = await fixture();
    try {
      f.agent.steer(input('请提问'));
      await f.delivered.promise;
      expect(f.channel.tryAnswer('c2c', 'user1', '进度怎样', 'user1')).toBe(false);
      f.agent.steer(input('进度怎样'));
      await f.agent.whenIdle();
      const view = () => f.ctx.sessionProjections.snapshot(f.agent.session, ['userQuestions']).values.userQuestions;
      expect(view()).toMatchObject({ active: [{ callId: 'question-call', state: 'continued' }] });
      expect(JSON.stringify(f.adapter.requests[1])).toContain('进度怎样');
      expect(JSON.stringify(f.adapter.requests[1])).toContain('pending');
      const result = f.channel.answerText('c2c', 'user1', 'user1', 'question-call', '2');
      expect(result.ok).toBe(true);
      await f.agent.whenIdle();
      expect(view()).toMatchObject({ active: [], settled: [{ callId: 'question-call', answers: [{ id: 'choice', selected: ['B'] }] }] });
      const replies = f.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source.kind === 'user-question-reply');
      expect(replies).toHaveLength(1);
      expect(JSON.stringify(f.adapter.requests[2])).toContain('answer_to_pending_question');
      expect(f.channel.answerText('c2c', 'user1', 'user1', 'question-call', '1').ok).toBe(false);
    } finally { await f.dispose(); }
  });

  it('answers an open request through its original waiter and preserves native caller and approval validation', async () => {
    const f = await fixture();
    try {
      f.agent.steer(input('请提问'));
      await f.delivered.promise;
      expect(f.channel.answerText('c2c', 'user1', 'user1', 'question-call', '1').ok).toBe(true);
      await f.agent.whenIdle();
      expect(f.ctx.sessionProjections.snapshot(f.agent.session, ['userQuestions']).values.userQuestions)
        .toMatchObject({ active: [], settled: [{ callId: 'question-call', answers: [{ id: 'choice', selected: ['A'] }] }] });
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source.kind === 'user-question-reply')).toHaveLength(0);
      const child = await f.ctx.agents.create({ sessionId: SessionId('qq-question-child'),
        meta: { cwd: f.directory, origin: 'subagent', parentSession: f.agent.id, delegationDepth: 1 },
        agentOptions: { provider: 'mock', model: 'mock' } });
      await expect(f.ctx.userQuestions.ask({ agent: child.agent, questions: [{ id: 'q', question: 'can child ask?' }] }))
        .rejects.toMatchObject({ code: 'DELEGATED_CALLER' });
      await expect(f.ctx.userQuestions.askTimed({ agent: f.agent, questions: [{ id: 'approval', question: 'allow?',
        detail: 'read one file', options: [{ label: 'yes' }, { label: 'no' }],
        intent: { kind: 'approval', approve: 'yes', reject: 'no' } }] }, ToolCallId('invalid-approval'), 100))
        .rejects.toMatchObject({ code: 'BAD_INTENT' });
      expect(f.sender.sendMarkdown).toHaveBeenCalledOnce();
    } finally { await f.dispose(); }
  });

  it('cancels an open native question without reviving it as a continued question', async () => {
    const f = await fixture();
    try {
      f.agent.steer(input('请提问'));
      await f.delivered.promise;
      f.agent.cancel({ kind: 'user' });
      await f.agent.whenIdle();
      expect(f.ctx.sessionProjections.snapshot(f.agent.session, ['userQuestions']).values.userQuestions)
        .toMatchObject({ active: [] });
      expect(f.channel.hasPending('qqbot:app:c2c:user1')).toBe(false);
      expect(f.channel.answerText('c2c', 'user1', 'user1', 'question-call', '1').ok).toBe(false);
      expect(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source.kind === 'user-question-reply')).toHaveLength(0);
    } finally { await f.dispose(); }
  });

  it('hydrates a continued question from the real host projection after replacing the QQ answerer', async () => {
    const f = await fixture();
    let restored: QuestionChannel | undefined;
    try {
      f.agent.steer(input('请提问'));
      await f.delivered.promise;
      await f.agent.whenIdle();
      f.channel.uninstall();
      restored = new QuestionChannel(f.manager, f.sender, { requireMention: false, askTimeoutMs: 10,
        conversation: { mode: 'interactive', taskAdmins: [] } }, f.logger);
      restored.install(f.ctx);
      expect(restored.listPending('c2c', 'user1', 'user1')).toContain('选哪个');
      expect(restored.answerText('c2c', 'user1', 'user1', 'question-call', '2').ok).toBe(true);
      await f.agent.whenIdle();
      expect(f.ctx.sessionProjections.snapshot(f.agent.session, ['userQuestions']).values.userQuestions)
        .toMatchObject({ active: [], settled: [{ callId: 'question-call', answers: [{ id: 'choice', selected: ['B'] }] }] });
      expect(f.sender.sendMarkdown).toHaveBeenCalledOnce();
    } finally { restored?.uninstall(); await f.dispose(); }
  });

  it('returns audited native approval outcomes and cancels a concurrent prompt without granting it', async () => {
    const f = await fixture(true);
    const sender = { sendMarkdown: vi.fn(async (..._args: unknown[]) => undefined) };
    const approvals = new ApprovalChannel(f.manager, sender,
      { access: { c2cMode: 'open', c2cAllow: [] } }, f.logger);
    approvals.install(f.ctx);
    try {
      const controller = new AbortController();
      const outcomes = Promise.withResolvers<string[]>();
      f.ctx.tools.register(defineTool({ name: 'request_two_approvals', description: 'Request two approvals in a real open turn', parameters: {},
        output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: 'decided' }] },
        async execute(_args, exec) {
          const results = await Promise.all([
            f.ctx.approval.request({ agent: exec.agent!, toolName: 'read', callId: ToolCallId('allow-call'), signal: exec.signal }),
            f.ctx.approval.request({ agent: exec.agent!, toolName: 'write', callId: ToolCallId('cancel-call'), signal: controller.signal }),
          ]);
          outcomes.resolve(results);
          return {};
        } }));
      f.agent.steer(input('请请求两项审批'));
      await vi.waitFor(() => expect(sender.sendMarkdown).toHaveBeenCalledTimes(2));
      const card = sender.sendMarkdown.mock.calls[0]![2] as { keyboard: { content: { rows: Array<{ buttons: Array<{ action: { data: string } }> }> } } };
      const data = card.keyboard.content.rows[0]!.buttons[0]!.action.data;
      expect(approvals.handleInteraction({ user_openid: 'intruder', data: { resolved: { button_data: data } } } as InteractionEvent)).toBe(false);
      expect(approvals.handleInteraction({ user_openid: 'user1', data: { resolved: { button_data: data } } } as InteractionEvent)).toBe(true);
      controller.abort();
      expect(await outcomes.promise).toEqual(['allowed-once', 'cancelled']);
      await f.agent.whenIdle();
      const decisions = f.agent.session.snapshotEvents().filter(event => event.type === 'approval/decided');
      expect(decisions).toHaveLength(2);
      expect(decisions.map(event => event.data.outcome)).toEqual(expect.arrayContaining(['allowed-once', 'cancelled']));
    } finally { approvals.uninstall(); await f.dispose(); }
  });

});
