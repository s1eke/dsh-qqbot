import { describe, it, expect, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema } from '../config.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import { handleInbound } from './inbound.ts';
import { QqInputRegistry } from './qq-input-origin.ts';

function fixture(maxPendingInputs = 3) {
  let generation = 0;
  const accepted: Array<{ id: string; content: Array<{ text: string }> }> = [];
  const record = { sessionId: 'root', agent: { steer: vi.fn(m => accepted.push(m)), followup: vi.fn(),
    whenIdle: vi.fn(() => new Promise<void>(() => {})) } } as unknown as SessionRecord;
  const manager = { generation: () => generation, isCurrent: (_s: string, _p: string, g: number) => g === generation,
    getOrCreate: vi.fn(async () => record), taskRegistry: { noteInput: vi.fn(), forgetInput: vi.fn() } } as unknown as SessionManager;
  const inputs = new QqInputRegistry();
  const notices: string[] = [];
  const config = ConfigSchema({ conversation: { mode: 'interactive', maxPendingInputs } });
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const context = (content: string) => ({ message: { kind: 'c2c', senderId: 'u', content, messageId: content }, state: {},
    bot: { sendMarkdown: async (_t: unknown, text: string) => { notices.push(text); } } }) as unknown as MiddlewareContext;
  const send = (text: string) => handleInbound(context(text), manager, config, logger, inputs);
  return { manager, record, accepted, inputs, notices, send, reset: () => { generation++; } };
}

describe('interactive inbound', () => {
  it('accepts consecutive inputs with distinct IDs before whenIdle resolves', async () => {
    const h = fixture();
    await h.send('按项目分组'); await h.send('还要附来源');
    expect(h.accepted.map(m => m.content[0]?.text)).toEqual(['按项目分组', '还要附来源']);
    expect(new Set(h.accepted.map(m => m.id)).size).toBe(2);
    expect(h.record.agent.followup).not.toHaveBeenCalled();
    expect(h.record.agent.whenIdle).not.toHaveBeenCalled();
    expect(h.inputs.size).toBe(2);
  });
  it('bounds the native pending inbox, frees quota at claim but retains turn identity', async () => {
    const h = fixture(1);
    await h.send('first'); await h.send('full');
    expect(h.accepted).toHaveLength(1); expect(h.notices.join()).toContain('上限');
    h.inputs.claimed(h.accepted[0]!.id, 7);
    expect(h.inputs.has(h.accepted[0]!.id)).toBe(true);
    await h.send('next'); expect(h.accepted).toHaveLength(2);
    h.inputs.releaseTurn('root', 7); // Covers a pre-step rejection without user/message.
    expect(h.inputs.has(h.accepted[0]!.id)).toBe(false);
    expect(h.inputs.has(h.accepted[1]!.id)).toBe(true);
  });
  it('rolls back a rejected native submission and does not consume quota', async () => {
    const h = fixture(1);
    vi.mocked(h.record.agent.steer!).mockImplementationOnce(() => { throw new Error('closed'); });
    await h.send('rejected'); expect(h.inputs.size).toBe(0);
    await h.send('accepted'); expect(h.accepted).toHaveLength(1);
  });
  it('does not submit a session creation that resolves after reset', async () => {
    const h = fixture();
    let ready!: (record: SessionRecord) => void;
    vi.mocked(h.manager.getOrCreate).mockReturnValueOnce(new Promise(resolve => { ready = resolve; }));
    const pending = h.send('stale'); h.reset(); ready(h.record); await pending;
    expect(h.accepted).toHaveLength(0);
    await h.send('fresh'); expect(h.accepted).toHaveLength(1);
  });
});
