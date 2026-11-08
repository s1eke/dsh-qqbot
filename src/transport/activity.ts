import type { Context } from '@deepseek-ai/cordis';
import { conversationConfig, type ImQQBotConfig } from '../config.ts';
import type { DshAgent, SessionManager } from '../session/index.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import type { QqInputRegistry } from './qq-input-origin.ts';
import type { RawSessionEvent } from './events.ts';
import type { SessionLike } from './outbound.ts';

interface ActiveTurn {
  agent: DshAgent;
  turn: number;
  generation: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Host lifecycle, not the short admission callback, owns running deadlines. */
export class ConversationActivity {
  private turns = new Map<string, ActiveTurn>();
  private typing = new Map<DshAgent, ReturnType<typeof setInterval>>();
  constructor(
    private readonly manager: SessionManager,
    private readonly inputs: QqInputRegistry,
    private readonly config: ImQQBotConfig,
    private readonly notify: (target: ReplyTarget, text: string) => Promise<unknown>,
    private readonly logger: Logger,
    private readonly sendTyping?: (target: ReplyTarget) => Promise<unknown>,
  ) {}

  install(ctx: Context): void {
    const bus = ctx as unknown as { on(name: string, fn: (...args: any[]) => void, options: { global: boolean }): void };
    bus.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      if (this.manager.findByAgent(agent)) this.inputs.claimed(String(message.id), turn);
    }, { global: true });
    bus.on('agent/inbox/discarded', ({ agent, message }) => {
      if (this.manager.findByAgent(agent)) this.inputs.release(String(message.id));
    }, { global: true });
    bus.on('agent/disposed', ({ agent }) => {
      if (this.turns.get(agent.id)?.agent === agent) this.clear(agent.id);
      this.stopTyping(agent);
    }, { global: true });
    bus.on('agent/status', ({ agent, status }) => {
      this.stopTyping(agent);
      const record = this.manager.findByAgent(agent);
      if (this.config.conversation?.mode !== 'interactive' || !record || status !== 'running'
        || record.scope !== 'c2c' || !this.sendTyping) return;
      const send = () => {
        const current = this.manager.findByAgent(agent);
        if (!current) { this.stopTyping(agent); return; }
        void this.sendTyping!(current.replyTarget).catch(err => this.logger.debug(`typing failed: ${String(err)}`));
      };
      send();
      const timer = setInterval(send, 50_000);
      timer.unref?.();
      this.typing.set(agent, timer);
    }, { global: true });
    bus.on('session/event', (session: SessionLike, event: RawSessionEvent) => this.onEvent(session, event), { global: true });
  }

  onEvent(session: SessionLike, event: RawSessionEvent): void {
    const id = session.header.id;
    const current = this.manager.findBySessionId(id);
    if (current?.agent.session && (current.agent.session as unknown) !== session) return;
    const turn = event.data.turn;
    if (typeof turn !== 'number') return;
    if (event.type === 'turn/end') {
      this.inputs.releaseTurn(id, turn);
      if (this.turns.get(id)?.turn === turn) this.clearTimer(id);
      return;
    }
    if (event.type !== 'turn/start' || this.config.conversation?.mode !== 'interactive') return;
    const record = this.manager.findBySessionId(id);
    if (!record) return;
    this.clearTimer(id);
    const state: ActiveTurn = { agent: record.agent, turn,
      generation: this.manager.generation(record.scope, record.peerId) };
    this.turns.set(id, state);
    const timeout = conversationConfig(this.config).mainTimeoutMs;
    if (timeout <= 0) return;
    state.timer = setTimeout(() => {
      const current = this.manager.findBySessionId(id);
      if (this.turns.get(id) !== state || current?.agent !== state.agent
        || current.generation !== state.generation) return;
      this.logger.warn(`main turn timed out: sessionId=${id} turn=${turn}`);
      void this.manager.stop(current.scope, current.peerId, 'main')
        .then(() => this.notify(current.replyTarget, '主会话本轮已达到运行期限，已请求停止；后台任务按各自期限继续。'))
        .catch(err => this.logger.warn(`timeout notice failed: ${String(err)}`));
    }, timeout);
    state.timer.unref?.();
  }

  clear(sessionId: string, preserveTurn = false): void {
    const agent = this.turns.get(sessionId)?.agent;
    if (agent && !preserveTurn) this.stopTyping(agent);
    this.clearTimer(sessionId);
    if (!preserveTurn) this.inputs.releaseSession(sessionId);
  }

  private stopTyping(agent: DshAgent): void {
    clearInterval(this.typing.get(agent));
    this.typing.delete(agent);
  }

  private clearTimer(sessionId: string): void {
    clearTimeout(this.turns.get(sessionId)?.timer);
    this.turns.delete(sessionId);
  }

  dispose(): void {
    for (const id of this.turns.keys()) this.clear(id);
    for (const agent of this.typing.keys()) this.stopTyping(agent);
  }
}
