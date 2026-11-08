import { conversationConfig } from "../config.js";
/** Host lifecycle, not the short admission callback, owns running deadlines. */
export class ConversationActivity {
    manager;
    inputs;
    config;
    notify;
    logger;
    sendTyping;
    turns = new Map();
    typing = new Map();
    constructor(manager, inputs, config, notify, logger, sendTyping) {
        this.manager = manager;
        this.inputs = inputs;
        this.config = config;
        this.notify = notify;
        this.logger = logger;
        this.sendTyping = sendTyping;
    }
    install(ctx) {
        const bus = ctx;
        bus.on('agent/inbox/claimed', ({ agent, message, turn }) => {
            if (this.manager.findByAgent(agent))
                this.inputs.claimed(String(message.id), turn);
        }, { global: true });
        bus.on('agent/inbox/discarded', ({ agent, message }) => {
            if (this.manager.findByAgent(agent))
                this.inputs.release(String(message.id));
        }, { global: true });
        bus.on('agent/disposed', ({ agent }) => {
            if (this.turns.get(agent.id)?.agent === agent)
                this.clear(agent.id);
            this.stopTyping(agent);
        }, { global: true });
        bus.on('agent/status', ({ agent, status }) => {
            this.stopTyping(agent);
            const record = this.manager.findByAgent(agent);
            if (this.config.conversation?.mode !== 'interactive' || !record || status !== 'running'
                || record.scope !== 'c2c' || !this.sendTyping)
                return;
            const send = () => {
                const current = this.manager.findByAgent(agent);
                if (!current) {
                    this.stopTyping(agent);
                    return;
                }
                void this.sendTyping(current.replyTarget).catch(err => this.logger.debug(`typing failed: ${String(err)}`));
            };
            send();
            const timer = setInterval(send, 50_000);
            timer.unref?.();
            this.typing.set(agent, timer);
        }, { global: true });
        bus.on('session/event', (session, event) => this.onEvent(session, event), { global: true });
    }
    onEvent(session, event) {
        const id = session.header.id;
        const current = this.manager.findBySessionId(id);
        if (current?.agent.session && current.agent.session !== session)
            return;
        const turn = event.data.turn;
        if (typeof turn !== 'number')
            return;
        if (event.type === 'turn/end') {
            this.inputs.releaseTurn(id, turn);
            if (this.turns.get(id)?.turn === turn)
                this.clearTimer(id);
            return;
        }
        if (event.type !== 'turn/start' || this.config.conversation?.mode !== 'interactive')
            return;
        const record = this.manager.findBySessionId(id);
        if (!record)
            return;
        this.clearTimer(id);
        const state = { agent: record.agent, turn,
            generation: this.manager.generation(record.scope, record.peerId) };
        this.turns.set(id, state);
        const timeout = conversationConfig(this.config).mainTimeoutMs;
        if (timeout <= 0)
            return;
        state.timer = setTimeout(() => {
            const current = this.manager.findBySessionId(id);
            if (this.turns.get(id) !== state || current?.agent !== state.agent
                || current.generation !== state.generation)
                return;
            this.logger.warn(`main turn timed out: sessionId=${id} turn=${turn}`);
            void this.manager.stop(current.scope, current.peerId, 'main')
                .then(() => this.notify(current.replyTarget, '主会话本轮已达到运行期限，已请求停止；后台任务按各自期限继续。'))
                .catch(err => this.logger.warn(`timeout notice failed: ${String(err)}`));
        }, timeout);
        state.timer.unref?.();
    }
    clear(sessionId, preserveTurn = false) {
        const agent = this.turns.get(sessionId)?.agent;
        if (agent && !preserveTurn)
            this.stopTyping(agent);
        this.clearTimer(sessionId);
        if (!preserveTurn)
            this.inputs.releaseSession(sessionId);
    }
    stopTyping(agent) {
        clearInterval(this.typing.get(agent));
        this.typing.delete(agent);
    }
    clearTimer(sessionId) {
        clearTimeout(this.turns.get(sessionId)?.timer);
        this.turns.delete(sessionId);
    }
    dispose() {
        for (const id of this.turns.keys())
            this.clear(id);
        for (const agent of this.typing.keys())
            this.stopTyping(agent);
    }
}
//# sourceMappingURL=activity.js.map