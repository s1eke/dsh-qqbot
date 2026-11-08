import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationActivity } from './activity.ts';
import { QqInputRegistry } from './qq-input-origin.ts';
import { ConfigSchema } from '../config.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';

afterEach(() => vi.useRealTimers());
describe('native activity deadlines', () => {
  it('an old turn deadline cannot cancel a later turn and rejected claims are released', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const record = { sessionId: 'r', scope: 'c2c', peerId: 'u', generation: 0, agent: { cancel }, replyTarget: {scope:'c2c', targetId:'u'} } as unknown as SessionRecord;
    const manager = { generation: () => record.generation, findBySessionId: () => record,
      stop: vi.fn(async () => { cancel(); }) } as unknown as SessionManager;
    const inputs = new QqInputRegistry();
    const notify = vi.fn(async () => {});
    const activity = new ConversationActivity(manager, inputs, ConfigSchema({ conversation: { mode:'interactive', mainTimeoutMs:100 } }), notify,
      { info:vi.fn(), warn:vi.fn(), error:vi.fn(), debug:vi.fn() });
    const session = { header:{ id:'r' } };
    activity.onEvent(session, { type:'turn/start', data:{turn:1} });
    inputs.register('claimed-but-blocked', {sessionId:'r',bytes:2}); inputs.claimed('claimed-but-blocked',1);
    await vi.advanceTimersByTimeAsync(50);
    activity.onEvent(session, { type:'turn/end', data:{turn:1} });
    expect(inputs.size).toBe(0);
    activity.onEvent(session, { type:'turn/start', data:{turn:2} });
    await vi.advanceTimersByTimeAsync(51); expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50); expect(cancel).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
    activity.dispose();
  });
});
