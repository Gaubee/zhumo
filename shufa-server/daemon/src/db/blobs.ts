/**
 * 内容寻址 blob 存取（PRODUCT_DESIGN.md §5 blobs 表 + 存储布局）。
 * 原始需求 2026-09-23（W2'）：DATA_ROOT/blobs/{hash[:2]}/{hash} + ref_count 去重。
 * 正交意图：
 *   [1] put：sha256 寻址写入（临时文件原子改名；已存在即去重）。
 *   [2] 引用计数：addRef/releaseRef（0 值回收实体文件与行）。
 *   [3] open/read：按 hash 取回字节流。
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  fstatSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import type { SqliteDb } from './database.js';

export interface BlobPutResult {
  hash: string;
  size: number;
  /** 是否命中已有实体（未重复写盘）。 */
  deduped: boolean;
}

export class BlobStore {
  private readonly root: string;

  constructor(
    private readonly dataRoot: string,
    private readonly db: SqliteDb,
  ) {
    this.root = path.join(dataRoot, 'blobs');
  }

  /** hash 对应的实体文件绝对路径（存在与否不作保证）。 */
  pathFor(hash: string): string {
    return path.join(this.root, hash.slice(0, 2), hash);
  }

  put(data: Uint8Array): BlobPutResult {
    const hash = createHash('sha256').update(data).digest('hex');
    const size = data.byteLength;
    const row = this.db.prepare('SELECT hash FROM blobs WHERE hash = ?').get(hash) as
      | { hash: string }
      | undefined;
    if (row) {
      this.addRef(hash);
      return { hash, size, deduped: true };
    }
    const target = this.pathFor(hash);
    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeBufferTo(tmp, data);
    renameSync(tmp, target);
    this.db
      .prepare('INSERT INTO blobs (hash, size, store_path, ref_count) VALUES (?, ?, ?, 1)')
      .run(hash, size, relativeStorePath(hash));
    return { hash, size, deduped: false };
  }

  /** 取回完整字节；未知 hash 或实体缺失返回 null。 */
  read(hash: string): Buffer | null {
    const file = this.existingFileOf(hash);
    return file ? readFileSync(file) : null;
  }

  /** 只读流式打开（HTTP Range 服务用），由调用方 closeSync。未知 hash 返回 null。 */
  open(hash: string): { fd: number; size: number } | null {
    const file = this.existingFileOf(hash);
    if (!file) return null;
    const fd = openSync(file, 'r');
    return { fd, size: fstatSync(fd).size };
  }

  addRef(hash: string): void {
    this.db.prepare('UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ?').run(hash);
  }

  /** 引用归零时回收实体与行（幂等：未知 hash 静默）。 */
  releaseRef(hash: string): void {
    const row = this.db
      .prepare('SELECT ref_count FROM blobs WHERE hash = ?')
      .get(hash) as { ref_count: number } | undefined;
    if (!row) return;
    const next = row.ref_count - 1;
    if (next > 0) {
      this.db.prepare('UPDATE blobs SET ref_count = ? WHERE hash = ?').run(next, hash);
      return;
    }
    this.db.prepare('DELETE FROM blobs WHERE hash = ?').run(hash);
    const file = this.pathFor(hash);
    if (existsSync(file)) rmSync(file, { force: true });
  }

  /** 登记一个已存在于别处的实体文件（.shufa 包体导入用，W5 消费）。 */
  registerExistingFile(hash: string, absolutePath: string): number {
    const size = statSync(absolutePath).size;
    this.db
      .prepare(
        `INSERT INTO blobs (hash, size, store_path, ref_count) VALUES (?, ?, ?, 1)
         ON CONFLICT(hash) DO UPDATE SET ref_count = ref_count + 1`,
      )
      .run(hash, size, path.relative(this.root, absolutePath));
    return size;
  }

  private existingFileOf(hash: string): string | null {
    const row = this.db
      .prepare('SELECT store_path FROM blobs WHERE hash = ?')
      .get(hash) as { store_path: string } | undefined;
    if (!row) return null;
    const file = path.join(this.root, row.store_path);
    return existsSync(file) ? file : null;
  }
}

function relativeStorePath(hash: string): string {
  return path.join(hash.slice(0, 2), hash);
}

/** 分片写盘（大文件不全量驻留写缓冲）。 */
function writeBufferTo(tmpPath: string, data: Uint8Array): void {
  const fd = openSync(tmpPath, 'w');
  try {
    let offset = 0;
    while (offset < data.byteLength) {
      const written = writeSync(fd, data, offset);
      if (written <= 0) throw new Error('blob 写入停滞');
      offset += written;
    }
  } finally {
    closeSync(fd);
  }
}
