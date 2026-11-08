/** QQ task addresses and outcomes; execution stays owned by the dsh subagent runtime. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PLUGIN_HOME } from "../shared/dirs.js";
const terminal = new Set(['completed', 'failed', 'cancelled']);
export class TaskRegistry {
    options;
    tasks = new Map();
    roots = new Map();
    timers = new Map();
    inputs = new Map();
    principals = new WeakMap();
    origins = new WeakMap();
    questionActors = new WeakMap();
    openQuestionActors = new WeakMap();
    answerForwards = new WeakMap();
    eventOffsets = new Map();
    eventEnds = new Map();
    runAgents = new Map();
    disposers = [];
    path;
    disposed = false;
    storageError;
    constructor(options) {
        this.options = options;
        this.path = options.storagePath ?? resolve(PLUGIN_HOME, 'tasks', `${encodeURIComponent(options.appId)}.json`);
        this.load();
    }
    noteInput(messageId, senderId, origin) {
        if (messageId && senderId)
            this.inputs.set(messageId, { senderId, ...origin });
    }
    forgetInput(messageId) { this.inputs.delete(messageId); }
    forgetSession(rootSessionId) {
        for (const [id, origin] of this.inputs)
            if (origin.rootSessionId === rootSessionId)
                this.inputs.delete(id);
        const agent = this.options.manager.findBySessionId(rootSessionId)?.agent;
        if (agent) {
            this.principals.delete(agent);
            this.origins.delete(agent);
            this.questionActors.delete(agent);
            this.openQuestionActors.delete(agent);
            this.answerForwards.delete(agent);
        }
    }
    /** Bind a verified native late answer to its actual responder before inbox acceptance. */
    noteQuestionAnswer(rootSessionId, callId, senderId, taskIds = []) {
        return this.registerQuestionAnswer(rootSessionId, callId, senderId, taskIds, false);
    }
    /** An open question's answer becomes actionable only after its real successful tool result. */
    noteQuestionOpenAnswer(rootSessionId, callId, senderId, taskIds = []) {
        return this.registerQuestionAnswer(rootSessionId, callId, senderId, taskIds, true);
    }
    registerQuestionAnswer(rootSessionId, callId, senderId, taskIds, open) {
        const record = this.options.manager.findBySessionId(rootSessionId);
        if (!record || !callId || !senderId)
            return () => { };
        const registrations = open ? this.openQuestionActors : this.questionActors;
        let calls = registrations.get(record.agent);
        if (!calls) {
            calls = new Map();
            registrations.set(record.agent, calls);
        }
        const tasks = taskIds.flatMap(id => {
            const task = this.tasks.get(id);
            return task && this.rootRecord(task)?.agent === record.agent && this.canOperate(task, senderId)
                ? [{ taskId: task.taskId, runId: task.runId }] : [];
        });
        const registration = { senderId, tasks, ...(open ? { offset: record.agent.session.snapshotEvents().length } : {}) };
        calls.set(callId, registration);
        return () => { if (calls.get(callId) === registration)
            calls.delete(callId); };
    }
    /** The model step, not the latest network arrival, determines the acting user. */
    noteStep(agent, messages) {
        this.answerForwards.delete(agent);
        const answered = this.consumeOpenAnswers(agent);
        if (messages.length === 0 && answered.length === 0)
            return;
        const actors = new Set(answered.map(answer => answer.senderId));
        for (const answer of answered)
            this.allowAnswerForward(agent, answer);
        for (const message of messages) {
            const id = typeof message.id === 'string' ? message.id : '';
            const input = this.inputs.get(id);
            if (input !== undefined) {
                const sameRoot = input.rootSessionId === undefined || input.rootSessionId === agent.id;
                actors.add(sameRoot ? input.senderId : '');
                if (sameRoot)
                    this.origins.set(agent, { messageId: input.qqMessageId ?? id, generation: input.generation });
                this.inputs.delete(id);
            }
            else if (message.source?.kind === 'user-question-reply') {
                const calls = this.questionActors.get(agent);
                const answer = message.source.callId ? calls?.get(message.source.callId) : undefined;
                actors.add(answer && message.source.outcome === 'answered' ? answer.senderId : '');
                if (answer && message.source.outcome === 'answered')
                    this.allowAnswerForward(agent, answer);
                if (message.source.callId)
                    calls?.delete(message.source.callId);
            }
            else if (message.source?.senderSessionId) {
                const task = this.currentForChild(message.source.senderSessionId);
                if (task && this.rootRecord(task)?.agent === agent)
                    actors.add(task.ownerId);
                else
                    actors.add('');
            }
            else if (message.source?.kind === 'user') {
                actors.add(''); // Desktop or unknown input cannot borrow a QQ user's authority.
            }
        }
        this.principals.set(agent, actors);
        if (actors.size !== 1 || actors.has(''))
            this.origins.delete(agent);
    }
    install(ctx) {
        const listen = (event, handler, prepend = false) => {
            const dispose = ctx.on(event, handler, { global: true, prepend });
            if (typeof dispose === 'function')
                this.disposers.push(dispose);
        };
        listen('subagent/start', (info) => { if (isLifecycle(info))
            this.onStart(info); });
        listen('subagent/end', (info) => { if (isLifecycle(info))
            this.onEnd(info); });
        listen('agent/pre-step', async (raw, delegate) => {
            const step = raw;
            if (step?.agent && Array.isArray(step.messages))
                this.noteStep(step.agent, step.messages);
            return delegate();
        }, true);
        listen('agent/inbox/discarded', (raw) => {
            const { agent, message } = raw;
            if (typeof message?.id === 'string')
                this.inputs.delete(message.id);
            if (agent && message?.source?.kind === 'user-question-reply' && message.source.callId)
                this.questionActors.get(agent)?.delete(message.source.callId);
        });
        listen('agent/inbox/inserted', (raw) => {
            const payload = raw;
            if (payload.agent && payload.message)
                this.noteProgress(payload.agent, payload.message);
        });
        listen('tools/pre-execute', async (raw, delegate) => {
            const denial = await this.authorizeTool(raw);
            return denial ? { kind: 'deny', reason: denial } : delegate();
        }, true);
    }
    /** Observe an accepted native activation. No agent is started by this registry. */
    onStart(info) {
        if (this.disposed || this.findRun(info.runId))
            return;
        const record = this.resolveRoot(info);
        if (!record)
            return;
        const previous = this.currentForChild(info.id);
        const child = this.agents()?.get(info.id);
        const eventCount = child?.session.snapshotEvents().length ?? 0;
        if (previous) {
            if (this.eventOffsets.has(previous.runId))
                this.eventEnds.set(previous.runId, eventCount);
            this.clearTimer(previous.runId);
        }
        const previousResult = previous && this.finalText(previous, { ...info, runId: previous.runId });
        const ownerId = previous?.ownerId ?? this.ownerFor(record.agent, record);
        const origin = this.origins.get(record.agent);
        // A mixed-author step has no safe task owner; the pre-execute gate rejects starts.
        const task = {
            taskId: previous?.taskId ?? `task-${randomUUID().slice(0, 8)}`,
            appId: this.options.appId, scope: record.scope, peerId: record.peerId,
            ownerId: ownerId ?? '', rootSessionId: record.sessionId,
            parentSessionId: info.parentSessionId, childId: info.id, runId: info.runId,
            originMessageId: previous?.originMessageId ?? origin?.messageId,
            generation: origin?.generation ?? record.generation,
            name: previous?.name ?? info.id, title: previous?.title ?? '后台任务',
            provider: info.provider, local: info.local, state: 'running', settled: false,
            startedAt: Date.now(), updatedAt: Date.now(), delivery: 'unconfirmed',
            attempts: previous ? [...previous.attempts, { ...attemptOf(previous),
                    output: previous.output ?? previousResult?.output, files: previous.files ?? previousResult?.files }] : [],
        };
        this.tasks.set(task.taskId, task);
        this.roots.set(task.taskId, record.agent);
        this.eventOffsets.set(info.runId, eventCount);
        if (child)
            this.runAgents.set(info.runId, child);
        this.persist();
        this.armTimeout(task, record.agent);
        void this.resolveLabel(task, record.agent);
    }
    onEnd(info) {
        const task = this.findRun(info.runId);
        if (!task || task.childId !== info.id || task.parentSessionId !== info.parentSessionId)
            return;
        this.clearTimer(info.runId);
        const state = resultState(info.stopReason);
        const final = this.finalText(task, info);
        this.eventOffsets.delete(info.runId);
        this.eventEnds.delete(info.runId);
        this.runAgents.delete(info.runId);
        if (task.runId !== info.runId) {
            const attempt = task.attempts.find(item => item.runId === info.runId);
            if (attempt)
                Object.assign(attempt, { state, endedAt: Date.now(), stopReason: info.stopReason, output: final.output, files: final.files });
        }
        else {
            Object.assign(task, { state, settled: true, endedAt: Date.now(), updatedAt: Date.now(), stopReason: info.stopReason, output: final.output, files: final.files,
                ...(final.evidence ? { evidence: final.evidence } : {}) });
        }
        this.persist();
    }
    /** Capture source-attributed child reports even when the settlement notice omits them. */
    noteProgress(recipient, message) {
        if (message.source?.kind !== 'agent-message' || !message.source.senderSessionId)
            return;
        const task = this.currentForChild(message.source.senderSessionId);
        if (!task || task.settled || this.rootRecord(task)?.agent !== recipient)
            return;
        const output = textOf(message.content);
        if (!output)
            return;
        task.progress = output;
        task.evidence = { sessionId: recipient.id, ...(typeof message.id === 'string' ? { messageId: message.id } : {}) };
        task.updatedAt = Date.now();
        this.persist();
    }
    list(scope, peerId) {
        return [...this.tasks.values()].filter(task => task.scope === scope && task.peerId === peerId)
            .sort((a, b) => b.startedAt - a.startedAt).map(copyTask);
    }
    get(id, scope, peerId) {
        const task = [...this.tasks.values()].find(item => item.scope === scope && item.peerId === peerId
            && (item.taskId === id || item.childId === id || item.name === id));
        return task && copyTask(task);
    }
    /** Only a current, local native activation can route a child approval to QQ. */
    resolveAgent(sessionId) {
        const task = this.currentForChild(sessionId);
        if (!task?.local || task.settled || terminal.has(task.state))
            return undefined;
        const record = this.rootRecord(task);
        const child = this.agents()?.get(sessionId);
        if (!record || !child)
            return undefined;
        try {
            if (this.runtime()?.rootOf(child) !== record.agent)
                return undefined;
        }
        catch {
            return undefined;
        }
        return { record, task: copyTask(task), ownerId: task.ownerId };
    }
    canOperate(task, senderId) {
        if (!senderId)
            return false;
        if (task.scope === 'c2c')
            return senderId === task.peerId;
        return senderId === task.ownerId || (this.options.taskAdmins ?? []).includes(senderId);
    }
    /** Snapshot this when presenting a question; arrivals alone never change it. */
    currentActor(rootSessionId) {
        const record = this.options.manager.findBySessionId(rootSessionId);
        return record ? this.ownerFor(record.agent, record) : undefined;
    }
    actorFor(agentId) {
        const task = this.resolveAgent(agentId);
        return task?.ownerId || this.currentActor(agentId);
    }
    /** Advertise only native tools visible in this agent's actual tool scope. */
    capabilityText(agent) {
        const record = this.options.manager.findBySessionId(agent.id);
        if (record?.agent !== agent)
            return '';
        if (!this.supportsManagedTasks(agent))
            return '';
        const tools = this.options.getService('tools');
        const available = ['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'wait_agent']
            .filter(name => tools?.get?.(name, agent));
        if (!available.includes('subagent') && !available.includes('subagent_fork'))
            return '';
        const tasks = this.list(record.scope, record.peerId).filter(task => task.rootSessionId === agent.id).slice(0, 12);
        return [
            `当前可用后台工具：${available.join('、')}。`,
            '你负责及时交流与协调；耗时工作交给本地后台子代理，提交后继续处理用户消息。只委派一层，不阻塞等待任务结果；收到原生结算后核实结果并汇报。',
            '子代理的问题由你向用户转述；得到答案后继续原任务。不要将 inactive 或工具调用结束当作业务成功。已有任务补充先确认目标，不重复创建任务。',
            ...(tools?.get?.('ask_user_question', agent) ? ['向用户转述后台任务问题时，ask_user_question 的 questions[].id 使用 <taskId>:<questionId>，只引用已登记的任务编号；不同发起者的任务分开提问。收到答案后，下一步立即 send_message 转发给对应任务。'] : []),
            ...(tools?.get?.('qqbot_report_task', agent) ? ['后台任务结算后，用 qqbot_report_task 发布保存的结果和文件；工具会确认 QQ 投递，请勿再重复结果正文。'] : []),
            ...tasks.map(task => `${task.taskId} / ${task.name}：${task.title}（${task.state}，${task.local ? '支持后续消息' : '不支持后续消息'}）`),
        ].join('\n');
    }
    /** An idle interrupted activation still holds its parent until native cleanup ends. */
    hasActive(rootSessionId) {
        return [...this.tasks.values()].some(task => task.rootSessionId === rootSessionId && !task.settled && !!this.rootRecord(task));
    }
    /** A host disposal without confirmed drain is loss of ownership, not successful cancellation. */
    forgetRoot(agent) {
        for (const task of this.tasks.values()) {
            if (this.roots.get(task.taskId) !== agent)
                continue;
            this.clearTimer(task.runId);
            this.roots.delete(task.taskId);
            if (!task.settled) {
                task.state = 'unknown';
                task.updatedAt = Date.now();
            }
        }
        this.principals.delete(agent);
        this.origins.delete(agent);
        this.questionActors.delete(agent);
        this.openQuestionActors.delete(agent);
        this.answerForwards.delete(agent);
        this.persist();
    }
    /** Call only after the host has successfully drained this root's tree. */
    closeRoot(rootSessionId, exactRoot) {
        const root = exactRoot ?? this.options.manager.findBySessionId(rootSessionId)?.agent;
        if (!root)
            return;
        for (const task of this.tasks.values()) {
            if (task.rootSessionId !== rootSessionId || this.roots.get(task.taskId) !== root)
                continue;
            this.clearTimer(task.runId);
            if (!task.settled)
                Object.assign(task, { state: 'cancelled', settled: true, endedAt: Date.now(), updatedAt: Date.now() });
            this.roots.delete(task.taskId);
        }
        this.persist();
    }
    /** Requests interruption of one exact run; acceptance does not assert quiescence. */
    async interrupt(id, actor, expectedRunId) {
        const view = this.get(id, actor.scope, actor.peerId);
        if (!view)
            return { ok: false, message: '找不到该任务' };
        const task = this.tasks.get(view.taskId);
        if (!this.canOperate(task, actor.senderId))
            return { ok: false, message: '只有任务发起者或任务管理员可以停止该任务' };
        if (expectedRunId !== undefined && task.runId !== expectedRunId)
            return { ok: false, message: '该次执行已结束，未停止新的执行' };
        return this.interruptExact(task.taskId, task.runId, this.roots.get(task.taskId));
    }
    markDelivery(taskId, runId, status, error) {
        const task = this.tasks.get(taskId);
        if (!task || task.runId !== runId)
            return;
        task.delivery = status;
        task.deliveryError = status === 'failed' ? error : undefined;
        task.updatedAt = Date.now();
        this.persist();
    }
    dispose() {
        this.disposed = true;
        for (const timer of this.timers.values())
            clearTimeout(timer);
        this.timers.clear();
        this.inputs.clear();
        this.eventOffsets.clear();
        this.eventEnds.clear();
        this.runAgents.clear();
        for (const dispose of this.disposers.splice(0))
            dispose();
    }
    /** Enforce natural-language task controls at the actual native tool boundary. */
    async authorizeTool(exec) {
        if (!exec?.agent)
            return undefined;
        const root = this.rootForCaller(exec.agent);
        if (!root)
            return undefined;
        const creator = exec.name === 'subagent' || exec.name === 'subagent_fork';
        const control = exec.name === 'send_message' || exec.name === 'interrupt_agent';
        if (!creator && !control)
            return undefined;
        if (!this.supportsManagedTasks(root.agent)) {
            if (this.options.conversationMode !== 'interactive')
                return undefined;
            return '当前宿主缺少可管理的后台任务能力，请升级宿主或切换 serial 模式。';
        }
        const callerTask = this.currentForChild(exec.agent.id);
        const senderId = callerTask?.ownerId ?? this.ownerFor(exec.agent, root);
        if (!senderId && (creator || !this.answerForwards.get(exec.agent)?.size))
            return '无法确定本次任务操作的 QQ 发起者；请单独发送任务指令。';
        if (creator)
            return exec.agent === root.agent ? undefined : 'QQ 后台任务只支持主代理直接委派一层';
        const args = objectOf(exec.arguments);
        const reference = typeof args?.agent === 'string' ? args.agent : undefined;
        if (!reference)
            return '任务操作缺少明确目标';
        const runtime = this.runtime();
        let targetId = reference;
        if (runtime?.resolveName)
            targetId = await runtime.resolveName(exec.agent, reference, exec.signal);
        else if (reference === 'lead')
            targetId = root.sessionId;
        else
            targetId = this.get(reference, root.scope, root.peerId)?.childId ?? reference;
        if (exec.signal.aborted || this.rootForCaller(exec.agent)?.agent !== root.agent)
            return '任务操作已取消或会话已关闭';
        if (targetId === root.sessionId && exec.name === 'send_message' && callerTask)
            return undefined;
        const task = this.currentForChild(targetId);
        const forwarded = task && exec.name === 'send_message' ? this.answerForwards.get(exec.agent)?.get(task.taskId) : undefined;
        const responder = forwarded?.runId === task?.runId ? forwarded?.senderId : undefined;
        if (!task || task.rootSessionId !== root.sessionId || !this.canOperate(task, responder ?? senderId ?? ''))
            return '无权操作该 QQ 任务';
        if (exec.name === 'send_message' && !task.local)
            return '该外部任务不支持后续消息';
        if (root.scope === 'group' && !this.rootRecord(task))
            return '任务所属会话已关闭';
        if (responder)
            this.answerForwards.get(exec.agent)?.delete(task.taskId);
        return undefined;
    }
    consumeOpenAnswers(agent) {
        const pending = this.openQuestionActors.get(agent);
        if (!pending?.size)
            return [];
        const events = agent.session.snapshotEvents();
        const answers = [];
        for (const [callId, actor] of pending) {
            const result = events.slice(actor.offset ?? events.length).find(event => {
                const data = objectOf(event.data) ?? event;
                return (event.type === 'tool/result' && objectOf(data.message)?.toolCallId === callId)
                    || (event.type === 'tool/subresult' && data.subCallId === callId);
            });
            if (!result)
                continue;
            pending.delete(callId);
            const data = objectOf(result.data) ?? result;
            if (objectOf(data.message)?.isError !== true && data.isError !== true)
                answers.push(actor);
        }
        return answers;
    }
    allowAnswerForward(agent, answer) {
        let forwards = this.answerForwards.get(agent);
        if (!forwards) {
            forwards = new Map();
            this.answerForwards.set(agent, forwards);
        }
        for (const target of answer.tasks) {
            const task = this.tasks.get(target.taskId);
            if (task?.runId === target.runId && this.rootRecord(task)?.agent === agent && this.canOperate(task, answer.senderId)) {
                forwards.set(target.taskId, { ...target, senderId: answer.senderId });
            }
        }
    }
    interruptExact(taskId, runId, root) {
        const task = this.tasks.get(taskId);
        if (!task || task.runId !== runId || task.settled)
            return { ok: false, message: '该次执行已经结束' };
        const record = this.rootRecord(task);
        const runtime = this.runtime();
        if (!root || record?.agent !== root || !runtime)
            return { ok: false, message: '任务状态待核实，当前无法安全停止' };
        const child = this.agents()?.get(task.childId);
        try {
            // No await between the run/root checks and the native cancellation operation.
            runtime.interrupt(task.childId, { kind: 'ancestor', agent: root });
        }
        catch (error) {
            return { ok: false, message: `停止失败：${errorText(error)}` };
        }
        if (task.settled || this.tasks.get(taskId)?.runId !== runId)
            return { ok: true, message: `停止请求已处理，${task.taskId} 的该次执行已结束`, task: copyTask(task) };
        task.state = 'stopping';
        task.updatedAt = Date.now();
        this.clearTimer(runId);
        this.persist();
        if (child)
            void child.whenIdle().then(() => {
                const current = this.tasks.get(taskId);
                if (this.disposed || current?.runId !== runId || current.settled || this.roots.get(taskId) !== root)
                    return;
                current.state = 'stopped';
                current.updatedAt = Date.now();
                this.persist();
            }).catch(error => this.options.logger.warn(`task idle observation failed: ${errorText(error)}`));
        return { ok: true, message: `已请求停止 ${task.taskId}，正在等待执行结束`, task: copyTask(task) };
    }
    armTimeout(task, root) {
        const timeout = this.options.timeoutMs ?? 60 * 60 * 1000;
        if (timeout <= 0)
            return;
        const { taskId, runId } = task;
        const timer = setTimeout(() => {
            this.timers.delete(runId);
            if (this.disposed)
                return;
            const outcome = this.interruptExact(taskId, runId, root);
            if (!outcome.ok)
                this.options.logger.warn(`task timeout could not stop ${taskId}: ${outcome.message}`);
        }, timeout);
        timer.unref?.();
        this.timers.set(runId, timer);
    }
    clearTimer(runId) {
        const timer = this.timers.get(runId);
        if (timer)
            clearTimeout(timer);
        this.timers.delete(runId);
    }
    rootRecord(task) {
        const record = this.options.manager.findBySessionId(task.rootSessionId);
        return record?.agent === this.roots.get(task.taskId) ? record : undefined;
    }
    rootForCaller(agent) {
        const direct = this.options.manager.findBySessionId(agent.id);
        if (direct?.agent === agent)
            return direct;
        try {
            const root = this.runtime()?.rootOf(agent);
            const record = root && this.options.manager.findBySessionId(root.id);
            return record?.agent === root ? record : undefined;
        }
        catch {
            return undefined;
        }
    }
    resolveRoot(info) {
        const child = info.local ? this.agents()?.get(info.id) : undefined;
        if (child)
            return this.rootForCaller(child);
        const parent = this.agents()?.get(info.parentSessionId);
        return parent ? this.rootForCaller(parent) : undefined;
    }
    ownerFor(agent, record) {
        if (record.scope === 'c2c')
            return record.peerId;
        const principals = this.principals.get(agent);
        return principals?.size === 1 ? [...principals][0] || undefined : undefined;
    }
    currentForChild(id) {
        return [...this.tasks.values()].find(task => task.childId === id);
    }
    findRun(id) {
        return [...this.tasks.values()].find(task => task.runId === id || task.attempts.some(attempt => attempt.runId === id));
    }
    agents() { return this.options.getService('agents'); }
    runtime() { return this.options.getService('subagents'); }
    supportsManagedTasks(agent) {
        const native = this.options.getService('subagents');
        return typeof agent.steer === 'function' && typeof native?.startActivation === 'function'
            && typeof native.rootOf === 'function' && typeof native.drainDescendants === 'function';
    }
    finalText(task, info) {
        const supplied = textOf(info.lastAssistantMessage);
        // Only scan the observed activation suffix, never a previous run's transcript.
        const offset = this.eventOffsets.get(info.runId);
        // Native end is published after disposal removes the child from AgentRegistry.
        const child = this.runAgents.get(info.runId);
        const events = offset === undefined ? [] : child?.session.snapshotEvents().slice(offset, this.eventEnds.get(info.runId)) ?? [];
        const files = events.flatMap(event => {
            if (event.type !== 'deliverables/presented')
                return [];
            const data = objectOf(event.data) ?? event;
            return Array.isArray(data.files) ? data.files.flatMap(raw => {
                const file = objectOf(raw);
                return typeof file?.path === 'string' ? [{ path: file.path, ...(typeof file.description === 'string' ? { description: file.description } : {}) }] : [];
            }) : [];
        });
        if (supplied)
            return { output: supplied, evidence: { sessionId: task.childId }, files };
        if (task.runId === info.runId && task.progress)
            return { output: task.progress, evidence: task.evidence, files };
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            if (event.type !== 'assistant/message')
                continue;
            const data = objectOf(event.data) ?? event;
            const output = textOf(objectOf(data.message)?.content);
            if (output)
                return { output, evidence: { sessionId: task.childId, ...(typeof event.seq === 'number' ? { seq: event.seq } : {}) }, files };
        }
        const prior = task.attempts.find(attempt => attempt.runId === info.runId);
        return { output: task.runId === info.runId ? task.progress ?? task.output ?? '' : prior?.output ?? '', evidence: task.runId === info.runId ? task.evidence : undefined,
            files: files.length ? files : prior?.files };
    }
    async resolveLabel(task, root) {
        const runtime = this.runtime();
        try {
            const child = this.agents()?.get(task.childId);
            if (child && runtime?.namesOf)
                task.name = runtime.namesOf(child).self;
            if (runtime?.listDescendants) {
                const entries = await runtime.listDescendants(root.id);
                if (this.disposed || this.tasks.get(task.taskId) !== task || this.rootRecord(task)?.agent !== root)
                    return;
                const entry = entries.find(item => item.id === task.childId && item.kind === 'child');
                if (entry?.path)
                    task.name = entry.path;
                if (entry?.label)
                    task.title = entry.label;
            }
            this.persist();
        }
        catch (error) {
            this.options.logger.warn(`task label unavailable: ${errorText(error)}`);
        }
    }
    load() {
        if (!this.path)
            return;
        try {
            const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
            const file = objectOf(parsed);
            if (file?.version !== 1 || !Array.isArray(file.tasks))
                throw new Error('unsupported task store');
            for (const raw of file.tasks) {
                if (!isStoredTask(raw) || raw.appId !== this.options.appId)
                    throw new Error('invalid task record');
                const task = copyTask(raw);
                if (!task.settled)
                    task.state = 'unknown';
                this.tasks.set(task.taskId, task);
            }
        }
        catch (error) {
            if (objectOf(error)?.code === 'ENOENT')
                return;
            this.storageError = `任务记录读取失败：${errorText(error)}`;
            this.options.logger.error(this.storageError);
        }
    }
    persist() {
        if (!this.path || this.disposed)
            return;
        // Never overwrite an unreadable store: preserve it for recovery.
        if (this.storageError?.startsWith('任务记录读取失败'))
            return;
        const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            writeFileSync(temporary, JSON.stringify({ version: 1, tasks: [...this.tasks.values()] }), { mode: 0o600 });
            renameSync(temporary, this.path);
            this.storageError = undefined;
        }
        catch (error) {
            this.storageError = `任务记录保存失败：${errorText(error)}`;
            this.options.logger.error(this.storageError);
            try {
                unlinkSync(temporary);
            }
            catch { /* The temporary file may not have been created. */ }
        }
    }
}
function attemptOf(task) {
    return { runId: task.runId, state: task.state, startedAt: task.startedAt, endedAt: task.endedAt, stopReason: task.stopReason, output: task.output, files: task.files?.map(file => ({ ...file })) };
}
function copyTask(task) { return { ...task, files: task.files?.map(file => ({ ...file })), ...(task.evidence ? { evidence: { ...task.evidence } } : {}), attempts: task.attempts.map(attempt => ({ ...attempt, files: attempt.files?.map(file => ({ ...file })) })) }; }
function objectOf(value) {
    return typeof value === 'object' && value !== null ? value : undefined;
}
function isLifecycle(value) {
    const item = objectOf(value);
    return !!item && ['id', 'runId', 'parentSessionId', 'provider'].every(key => typeof item[key] === 'string') && typeof item.local === 'boolean';
}
function isStoredTask(value) {
    const item = objectOf(value);
    return !!item && ['taskId', 'appId', 'peerId', 'ownerId', 'rootSessionId', 'parentSessionId', 'childId', 'runId', 'name', 'title', 'provider'].every(key => typeof item[key] === 'string')
        && (item.scope === 'c2c' || item.scope === 'group') && typeof item.local === 'boolean' && typeof item.settled === 'boolean'
        && typeof item.startedAt === 'number' && typeof item.updatedAt === 'number'
        && ['running', 'stopping', 'stopped', 'completed', 'failed', 'cancelled', 'unknown'].includes(String(item.state))
        && ['unconfirmed', 'sent', 'failed'].includes(String(item.delivery)) && Array.isArray(item.attempts)
        && validFiles(item.files)
        && item.attempts.every(raw => { const attempt = objectOf(raw); return !!attempt && typeof attempt.runId === 'string' && typeof attempt.startedAt === 'number' && validFiles(attempt.files); });
}
function validFiles(value) {
    return value === undefined || (Array.isArray(value) && value.every(raw => {
        const file = objectOf(raw);
        return typeof file?.path === 'string' && (file.description === undefined || typeof file.description === 'string');
    }));
}
function resultState(reason) {
    if (reason === 'completed')
        return 'completed';
    if (reason === 'aborted' || reason === 'cancelled' || reason === 'interrupted')
        return 'cancelled';
    return 'failed';
}
function textOf(value) {
    if (!Array.isArray(value))
        return '';
    return value.flatMap(block => { const part = objectOf(block); return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []; }).join('\n');
}
function errorText(error) { return error instanceof Error ? error.message : String(error); }
export function formatTask(task, includeResult = false) {
    const states = { running: '执行中', stopping: '停止中', stopped: '当前执行已停止', completed: '执行已结束', failed: '执行失败', cancelled: '已取消', unknown: '状态待核实' };
    const delivery = { unconfirmed: '结果送达尚未确认', sent: '结果已送达', failed: '结果投递失败' }[task.delivery];
    return [`${task.taskId} · ${task.title}`, `状态：${states[task.state]}；${task.local ? '可追加要求' : '不支持后续消息'}`,
        `代理：${task.name}`, ...(task.settled ? [`投递：${delivery}`] : []),
        ...(!task.settled && task.progress ? [`最近进展：${task.progress}`] : []),
        ...(includeResult ? [task.output || '暂无最终文本；停止或空闲不代表任务已成功完成。'] : []),
        ...(includeResult && task.settled && task.progress && task.progress !== task.output ? [`任务消息：${task.progress}`] : []),
        ...(includeResult && task.files?.length ? ['结果文件：', ...task.files.map(file => `${file.path}${file.description ? ` — ${file.description}` : ''}`)] : []),
        ...(task.deliveryError ? [`投递错误：${task.deliveryError}`] : [])].join('\n');
}
//# sourceMappingURL=task-registry.js.map