/**
 * 后台 CRUD 与权限矩阵抽测（W2' 验证门）：
 * anonymous→admin 403、user→admin 403、未认证 401；tasks/res 501 壳。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §2/§4）。
 */
import { clientFor, createServices } from './helpers.js';
import { expect, test } from 'vitest';
import type { RpcContext } from '../src/rpc.js';

/** 造一个已配置的管理员与普通用户，返回各自身份的 context。 */
async function seedIdentities(s: ReturnType<typeof createServices>) {
  const bootstrap = clientFor(s.context());
  const admin = await bootstrap.setup.createAdmin({ username: 'boss', password: 'secret66' });
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

test('admin 用户修改防护：匿名内置账号不可改；不能自禁/自降级；未知用户 404', async () => {
  const s = createServices();
  try {
    const { adminCtx, admin } = await seedIdentities(s);
    const adminAuthed = clientFor(adminCtx);
    const { users } = await adminAuthed.admin.users.list();
    const anonId = users.find((u) => u.username === '__anonymous__')?.id ?? '';
    await expect(adminAuthed.admin.users.update({ id: anonId, disabled: true })).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
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
    const { ensureAnonymousUser } = await import('../src/auth.js');
    ensureAnonymousUser(s.db);
    const anonUser = s.db.prepare("SELECT * FROM users WHERE username = '__anonymous__'").get() as never;
    const authed = clientFor(s.context({ user: anonUser }));
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
