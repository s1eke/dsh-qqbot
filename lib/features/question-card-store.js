/** Durable QQ card addressing only; question state is always read from the host projection. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PLUGIN_HOME } from "../shared/dirs.js";
export class QuestionCardStore {
    logger;
    entries = new Map();
    path;
    constructor(appId, logger, directory = join(PLUGIN_HOME, 'question-cards')) {
        this.logger = logger;
        if (!appId)
            return;
        this.path = join(directory, `${encodeURIComponent(appId)}.json`);
        try {
            const data = JSON.parse(readFileSync(this.path, 'utf8'));
            if (!Array.isArray(data))
                throw new Error('Expected an array of QQ question cards');
            for (const card of data) {
                if (isCard(card))
                    this.entries.set(this.key(card.sessionId, card.callId), card);
            }
        }
        catch (error) {
            if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
                logger.warn(`QQ question cards could not be read: ${String(error)}`);
            }
        }
    }
    get(sessionId, callId) {
        return this.entries.get(this.key(sessionId, callId));
    }
    set(card) {
        this.entries.set(this.key(card.sessionId, card.callId), { ...card, messageIds: [...card.messageIds],
            ...(card.taskIds ? { taskIds: [...card.taskIds] } : {}), ...(card.taskRuns ? { taskRuns: { ...card.taskRuns } } : {}) });
        this.save();
    }
    delete(sessionId, callId) {
        if (this.entries.delete(this.key(sessionId, callId)))
            this.save();
    }
    key(sessionId, callId) { return JSON.stringify([sessionId, callId]); }
    save() {
        if (!this.path)
            return;
        try {
            mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
            const temporary = `${this.path}.${process.pid}.tmp`;
            writeFileSync(temporary, JSON.stringify([...this.entries.values()]), { mode: 0o600 });
            renameSync(temporary, this.path);
        }
        catch (error) {
            this.logger.warn(`QQ question cards could not be saved: ${String(error)}`);
        }
    }
}
function isCard(value) {
    if (!value || typeof value !== 'object')
        return false;
    const card = value;
    return typeof card.sessionId === 'string' && typeof card.callId === 'string'
        && (card.scope === 'c2c' || card.scope === 'group') && typeof card.peerId === 'string'
        && typeof card.nonce === 'string' && /^[a-f0-9]{16}$/.test(card.nonce)
        && (card.ownerId === undefined || typeof card.ownerId === 'string')
        && Array.isArray(card.messageIds) && card.messageIds.every(id => typeof id === 'string')
        && (card.taskIds === undefined || (Array.isArray(card.taskIds) && card.taskIds.every(id => typeof id === 'string')))
        && (card.taskRuns === undefined || (card.taskRuns !== null && typeof card.taskRuns === 'object'
            && !Array.isArray(card.taskRuns) && Object.values(card.taskRuns).every(id => typeof id === 'string')))
        && (card.dismissed === undefined || typeof card.dismissed === 'boolean');
}
//# sourceMappingURL=question-card-store.js.map