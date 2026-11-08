/**
 * IdleEvictor — 闲置会话回收器
 *
 * 定期检查会话最后活跃时间，超时则自动回收释放资源。
 * timeoutMs <= 0 时不启动定时器，也不回收任何会话。
 */
import type { SessionRecord } from './types.ts';

/** 回收检查周期(ms) */
const CHECK_INTERVAL_MS = 60_000;

export class IdleEvictor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly sessions: Map<string, SessionRecord>;
  private readonly timeoutMs: number;
  private readonly onEvict: (key: string, record: SessionRecord) => void;
  private readonly isBusy: (key: string, record: SessionRecord) => boolean;

  constructor(
    sessions: Map<string, SessionRecord>,
    timeoutMs: number,
    onEvict: (key: string, record: SessionRecord) => void,
    isBusy: (key: string, record: SessionRecord) => boolean = (_key, record) => record.agent.status !== 'idle',
  ) {
    this.sessions = sessions;
    this.timeoutMs = timeoutMs;
    this.onEvict = onEvict;
    this.isBusy = isBusy;
    if (timeoutMs > 0) {
      this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
    }
  }

  /** 执行一轮回收检查。未配置超时（<=0）时不回收任何会话。 */
  check(): void {
    if (this.timeoutMs <= 0) return;
    const now = Date.now();
    for (const [key, record] of this.sessions) {
      if (this.isBusy(key, record)) {
        record.lastActivity = now;
        continue;
      }
      if (now - record.lastActivity > this.timeoutMs) {
        this.onEvict(key, record);
      }
    }
  }

  /** 停止回收定时器 */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
