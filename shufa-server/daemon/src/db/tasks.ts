/**
 * tasks + resources 两域行存取（PRODUCT_DESIGN.md §5；W2' store.ts 已满四域意图，
 * 本文件承接 W4 新增域）。原始需求 2026-09-23（W4 任务编排）。
 * 正交意图：
 *   [1] tasks：创建/取查/按属主列表/状态与结果推进。
 *   [2] resources：mkdir 式目录行 + 文件行登记（视频上传进本人资源树）。
 *   [3] 归属判定：资源/任务的 owner 校验（admin 豁免由调用方裁决）。
 */
import { nowIso, newId } from './store.js';
import type { TaskStatus } from '@zhumo/contracts';
import type { SqliteDb } from './database.js';

// ---------------------------------------------------------------- tasks

export interface TaskRow {
  id: string;
  resource_id: string | null;
  owner_id: string;
  status: TaskStatus;
  prompt: string | null;
  video_resource_id: string | null;
  agent_session_id: string | null;
  result_id: string | null;
  /** 任务级模型覆盖（五轮活动模型；NULL=跟随默认模型）。 */
  model_provider: string | null;
  model_model: string | null;
  /** 任务级思考强度档（2026-09-25 前台对齐；NULL=不覆盖）。 */
  model_effort: string | null;
  /** 会话标题（内核 session/title 帧；NULL=回退 prompt 截断投影）。 */
  title: string | null;
  /** 失败原因（AgentChat 走查 R3：failed 必须可见——turn-end error 明文落库，
   * 列表 badge/详情转录都可回放；resume 成功拉回 running 时清空）。 */
  error: string | null;
  created_at: string;
  updated_at: string;
}

export function createTask(
  db: SqliteDb,
  input: {
    ownerId: string;
    resourceId: string | null;
    videoResourceId: string | null;
    prompt: string;
    modelProvider?: string | null;
    modelModel?: string | null;
    modelEffort?: string | null;
  },
): TaskRow {
  const row: TaskRow = {
    id: newId(),
    resource_id: input.resourceId,
    owner_id: input.ownerId,
    status: 'queued',
    prompt: input.prompt,
    video_resource_id: input.videoResourceId,
    agent_session_id: null,
    result_id: null,
    model_provider: input.modelProvider ?? null,
    model_model: input.modelModel ?? null,
    model_effort: input.modelEffort ?? null,
    title: null,
    error: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO tasks (id, resource_id, owner_id, status, prompt, video_resource_id,
                        agent_session_id, result_id, model_provider, model_model, model_effort, title,
                        created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    row.id,
    row.resource_id,
    row.owner_id,
    row.prompt,
    row.video_resource_id,
    row.model_provider,
    row.model_model,
    row.model_effort,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function getTaskById(db: SqliteDb, id: string): TaskRow | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return (row as TaskRow | undefined) ?? null;
}

export function listTasksByOwner(db: SqliteDb, ownerId: string): TaskRow[] {
  return db
    .prepare('SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at DESC')
    .all(ownerId) as TaskRow[];
}

export function updateTask(
  db: SqliteDb,
  id: string,
  patch: {
    status?: TaskStatus;
    agentSessionId?: string | null;
    resultId?: string | null;
    error?: string | null;
    modelProvider?: string | null;
    modelModel?: string | null;
    /** undefined=不变；显式 null=清除档位。 */
    modelEffort?: string | null;
  },
): TaskRow | null {
  if (patch.status !== undefined) {
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(
      patch.status,
      nowIso(),
      id,
    );
  }
  if (patch.agentSessionId !== undefined) {
    db.prepare('UPDATE tasks SET agent_session_id = ?, updated_at = ? WHERE id = ?').run(
      patch.agentSessionId,
      nowIso(),
      id,
    );
  }
  if (patch.resultId !== undefined) {
    db.prepare('UPDATE tasks SET result_id = ?, updated_at = ? WHERE id = ?').run(
      patch.resultId,
      nowIso(),
      id,
    );
  }
  if (patch.error !== undefined) {
    db.prepare('UPDATE tasks SET error = ?, updated_at = ? WHERE id = ?').run(
      patch.error,
      nowIso(),
      id,
    );
  }
  if (
    patch.modelProvider !== undefined ||
    patch.modelModel !== undefined ||
    patch.modelEffort !== undefined
  ) {
    const current = getTaskById(db, id);
    db.prepare(
      'UPDATE tasks SET model_provider = ?, model_model = ?, model_effort = ?, updated_at = ? WHERE id = ?',
    ).run(
      patch.modelProvider !== undefined ? patch.modelProvider : (current?.model_provider ?? null),
      patch.modelModel !== undefined ? patch.modelModel : (current?.model_model ?? null),
      patch.modelEffort !== undefined ? patch.modelEffort : (current?.model_effort ?? null),
      nowIso(),
      id,
    );
  }
  return getTaskById(db, id);
}

/** 会话标题回写（内核 session/title 帧 → 行；无匹配行 = 0，幂等）。 */
export function updateTaskTitleBySession(
  db: SqliteDb,
  sessionId: string,
  title: string,
): void {
  db.prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE agent_session_id = ?').run(
    title,
    nowIso(),
    sessionId,
  );
}

// ---------------------------------------------------------------- resources

export interface ResourceRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  is_dir: number;
  content_hash: string | null;
  size: number;
  meta: string | null;
  created_at: string;
  updated_at: string;
}

export function createResource(
  db: SqliteDb,
  input: {
    ownerId: string;
    parentId: string | null;
    name: string;
    isDir: boolean;
    contentHash?: string | null;
    size?: number;
    meta?: Record<string, unknown> | null;
  },
): ResourceRow {
  const row: ResourceRow = {
    id: newId(),
    owner_id: input.ownerId,
    parent_id: input.parentId,
    name: input.name,
    is_dir: input.isDir ? 1 : 0,
    content_hash: input.contentHash ?? null,
    size: input.size ?? 0,
    meta: input.meta ? JSON.stringify(input.meta) : null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta,
                            created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.owner_id,
    row.parent_id,
    row.name,
    row.is_dir,
    row.content_hash,
    row.size,
    row.meta,
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function getResourceById(db: SqliteDb, id: string): ResourceRow | null {
  const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(id);
  return (row as ResourceRow | undefined) ?? null;
}

/** 更新 .shufa 目录行 meta（agent_session_id/result_id 绑定）。 */
export function updateResourceMeta(db: SqliteDb, id: string, meta: Record<string, unknown>): void {
  db.prepare('UPDATE resources SET meta = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(meta),
    nowIso(),
    id,
  );
}

export function parseResourceMeta(row: ResourceRow): Record<string, unknown> | null {
  if (!row.meta) return null;
  try {
    const parsed: unknown = JSON.parse(row.meta);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- W10k 统一队列

export interface TaskQueueRow {
  message_id: string;
  seq: number;
  kind: 'anchor' | 'attach';
  effect: 'steer' | 'inject' | null;
  text: string;
  state: 'queued' | 'admitted' | 'inflight';
}

/** 队列整体覆写（每次变更全量重写——条目数个位数级，无需增量）。state 一并
 * 落库：崩溃恢复只回填 queued（admitted/inflight 在内核侧，收养重新纳入）。 */
export function overwriteTaskQueue(
  db: SqliteDb,
  taskId: string,
  items: Array<{
    id: string;
    text: string;
    kind: 'anchor' | 'attach';
    effect?: 'steer' | 'inject';
    state?: 'queued' | 'admitted' | 'inflight';
  }>,
  lockBoundaryId: string | null,
): void {
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM task_queue WHERE task_id = ?').run(taskId);
    const insert = db.prepare(
      'INSERT INTO task_queue (task_id, message_id, seq, kind, effect, text, state) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    items.forEach((item, i) => {
      insert.run(taskId, item.id, i, item.kind, item.effect ?? null, item.text, item.state ?? 'queued');
    });
    db.prepare('UPDATE tasks SET queue_lock_boundary = ? WHERE id = ?').run(
      lockBoundaryId,
      taskId,
    );
  });
  wipe();
}

/** 读回持久化队列（空存档返回 null；行序即 seq 序）。 */
export function readTaskQueue(
  db: SqliteDb,
  taskId: string,
): { items: TaskQueueRow[]; lockBoundaryId: string | null } | null {
  const rows = db
    .prepare('SELECT message_id, seq, kind, effect, text, state FROM task_queue WHERE task_id = ? ORDER BY seq')
    .all(taskId) as Array<{ message_id: string; seq: number; kind: string; effect: string | null; text: string; state: string }>;
  const boundaryRow = db
    .prepare('SELECT queue_lock_boundary FROM tasks WHERE id = ?')
    .get(taskId) as { queue_lock_boundary: string | null } | undefined;
  if (rows.length === 0 && (boundaryRow === undefined || boundaryRow.queue_lock_boundary === null)) {
    return null;
  }
  return {
    items: rows.map((row) => ({
      message_id: row.message_id,
      seq: row.seq,
      kind: row.kind as 'anchor' | 'attach',
      effect: row.effect as 'steer' | 'inject' | null,
      text: row.text,
      state: row.state as 'queued' | 'admitted' | 'inflight',
    })),
    lockBoundaryId: boundaryRow?.queue_lock_boundary ?? null,
  };
}
