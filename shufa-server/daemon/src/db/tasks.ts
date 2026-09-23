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
    error: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO tasks (id, resource_id, owner_id, status, prompt, video_resource_id,
                        agent_session_id, result_id, model_provider, model_model,
                        created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, NULL, NULL, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.resource_id,
    row.owner_id,
    row.prompt,
    row.video_resource_id,
    row.model_provider,
    row.model_model,
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
  if (patch.modelProvider !== undefined || patch.modelModel !== undefined) {
    const current = getTaskById(db, id);
    db.prepare('UPDATE tasks SET model_provider = ?, model_model = ?, updated_at = ? WHERE id = ?').run(
      patch.modelProvider !== undefined ? patch.modelProvider : (current?.model_provider ?? null),
      patch.modelModel !== undefined ? patch.modelModel : (current?.model_model ?? null),
      nowIso(),
      id,
    );
  }
  return getTaskById(db, id);
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
