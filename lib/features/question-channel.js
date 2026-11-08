/** QQ answerer for the host question waterfall; the host owns timed question persistence. */
import { randomUUID } from 'node:crypto';
import { parseAnswer } from "./answer-parser.js";
import { buildKeyboard, formatQuestion } from "./question-renderer.js";
import { decodeButtonData } from "./button-utils.js";
import { QuestionCardStore } from "./question-card-store.js";
function errorWithCode(message, code = 'ASK_ABORTED') {
    return Object.assign(new Error(message), { name: 'UserQuestionError', code });
}
function errorCode(error) {
    return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function messageIdsOf(value) {
    const ids = new Set();
    const visited = new WeakSet();
    const collect = (value) => {
        if (!value || typeof value !== 'object' || visited.has(value))
            return;
        visited.add(value);
        const response = value;
        for (const key of ['id', 'messageId', 'ref_idx', 'refIdx', 'msgIdx']) {
            if (typeof response[key] === 'string' && response[key])
                ids.add(response[key]);
        }
        // QQ quotes address MessageResponse.ext_info.ref_idx, which differs from the REST message id.
        collect(response.ext_info);
        collect(response.data);
    };
    collect(value);
    return [...ids];
}
export class QuestionChannel {
    manager;
    sender;
    config;
    logger;
    targets;
    pending = new Map();
    cancelled = new WeakMap();
    ctx;
    disposers = [];
    cards;
    constructor(manager, sender, config, logger, targets) {
        this.manager = manager;
        this.sender = sender;
        this.config = config;
        this.logger = logger;
        this.targets = targets;
        this.cards = new QuestionCardStore(config.appId, logger);
    }
    /** Register without replacing ask(): host identity, intent, and deadline validation stay authoritative. */
    install(ctx) {
        if (this.ctx)
            return;
        this.ctx = ctx;
        this.disposers.push(ctx.on('user-questions/request', (raw, next) => {
            const request = raw;
            const record = request.agent ? this.manager.findBySessionId(request.agent.id) : undefined;
            const target = record && request.agent
                ? (this.targets ? this.targets.targetFor(request.agent.id) : record.replyTarget) : undefined;
            if (!record || !target || (record.agent && record.agent !== request.agent))
                return next();
            return this.askViaQQ(record, target, request);
        }, { global: true, prepend: true }));
        this.disposers.push(ctx.on('session/event', (rawSession) => {
            // The durable question projection is updated at the end of the host's append.
            queueMicrotask(() => {
                if (!this.ctx)
                    return;
                const session = rawSession;
                const record = session?.header?.id ? this.manager.findBySessionId(session.header.id) : undefined;
                if (record)
                    this.restore(record.scope, record.replyTarget.targetId);
                this.reconcile();
            });
        }, { global: true }));
    }
    uninstall() {
        for (const dispose of this.disposers.splice(0))
            dispose();
        for (const entry of [...this.pending.values()])
            this.remove(entry, errorWithCode('QQ question channel unloaded'), entry.phase !== 'open');
        this.ctx = undefined;
    }
    cancelPending(sessionKey, record) {
        // A restored native session may still have projected questions before any card interaction hydrated them.
        if (record?.sessionKey === sessionKey)
            this.restore(record.scope, record.replyTarget.targetId);
        for (const entry of [...this.pending.values()]) {
            if (entry.record.sessionKey !== sessionKey)
                continue;
            const ids = this.cancelled.get(entry.record) ?? new Set();
            ids.add(entry.id);
            this.cancelled.set(entry.record, ids);
            this.persist(entry, true);
            this.remove(entry, errorWithCode('Question cancelled with its conversation'), true);
        }
    }
    hasPending(sessionKey) {
        return [...this.pending.values()].some(entry => entry.record.sessionKey === sessionKey && this.current(entry));
    }
    /** Ordinary unassociated text must continue to the conversation. */
    tryAnswer(scope, peerId, text, senderId, quotedMessageId) {
        if (!quotedMessageId || !text.trim())
            return false;
        const entry = [...this.pending.values()].find(candidate => candidate.messageIds.has(quotedMessageId)
            && candidate.target.scope === scope && candidate.target.targetId === peerId);
        return entry !== undefined && this.answerText(scope, peerId, senderId, entry.nonce, text).ok;
    }
    /** Explicit /answer submission; the short request id is also carried by every card. */
    answerText(scope, peerId, senderId, requestId, text) {
        this.restore(scope, peerId);
        const entry = [...this.pending.values()].find(candidate => (candidate.id === requestId || candidate.nonce === requestId)
            && candidate.target.scope === scope && candidate.target.targetId === peerId);
        if (!entry || !this.authorized(entry, senderId))
            return { ok: false, message: '问题不存在、已结束，或你无权回答。' };
        const question = this.currentQuestion(entry);
        if (!question)
            return { ok: false, message: '这组答案正在提交，请勿重复回答。' };
        if (!text.trim())
            return { ok: false, message: '请输入本题的答案。' };
        const answer = parseAnswer(question, text.trim());
        if (question.intent?.kind === 'approval' && (answer.custom !== undefined || answer.selected.length !== 1)) {
            return { ok: false, message: '请点击审批按钮，或输入所列动作的编号。' };
        }
        return this.accept(entry, answer, senderId);
    }
    listPending(scope, peerId, senderId) {
        this.restore(scope, peerId);
        const entries = [...this.pending.values()].filter(entry => entry.target.scope === scope
            && entry.target.targetId === peerId && this.authorized(entry, senderId));
        if (!entries.length)
            return '当前没有可回答的问题。';
        return entries.map(entry => {
            const question = this.currentQuestion(entry);
            return `${entry.taskIds?.length ? `任务 ${entry.taskIds.join('、')}\n` : ''}${entry.nonce}: ${question?.question ?? '答案正在提交'}\n/answer ${entry.nonce} <答案>`;
        }).join('\n\n');
    }
    handleInteraction(event) {
        const raw = event.data?.resolved?.button_data;
        const button = raw ? decodeButtonData(raw) : undefined;
        if (!button || button.t !== 'question' || !button.n || !button.c)
            return false;
        const scope = event.group_openid ? 'group' : 'c2c';
        const peerId = event.group_openid ?? event.user_openid;
        if (peerId)
            this.restore(scope, peerId);
        const entry = this.pending.get(button.n);
        if (!entry || entry.id !== button.c)
            return false;
        if (entry.target.scope !== scope || entry.target.targetId !== peerId)
            return false;
        if (!this.authorized(entry, event.group_member_openid ?? event.user_openid))
            return false;
        const question = this.currentQuestion(entry);
        if (!question || question.id !== button.q || question.multiSelect)
            return false;
        const option = question.options?.[button.i];
        if (!option)
            return false;
        return this.accept(entry, { id: question.id, selected: [option.label] }, (event.group_member_openid ?? event.user_openid)).ok;
    }
    current(entry) {
        return this.manager.getSessionRecord(entry.target.scope, entry.target.targetId) === entry.record
            && entry.record.generation === entry.generation;
    }
    authorized(entry, actor) {
        if (!actor || !this.current(entry))
            return false;
        for (const taskId of entry.taskIds ?? []) {
            const task = this.manager.taskRegistry?.get?.(taskId, entry.target.scope, entry.target.targetId);
            if (!task || task.taskId !== taskId || task.rootSessionId !== entry.request.agent?.id
                || task.runId !== entry.taskRuns?.[taskId] || task.ownerId !== entry.ownerId)
                return false;
        }
        if (entry.target.scope === 'c2c')
            return actor === entry.target.targetId
                && this.config.access?.c2cMode !== 'disabled'
                && (this.config.access?.c2cMode !== 'allowlist' || this.config.access.c2cAllow.includes(actor));
        if (this.config.access?.groupMode === 'disabled'
            || (this.config.access?.groupMode === 'allowlist' && !this.config.access.groupAllow?.includes(entry.target.targetId)))
            return false;
        return actor === entry.ownerId || (this.config.conversation?.taskAdmins?.includes(actor) ?? false);
    }
    currentQuestion(entry) {
        return entry.request.questions.find(question => !entry.answers.has(question.id));
    }
    accept(entry, answer, actor) {
        if (entry.respondent !== undefined && entry.respondent !== actor) {
            return { ok: false, message: '这组问题已由另一位授权用户开始作答，请由同一人完成。' };
        }
        entry.respondent = actor;
        entry.answers.set(answer.id, answer);
        if (entry.answers.size < entry.request.questions.length) {
            void this.sendQuestion(entry).catch(error => this.deliveryFailed(entry, error));
            return { ok: true, message: '已记录，请继续回答下一题。' };
        }
        return this.submit(entry);
    }
    submit(entry) {
        if (!entry.respondent || !this.authorized(entry, entry.respondent)) {
            this.remove(entry, errorWithCode('Question owner or task activation changed'));
            return { ok: false, message: '问题或任务状态已变化，无法提交旧答案。' };
        }
        const result = { answers: entry.request.questions.map(question => entry.answers.get(question.id)) };
        if (entry.phase === 'open') {
            let rollbackActor;
            try {
                if (entry.request.agent && entry.request.wait?.callId && entry.taskIds?.length) {
                    rollbackActor = this.manager.taskRegistry?.noteQuestionOpenAnswer?.(entry.request.agent.id, entry.id, entry.respondent, entry.taskIds);
                }
                const resolve = entry.resolve;
                this.remove(entry);
                resolve?.(result);
                return { ok: true, message: '答案已提交。' };
            }
            catch (error) {
                rollbackActor?.();
                entry.answers.clear();
                this.logger.warn(`QQ open question answer attribution failed: ${String(error)}`);
                return { ok: false, message: '任务状态已变化，请重新回答。' };
            }
        }
        const projected = this.projected(entry.request.agent).find(question => question.callId === entry.id);
        if (projected?.state !== 'continued') {
            return { ok: true, message: '答案已记录，正在等待问题切换为可继续回答状态。' };
        }
        const service = this.ctx?.get('userQuestions');
        if (!service?.answer || !entry.request.agent)
            return { ok: false, message: '当前宿主不支持迟到回答。' };
        let rollbackActor;
        try {
            rollbackActor = entry.respondent ? this.manager.taskRegistry?.noteQuestionAnswer?.(entry.request.agent.id, entry.id, entry.respondent, entry.taskIds) : undefined;
            if (!service.answer(entry.request.agent, entry.id, result)) {
                rollbackActor?.();
                this.remove(entry);
                return { ok: false, message: '该问题已结束。' };
            }
            this.remove(entry);
            return { ok: true, message: '答案已提交，代理将在后续步骤读取。' };
        }
        catch (error) {
            rollbackActor?.();
            if (errorCode(error) === 'REPLY_QUEUED')
                this.remove(entry);
            else
                entry.answers.clear();
            this.logger.warn(`QQ question answer failed: ${String(error)}`);
            return { ok: false, message: errorCode(error) === 'REPLY_QUEUED' ? '该问题的答案已在队列中。' : '答案未提交，请检查答案后重试。' };
        }
    }
    askViaQQ(record, target, request) {
        if (request.signal?.aborted)
            return Promise.reject(errorWithCode('Question already aborted'));
        if (!request.questions.length)
            return Promise.reject(errorWithCode('Question is empty', 'EMPTY_QUESTIONS'));
        return new Promise((resolve, reject) => {
            const entry = this.entry(record, target, request);
            entry.resolve = resolve;
            entry.reject = reject;
            entry.onAbort = () => {
                const reason = request.signal?.reason;
                if (request.wait?.timed && errorCode(reason) === 'ASK_TIMED_OUT') {
                    entry.phase = 'continuing';
                    this.detachWait(entry);
                    entry.resolve = undefined;
                    entry.reject = undefined;
                    reject(reason instanceof Error ? reason : errorWithCode('Question foreground wait expired', 'ASK_TIMED_OUT'));
                    return;
                }
                this.remove(entry, errorWithCode('Question aborted'));
            };
            request.signal?.addEventListener('abort', entry.onAbort, { once: true });
            // Native timed waits own their deadline. Only legacy calls use the plugin's cancellation timeout.
            if (!request.wait?.timed && this.config.askTimeoutMs > 0) {
                entry.timer = setTimeout(() => this.remove(entry, errorWithCode('Question timed out')), this.config.askTimeoutMs);
            }
            void this.sendQuestion(entry).catch(error => this.deliveryFailed(entry, error));
        });
    }
    entry(record, target, request, restoring = false) {
        const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
        const ownership = restoring ? { ownerId: target.scope === 'c2c' ? target.targetId : undefined }
            : this.questionOwnership(record, target, request);
        const entry = {
            record, generation: record.generation, ...ownership,
            target: { ...target }, request,
            id: request.wait?.callId ?? nonce, nonce, phase: 'open', answers: new Map(), messageIds: new Set(),
            release: this.manager.holdActivity?.(target.scope, target.targetId, 'question', record.generation),
        };
        this.pending.set(nonce, entry);
        if (!restoring)
            this.persist(entry);
        return entry;
    }
    /** The model may name a task; only the registry determines who owns it. */
    questionOwnership(record, target, request) {
        const ordinaryOwner = target.scope === 'c2c' ? target.targetId
            : this.config.conversation?.mode === 'interactive' ? this.manager.taskRegistry?.actorFor(request.agent?.id ?? '') : record.senderId;
        const owners = new Set();
        const taskIds = new Set();
        const taskRuns = {};
        for (const question of request.questions) {
            const taskId = /^(task-[^:]+):.+$/.exec(question.id)?.[1];
            if (!taskId) {
                owners.add(ordinaryOwner);
                continue;
            }
            const task = this.manager.taskRegistry?.get?.(taskId, target.scope, target.targetId);
            if (!task || task.taskId !== taskId || task.rootSessionId !== request.agent?.id
                || task.scope !== target.scope || task.peerId !== target.targetId || !task.ownerId || !task.runId) {
                throw errorWithCode(`Question ${question.id} does not identify a task owned by this QQ conversation`, 'BAD_TASK_QUESTION');
            }
            owners.add(task.ownerId);
            taskIds.add(taskId);
            taskRuns[taskId] = task.runId;
        }
        if (taskIds.size && owners.size !== 1) {
            throw errorWithCode('Questions for different task owners must use separate ask_user_question calls', 'MIXED_TASK_OWNERS');
        }
        return { ownerId: owners.values().next().value, ...(taskIds.size ? { taskIds: [...taskIds], taskRuns } : {}) };
    }
    async sendQuestion(entry) {
        const question = this.currentQuestion(entry);
        if (!question || !this.current(entry) || !this.pending.has(entry.nonce))
            return;
        const keyboard = buildKeyboard(question, { callId: entry.id, nonce: entry.nonce });
        const prefix = entry.taskIds?.length ? `任务 ${entry.taskIds.join('、')}\n\n` : '';
        const text = prefix + formatQuestion(question, entry.target.scope === 'group' && this.config.requireMention, keyboard !== undefined, entry.nonce);
        let sent;
        try {
            sent = await this.sender.sendMarkdown(entry.target, text, keyboard ? { keyboard } : undefined);
        }
        catch (error) {
            if (!keyboard || !this.pending.has(entry.nonce))
                throw error;
            sent = await this.sender.sendMarkdown(entry.target, prefix + formatQuestion(question, entry.target.scope === 'group' && this.config.requireMention, false, entry.nonce));
        }
        const messageIds = messageIdsOf(sent);
        if (messageIds.length && this.pending.has(entry.nonce)) {
            for (const id of messageIds)
                entry.messageIds.add(id);
            this.persist(entry);
        }
    }
    deliveryFailed(entry, error) {
        if (!this.pending.has(entry.nonce))
            return;
        if (entry.phase === 'open')
            this.remove(entry, error instanceof Error ? error : new Error(String(error)));
        else
            this.logger.warn(`QQ continued question card could not be delivered; /answer remains available: ${String(error)}`);
    }
    projected(agent) {
        if (!agent?.session)
            return [];
        const reader = this.ctx?.get('sessionProjections');
        if (!reader?.snapshot)
            return [];
        try {
            const view = reader.snapshot(agent.session, ['userQuestions']).values.userQuestions;
            if (!view || typeof view !== 'object' || !('active' in view) || !Array.isArray(view.active))
                return [];
            return view.active.filter((question) => question !== null && typeof question === 'object'
                && typeof question.callId === 'string' && (question.state === 'open' || question.state === 'continued') && Array.isArray(question.questions));
        }
        catch (error) {
            this.logger.warn(`QQ question projection unavailable: ${String(error)}`);
            return [];
        }
    }
    restore(scope, peerId) {
        const record = this.manager.getSessionRecord(scope, peerId);
        if (!record?.agent)
            return;
        for (const question of this.projected(record.agent)) {
            if (question.state !== 'continued' || this.cancelled.get(record)?.has(question.callId))
                continue;
            if ([...this.pending.values()].some(entry => entry.record === record && entry.id === question.callId))
                continue;
            const saved = this.cards.get(record.agent.id, question.callId);
            if (saved?.dismissed || (saved && (saved.scope !== scope || saved.peerId !== peerId)))
                continue;
            const entry = this.entry(record, record.replyTarget, { agent: record.agent, questions: question.questions,
                wait: { callId: question.callId, timed: true } }, true);
            entry.phase = 'continued';
            if (scope === 'group')
                entry.ownerId = undefined;
            if (saved) {
                this.pending.delete(entry.nonce);
                entry.nonce = saved.nonce;
                entry.ownerId = saved.ownerId;
                entry.taskIds = saved.taskIds;
                entry.taskRuns = saved.taskRuns;
                entry.messageIds = new Set(saved.messageIds);
                this.pending.set(entry.nonce, entry);
            }
            this.persist(entry);
        }
    }
    reconcile() {
        for (const entry of [...this.pending.values()]) {
            if (!this.current(entry)) {
                this.remove(entry, errorWithCode('Conversation changed'));
                continue;
            }
            if (entry.phase === 'open')
                continue;
            const question = this.projected(entry.request.agent).find(candidate => candidate.callId === entry.id);
            if (question?.state === 'continued') {
                entry.phase = 'continued';
                if (entry.answers.size === entry.request.questions.length)
                    this.submit(entry);
            }
            else if (entry.phase === 'continued')
                this.remove(entry);
        }
    }
    detachWait(entry) {
        if (entry.timer)
            clearTimeout(entry.timer);
        if (entry.onAbort)
            entry.request.signal?.removeEventListener('abort', entry.onAbort);
        entry.timer = undefined;
        entry.onAbort = undefined;
    }
    persist(entry, dismissed = false) {
        if (!entry.request.agent || !entry.request.wait?.timed)
            return;
        this.cards.set({ sessionId: entry.request.agent.id, callId: entry.id,
            scope: entry.target.scope, peerId: entry.target.targetId, ownerId: entry.ownerId,
            nonce: entry.nonce, messageIds: [...entry.messageIds], taskIds: entry.taskIds, taskRuns: entry.taskRuns, dismissed });
    }
    remove(entry, error, preserveCard = false) {
        if (!this.pending.delete(entry.nonce))
            return;
        this.detachWait(entry);
        entry.release?.();
        if (!preserveCard && entry.request.agent)
            this.cards.delete(entry.request.agent.id, entry.id);
        if (error)
            entry.reject?.(error);
    }
}
//# sourceMappingURL=question-channel.js.map