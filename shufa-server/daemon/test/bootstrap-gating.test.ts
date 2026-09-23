/**
 * bootstrap 门控全流程测试：未配置 → setup/admin → 完成后 403（W2' 验证门）。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §1/§4）。
 */
import { readFileSync } from 'node:fs';
import { parseDotenv } from '../src/config.js';
import { getSetting } from '../src/db/store.js';
import { clientFor, createServices } from './helpers.js';
import { expect } from 'vitest';
import { test } from 'vitest';

test('初始态：needs_setup=true 且 setup 端点可达', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    const bootstrap = await client.bootstrap();
    expect(bootstrap.needs_setup).toBe(true);
    expect(bootstrap.allow_anonymous).toBe(true);
    expect(bootstrap.site_name).toBe('朱墨');
    // 走查 BUG2：settings/env 均未配置 → model_route 为 null。
    expect(bootstrap.model_route).toBeNull();

    const { steps } = await client.setup.steps();
    expect(steps.map((step) => step.id)).toEqual(['ffmpeg', 'python-env', 'whisper-model']);
    expect(steps.every((step) => step.status === 'pending')).toBe(true);
  } finally {
    s.dispose();
  }
});

test('setup.createAdmin：写 .env + 落 users 表 + 返回管理员 JWT', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    const result = await client.setup.createAdmin({ username: 'boss', password: 'secret66' });
    expect(result.user.role).toBe('admin');
    expect(result.user.username).toBe('boss');
    expect(result.token.split('.').length).toBe(3);

    const env = parseDotenv(readFileSync(s.envFile, 'utf8'));
    expect(env['ADMIN_USERNAME']).toBe('boss');
    expect(env['ADMIN_PASSWORD']).toBe('secret66');
    expect((env['JWT_SECRET'] ?? '').length).toBeGreaterThanOrEqual(32);

    // needs_setup 翻转为 false（同一进程内配置已同步）。
    const bootstrap = await client.bootstrap();
    expect(bootstrap.needs_setup).toBe(false);
  } finally {
    s.dispose();
  }
});

test('完成后 setup 端点一律 403（§4 完成后 403）', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    await client.setup.createAdmin({ username: 'boss', password: 'secret66' });
    await expect(client.setup.steps()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(client.setup.runStep({ id: 'ffmpeg', force: false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(client.setup.complete()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      client.setup.createAdmin({ username: 'other', password: 'secret66' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } finally {
    s.dispose();
  }
});

test('setup.complete：写安装完成标记（幂等）', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    expect((await client.setup.complete()).ok).toBe(true);
    expect(getSetting(s.db, 'setup_completed')).toBe('1');
  } finally {
    s.dispose();
  }
});
