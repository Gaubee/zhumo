/**
 * 资源管理器服务（PRODUCT_DESIGN.md §2 /admin/resources + §4 /api/res/** + §5 resources/blobs）。
 * 原始需求 2026-09-23（W5）：每用户根文件夹（<DATA_ROOT>/users/<username>/ 惰性建行）
 * + 树读面（面包屑 + 单层子项）+ CRUD + 内容寻址上传；删除 = 资源行移除 +
 * blob 引用释放（归零回收实体文件）；任务 .shufa 目录受保护（禁删/禁改名/禁移动）。
 * 错误语义：不存在 404、越权 403、保护/冲突 409、非法输入 400（ORPCError 直抛）。
 * 正交意图：
 *   [1] 根定位：meta.root 根行惰性创建；NULL-parent 行（任务文件夹/直传视频）逻辑挂根下。
 *   [2] 读面：tree（owner 解析 + 面包屑链 + 子项排序，.shufa meta 徽标投影含任务状态）。
 *   [3] 变更面：mkdir / rename / move（同名策略、环检测、跨用户禁移）。
 *   [4] 删除：子树级联 + blob ref_count 释放（归零删实体）+ 根与 .shufa 保护。
 *   [5] 上传：base64 解码校验 → BlobStore 内容寻址 → 资源行（同名 " (2)" 递增）。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ORPCError } from '@orpc/server';
import type {
  ResDeleteOutput,
  ResOwner,
  ResTreeOutput,
  ResUploadOutput,
  ResourceItem,
} from '@zhumo/contracts';
import type { AppConfig } from './config.js';
import type { SqliteDb } from './db/database.js';
import { BlobStore } from './db/blobs.js';
import {
  createResource,
  getTaskById,
  getResourceById,
  parseResourceMeta,
  type ResourceRow,
} from './db/tasks.js';
import { getUserById, getUserByUsername, nowIso, type UserRow } from './db/store.js';

/** 上传大小上限（§2 与 W4 视频直传一致：256MB）。 */
export const RESOURCE_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;

export interface ResourceServiceDeps {
  config: Pick<AppConfig, 'dataRoot'>;
  db: SqliteDb;
  blobs: BlobStore;
  /** 测试注入小上限用；缺省 256MB。 */
  maxUploadBytes?: number;
}

/** 附件图片扩展名 → MIME（/raw 预览与 sharp 判型；仅附件场景消费的小表）。 */
const MIME_OF_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

export class ResourceService {
  private readonly maxUploadBytes: number;

  constructor(private readonly deps: ResourceServiceDeps) {
    this.maxUploadBytes = deps.maxUploadBytes ?? RESOURCE_UPLOAD_MAX_BYTES;
  }

  // ---------------------------------------------------------------- [1] 根定位

  /** 用户根资源行：无则惰性创建（物理目录 + meta.root 行，名为 username）。 */
  rootOf(ownerId: string): ResourceRow {
    const existing = this.findRoot(ownerId);
    if (existing) return existing;
    const owner = getUserById(this.deps.db, ownerId);
    if (!owner) throw new ORPCError('NOT_FOUND', { message: `用户不存在：${ownerId}` });
    try {
      mkdirSync(path.join(this.deps.config.dataRoot, 'users', owner.username), { recursive: true });
    } catch {
      // 物理目录创建失败不阻断逻辑树（只读环境仍可浏览；写入型操作另行失败）。
    }
    return createResource(this.deps.db, {
      ownerId,
      parentId: null,
      name: owner.username,
      isDir: true,
      meta: { root: true },
    });
  }

  private findRoot(ownerId: string): ResourceRow | null {
    const rows = this.deps.db
      .prepare('SELECT * FROM resources WHERE owner_id = ? AND parent_id IS NULL')
      .all(ownerId) as ResourceRow[];
    return rows.find((row) => parseResourceMeta(row)?.root === true) ?? null;
  }

  /** 逻辑父 id：有 parent_id 用之；NULL-parent 行（任务文件夹等）挂根下；根无父。 */
  private logicalParentId(row: ResourceRow, rootId: string): string | null {
    if (row.parent_id) return row.parent_id;
    return row.id === rootId ? null : rootId;
  }

  // ---------------------------------------------------------------- [2] 读面

  /**
   * 附件上传（走查 R7：聊天中附加图片）：内容寻址 blob + 用户资源树根级登记
   * （meta.mime 供 /raw 预览判型）。返回 blob 绝对路径（注入提示词，agent 经
   * 工具读取）+ resource_id（/api/res/{id}/raw?w=N sharp 预览）。
   */
  attachmentUpload(actor: UserRow, input: { filename: string; data_base64: string }): {
    resource_id: string;
    name: string;
    path: string;
    size: number;
  } {
    const bytes = Buffer.from(input.data_base64, 'base64');
    if (bytes.byteLength === 0) throw new ORPCError('BAD_REQUEST', { message: '附件内容为空' });
    if (bytes.byteLength > Math.min(this.maxUploadBytes, 16 * 1024 * 1024)) {
      throw new ORPCError('BAD_REQUEST', { message: '附件超过 16MB 上限' });
    }
    const safeName = path.basename(input.filename) || 'attachment';
    const put = this.deps.blobs.put(bytes);
    const root = this.rootOf(actor.id);
    const row = createResource(this.deps.db, {
      ownerId: actor.id,
      parentId: this.logicalParentId(root, root.id) ?? root.id,
      name: safeName,
      isDir: false,
      contentHash: put.hash,
      size: bytes.byteLength,
      meta: { attachment: true, mime: MIME_OF_EXT[path.extname(safeName).toLowerCase()] ?? 'application/octet-stream' },
    });
    return {
      resource_id: row.id,
      name: safeName,
      path: this.deps.blobs.pathFor(put.hash),
      size: bytes.byteLength,
    };
  }

  tree(actor: UserRow, input: { owner?: string; parent?: string }): ResTreeOutput {
    const owner = this.resolveOwner(actor, input.owner);
    const root = this.rootOf(owner.id);
    const path: ResourceRow[] = [root];
    let parentId = root.id;
    if (input.parent) {
      const parent = this.requireOwnedRow(actor, input.parent);
      if (parent.is_dir !== 1) {
        throw new ORPCError('BAD_REQUEST', { message: 'parent 必须是文件夹' });
      }
      parentId = parent.id;
      const chain: ResourceRow[] = [];
      const seen = new Set<string>();
      let current: ResourceRow | null = parent;
      while (current && current.id !== root.id && !seen.has(current.id)) {
        seen.add(current.id);
        chain.unshift(current);
        const pid = this.logicalParentId(current, root.id);
        current = pid ? getResourceById(this.deps.db, pid) : null;
      }
      path.push(...chain);
    }
    const ownerView: ResOwner = { id: owner.id, username: owner.username };
    return {
      owner: ownerView,
      root: this.toItem(root),
      path: path.map((row) => this.toItem(row)),
      items: this.childRows(owner.id, root.id, parentId).map((row) => this.toItem(row)),
    };
  }

  /** 归属校验：缺失 404；访问他人资源且非 admin 403。 */
  requireOwnedRow(actor: UserRow, id: string): ResourceRow {
    const row = getResourceById(this.deps.db, id);
    if (!row) throw new ORPCError('NOT_FOUND', { message: `资源不存在：${id}` });
    if (row.owner_id !== actor.id && actor.role !== 'admin') {
      throw new ORPCError('FORBIDDEN', { message: '无权访问他人资源' });
    }
    return row;
  }

  /** owner 参数解析：缺省本人；非 admin 指定他人 403；用户不存在 404。 */
  private resolveOwner(actor: UserRow, ownerParam?: string): UserRow {
    if (!ownerParam || ownerParam === actor.username) return actor;
    if (actor.role !== 'admin') {
      throw new ORPCError('FORBIDDEN', { message: '仅管理员可查看他人资源' });
    }
    const target = getUserByUsername(this.deps.db, ownerParam);
    if (!target) throw new ORPCError('NOT_FOUND', { message: `用户不存在：${ownerParam}` });
    return target;
  }

  /** 某目录的单层子项（含 NULL-parent 逻辑挂根行），文件夹优先、名称排序。 */
  private childRows(ownerId: string, rootId: string, parentId: string): ResourceRow[] {
    const rows = this.deps.db
      .prepare(
        `SELECT * FROM resources WHERE owner_id = ?
         AND (parent_id = ? OR (parent_id IS NULL AND id != ?))`,
      )
      .all(ownerId, parentId, rootId) as ResourceRow[];
    // parent 非根时上面的 NULL 分支不命中（parent_id = ? 已限定）；parent 为根时排除根自身。
    const scoped = rows.filter((row) => this.logicalParentId(row, rootId) === parentId);
    return scoped.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return b.is_dir - a.is_dir;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  }

  /** 行 → 线格式视图；.shufa 目录投影徽标 meta（含任务状态），其余不外泄服务端 meta。 */
  toItem(row: ResourceRow): ResourceItem {
    const meta = parseResourceMeta(row);
    const taskId = row.is_dir === 1 && typeof meta?.task_id === 'string' ? meta.task_id : null;
    const badge: ResourceItem['meta'] = taskId
      ? {
          task_id: taskId,
          task_status: getTaskById(this.deps.db, taskId)?.status ?? null,
          agent_session_id: typeof meta?.agent_session_id === 'string' ? meta.agent_session_id : null,
          result_id: typeof meta?.result_id === 'string' ? meta.result_id : null,
        }
      : null;
    return {
      id: row.id,
      parent_id: row.parent_id,
      name: row.name,
      is_dir: row.is_dir === 1,
      size: row.size,
      meta: badge,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // ---------------------------------------------------------------- [3] 变更面

  mkdir(actor: UserRow, input: { parent: string; name: string }): ResourceItem {
    const parent = this.requireOwnedRow(actor, input.parent);
    if (parent.is_dir !== 1) throw new ORPCError('BAD_REQUEST', { message: 'parent 必须是文件夹' });
    const root = this.rootOf(parent.owner_id);
    const name = this.uniqueName(parent.owner_id, root.id, parent.id, input.name, '');
    return this.toItem(
      createResource(this.deps.db, {
        ownerId: parent.owner_id,
        parentId: parent.id,
        name,
        isDir: true,
      }),
    );
  }

  rename(actor: UserRow, input: { id: string; name: string }): ResourceItem {
    const row = this.requireOwnedRow(actor, input.id);
    const root = this.rootOf(row.owner_id);
    if (row.id === root.id) throw new ORPCError('CONFLICT', { message: '根文件夹不可改名' });
    if (this.shufaTaskId(row)) {
      throw new ORPCError('CONFLICT', { message: '任务 .shufa 目录受保护，不可改名' });
    }
    if (input.name !== row.name) {
      this.assertSiblingFree(row.owner_id, root.id, this.logicalParentId(row, root.id), input.name, row.id);
    }
    this.deps.db
      .prepare('UPDATE resources SET name = ?, updated_at = ? WHERE id = ?')
      .run(input.name, nowIso(), row.id);
    return this.toItem(getResourceById(this.deps.db, row.id) as ResourceRow);
  }

  move(actor: UserRow, input: { id: string; new_parent: string }): ResourceItem {
    const row = this.requireOwnedRow(actor, input.id);
    const target = this.requireOwnedRow(actor, input.new_parent);
    if (row.id === target.id) {
      throw new ORPCError('BAD_REQUEST', { message: '不能把资源移动到其自身' });
    }
    if (target.is_dir !== 1) throw new ORPCError('BAD_REQUEST', { message: 'new_parent 必须是文件夹' });
    if (row.owner_id !== target.owner_id) {
      throw new ORPCError('CONFLICT', { message: '不能跨用户移动资源' });
    }
    const root = this.rootOf(row.owner_id);
    if (row.id === root.id) throw new ORPCError('CONFLICT', { message: '根文件夹不可移动' });
    if (this.shufaTaskId(row)) {
      throw new ORPCError('CONFLICT', { message: '任务 .shufa 目录受保护，不可移动' });
    }
    if (row.is_dir === 1 && this.isDescendant(target, row, root.id)) {
      throw new ORPCError('CONFLICT', { message: '不能把文件夹移动到其子目录内' });
    }
    this.assertSiblingFree(
      row.owner_id,
      root.id,
      target.id,
      row.name,
      row.id,
    );
    this.deps.db
      .prepare('UPDATE resources SET parent_id = ?, updated_at = ? WHERE id = ?')
      .run(target.id, nowIso(), row.id);
    return this.toItem(getResourceById(this.deps.db, row.id) as ResourceRow);
  }

  // ---------------------------------------------------------------- [4] 删除

  /** 级联删除：返回移除行数与归零回收的 blob 实体数；根与任务 .shufa 保护。 */
  remove(actor: UserRow, input: { id: string }): ResDeleteOutput {
    const row = this.requireOwnedRow(actor, input.id);
    const root = this.rootOf(row.owner_id);
    if (row.id === root.id) throw new ORPCError('CONFLICT', { message: '根文件夹不可删除' });
    const subtree = this.subtreeOf(row, root.id);
    for (const node of subtree) {
      if (this.shufaTaskId(node)) {
        throw new ORPCError('CONFLICT', {
          message: '任务 .shufa 目录受保护：任务资产（会话/结果）不可删除',
        });
      }
    }
    let blobsReleased = 0;
    // 先删资源行（resources.content_hash → blobs 的 FK），再释放 blob 引用；子先于父。
    for (const node of [...subtree].reverse()) {
      this.deps.db.prepare('DELETE FROM resources WHERE id = ?').run(node.id);
      if (node.content_hash) {
        const blob = this.deps.db
          .prepare('SELECT ref_count FROM blobs WHERE hash = ?')
          .get(node.content_hash) as { ref_count: number } | undefined;
        if (blob && blob.ref_count <= 1) blobsReleased += 1;
        this.deps.blobs.releaseRef(node.content_hash);
      }
    }
    return { deleted: subtree.length, blobs_released: blobsReleased };
  }

  /** 逻辑子树（含自身）：沿 logicalParentId 收敛，防环用 seen。 */
  private subtreeOf(row: ResourceRow, rootId: string): ResourceRow[] {
    const all = this.deps.db
      .prepare('SELECT * FROM resources WHERE owner_id = ?')
      .all(row.owner_id) as ResourceRow[];
    const byParent = new Map<string, ResourceRow[]>();
    for (const node of all) {
      const pid = this.logicalParentId(node, rootId);
      if (pid === null) continue;
      const bucket = byParent.get(pid) ?? [];
      bucket.push(node);
      byParent.set(pid, bucket);
    }
    const result: ResourceRow[] = [];
    const queue = [row];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const node = queue.shift() as ResourceRow;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      result.push(node);
      queue.push(...(byParent.get(node.id) ?? []));
    }
    return result;
  }

  // ---------------------------------------------------------------- [5] 上传

  upload(actor: UserRow, input: { parent: string; filename: string; b64: string }): ResUploadOutput {
    const parent = this.requireOwnedRow(actor, input.parent);
    if (parent.is_dir !== 1) throw new ORPCError('BAD_REQUEST', { message: 'parent 必须是文件夹' });
    const bytes = Buffer.from(input.b64, 'base64');
    if (bytes.byteLength === 0) throw new ORPCError('BAD_REQUEST', { message: '上传内容为空' });
    if (bytes.byteLength > this.maxUploadBytes) {
      throw new ORPCError('BAD_REQUEST', { message: '上传内容超过 256MB 上限' });
    }
    const safeName = path.basename(input.filename).trim();
    if (!safeName || safeName === '.' || safeName === '..') {
      throw new ORPCError('BAD_REQUEST', { message: `非法文件名：${input.filename}` });
    }
    const put = this.deps.blobs.put(bytes);
    const root = this.rootOf(parent.owner_id);
    const { stem, ext } = splitName(safeName);
    const name = this.uniqueName(parent.owner_id, root.id, parent.id, stem, ext);
    const row = createResource(this.deps.db, {
      ownerId: parent.owner_id,
      parentId: parent.id,
      name,
      isDir: false,
      contentHash: put.hash,
      size: put.size,
      meta: { blob: true },
    });
    return { item: this.toItem(row), deduped: put.deduped };
  }

  // ---------------------------------------------------------------- internals

  /** .shufa 任务目录判定（任务资产保护标记：meta.task_id 非空）。 */
  private shufaTaskId(row: ResourceRow): string | null {
    if (row.is_dir !== 1) return null;
    const taskId = parseResourceMeta(row)?.task_id;
    return typeof taskId === 'string' && taskId.length > 0 ? taskId : null;
  }

  /** target 是否位于 folder 子树内（沿逻辑父链上溯）。 */
  private isDescendant(target: ResourceRow, folder: ResourceRow, rootId: string): boolean {
    const byId = new Map<string, ResourceRow>();
    for (const node of this.deps.db
      .prepare('SELECT * FROM resources WHERE owner_id = ?')
      .all(target.owner_id) as ResourceRow[]) {
      byId.set(node.id, node);
    }
    const seen = new Set<string>();
    let current: ResourceRow | null = target;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.id === folder.id) return true;
      const pid = this.logicalParentId(current, rootId);
      current = pid ? (byId.get(pid) ?? getResourceById(this.deps.db, pid)) : null;
    }
    return false;
  }

  /** 同名去重（mkdir/上传）：占用时递增 " (n)"；dir 的 ext 传空串按整名处理。 */
  private uniqueName(
    ownerId: string,
    rootId: string,
    parentId: string,
    stem: string,
    ext: string,
  ): string {
    const taken = new Set(
      this.childRows(ownerId, rootId, parentId).map((row) => row.name.toLowerCase()),
    );
    if (!taken.has(`${stem}${ext}`.toLowerCase())) return `${stem}${ext}`;
    for (let n = 2; ; n += 1) {
      const candidate = `${stem} (${n})${ext}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  /** rename/move 的冲突面：目标位置同名资源已存在（排除自身）→ 409。 */
  private assertSiblingFree(
    ownerId: string,
    rootId: string,
    parentId: string | null,
    name: string,
    selfId: string,
  ): void {
    if (!parentId) return;
    const clash = this.childRows(ownerId, rootId, parentId).some(
      (sibling) => sibling.id !== selfId && sibling.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) throw new ORPCError('CONFLICT', { message: `同名资源已存在：${name}` });
  }
}

/** 拆扩展名（leading dot 文件如 .shufa 视为无扩展名）。 */
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}
