/**
 * 登录 / 匿名 JWT / scrypt 哈希测试（W2' 验证门）。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §2 匿名开关、§4 auth 路由）。
 */
import { authenticate, hashPassword, setAllowAnonymous, verifyPassword } from '../src/auth.js';
import { createUser, updateUserCredentials } from '../src/db/store.js';
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

test('匿名 JWT：默认允许；开关关闭后 403；内置账号不可直接登录', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    const anon = await client.auth.anonymous();
    expect(anon.user.role).toBe('anonymous');
    const anonUser = await authenticate(TEST_SECRET, s.db, anon.token);
    expect(anonUser?.role).toBe('anonymous');

    setAllowAnonymous(s.db, false);
    await expect(client.auth.anonymous()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      client.auth.login({ username: '__anonymous__', password: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // 开关重开即恢复（同一内置账号）。
    setAllowAnonymous(s.db, true);
    expect((await client.auth.anonymous()).user.username).toBe('__anonymous__');
  } finally {
    s.dispose();
  }
});

test('BUG1：开关关闭后，开关开启期签发的旧匿名 token 在认证面立即失效', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
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

test('me：有效 token 返回用户视图；禁用/无凭证 401', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    await expect(client.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const issued = await client.setup.createAdmin({ username: 'boss', password: 'secret66' });
    const authed = clientFor(s.context({ token: issued.token }));
    const me = await authed.me();
    expect(me.username).toBe('boss');

    // 禁用后同 token 立即失效。
    updateUserCredentials(s.db, issued.user.id, { disabled: true });
    await expect(authed.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  } finally {
    s.dispose();
  }
});

test('禁用用户登录被拒', async () => {
  const s = createServices();
  try {
    const admin = clientFor(s.context());
    const issued = await admin.setup.createAdmin({ username: 'boss', password: 'secret66' });
    const adminAuthed = clientFor(s.context({ token: issued.token }));
    const user = await adminAuthed.admin.users.create({
      username: 'alice',
      password: 'alice-pass',
      role: 'user',
    });
    await adminAuthed.admin.users.update({ id: user.id, disabled: true });

    await expect(
      clientFor(s.context()).auth.login({ username: 'alice', password: 'alice-pass' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    // createUser 直接建的用户同样受禁用约束。
    const raw = createUser(s.db, { username: 'bob', passwordHash: hashPassword('bob-pass'), role: 'user' });
    updateUserCredentials(s.db, raw.id, { disabled: true });
    await expect(
      clientFor(s.context()).auth.login({ username: 'bob', password: 'bob-pass' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  } finally {
    s.dispose();
  }
});
