/**
 * SQLite 模式与迁移（PRODUCT_DESIGN.md §5 六张表，列名与顺序一字不差）。
 * 原始需求 2026-09-23（W2'）：better-sqlite3 + user_version 单步迁移。
 * 正交意图：
 *   [1] v1 全量 DDL（users/settings/wizard_steps/blobs/resources/tasks/results）。
 * 偏差说明：§5 的 `meta JSON`——SQLite 无 JSON 存储类，按 TEXT 落库（JSON 字符串），
 * 列名保持 meta；表结构其余部分与规格逐列一致。
 */

export interface Migration {
  readonly version: number;
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wizard_steps (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK(kind IN ('command', 'download')),
  title      TEXT NOT NULL,
  command    TEXT,
  url        TEXT,
  target_dir TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  last_log   TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  hash       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  store_path TEXT NOT NULL,
  ref_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS resources (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL REFERENCES users(id),
  parent_id    TEXT REFERENCES resources(id),
  name         TEXT NOT NULL,
  is_dir       INTEGER NOT NULL,
  content_hash TEXT REFERENCES blobs(hash),
  size         INTEGER NOT NULL DEFAULT 0,
  meta         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources(owner_id);
CREATE INDEX IF NOT EXISTS idx_resources_parent ON resources(parent_id);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  resource_id       TEXT REFERENCES resources(id),
  owner_id          TEXT NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK(status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  prompt            TEXT,
  video_resource_id TEXT REFERENCES resources(id),
  agent_session_id  TEXT,
  result_id         TEXT REFERENCES results(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
`,
  },
  {
    // 五轮（2026-09-24）：任务级模型覆盖（活动模型由前台按任务选择）。
    version: 2,
    up: `
ALTER TABLE tasks ADD COLUMN model_provider TEXT;
ALTER TABLE tasks ADD COLUMN model_model TEXT;

CREATE TABLE IF NOT EXISTS results (
  id          TEXT PRIMARY KEY,
  public_id   TEXT NOT NULL UNIQUE,
  task_id     TEXT REFERENCES tasks(id),
  owner_id    TEXT NOT NULL REFERENCES users(id),
  title       TEXT,
  bundle_path TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_owner ON results(owner_id);
`,
  },
  {
    // AgentChat 走查 R3（2026-09-24）：failed 必须可见——错误明文落库。
    version: 3,
    up: `
ALTER TABLE tasks ADD COLUMN error TEXT;
`,
  },
  {
    // 前台对齐（2026-09-25）：任务级思考强度档（模型 efforts 之一；NULL=不覆盖）。
    version: 4,
    up: `
ALTER TABLE tasks ADD COLUMN model_effort TEXT;
`,
  },
  {
    // 会话标题（2026-09-25 三轮）：内核 session/title 帧落行；NULL=回退 prompt 截断。
    version: 5,
    up: `
ALTER TABLE tasks ADD COLUMN title TEXT;
`,
  },
  {
    // W10k 统一队列（Owner 语义 2026-09-28）：单一有序序列 daemon 单一事实源——
    // anchor（开轮）/ attach（补充，effect=steer|inject）。内核 inbox 退化为瞬时
    // 投递缓冲；队列本体落库（daemon 重启恢复）。tasks.queue_lock_boundary=
    // 锁定边界 message_id（null=未锁）。
    version: 6,
    up: `
CREATE TABLE IF NOT EXISTS task_queue (
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  message_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('anchor', 'attach')),
  effect     TEXT CHECK(effect IN ('steer', 'inject')),
  text       TEXT NOT NULL,
  PRIMARY KEY (task_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_task_queue_task ON task_queue(task_id);
ALTER TABLE tasks ADD COLUMN queue_lock_boundary TEXT;
`,
  },
];
