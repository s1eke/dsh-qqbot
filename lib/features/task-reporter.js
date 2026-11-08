import { chunkMarkdownText } from "../transport/chunker.js";
import { formatTask } from "./task-registry.js";
/** A report is a delivery of an existing run result, never a new execution. */
export class TaskReporter {
    manager;
    registry;
    sender;
    config;
    files;
    pending = new Map();
    constructor(manager, registry, sender, config, files) {
        this.manager = manager;
        this.registry = registry;
        this.sender = sender;
        this.config = config;
        this.files = files;
    }
    report(agent, id, signal) {
        const record = this.manager.findByAgent(agent);
        if (!record)
            return Promise.reject(new Error('Only the current QQ root can report its tasks'));
        const task = this.registry.get(id, record.scope, record.peerId);
        if (!task || task.rootSessionId !== record.sessionId || !task.settled) {
            return Promise.reject(new Error('Task has no verified terminal result in this conversation'));
        }
        const receipt = { taskId: task.taskId, runId: task.runId, delivered: true, duplicate: false };
        if (task.delivery === 'sent')
            return Promise.resolve({ ...receipt, duplicate: true });
        const key = `${task.taskId}:${task.runId}`;
        const existing = this.pending.get(key);
        if (existing)
            return existing;
        const generation = record.generation;
        const target = { ...record.replyTarget, scope: task.scope, targetId: task.peerId };
        const assertCurrent = () => {
            signal.throwIfAborted();
            if (this.manager.findByAgent(agent) !== record || record.generation !== generation
                || this.registry.get(task.taskId, task.scope, task.peerId)?.runId !== task.runId) {
                throw new Error('Task report belongs to a closed conversation or earlier activation');
            }
        };
        const release = this.manager.holdActivity(record.scope, record.peerId, 'input', generation);
        const sending = Promise.resolve().then(async () => {
            try {
                for (const chunk of chunkMarkdownText(formatTask(task, true), this.config.textChunkLimit)) {
                    assertCurrent();
                    await this.sender.sendMarkdown(target, chunk);
                }
                assertCurrent();
                if (this.config.sendFile.sendPresentedFiles && task.files?.length && this.files) {
                    const result = await this.files.deliverWithReceipt(target, task.files, assertCurrent);
                    if (result.missed.length)
                        throw new Error(`部分交付物未送达：${result.missed.join('、')}`);
                }
                assertCurrent();
                this.registry.markDelivery(task.taskId, task.runId, 'sent');
                return receipt;
            }
            catch (error) {
                this.registry.markDelivery(task.taskId, task.runId, 'failed', error instanceof Error ? error.message : String(error));
                throw error;
            }
            finally {
                release();
                this.pending.delete(key);
            }
        });
        this.pending.set(key, sending);
        return sending;
    }
}
export function registerTaskReporter(ctx, reporter, logger) {
    const tools = ctx.get('tools');
    if (!tools?.register) {
        logger.warn('QQ task reporting tool unavailable: host has no tools registry');
        return;
    }
    tools.register({
        name: 'qqbot_report_task',
        description: 'Deliver a settled background task result and its declared files to this QQ conversation. Use once after reviewing a native task completion; do not repeat the delivered text in your reply. Delivery failures can be retried without rerunning the task.',
        parameters: { type: 'object', properties: { task: { type: 'string', description: 'Task ID, full native agent name, or child session ID from the task context.' } }, required: ['task'], additionalProperties: false },
        output: { schema: { type: 'object', properties: {
                    taskId: { type: 'string' }, runId: { type: 'string' }, delivered: { type: 'boolean' }, duplicate: { type: 'boolean' },
                }, required: ['taskId', 'runId', 'delivered', 'duplicate'], additionalProperties: false },
            render: (_args, result) => [{ type: 'text', text: result.duplicate
                        ? `${result.taskId} 已经送达，无需重复正文。` : `${result.taskId} 结果已送达 QQ，无需重复正文。` }] },
        execute: (args, exec) => {
            if (!exec.agent || typeof args.task !== 'string')
                throw new Error('A QQ root and task ID are required');
            return reporter.report(exec.agent, args.task, exec.signal);
        },
    });
}
//# sourceMappingURL=task-reporter.js.map