/**
 * 数据库连接与迁移执行。
 * 原始需求 2026-09-23（W2'）：better-sqlite3 打开 <data_root>/shufa.db，
 * PRAGMA 外键开启，按 user_version 顺序应用 MIGRATIONS。
 * 正交意图：
 *   [1] openDatabase：连接 + 迁移的唯一入口。
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './schema.js';

export type SqliteDb = Database.Database;

export function openDatabase(dataRoot: string): SqliteDb {
  mkdirSync(dataRoot, { recursive: true });
  const dbPath = path.join(dataRoot, 'shufa.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: SqliteDb): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.up);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
