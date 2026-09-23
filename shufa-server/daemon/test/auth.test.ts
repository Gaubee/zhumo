/**
 * 登录 / 匿名 JWT / scrypt 哈希测试（W2' 验证门）。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §2 匿名开关、§4 auth 路由）。
 */
import { authenticate, hashPassword, setAllowAnonymous, verifyPassword } from '../src/auth.js';
import { createUser, getSetting, updateUserCredentials } from '../src/db/store.js';
import { ResourceService } from '../src/resources.js';
import { clientFor, createServices, TEST_SECRET } from './helpers.js';
import { expect, test } from 'vitest';

test('scrypt 哈希：格式 scrypt$salt$hash，可验真拒伪', () => {
  const stored = hashPassword('secret66');
  expect(stored.startsWith('scrypt$')).toBe(true);
  expect(stored.split('$').length).toBe(3);
  expect(verifyPassword('secret66', stored)).toBe(true);
  expect(verifyPassword('wrong', stored)).toBe(false);
  expect(verifyPassword('secret66', 'garbage')).toBe(false);
});

test('登录：正确凭证签发 JWT；错误密码/未知用户 401', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    await client.setup.createAdmin({ username: 'boss', password: 'secret66' });

    const ok = await client.auth.login({ username: 'boss', password: 'secret66' });
    expect(ok.user.role).toBe('admin');
    const user = await authenticate(TEST_SECRET, s.db, ok.token);
    expect(user?.id).toBe(ok.user.id);
    expect(user?.role).toBe('admin');

    await expect(
      client.auth.login({ username: 'boss', password: 'wrong-pass' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      client.auth.login({ username: 'nobody', password: 'secret66' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  } finally {
    s.dispose();
  }
});

test('匿名 JWT：默认关闭（BUG6 安全默认）；显式开启后可用；内置账号不可直接登录', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    // BUG6：全新安装（settings 无 allow_anonymous 键）默认关闭。
    await expect(client.auth.anonymous()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 显式开启（安装向导勾选 / 后台开关）后匿名签发恢复。
    setAllowAnonymous(s.db, true);
    const anon = await client.auth.anonymous();
    expect(anon.user.role).toBe('anonymous');
    const anonUser = await authenticate(TEST_SECRET, s.db, anon.token);
    expect(anonUser?.role).toBe('anonymous');

    await expect(
      client.auth.login({ username: '__anonymous__', password: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 开关再关闭即恢复拒绝（同一内置账号）。
    setAllowAnonymous(s.db, false);
    await expect(client.auth.anonymous()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } finally {
    s.dispose();
  }
});

test('BUG6：createAdmin 显式 allow_anonymous 落 settings；缺省写 0', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    // 缺省：创建管理员即写 '0'（消除缺省歧义）。
    await client.setup.createAdmin({ username: 'boss', password: 'secret66' });
    expect(getSetting(s.db, 'allow_anonymous')).toBe('0');
    expect((await client.bootstrap()).allow_anonymous).toBe(false);
    s.dispose();

    // 显式 true：写 '1'，匿名登录可用。
    const s2 = createServices();
    try {
      const client2 = clientFor(s2.context());
      await client2.setup.createAdmin({
        username: 'boss',
        password: 'secret66',
        allow_anonymous: true,
      });
      expect(getSetting(s2.db, 'allow_anonymous')).toBe('1');
      expect((await client2.auth.anonymous()).user.username).toBe('__anonymous__');
    } finally {
      s2.dispose();
    }
  } finally {
    s.dispose();
  }
});

test('BUG1：开关关闭后，开关开启期签发的旧匿名 token 在认证面立即失效', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    await client.setup.createAdmin({ username: 'boss', password: 'secret66', allow_anonymous: true });
    const anon = await client.auth.anonymous();
    const anonClient = clientFor(s.context({ token: anon.token }));
    expect((await anonClient.me()).role).toBe('anonymous');

    // 开关翻 0：旧匿名 token 访问 requireAuth 面（me/tasks/admin）一律 401。
    setAllowAnonymous(s.db, false);
    await expect(anonClient.me()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: '匿名访问已关闭，请登录后使用',
    });
    await expect(anonClient.tasks.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anonClient.admin.users.list()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    // 翻回 1：同一 token 恢复可用。
    setAllowAnonymous(s.db, true);
    expect((await anonClient.me()).role).toBe('anonymous');
  } finally {
    s.dispose();
  }
});

test('refresh：旧 token 换新 token；无效 token 401', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    await client.setup.createAdmin({ username: 'boss', password: 'secret66' });
    const issued = await client.auth.login({ username: 'boss', password: 'secret66' });

    const refreshed = await client.auth.refresh({ token: issued.token });
    expect(refreshed.token).toBeTruthy();
    expect(refreshed.user.id).toBe(issued.user.id);

    await expect(client.auth.refresh({ token: 'not-a-jwt' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    // 复用连接 token 的形态：context 带 token、body 不带。
    const connClient = clientFor(s.context({ token: issued.token }));
    expect((await connClient.auth.refresh({})).user.id).toBe(issued.user.id);
  } finally {
    s.dispose();
  }
});

test('me：有效 token 返回用户视图；禁用用户 token 仍可认证（BUG5 禁写不禁读）；无凭证 401', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    await expect(client.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const issued = await client.setup.createAdmin({ username: 'boss', password: 'secret66' });
    const authed = clientFor(s.context({ token: issued.token }));
    const me = await authed.me();
    expect(me.username).toBe('boss');

    // BUG5：禁用后同 token 仍可认证（读面），由写路由的 requireActiveUser 拦截。
    updateUserCredentials(s.db, issued.user.id, { disabled: true });
    expect((await authed.me()).disabled).toBe(true);
  } finally {
    s.dispose();
  }
});

test('BUG5 禁用语义：可登录、可读（me/res.tree），写操作 FORBIDDEN', async () => {
  const s = createServices();
  try {
    const boot = clientFor(s.context());
    const issued = await boot.setup.createAdmin({ username: 'boss', password: 'secret66' });
    const adminAuthed = clientFor(s.context({ token: issued.token }));
    const user = await adminAuthed.admin.users.create({
      username: 'alice',
      password: 'alice-pass',
      role: 'user',
    });

    // 禁用后登录不再 401（BUG5：登录路径去掉 disabled 拒绝）。
    await adminAuthed.admin.users.update({ id: user.id, disabled: true });
    const relogin = await boot.auth.login({ username: 'alice', password: 'alice-pass' });
    expect(relogin.user.disabled).toBe(true);
    const alice = clientFor(
      s.context({
        token: relogin.token,
        resources: new ResourceService({ config: s.config, db: s.db, blobs: s.blobs }),
      }),
    );

    // 读面畅通：me 与资源树浏览。
    expect((await alice.me()).username).toBe('alice');
    const tree = await alice.res.tree({});
    expect(tree.owner.username).toBe('alice');

    // 写面全拒：建任务 / 续聊 / 取消 / 资源变更与上传。
    await expect(
      alice.tasks.create({ prompt: 'x', video_resource_id: 'r1' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: '账号已被禁用：不能新建任务，仍可查看已有任务',
    });
    await expect(alice.tasks.followup({ id: 't1', text: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(alice.tasks.cancel({ id: 't1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(alice.res.mkdir({ parent: tree.root.id, name: '新目录' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      alice.res.upload({ parent: tree.root.id, filename: 'a.txt', b64: Buffer.from('x').toString('base64') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 对照组：未禁用用户同样的调用通过守卫（走到 501 服务未装配或成功）。
    const bobRow = createUser(s.db, {
      username: 'bob',
      passwordHash: hashPassword('bob-pass'),
      role: 'user',
    });
    const bob = clientFor(
      s.context({
        user: bobRow,
        resources: new ResourceService({ config: s.config, db: s.db, blobs: s.blobs }),
      }),
    );
    const bobTree = await bob.res.tree({});
    await expect(bob.res.mkdir({ parent: bobTree.root.id, name: '目录' })).resolves.toBeTruthy();
  } finally {
    s.dispose();
  }
});
