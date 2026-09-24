/**
 * 领域行存取面（users / settings / wizard_steps / results 四域 SQL 的唯一归宿）。
 * 原始需求 2026-09-23（W2'）：查询语句集中于此，auth/wizard/rpc 只消费视图。
 * 正交意图：
 *   [1] users：按用户名/ID 取查、创建、改密、禁用、改角色；非匿名存在性判定与
 *       行删除（BUG5 级联删除的库内收尾）。
 *   [2] settings：键值读写（字符串承载）。
 *   [3] wizard_steps：种子落库、列表、状态推进、进度统计（BUG2 setup_progress）。
 *   [4] results：public_id 取查与登记。
 */
import { randomUUID } from 'node:crypto';
import { ANONYMOUS_USERNAME } from '@zhumo/contracts';
import type { Role, WizardKind, WizardStatus } from '@zhumo/contracts';
import type { SqliteDb } from './database.js';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  created_at: string;
  disabled: number;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------- users

export function getUserByUsername(db: SqliteDb, username: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  return (row as UserRow | undefined) ?? null;
}

export function getUserById(db: SqliteDb, id: string): UserRow | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return (row as UserRow | undefined) ?? null;
}

export function listUsers(db: SqliteDb): UserRow[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all() as UserRow[];
}

/** 是否存在非匿名用户（走查 BUG2 setup_progress.admin_created；.env 引导的同判）。 */
export function hasNonAnonymousUser(db: SqliteDb): boolean {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM users WHERE username != ?')
    .get(ANONYMOUS_USERNAME) as { n: number };
  return row.n > 0;
}

/** 删除用户行（admin.users.delete 级联的收尾步；行级引用先由调用方清空）。 */
export function deleteUserRow(db: SqliteDb, id: string): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

/** 向导进度统计（走查 BUG2 setup_progress.steps_done/total）。 */
export function wizardProgressStats(db: SqliteDb): { done: number; total: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
       FROM wizard_steps`,
    )
    .get() as { total: number; done: number | null };
  return { done: row.done ?? 0, total: row.total };
}

export function createUser(
  db: SqliteDb,
  input: { username: string; passwordHash: string; role: Role },
): UserRow {
  const row: UserRow = {
    id: newId(),
    username: input.username,
    password_hash: input.passwordHash,
    role: input.role,
    created_at: nowIso(),
    disabled: 0,
  };
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, created_at, disabled)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.username, row.password_hash, row.role, row.created_at, row.disabled);
  return row;
}

export function updateUserCredentials(
  db: SqliteDb,
  id: string,
  patch: { passwordHash?: string; disabled?: boolean; role?: Role },
): void {
  if (patch.passwordHash !== undefined) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(patch.passwordHash, id);
  }
  if (patch.disabled !== undefined) {
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(patch.disabled ? 1 : 0, id);
  }
  if (patch.role !== undefined) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(patch.role, id);
  }
}

// ---------------------------------------------------------------- settings

export function getSetting(db: SqliteDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function putSetting(db: SqliteDb, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function listSettings(db: SqliteDb): Array<{ key: string; value: string }> {
  return db.prepare('SELECT key, value FROM settings ORDER BY key').all() as Array<{
    key: string;
    value: string;
  }>;
}

// ---------------------------------------------------------------- wizard_steps

export interface WizardStepRow {
  id: string;
  kind: WizardKind;
  title: string;
  command: string | null;
  url: string | null;
  target_dir: string;
  status: WizardStatus;
  last_log: string | null;
  updated_at: string;
}

export function getWizardStep(db: SqliteDb, id: string): WizardStepRow | null {
  const row = db.prepare('SELECT * FROM wizard_steps WHERE id = ?').get(id);
  return (row as WizardStepRow | undefined) ?? null;
}

export function listWizardSteps(db: SqliteDb): WizardStepRow[] {
  return db.prepare('SELECT * FROM wizard_steps ORDER BY rowid ASC').all() as WizardStepRow[];
}

/**
 * 种子迁移落库（走查修订 2026-09-22，原语义「已存在即跳过」无法把定义修订带给存量库）：
 * - 在册 seed id：定义字段恒更新（kind/title/command/target_dir；url 仅当行
 *   status='pending' 时跟随种子——已完成行可能持有用户自选镜像 URL，不可覆盖）；
 *   status/last_log/updated_at 是运行态，保留行一律不动。
 * - 不在当前种子清单里的行直接删除（如已下线的 webui-install）。
 * - 新 id 照旧插入为 pending。
 */
export function seedWizardSteps(db: SqliteDb, seeds: Array<Omit<WizardStepRow, 'status' | 'last_log' | 'updated_at'>>): void {
  const insert = db.prepare(
    `INSERT INTO wizard_steps (id, kind, title, command, url, target_dir, status, last_log, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
  );
  const updateDefinition = db.prepare(
    'UPDATE wizard_steps SET kind = ?, title = ?, command = ?, target_dir = ? WHERE id = ?',
  );
  const updateUrlIfPending = db.prepare(
    "UPDATE wizard_steps SET url = ? WHERE id = ? AND status = 'pending'",
  );
  for (const seed of seeds) {
    if (!getWizardStep(db, seed.id)) {
      insert.run(seed.id, seed.kind, seed.title, seed.command, seed.url, seed.target_dir, nowIso());
      continue;
    }
    updateDefinition.run(seed.kind, seed.title, seed.command, seed.target_dir, seed.id);
    updateUrlIfPending.run(seed.url, seed.id);
  }
  // 清理不在当前种子清单中的历史行。
  const known = new Set(seeds.map((s) => s.id));
  const stale = listWizardSteps(db).filter((row) => !known.has(row.id));
  if (stale.length > 0) {
    const del = db.prepare('DELETE FROM wizard_steps WHERE id = ?');
    for (const row of stale) del.run(row.id);
  }
}

/** download 步骤参数化：把运行时组装的 URL 持久化回行（whisper 型号/镜像切换）。 */
export function updateWizardStepUrl(db: SqliteDb, id: string, url: string): void {
  db.prepare('UPDATE wizard_steps SET url = ?, updated_at = ? WHERE id = ?').run(url, nowIso(), id);
}

export function updateWizardProgress(
  db: SqliteDb,
  id: string,
  patch: { status?: WizardStatus; lastLog?: string | null },
): void {
  if (patch.status !== undefined) {
    db.prepare('UPDATE wizard_steps SET status = ?, updated_at = ? WHERE id = ?').run(
      patch.status,
      nowIso(),
      id,
    );
  }
  if (patch.lastLog !== undefined) {
    db.prepare('UPDATE wizard_steps SET last_log = ?, updated_at = ? WHERE id = ?').run(
      patch.lastLog,
      nowIso(),
      id,
    );
  }
}

// ---------------------------------------------------------------- results

export interface ResultRow {
  id: string;
  public_id: string;
  task_id: string | null;
  owner_id: string;
  title: string | null;
  bundle_path: string;
  created_at: string;
}

export function getResultByPublicId(db: SqliteDb, publicId: string): ResultRow | null {
  const row = db.prepare('SELECT * FROM results WHERE public_id = ?').get(publicId);
  return (row as ResultRow | undefined) ?? null;
}

/** 任务的全部导出结果（新→旧；任务详情标签页数据源——一次对话可多次导出）。 */
export function listResultsByTask(
  db: SqliteDb,
  taskId: string,
): Array<{ public_id: string; title: string | null; created_at: string }> {
  return db
    .prepare(
      'SELECT public_id, title, created_at FROM results WHERE task_id = ? ORDER BY created_at DESC',
    )
    .all(taskId) as Array<{ public_id: string; title: string | null; created_at: string }>;
}

export function createResult(
  db: SqliteDb,
  input: { publicId: string; taskId: string | null; ownerId: string; title: string | null; bundlePath: string },
): ResultRow {
  const row: ResultRow = {
    id: newId(),
    public_id: input.publicId,
    task_id: input.taskId,
    owner_id: input.ownerId,
    title: input.title,
    bundle_path: input.bundlePath,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO results (id, public_id, task_id, owner_id, title, bundle_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.public_id, row.task_id, row.owner_id, row.title, row.bundle_path, row.created_at);
  return row;
}

/** 任务 + bundle 已有的结果行（重导合并入口；Owner 2026-09-25：agent 会话中途
 * 反复重导不应每次各产生一个链接——同 bundle 重导复用 public_id、刷新时间）。 */
export function getResultByTaskBundle(
  db: SqliteDb,
  taskId: string,
  bundlePath: string,
): ResultRow | null {
  const row = db
    .prepare('SELECT * FROM results WHERE task_id = ? AND bundle_path = ? ORDER BY created_at DESC LIMIT 1')
    .get(taskId, bundlePath);
  return (row as ResultRow | undefined) ?? null;
}

/** 重导合并：复用既有行（刷新时间戳，public_id 不变）。 */
export function touchResult(db: SqliteDb, resultId: string): void {
  db.prepare('UPDATE results SET created_at = ? WHERE id = ?').run(nowIso(), resultId);
}
