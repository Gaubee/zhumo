/**
 * 数据库连接与迁移执行。
 * 原始需求 2026-09-23（W2'）：打开 <data_root>/shufa.db，PRAGMA 外键开启，
 * 按 user_version 顺序应用 MIGRATIONS。
 * 迁移（2026-09-25，Owner 指令「去 better-sqlite3」）：改 node:sqlite
 * （DatabaseSync，Node ≥23.4 免 flag；本仓 node 24.21 实证可用）——原生
 * 编译依赖消失（Windows 免 node-gyp/预编译二进制）。项目未用 better-sqlite3
 * 任何特有能力（无 BLOB 列/命名参数/自定义函数/backup/lastInsertRowid 消费），
 * 本文件以同构适配层保持既有 prepare/run/get/all/exec/pragma/transaction
 * 调用面，全库 170 处调用零改动。
 * 已知语义差异：node:sqlite 的行对象是 null-prototype（无自有 Object 原型
 * 方法）——项目全部用法是属性访问/展开/JSON 序列化，不受影响。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './schema.js';

/** 语句面（位置参数绑定——全库唯一用法）。 */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** 连接面（与原 better-sqlite3 用法同构的最小子集）。 */
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  /** pragma 兼容面：赋值形式走 exec；{ simple: true } 读取返回裸标量。 */
  pragma(source: string, options?: { simple?: boolean }): unknown;
  /** 包裹事务（迁移唯一使用点）：返回执行器，异常自动 ROLLBACK。 */
  transaction(fn: () => void): () => void;
  close(): void;
}

export function openDatabase(dataRoot: string): SqliteDb {
  mkdirSync(dataRoot, { recursive: true });
  const dbPath = path.join(dataRoot, 'shufa.db');
  const raw = new DatabaseSync(dbPath);
  const db: SqliteDb = {
    prepare: (sql) => raw.prepare(sql) as unknown as SqliteStatement,
    exec: (sql) => void raw.exec(sql),
    pragma: (source, options) => {
      if (options?.simple === true && !source.includes('=')) {
        const key = source.trim().split(/\s+/)[0] ?? '';
        const row = raw.prepare(`PRAGMA ${key}`).get() as Record<string, unknown> | undefined;
        return row?.[key];
      }
      raw.exec(`PRAGMA ${source}`);
      return undefined;
    },
    transaction:
      (fn: () => void): (() => void) =>
      () => {
        raw.exec('BEGIN');
        try {
          fn();
          raw.exec('COMMIT');
        } catch (error) {
          raw.exec('ROLLBACK');
          throw error;
        }
      },
    // better-sqlite3 的 close 幂等；node:sqlite 二次 close 抛
    // "database is not open"（auth.test 实证存在重复 close 场景）——对齐幂等语义。
    close: () => {
      try {
        raw.close();
      } catch {
        // 已关闭：吞掉（幂等）。
      }
    },
  };
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
