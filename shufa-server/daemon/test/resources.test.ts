/**
 * 资源管理器测试（W5）：树/建目/改名/移动/删除级联 + ref_count 归零删实体 /
 * 越权 403/404 / .shufa 任务资产保护 / 上传内容寻址与同名 " (2)" 递增 /
 * rpc res 六端点接线 + /api/res/{id}/raw 原始内容面（token 鉴权 + Range 206）。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §2/§4/§5）。
 * 正交意图：
 *   [1] ResourceService 读面（根惰性创建、面包屑、子项排序、.shufa 徽标投影）。
 *   [2] 变更面（mkdir/rename/move 语义与保护规则）。
 *   [3] 删除级联与 blob 引用计数回收。
 *   [4] 上传（寻址去重、同名递增、上限、穿越净化）。
 *   [5] rpc/HTTP 面（401/501/403/404/raw Range）。
 */
import { existsSync } from 'node:fs';
import { getResourceById, parseResourceMeta } from '../src/db/tasks.js';
import path from 'node:path';
import { RPCHandler } from '@orpc/server/ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResource, createTask, updateResourceMeta, type ResourceRow } from '../src/db/tasks.js';
import { createUser } from '../src/db/store.js';
import { hashPassword } from '../src/auth.js';
import { BlobStore } from '../src/db/blobs.js';
import { ResourceService, RESOURCE_UPLOAD_MAX_BYTES } from '../src/resources.js';
import { DaemonHttp } from '../src/http.js';
import { signJwt } from '../src/auth.js';
import { clientFor, createServices, TEST_SECRET, type TestServices } from './helpers.js';
import { router, type RpcContext } from '../src/rpc.js';

/** 同步服务调用的错误码断言（ORPCError.code）。 */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}，但未抛错`);
}

describe('ResourceService 树与变更', () => {
  let env: TestServices;
  let alice: ReturnType<typeof createUser>;
  let bob: ReturnType<typeof createUser>;
  let admin: ReturnType<typeof createUser>;
  let service: ResourceService;
  let blobs: BlobStore;

  beforeEach(() => {
    env = createServices();
    alice = createUser(env.db, { username: 'alice', passwordHash: hashPassword('pw'), role: 'user' });
    bob = createUser(env.db, { username: 'bob', passwordHash: hashPassword('pw'), role: 'user' });
    admin = createUser(env.db, { username: 'root-admin', passwordHash: hashPassword('pw'), role: 'admin' });
    blobs = new BlobStore(env.config.dataRoot, env.db);
    service = new ResourceService({ config: env.config, db: env.db, blobs });
  });

  afterEach(() => {
    env.dispose();
  });

  /** 造 .shufa 任务目录（与 TaskService.create 同构：任务文件夹 + .shufa meta 行 + 任务行）。 */
  function seedTaskFolder(ownerId: string): { folder: ResourceRow; shufa: ResourceRow } {
    const folder = createResource(env.db, {
      ownerId,
      parentId: null,
      name: `20260923-${Math.random().toString(16).slice(2, 6)}`,
      isDir: true,
    });
    const shufa = createResource(env.db, {
      ownerId,
      parentId: folder.id,
      name: '.shufa',
      isDir: true,
      meta: { dir: path.join(env.root, 'phys', folder.name, '.shufa'), task_id: null, agent_session_id: null, result_id: null },
    });
    const task = createTask(env.db, { ownerId, resourceId: shufa.id, videoResourceId: null, prompt: 'p' });
    updateResourceMeta(env.db, shufa.id, {
      dir: path.join(env.root, 'phys', folder.name, '.shufa'),
      task_id: task.id,
      agent_session_id: 'sess-1',
      result_id: null,
    });
    return { folder, shufa };
  }

  it('tree：根惰性创建（行 + 物理目录）且幂等，NULL-parent 行逻辑挂根，文件夹优先', () => {
    const first = service.tree(alice, {});
    expect(first.root.name).toBe('alice');
    expect(first.root.is_dir).toBe(true);
    expect(first.path).toHaveLength(1);
    expect(existsSync(path.join(env.config.dataRoot, 'users', 'alice'))).toBe(true);

    // NULL-parent 行（TaskService 产生的任务文件夹 / 直传视频）应出现在根层，目录在前。
    const { folder } = seedTaskFolder(alice.id);
    createResource(env.db, {
      ownerId: alice.id, parentId: null, name: 'b-视频.mp4', isDir: false,
      contentHash: null, size: 10, meta: { blob: true },
    });
    createResource(env.db, { ownerId: alice.id, parentId: null, name: 'a-文件夹', isDir: true });
    const again = service.tree(alice, {});
    expect(again.root.id).toBe(first.root.id); // 惰性创建幂等
    const names = again.items.map((item) => item.name);
    expect(names).toContain('a-文件夹');
    expect(names).toContain(folder.name);
    expect(names).toContain('b-视频.mp4');
    const dirCount = again.items.filter((item) => item.is_dir).length;
    expect(again.items.slice(0, dirCount).every((item) => item.is_dir)).toBe(true);
  });

  it('tree：parent 面包屑链 + .shufa 徽标 meta（含任务状态）；未知 parent 404；非目录 400', () => {
    const { folder } = seedTaskFolder(alice.id);
    const inside = service.tree(alice, { parent: folder.id });
    expect(inside.path.map((row) => row.name)).toEqual(['alice', folder.name]);
    const shufaView = inside.items.find((row) => row.name === '.shufa');
    expect(shufaView?.meta).toMatchObject({
      task_id: expect.any(String),
      task_status: 'queued',
      agent_session_id: 'sess-1',
      result_id: null,
    });
    expectCode(() => service.tree(alice, { parent: 'nope' }), 'NOT_FOUND');
    const file = service.upload(alice, {
      parent: service.rootOf(alice.id).id,
      filename: 'x.png',
      b64: Buffer.from('x').toString('base64'),
    });
    expectCode(() => service.tree(alice, { parent: file.item.id }), 'BAD_REQUEST');
  });

  it('tree：越权 403（普通用户看他人 / 传他人 owner），admin 可带 owner 看任意用户', () => {
    seedTaskFolder(alice.id);
    expectCode(() => service.tree(bob, { owner: 'alice' }), 'FORBIDDEN');
    // 非 admin 传任意 owner（含不存在的用户名）一律 403，不泄露用户存在性。
    expectCode(() => service.tree(bob, { owner: 'missing-user' }), 'FORBIDDEN');
    const asAdmin = service.tree(admin, { owner: 'alice' });
    expect(asAdmin.owner.username).toBe('alice');
    expect(asAdmin.items).toHaveLength(1);
  });

  it('mkdir：建目录 + 同名自动 " (2)"；rename 生效、撞名 409、根 409、.shufa 409', () => {
    const root = service.rootOf(alice.id);
    const dir = service.mkdir(alice, { parent: root.id, name: '碑帖' });
    expect(dir.name).toBe('碑帖');
    const dir2 = service.mkdir(alice, { parent: root.id, name: '碑帖' });
    expect(dir2.name).toBe('碑帖 (2)');

    const renamed = service.rename(alice, { id: dir2.id, name: '法帖' });
    expect(renamed.name).toBe('法帖');
    expectCode(() => service.rename(alice, { id: dir2.id, name: '碑帖' }), 'CONFLICT');
    expectCode(() => service.rename(alice, { id: root.id, name: 'x' }), 'CONFLICT');

    const { shufa } = seedTaskFolder(alice.id);
    expectCode(() => service.rename(alice, { id: shufa.id, name: 'renamed' }), 'CONFLICT');
  });

  it('move：移动生效；入自身子树 409；跨用户 409；.shufa 409；目标撞名 409', () => {
    const root = service.rootOf(alice.id);
    const a = service.mkdir(alice, { parent: root.id, name: 'A' });
    const b = service.mkdir(alice, { parent: root.id, name: 'B' });
    const inner = service.mkdir(alice, { parent: a.id, name: 'A-1' });

    const moved = service.move(alice, { id: inner.id, new_parent: b.id });
    expect(moved.parent_id).toBe(b.id);

    // 环检测：C 移入仍在 C 内的 C-1。
    const c = service.mkdir(alice, { parent: root.id, name: 'C' });
    const c1 = service.mkdir(alice, { parent: c.id, name: 'C-1' });
    expectCode(() => service.move(alice, { id: c.id, new_parent: c1.id }), 'CONFLICT');

    const { folder, shufa } = seedTaskFolder(alice.id);
    expectCode(() => service.move(alice, { id: shufa.id, new_parent: b.id }), 'CONFLICT'); // .shufa 保护
    const movedTask = service.move(alice, { id: folder.id, new_parent: a.id }); // 任务文件夹可移
    expect(movedTask.parent_id).toBe(a.id);

    service.mkdir(alice, { parent: b.id, name: 'A' });
    expectCode(() => service.move(alice, { id: a.id, new_parent: b.id }), 'CONFLICT'); // 撞名
    const bobRoot = service.rootOf(bob.id);
    expectCode(() => service.move(admin, { id: inner.id, new_parent: bobRoot.id }), 'CONFLICT'); // 跨用户
    expectCode(() => service.move(bob, { id: a.id, new_parent: b.id }), 'FORBIDDEN'); // 越权
  });

  it('删除：文件行移除 + ref_count 减一；共享 blob 存活；归零删实体；级联计数', () => {
    const root = service.rootOf(alice.id);
    const bytes = Buffer.from('shared-bytes');
    // 与 upload 同构：每个资源行一次 put（内容寻址去重，ref_count +1）。
    const mk = (name: string, parentId: string) => {
      const put = blobs.put(bytes);
      return createResource(env.db, {
        ownerId: alice.id, parentId, name, isDir: false,
        contentHash: put.hash, size: put.size, meta: { blob: true },
      });
    };
    const f1 = mk('a.txt', root.id);
    const f2 = mk('b.txt', root.id);
    const hash = f1.content_hash as string;
    expect(
      (env.db.prepare('SELECT ref_count FROM blobs WHERE hash = ?').get(hash) as { ref_count: number })
        .ref_count,
    ).toBe(2);

    expect(service.remove(alice, { id: f1.id })).toEqual({ deleted: 1, blobs_released: 0 });
    expect(existsSync(blobs.pathFor(hash))).toBe(true); // 仍有 1 个引用

    const dir = service.mkdir(alice, { parent: root.id, name: 'dir' });
    mk('c.txt', dir.id);
    expect(service.remove(alice, { id: dir.id })).toEqual({ deleted: 2, blobs_released: 0 });

    expect(service.remove(alice, { id: f2.id })).toEqual({ deleted: 1, blobs_released: 1 });
    expect(existsSync(blobs.pathFor(hash))).toBe(false); // 归零回收实体
    expect((env.db.prepare('SELECT COUNT(*) AS n FROM blobs WHERE hash = ?').get(hash) as { n: number }).n).toBe(0);

    expectCode(() => service.remove(alice, { id: root.id }), 'CONFLICT'); // 根保护
  });

  it('删除：.shufa 直删 409；级联途经任务文件夹 409；他人资源 403；未知 404', () => {
    const { folder, shufa } = seedTaskFolder(alice.id);
    expectCode(() => service.remove(alice, { id: shufa.id }), 'CONFLICT');
    expectCode(() => service.remove(alice, { id: folder.id }), 'CONFLICT');
    expectCode(() => service.remove(bob, { id: folder.id }), 'FORBIDDEN');
    expectCode(() => service.remove(bob, { id: 'missing' }), 'NOT_FOUND');
    expectCode(() => service.remove(admin, { id: folder.id }), 'CONFLICT'); // admin 豁免归属但不豁免保护
  });

  it('上传：内容寻址去重、同名 " (2)"、穿越净化、超限 400、空内容 400', () => {
    const root = service.rootOf(alice.id);
    const b64 = Buffer.from('png-bytes').toString('base64');
    const first = service.upload(alice, { parent: root.id, filename: '帖.png', b64 });
    expect(first.deduped).toBe(false);
    const second = service.upload(alice, { parent: root.id, filename: '帖.png', b64 });
    expect(second.deduped).toBe(true);
    expect(second.item.name).toBe('帖 (2).png');
    expect((env.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n).toBe(1);

    // 文件名取 basename（穿越净化）；evil.png 未被占用故不追加序号。
    const third = service.upload(alice, { parent: root.id, filename: '../../evil.png', b64 });
    expect(third.item.name).toBe('evil.png');

    const tiny = new ResourceService({ config: env.config, db: env.db, blobs, maxUploadBytes: 4 });
    expectCode(() => tiny.upload(alice, { parent: root.id, filename: 'big.png', b64 }), 'BAD_REQUEST');
    expectCode(() => service.upload(alice, { parent: root.id, filename: 'empty.png', b64: '' }), 'BAD_REQUEST');
    expect(RESOURCE_UPLOAD_MAX_BYTES).toBe(256 * 1024 * 1024);
  });
});

describe('走查 R7 附件上传', () => {
  let env: TestServices;
  let service: ResourceService;

  beforeEach(() => {
    env = createServices();
    const user = createUser(env.db, { username: 'alice', passwordHash: 'x', role: 'user' });
    (env as unknown as { __user?: unknown }).__user = user;
    service = new ResourceService({ config: env.config, db: env.db, blobs: new BlobStore(env.config.dataRoot, env.db) });
  });

  afterEach(() => env.dispose());

  it('attachmentUpload：blob 落盘 + 资源树登记（meta.mime）+ path 可读；空内容/超限拒绝', async () => {
    const user = (env as unknown as { __user: ReturnType<typeof createUser> }).__user;
    // 1x1 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const out = service.attachmentUpload(user, { filename: 'demo.png', data_base64: png.toString('base64') });
    expect(out.name).toBe('demo.png');
    expect(out.size).toBe(png.byteLength);
    expect(existsSync(out.path)).toBe(true);
    const row = getResourceById(env.db, out.resource_id);
    expect(row?.content_hash).toBeTruthy();
    expect(parseResourceMeta(row ?? ({ meta: '' } as never))?.mime).toBe('image/png');
    // 空内容拒绝
    expect(() => service.attachmentUpload(user, { filename: 'x.png', data_base64: '' })).toThrow();
    // sharp 缩略 smoke（webp 输出非空）——附件预览管线核心依赖。
    const sharp = (await import('sharp')).default;
    const thumb = await sharp(out.path).resize({ width: 96 }).webp().toBuffer();
    expect(thumb.byteLength).toBeGreaterThan(0);
  });
});

describe('res rpc/HTTP 接线', () => {
  let env: TestServices;
  let alice: ReturnType<typeof createUser>;

  beforeEach(() => {
    env = createServices();
    alice = createUser(env.db, { username: 'alice', passwordHash: hashPassword('pw'), role: 'user' });
  });

  afterEach(() => {
    env.dispose();
  });

  it('rpc：未认证 401；未装配 501；装配后全链路（tree→upload→mkdir→move→delete）', async () => {
    const bare = clientFor(env.context({ user: alice, secret: TEST_SECRET }));
    await expect(bare.res.tree({})).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(clientFor(env.context({ secret: TEST_SECRET })).res.tree({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    const blobs = new BlobStore(env.config.dataRoot, env.db);
    const service = new ResourceService({ config: env.config, db: env.db, blobs });
    const client = clientFor(env.context({ user: alice, secret: TEST_SECRET, resources: service }));

    const tree = await client.res.tree({});
    const upload = await client.res.upload({
      parent: tree.root.id,
      filename: 'lesson.mp4',
      b64: Buffer.from('video-bytes').toString('base64'),
    });
    expect(upload.item.name).toBe('lesson.mp4');
    const dir = await client.res.mkdir({ parent: tree.root.id, name: '收藏' });
    await client.res.move({ id: upload.item.id, new_parent: dir.item.id });
    const sub = await client.res.tree({ parent: dir.item.id });
    expect(sub.items.map((item) => item.name)).toEqual(['lesson.mp4']);
    const removed = await client.res.delete({ id: dir.item.id });
    expect(removed.deleted).toBe(2);
    expect(removed.blobs_released).toBe(1);
  });

  it('GET /api/res/{id}/raw：query token 鉴权、归属 403、MIME 按资源名、Range 206', async () => {
    const blobs = new BlobStore(env.config.dataRoot, env.db);
    const service = new ResourceService({ config: env.config, db: env.db, blobs });
    const rpcHandler = new RPCHandler<RpcContext>(router);
    const daemon = new DaemonHttp({
      config: env.config,
      db: env.db,
      wizard: env.wizard,
      secret: env.secret,
      rpcHandler,
      resources: service,
      blobs,
    });
    const port = await daemon.listen(0, '127.0.0.1');
    try {
      const root = service.rootOf(alice.id);
      const { item } = service.upload(alice, {
        parent: root.id,
        filename: 'clip.mp4',
        b64: Buffer.alloc(1000, 0x61).toString('base64'),
      });
      const bob = createUser(env.db, { username: 'bob', passwordHash: hashPassword('pw'), role: 'user' });
      const { token } = await signJwt(env.secret, { sub: alice.id, role: alice.role });

      const base = `http://127.0.0.1:${port}`;
      const full = await fetch(`${base}/api/res/${item.id}/raw?token=${token}`);
      expect(full.status).toBe(200);
      expect(full.headers.get('content-type')).toBe('video/mp4');
      expect(Buffer.from(await full.arrayBuffer()).byteLength).toBe(1000);

      const range = await fetch(`${base}/api/res/${item.id}/raw?token=${token}`, {
        headers: { range: 'bytes=0-9' },
      });
      expect(range.status).toBe(206);
      expect(range.headers.get('content-range')).toBe('bytes 0-9/1000');

      const bobToken = (await signJwt(env.secret, { sub: bob.id, role: bob.role })).token;
      expect((await fetch(`${base}/api/res/${item.id}/raw?token=${bobToken}`)).status).toBe(403);
      expect((await fetch(`${base}/api/res/${item.id}/raw`)).status).toBe(401);
      expect((await fetch(`${base}/api/res/missing/raw?token=${token}`)).status).toBe(404);
    } finally {
      await daemon.stop();
    }
  });
});
