/**
 * 后台 CRUD 与权限矩阵抽测（W2' 验证门）：
 * anonymous→admin 403、user→admin 403、未认证 401；tasks/res 501 壳。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §2/§4）。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../src/auth.js';
import {
  createUser,
  getUserById,
} from '../src/db/store.js';
import { createResult } from '../src/db/store.js';
import { createResource, createTask, getResourceById } from '../src/db/tasks.js';
import { clientFor, createServices } from './helpers.js';
import { expect, test } from 'vitest';
import type { RpcContext } from '../src/rpc.js';

/** 造一个已配置的管理员与普通用户，返回各自身份的 context。 */
async function seedIdentities(s: ReturnType<typeof createServices>) {
  const bootstrap = clientFor(s.context());
  // 走查 BUG6：匿名默认关——本夹具需要匿名身份参与权限矩阵，显式开启。
  const admin = await bootstrap.setup.createAdmin({
    username: 'boss',
    password: 'secret66',
    allow_anonymous: true,
  });
  const adminAuthed = clientFor(s.context({ token: admin.token }));
  const user = await adminAuthed.admin.users.create({
    username: 'alice',
    password: 'alice-pass',
    role: 'user',
  });
  const userLogin = await bootstrap.auth.login({ username: 'alice', password: 'alice-pass' });
  const anon = await bootstrap.auth.anonymous();
  return {
    adminCtx: s.context({ token: admin.token }) as RpcContext,
    userCtx: s.context({ token: userLogin.token }),
    anonCtx: s.context({ token: anon.token }),
    admin,
    user,
    anon,
  };
}

test('admin 用户 CRUD：创建/列表/禁用/改角色', async () => {
  const s = createServices();
  try {
    const { adminCtx } = await seedIdentities(s);
    const adminAuthed = clientFor(adminCtx);
    const { users } = await adminAuthed.admin.users.list();
    const names = users.map((u) => u.username);
    expect(names).toContain('boss');
    expect(names).toContain('alice');
    expect(names).toContain('__anonymous__');

    const target = users.find((u) => u.username === 'alice');
    expect(target?.role).toBe('user');
    const updated = await adminAuthed.admin.users.update({ id: target?.id ?? '', role: 'admin' });
    expect(updated.role).toBe('admin');
  } finally {
    s.dispose();
  }
});

test('权限矩阵：匿名/普通用户调 admin 端点 403；未认证 401', async () => {
  const s = createServices();
  try {
    const { adminCtx, userCtx, anonCtx } = await seedIdentities(s);
    await expect(clientFor(anonCtx).admin.users.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(clientFor(userCtx).admin.users.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(clientFor(anonCtx).admin.settings.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      clientFor(userCtx).admin.password({ old_password: 'x', new_password: 'yyyyyy' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // 无 token 连接调认证端点：401 而非 403。
    await expect(clientFor(s.context()).me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(clientFor(s.context()).admin.users.list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    // admin 正常。
    await expect(clientFor(adminCtx).admin.users.list()).resolves.toBeTruthy();
  } finally {
    s.dispose();
  }
});

test('admin settings：白名单 get/put/list；匿名开关联动 bootstrap', async () => {
  const s = createServices();
  try {
    const { adminCtx } = await seedIdentities(s);
    const admin = clientFor(adminCtx);

    const put = await admin.admin.settings.put({ key: 'site_name', value: '书法点评台' });
    expect(put.value).toBe('书法点评台');
    expect((await admin.admin.settings.get({ key: 'site_name' })).value).toBe('书法点评台');

    await admin.admin.settings.put({ key: 'allow_anonymous', value: '0' });
    const bootstrap = await clientFor(s.context()).bootstrap();
    expect(bootstrap.allow_anonymous).toBe(false);
    expect(bootstrap.site_name).toBe('书法点评台');

    await expect(
      admin.admin.settings.put({ key: 'allow_anonymous', value: 'yes' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const { settings } = await admin.admin.settings.list();
    expect(settings.map((entry) => entry.key).sort()).toEqual([
      'allow_anonymous',
      'llm_api',
      'llm_api_key',
      'llm_base_url',
      'llm_model',
      'llm_provider',
      'site_base_url',
      'site_name',
    ]);
    // W7 联调：llm_* 模型路由键经白名单落库（resolveModelRouteFromStore 第一信源）。
    await admin.admin.settings.put({ key: 'llm_provider', value: 'zhipu' });
    await admin.admin.settings.put({ key: 'llm_model', value: 'glm-5.3-flash' });
    await admin.admin.settings.put({ key: 'llm_api', value: 'openai-completions' });
    expect((await admin.admin.settings.get({ key: 'llm_provider' })).value).toBe('zhipu');
  } finally {
    s.dispose();
  }
});

test('admin 改密：需原密码；改后新密码可登录', async () => {
  const s = createServices();
  try {
    const { adminCtx } = await seedIdentities(s);
    const admin = clientFor(adminCtx);
    await expect(
      admin.admin.password({ old_password: 'wrong-old', new_password: 'new-pass-99' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await admin.admin.password({ old_password: 'secret66', new_password: 'new-pass-99' });
    const relogin = await clientFor(s.context()).auth.login({
      username: 'boss',
      password: 'new-pass-99',
    });
    expect(relogin.user.username).toBe('boss');
    await expect(
      clientFor(s.context()).auth.login({ username: 'boss', password: 'secret66' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  } finally {
    s.dispose();
  }
});

test('admin 用户修改防护：__anonymous__ 三禁（改密/禁用/改角色）；不能自禁/自降级；未知用户 404', async () => {
  const s = createServices();
  try {
    const { adminCtx, admin } = await seedIdentities(s);
    const adminAuthed = clientFor(adminCtx);
    const { users } = await adminAuthed.admin.users.list();
    const anonId = users.find((u) => u.username === '__anonymous__')?.id ?? '';
    // 走查 BUG5 三禁：禁改密 / 禁禁用 / 禁改角色（匿名开合只走 allow_anonymous 设置）。
    await expect(
      adminAuthed.admin.users.update({ id: anonId, password: 'newpass-1' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: '内置匿名账号不可改密' });
    await expect(adminAuthed.admin.users.update({ id: anonId, disabled: true })).rejects.toMatchObject(
      { code: 'CONFLICT', message: '内置匿名账号不可禁用（匿名访问开关走 allow_anonymous 设置）' },
    );
    await expect(
      adminAuthed.admin.users.update({ id: anonId, role: 'user' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: '内置匿名账号不可改角色' });
    await expect(
      adminAuthed.admin.users.update({ id: admin.user.id, disabled: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      adminAuthed.admin.users.update({ id: 'no-such-id', role: 'user' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  } finally {
    s.dispose();
  }
});

test('tasks 需认证（未装配服务时 501）/ res 为 501 壳', async () => {
  const s = createServices();
  try {
    // W4 起 tasks 四端点挂 requireAuth（未认证一律 401，先于 501 判定）。
    const anon = clientFor(s.context());
    await expect(anon.tasks.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anon.tasks.get({ id: 't1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anon.tasks.cancel({ id: 't1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anon.tasks.create({ prompt: 'x', video_resource_id: 'r1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // 已认证但 TaskService 未装配（内核停用）：501。
    // 走查 BUG6 后匿名默认关（requireAuth 匿名门控 401），501 壳改用普通用户验证。
    const plainUser = createUser(s.db, {
      username: 'bob',
      passwordHash: hashPassword('bob-pass-99'),
      role: 'user',
    });
    const authed = clientFor(s.context({ user: plainUser }));
    await expect(authed.tasks.list()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(authed.tasks.get({ id: 't1' })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    await expect(authed.tasks.cancel({ id: 't1' })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    // res 六端点挂 requireAuth（未认证 401）；已认证但 ResourceService 未装配：501。
    await expect(anon.res.tree({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anon.res.rename({ id: 'r1', name: 'x' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(authed.res.tree({})).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  } finally {
    s.dispose();
  }
});

test('BUG5 admin.users.delete：数据级联清理（行 / 磁盘目录 / blob 引用计数）', async () => {
  const s = createServices();
  try {
    const boot = clientFor(s.context());
    const adminIssued = await boot.setup.createAdmin({ username: 'boss', password: 'secret66' });
    const admin = clientFor(s.context({ token: adminIssued.token }));
    const carol = await admin.admin.users.create({ username: 'carol', password: 'carol-pw', role: 'user' });
    const daveRow = createUser(s.db, {
      username: 'dave',
      passwordHash: hashPassword('dave-pass-99'),
      role: 'user',
    });

    // carol 名下数据：独享 blob（应被 GC）+ 与 dave 共享 blob（ref 2→1，实体保留）。
    const soloBytes = Buffer.from('carol-solo-video-bytes');
    const soloHash = s.blobs.put(soloBytes).hash;
    const sharedBytes = Buffer.from('shared-blob-bytes');
    const sharedHash = s.blobs.put(sharedBytes).hash; // carol 的引用（ref 1）
    s.blobs.put(sharedBytes); // dave 的引用（ref 2）
    const carolRes = createResource(s.db, {
      ownerId: carol.id,
      parentId: null,
      name: 'carol-video.mp4',
      isDir: false,
      contentHash: soloHash,
      size: soloBytes.byteLength,
    });
    const carolSharedRes = createResource(s.db, {
      ownerId: carol.id,
      parentId: null,
      name: 'shared.mp4',
      isDir: false,
      contentHash: sharedHash,
      size: sharedBytes.byteLength,
    });
    const daveRes = createResource(s.db, {
      ownerId: daveRow.id,
      parentId: null,
      name: 'dave-file.bin',
      isDir: false,
      contentHash: sharedHash,
      size: sharedBytes.byteLength,
    });
    const carolTask = createTask(s.db, {
      ownerId: carol.id,
      resourceId: carolRes.id,
      videoResourceId: carolSharedRes.id,
      prompt: '讲评这段',
    });
    createResult(s.db, {
      publicId: 'pubcarol0001',
      taskId: carolTask.id,
      ownerId: carol.id,
      title: null,
      bundlePath: path.join(s.config.dataRoot, 'users', 'carol', 't', '.shufa', 'bundle'),
    });
    // 物理用户目录（任务目录/.shufa/资源实体视图都在其中）。
    const carolDir = path.join(s.config.dataRoot, 'users', 'carol');
    const daveDir = path.join(s.config.dataRoot, 'users', 'dave');
    mkdirSync(path.join(carolDir, 'task-x', '.shufa'), { recursive: true });
    writeFileSync(path.join(carolDir, 'task-x', '.shufa', 'frames.jsonl'), '{}');
    mkdirSync(daveDir, { recursive: true });
    writeFileSync(path.join(daveDir, 'keep.txt'), 'dave');
    expect(existsSync(s.blobs.pathFor(soloHash))).toBe(true);
    expect(existsSync(s.blobs.pathFor(sharedHash))).toBe(true);

    // 守卫：非 admin 403；匿名 409；自己 409；未知 404。
    const carolLogin = await boot.auth.login({ username: 'carol', password: 'carol-pw' });
    await expect(
      clientFor(s.context({ token: carolLogin.token })).admin.users.delete({ id: daveRow.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { users } = await admin.admin.users.list();
    const anonId = users.find((u) => u.username === '__anonymous__')?.id ?? '';
    await expect(admin.admin.users.delete({ id: anonId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: '内置匿名账号不可删除',
    });
    await expect(
      admin.admin.users.delete({ id: adminIssued.user.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: '不能删除当前登录的管理员自己' });
    await expect(admin.admin.users.delete({ id: 'no-such-id' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // 删除 carol。
    await expect(admin.admin.users.delete({ id: carol.id })).resolves.toEqual({ ok: true });

    // 行级：users/tasks/results/resources 全清；dave 完好。
    expect(getUserById(s.db, carol.id)).toBeNull();
    expect(
      (s.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ?').get(carol.id) as { n: number }).n,
    ).toBe(0);
    expect(
      (s.db.prepare('SELECT COUNT(*) AS n FROM results WHERE owner_id = ?').get(carol.id) as { n: number }).n,
    ).toBe(0);
    expect(
      (s.db.prepare('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?').get(carol.id) as { n: number }).n,
    ).toBe(0);
    expect(getResourceById(s.db, daveRes.id)?.id).toBe(daveRes.id);
    expect(getUserById(s.db, daveRow.id)?.username).toBe('dave');

    // blob GC：独享 blob 归零回收（行 + 实体文件）；共享 blob ref 2→1、实体保留。
    expect(
      (s.db.prepare('SELECT COUNT(*) AS n FROM blobs WHERE hash = ?').get(soloHash) as { n: number })
        .n,
    ).toBe(0);
    expect(existsSync(s.blobs.pathFor(soloHash))).toBe(false);
    const shared = s.db.prepare('SELECT ref_count FROM blobs WHERE hash = ?').get(sharedHash) as {
      ref_count: number;
    };
    expect(shared.ref_count).toBe(1);
    expect(existsSync(s.blobs.pathFor(sharedHash))).toBe(true);

    // 磁盘：carol 用户目录整删，dave 目录不动。
    expect(existsSync(carolDir)).toBe(false);
    expect(existsSync(path.join(daveDir, 'keep.txt'))).toBe(true);

    // 重复删除 → 404。
    await expect(admin.admin.users.delete({ id: carol.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  } finally {
    s.dispose();
  }
});
