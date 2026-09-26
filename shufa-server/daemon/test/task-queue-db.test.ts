/**
 * W10k 队列持久化 DB 层测试（Codex 复核 P1）：state 列落库/读回 +
 * tasks 删除级联（task_queue 不阻断、无孤儿行）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.js';
import { overwriteTaskQueue, readTaskQueue } from '../src/db/tasks.js';

describe('task_queue 持久化（W10k DB 层）', () => {
  let root: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'shufa-queue-db-'));
    db = openDatabase(root);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function seedTask(taskId: string): void {
    const userId = `u-${randomUUID()}`;
    db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, `n-${randomUUID().slice(0, 8)}`, 'x', 'user', new Date().toISOString());
    db.prepare('INSERT INTO tasks (id, owner_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, userId, 'done', new Date().toISOString(), new Date().toISOString());
  }

  it('state 落库读回（admitted/inflight 如实持久化）', () => {
    const taskId = `t-${randomUUID()}`;
    seedTask(taskId);
    overwriteTaskQueue(
      db,
      taskId,
      [
        { id: 'q1', text: '留', kind: 'anchor', state: 'queued' },
        { id: 'q2', text: '认', kind: 'anchor', state: 'admitted' },
        { id: 'q3', text: '飞', kind: 'attach', effect: 'steer', state: 'inflight' },
      ],
      'q1',
    );
    const read = readTaskQueue(db, taskId);
    expect(read?.items.map((i) => [i.message_id, i.state])).toEqual([
      ['q1', 'queued'],
      ['q2', 'admitted'],
      ['q3', 'inflight'],
    ]);
    expect(read?.lockBoundaryId).toBe('q1');
  });

  it('删除任务级联清空队列行（Codex P1：外键不再阻断）', () => {
    const taskId = `t-${randomUUID()}`;
    seedTask(taskId);
    overwriteTaskQueue(db, taskId, [{ id: 'q1', text: 'A', kind: 'anchor', state: 'queued' }], null);
    expect(db.prepare('SELECT count(*) c FROM task_queue WHERE task_id = ?').get(taskId))
      .toMatchObject({ c: 1 });
    expect(() => db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)).not.toThrow();
    expect(db.prepare('SELECT count(*) c FROM task_queue WHERE task_id = ?').get(taskId))
      .toMatchObject({ c: 0 });
  });
});
