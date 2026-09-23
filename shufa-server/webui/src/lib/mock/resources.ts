/**
 * 资源管理器 mock 引擎（W5）：内存资源行 + 与 daemon ResourceService 同语义六操作。
 * 原始需求 2026-09-23：webui mock 层驱动页面，接口签名与 res.* oRPC 契约一致，
 * 联调期（USE_MOCK=false）整体被真 API 替换后删除本文件。
 * 正交意图：
 *   [1] 行存储：每用户根惰性创建 + parent_id 逻辑树（行附 mock 实体字节供预览/下载）。
 *   [2] 读面：tree（面包屑链 + 单层子项，目录优先、名称排序）。
 *   [3] 变更面：mkdir / rename / move（同名策略、环检测、根保护、跨用户禁移）。
 *   [4] 删除：子树级联计数 + .shufa 任务目录保护（错误文案与 daemon 一致）。
 *   [5] 上传：同名 " (2)" 递增 + 内容去重标记。
 */
import type {
  ResDeleteOutput,
  ResTreeOutput,
  ResUploadOutput,
  ResourceBadge,
  ResourceItem,
} from "$lib/types";

/** mock 行：契约视图 + 内部字段（owner 用户名 / mock 实体字节）。 */
interface MockResRow extends ResourceItem {
  owner: string;
  content: { b64: string; mime: string } | null;
}

const now = (): string => new Date().toISOString();

/** 种子视频（1s 160x96 H.264，base64 ~2KB）：让视频预览开箱可用。 */
const SEED_MP4_B64 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAPBbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAux0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKAAAABgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAIAAABAAAAAAJkbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAAMABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACD21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAc9zdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAKAAYABIAAAASAAAAAAAAAABFUxhdmM2Mi4xMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UKNsBEAAAMAAQAAAwAYDxIllgEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAdgAAAAAAAAAAYc3R0cwAAAAAAAAABAAAADAAABAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAAGhjdHRzAAAAAAAAAAsAAAABAAAIAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAQAAAAAAIAAAQAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAMAAAAAQAAAERzdHN6AAAAAAAAAAAAAAAMAAADCQAAABAAAAANAAAADQAAAA0AAAAWAAAADwAAAA0AAAANAAAAFQAAAA8AAAANAAAAFHN0Y28AAAAAAAAAAQAAA/EAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYyLjMuMTAwAAAACGZyZWUAAAO4bWRhdAAAAq4GBf//qtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0zIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0xMiBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAFNliIQAEP/+5sD5llkdx99Q2tAdSV0C7rnkN6cQDP0xoO0P46qTqIAauUq8cMLYZk2xDp2KLPIuJJchFhOT9isAMCiSacZ10QzKcP6iyMS3QHAc8QAAAAxBmiRsQQ/+qlUAPGAAAAAJQZ5CeIb/AJSBAAAACQGeYXRDPwC2gAAAAAkBnmNqQz8AtoEAAAASQZpoSahBaJlMCH///qmWAOaBAAAAC0GehkURLDf/AJSBAAAACQGepXRDPwC2gQAAAAkBnqdqQz8AtoAAAAARQZqrSahBbJlMCGf//p4QBswAAAALQZ7JRRUsN/8AlIEAAAAJAZ7qakM/ALaA";

/** 种子图片（内嵌 SVG 示例）：让图片预览开箱可用。 */
const SEED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160"><rect width="240" height="160" fill="#faf7f0"/><rect x="16" y="16" width="208" height="128" fill="none" stroke="#c0392b" stroke-width="3"/><text x="120" y="105" font-size="72" text-anchor="middle" fill="#2a2622" font-family="Kaiti, STKaiti, serif">永字八法</text></svg>`;

export class MockResources {
  private rows: MockResRow[] = [];
  private seq = 0;
  private seenContent = new Set<string>();

  private newId(): string {
    this.seq += 1;
    return `mr-${this.seq}`;
  }

  private rootOf(username: string): MockResRow {
    const existing = this.rows.find((row) => row.owner === username && row.meta === null && row.parent_id === null && row.is_dir);
    if (existing) return existing;
    const root: MockResRow = {
      id: this.newId(), owner: username, parent_id: null, name: username,
      is_dir: true, size: 0, meta: null, content: null,
      created_at: now(), updated_at: now(),
    };
    this.rows.push(root);
    return root;
  }

  /** mock 根行约定：meta 恒为 null，靠 parent_id === null + is_dir 定位（每用户唯一）。 */
  private rowOf(id: string): MockResRow {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`资源不存在：${id}`);
    return row;
  }

  private requireOwned(actor: string | undefined, id: string): MockResRow {
    const row = this.rowOf(id);
    if (actor !== undefined && row.owner !== actor) throw new Error("无权访问他人资源");
    return row;
  }

  private view(row: MockResRow): ResourceItem {
    const { id, parent_id, name, is_dir, size, meta, created_at, updated_at } = row;
    return { id, parent_id, name, is_dir, size, meta, created_at, updated_at };
  }

  private childRows(owner: string, rootId: string, parentId: string): MockResRow[] {
    const rows = this.rows.filter((row) => row.owner === owner && row.id !== rootId);
    return rows
      .filter((row) => this.logicalParentId(row, rootId) === parentId)
      .sort((a, b) => {
        if (a.is_dir !== b.is_dir) return Number(b.is_dir) - Number(a.is_dir);
        return a.name.localeCompare(b.name, "zh-Hans-CN");
      });
  }

  /** NULL-parent 行（任务文件夹/直传视频）逻辑挂根下。 */
  private logicalParentId(row: MockResRow, rootId: string): string | null {
    if (row.parent_id) return row.parent_id;
    return row.id === rootId ? null : rootId;
  }

  tree(owner: string, parent?: string): ResTreeOutput {
    const root = this.rootOf(owner);
    const path: MockResRow[] = [root];
    let parentId = root.id;
    if (parent) {
      const target = this.rowOf(parent);
      if (!target.is_dir) throw new Error("parent 必须是文件夹");
      parentId = target.id;
      const chain: MockResRow[] = [];
      const seen = new Set<string>();
      let current: MockResRow | null = target;
      while (current && current.id !== root.id && !seen.has(current.id)) {
        seen.add(current.id);
        chain.unshift(current);
        const pid = this.logicalParentId(current, root.id);
        current = pid ? this.rowOf(pid) : null;
      }
      path.push(...chain);
    }
    return {
      owner: { id: `user-${owner}`, username: owner },
      root: this.view(root),
      path: path.map((row) => this.view(row)),
      items: this.childRows(owner, root.id, parentId).map((row) => this.view(row)),
    };
  }

  /** owner 形参保留与真 API 的签名对称（mock 单机不校验变更归属）。 */
  mkdir(_owner: string, parent: string, name: string): ResourceItem {
    const parentRow = this.requireOwned(undefined, parent);
    if (!parentRow.is_dir) throw new Error("parent 必须是文件夹");
    const finalName = this.uniqueName(parentRow.owner, this.rootOf(parentRow.owner).id, parent, name, "");
    return this.view(this.insertRow(parentRow.owner, parent, finalName, true, 0, null, null));
  }

  rename(id: string, name: string): ResourceItem {
    const row = this.requireOwned(undefined, id);
    const root = this.rootOf(row.owner);
    if (row.id === root.id) throw new Error("根文件夹不可改名");
    if (row.meta) throw new Error("任务 .shufa 目录受保护，不可改名");
    if (name !== row.name) {
      const clash = this.childRows(row.owner, root.id, this.logicalParentId(row, root.id) ?? "").some(
        (sibling) => sibling.id !== row.id && sibling.name.toLowerCase() === name.toLowerCase(),
      );
      if (clash) throw new Error(`同名资源已存在：${name}`);
    }
    row.name = name;
    row.updated_at = now();
    return this.view(row);
  }

  move(id: string, newParent: string): ResourceItem {
    const row = this.requireOwned(undefined, id);
    const target = this.requireOwned(undefined, newParent);
    if (row.id === target.id) throw new Error("不能把资源移动到其自身");
    if (!target.is_dir) throw new Error("new_parent 必须是文件夹");
    if (row.owner !== target.owner) throw new Error("不能跨用户移动资源");
    const root = this.rootOf(row.owner);
    if (row.id === root.id) throw new Error("根文件夹不可移动");
    if (row.meta) throw new Error("任务 .shufa 目录受保护，不可移动");
    if (row.is_dir && this.isDescendant(target, row, root.id)) {
      throw new Error("不能把文件夹移动到其子目录内");
    }
    const clash = this.childRows(row.owner, root.id, target.id).some(
      (sibling) => sibling.id !== row.id && sibling.name.toLowerCase() === row.name.toLowerCase(),
    );
    if (clash) throw new Error(`同名资源已存在：${row.name}`);
    row.parent_id = target.id;
    row.updated_at = now();
    return this.view(row);
  }

  remove(id: string): ResDeleteOutput {
    const row = this.requireOwned(undefined, id);
    const root = this.rootOf(row.owner);
    if (row.id === root.id) throw new Error("根文件夹不可删除");
    const subtree = this.subtreeOf(row, root.id);
    if (subtree.some((node) => node.meta !== null)) {
      throw new Error("任务 .shufa 目录受保护：任务资产（会话/结果）不可删除");
    }
    let blobsReleased = 0;
    for (const node of subtree.reverse()) {
      if (node.content) blobsReleased += 1;
      this.rows = this.rows.filter((candidate) => candidate.id !== node.id);
    }
    return { deleted: subtree.length, blobs_released: blobsReleased };
  }

  upload(_owner: string, parent: string, filename: string, b64: string, mime: string): ResUploadOutput {
    const parentRow = this.requireOwned(undefined, parent);
    if (!parentRow.is_dir) throw new Error("parent 必须是文件夹");
    if (b64.length === 0) throw new Error("上传内容为空");
    const safeName = filename.split(/[\\/]/).pop() ?? "";
    if (!safeName || safeName === "." || safeName === "..") throw new Error(`非法文件名：${filename}`);
    const deduped = this.seenContent.has(b64);
    this.seenContent.add(b64);
    const dot = safeName.lastIndexOf(".");
    const stem = dot <= 0 ? safeName : safeName.slice(0, dot);
    const ext = dot <= 0 ? "" : safeName.slice(dot);
    const name = this.uniqueName(parentRow.owner, this.rootOf(parentRow.owner).id, parent, stem, ext);
    const size = Math.floor((b64.length * 3) / 4);
    return {
      item: this.view(this.insertRow(parentRow.owner, parent, name, false, size, null, { b64, mime })),
      deduped,
    };
  }

  /** 预览/下载用 mock 实体（真实现为 GET /api/res/{id}/raw）。 */
  rawUrl(id: string): string | null {
    const row = this.rowOf(id);
    if (row.is_dir || !row.content) return null;
    return `data:${row.content.mime};base64,${row.content.b64}`;
  }

  // ---------------------------------------------------------------- internals

  private insertRow(
    owner: string,
    parentId: string,
    name: string,
    isDir: boolean,
    size: number,
    meta: ResourceBadge | null,
    content: { b64: string; mime: string } | null,
  ): MockResRow {
    const row: MockResRow = {
      id: this.newId(), owner, parent_id: parentId, name, is_dir: isDir,
      size, meta, content, created_at: now(), updated_at: now(),
    };
    this.rows.push(row);
    return row;
  }

  private uniqueName(owner: string, rootId: string, parentId: string, stem: string, ext: string): string {
    const taken = new Set(this.childRows(owner, rootId, parentId).map((row) => row.name.toLowerCase()));
    if (!taken.has(`${stem}${ext}`.toLowerCase())) return `${stem}${ext}`;
    for (let n = 2; ; n += 1) {
      const candidate = `${stem} (${n})${ext}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  private isDescendant(target: MockResRow, folder: MockResRow, rootId: string): boolean {
    const seen = new Set<string>();
    let current: MockResRow | null = target;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.id === folder.id) return true;
      const pid = this.logicalParentId(current, rootId);
      current = pid ? this.rowOf(pid) : null;
    }
    return false;
  }

  private subtreeOf(row: MockResRow, rootId: string): MockResRow[] {
    const result: MockResRow[] = [];
    const queue = [row];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const node = queue.shift() as MockResRow;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      result.push(node);
      queue.push(...this.childRows(node.owner, rootId, node.id));
    }
    return result;
  }
}

/** 单例（mockDb 同生命周期；联调切真 API 后整体废弃）。 */
export const mockResources = new MockResources();

/** 种子：王老师名下的示例树（含 .shufa 徽标目录 + 可预览媒体）。 */
export function seedMockResources(): void {
  const owner = "王老师";
  const root = mockResources.tree(owner).root;
  const folder = mockResources.mkdir(owner, root.id, "兰亭序临摹");
  mockResources.upload(
    owner, folder.id, "行书示范-起笔.mp4", SEED_MP4_B64, "video/mp4",
  );
  mockResources.upload(
    owner, root.id, "楷书入门-横竖点.mp4", SEED_MP4_B64, "video/mp4",
  );
  mockResources.upload(
    owner, root.id, "永字八法.png",
    btoa(unescape(encodeURIComponent(SEED_SVG))), "image/svg+xml",
  );
  // .shufa 任务目录（带徽标 meta；保护语义与 daemon 一致）。
  const shufa: MockResRow = {
    id: `mr-shufa-1`, owner, parent_id: folder.id, name: ".shufa",
    is_dir: true, size: 0,
    meta: {
      task_id: "t-1", task_status: "done",
      agent_session_id: "sess-ls-01", result_id: "aZ3xKq9LmP",
    },
    content: null, created_at: now(), updated_at: now(),
  };
  (mockResources as unknown as { rows: MockResRow[] }).rows.push(shufa);
}