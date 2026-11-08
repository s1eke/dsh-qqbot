import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { ConfigSchema } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import { admissionTicket, interactiveAdmission } from './admission.ts';

function setup(timeout = 100, maxQueue = 3) {
  let generation = 0;
  let held = 0;
  let invalidated: ((_record: undefined, key: string) => void) | undefined;
  const manager = {
    onInvalidate: (listener: typeof invalidated) => { invalidated = listener; },
    generation: () => generation,
    isCurrent: (_scope: string, _peer: string, value: number) => value === generation,
    holdActivity: () => { held++; return () => { held--; }; },
  } as unknown as SessionManager;
  const notices: string[] = [];
  const message = () => ({ message: { kind: 'c2c', senderId: 'u' }, state: {},
    replyTarget: { scope: 'c2c', targetId: 'u' },
    bot: { sendMarkdown: async (_target: unknown, text: string) => { notices.push(text); } },
  }) as unknown as MiddlewareContext;
  return { middleware: interactiveAdmission(ConfigSchema({ maxQueue, conversation: { mode: 'interactive', admissionTimeoutMs: timeout } }), manager),
    message, notices, held: () => held, reset: () => { generation++; invalidated?.(undefined, 'qqbot::c2c:u'); } };
}

afterEach(() => vi.useRealTimers());
describe('interactive admission', () => {
  it('preserves each message and receive order without waiting for background execution', async () => {
    const h = setup();
    let ready!: () => void;
    const media = new Promise<void>(resolve => { ready = resolve; });
    const received: string[] = [];
    const a = h.middleware(h.message(), async () => { await media; received.push('media'); });
    const b = h.middleware(h.message(), async () => { received.push('text'); });
    await Promise.resolve();
    expect(received).toEqual([]);
    ready(); await Promise.all([a, b]);
    expect(received).toEqual(['media', 'text']);
    expect(h.held()).toBe(0);
  });
  it('expires a stuck preparation, rejects late work and accepts subsequent messages', async () => {
    vi.useFakeTimers();
    const h = setup();
    const ctx = h.message();
    let ready!: () => void;
    const wait = new Promise<void>(resolve => { ready = resolve; });
    const submitted: string[] = [];
    const p = h.middleware(ctx, async () => {
      await wait;
      if (!admissionTicket(ctx)?.signal.aborted) submitted.push('late');
    });
    await vi.advanceTimersByTimeAsync(101); await p;
    ready(); await Promise.resolve();
    await h.middleware(h.message(), async () => { submitted.push('new'); });
    expect(submitted).toEqual(['new']);
    expect(h.notices.join()).toContain('超时');
    expect(h.held()).toBe(0);
  });
  it('a reset invalidates waiting tickets without dropping the first post-reset input', async () => {
    const h = setup();
    let ready!: () => void;
    const wait = new Promise<void>(resolve => { ready = resolve; });
    const first = h.middleware(h.message(), () => wait);
    const stale = vi.fn(async () => {});
    const second = h.middleware(h.message(), stale);
    h.reset(); ready(); await Promise.all([first, second]);
    const fresh = vi.fn(async () => {});
    await h.middleware(h.message(), fresh);
    expect(stale).not.toHaveBeenCalled(); expect(fresh).toHaveBeenCalledOnce();
  });
  it('bounds pending preparation, leaving control middleware outside this queue', async () => {
    const h = setup(100, 1);
    let ready!: () => void;
    const first = h.middleware(h.message(), () => new Promise<void>(resolve => { ready = resolve; }));
    await Promise.resolve(); await Promise.resolve();
    const next = vi.fn(async () => {});
    await h.middleware(h.message(), next);
    expect(next).not.toHaveBeenCalled(); expect(h.notices.join()).toContain('队列已满');
    ready(); await first;
  });
  it('stop releases a hung old preparation immediately for a new-generation message', async () => {
    const h = setup(60_000);
    const first = h.middleware(h.message(), () => new Promise<void>(() => {}));
    await Promise.resolve(); await Promise.resolve(); h.reset(); await first;
    const fresh = vi.fn(async () => {});
    await h.middleware(h.message(), fresh);
    expect(fresh).toHaveBeenCalledOnce(); expect(h.held()).toBe(0);
  });
});
