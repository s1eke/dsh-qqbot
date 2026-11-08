import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { QuestionCardStore } from './question-card-store.ts';

const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
describe('question card associations', () => {
  it('restores owner and nonce across reloads and retains explicit dismissal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qq-question-cards-'));
    try {
      const store = new QuestionCardStore('app', logger(), dir);
      const card = { sessionId: 'root', callId: 'call', scope: 'group' as const, peerId: 'group',
        ownerId: 'owner', nonce: 'abcdefabcdef1234', messageIds: ['qq-card'], taskIds: ['task-one'], taskRuns: { 'task-one': 'run1' } };
      store.set(card);
      const resumed = new QuestionCardStore('app', logger(), dir);
      expect(resumed.get('root', 'call')).toEqual(card);
      resumed.set({ ...card, dismissed: true });
      expect(new QuestionCardStore('app', logger(), dir).get('root', 'call')?.dismissed).toBe(true);
      resumed.delete('root', 'call');
      expect(JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
