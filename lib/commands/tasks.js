import { getScopePeer, sendMarkdownChunked } from "../shared/index.js";
import { formatTask } from "../features/task-registry.js";
export function tasksCommand({ manager, config }) {
    return {
        name: 'tasks', category: 'agent', scope: 'all', description: '查看后台任务及结果',
        handler: async (ctx) => {
            const registry = manager.taskRegistry;
            if (!registry)
                return '当前未启用后台任务跟踪';
            const { scope, peerId } = getScopePeer(ctx);
            const tasks = registry.list(scope, peerId);
            const questions = manager.questionChannel?.listPending(scope, peerId, ctx.message.senderId);
            const approvals = manager.approvalChannel?.listPending(scope, peerId, ctx.message.senderId);
            const text = [registry.storageError, tasks.length ? tasks.slice(0, 20).map(task => formatTask(task)).join('\n\n') : '当前没有后台任务',
                tasks.length ? '使用 /task <任务编号> 查看结果，/stop <任务编号> 停止该次执行。' : undefined,
                tasks.length > 20 ? '仅展示最近 20 个任务；旧结果仍可通过任务编号查询。' : undefined,
                questions && questions !== '当前没有可回答的问题。' ? `待答问题：\n${questions}` : undefined,
                approvals || undefined].filter(Boolean).join('\n\n');
            await sendMarkdownChunked(ctx, text, config.textChunkLimit);
            return { kind: 'noop' };
        },
    };
}
export function taskCommand({ manager, config }) {
    return {
        name: 'task', category: 'agent', scope: 'all', description: '查看任务详情（/task <任务编号>）',
        handler: async (ctx) => {
            const registry = manager.taskRegistry;
            if (!registry)
                return '当前未启用后台任务跟踪';
            const id = (ctx.command?.raw ?? '').trim();
            if (!id)
                return '用法：/task <任务编号>；使用 /tasks 查看编号';
            const { scope, peerId } = getScopePeer(ctx);
            const task = registry.get(id, scope, peerId);
            if (!task)
                return '找不到该任务';
            try {
                await sendMarkdownChunked(ctx, formatTask(task, true), config.textChunkLimit);
                if (task.settled && (!task.files?.length || config.sendFile.sendPresentedFiles === false))
                    registry.markDelivery(task.taskId, task.runId, 'sent');
            }
            catch (error) {
                registry.markDelivery(task.taskId, task.runId, 'failed', error instanceof Error ? error.message : String(error));
                throw error;
            }
            return { kind: 'noop' };
        },
    };
}
//# sourceMappingURL=tasks.js.map