import { describe, expect, it, vi } from 'vitest';
import { IdleEvictor } from './idle-evictor.ts';
import type { SessionRecord } from './types.ts';

function record(status: 'idle' | 'running'): SessionRecord {
  return { lastActivity: Date.now() - 10_000, agent: { status } } as SessionRecord;
}

describe('IdleEvictor', () => {
  it('运行中的主代理不回收，停止后从最后活动时刻重新计算', () => {
    vi.useFakeTimers();
    const item = record('running');
    const evicted = vi.fn();
    const evictor = new IdleEvictor(new Map([['key', item]]), 100, evicted);
    try {
      evictor.check();
      expect(evicted).not.toHaveBeenCalled();
      Object.assign(item.agent, { status: 'idle' });
      evictor.check();
      expect(evicted).not.toHaveBeenCalled();
      vi.advanceTimersByTime(101);
      evictor.check();
      expect(evicted).toHaveBeenCalledWith('key', item);
    } finally { evictor.dispose(); vi.useRealTimers(); }
  });

  it('外部活动可保活，即使主代理 idle', () => {
    const item = record('idle');
    const evicted = vi.fn();
    const busy = vi.fn(() => true);
    const evictor = new IdleEvictor(new Map([['key', item]]), 100, evicted, busy);
    try {
      evictor.check();
      expect(busy).toHaveBeenCalledWith('key', item);
      expect(evicted).not.toHaveBeenCalled();
      busy.mockReturnValue(false);
      item.lastActivity = Date.now() - 101;
      evictor.check();
      expect(evicted).toHaveBeenCalledWith('key', item);
    } finally { evictor.dispose(); }
  });
});
