/**
 * bootstrap 门控全流程测试：未配置 → setup/admin → 完成后 403（W2' 验证门）。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §1/§4）。
 */
import { readFileSync } from 'node:fs';
import { parseDotenv } from '../src/config.js';
import { getSetting, putSetting, updateWizardProgress } from '../src/db/store.js';
import { clientFor, createServices } from './helpers.js';
import { expect } from 'vitest';
import { test } from 'vitest';

test('初始态：needs_setup=true 且 setup 端点可达；setup_progress 三态之「全新」', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    const bootstrap = await client.bootstrap();
    expect(bootstrap.needs_setup).toBe(true);
    // 走查 BUG6（Owner 2026-09-23 安全默认）：匿名默认关闭。
    expect(bootstrap.allow_anonymous).toBe(false);
    expect(bootstrap.site_name).toBe('朱墨');
    // 走查 BUG2：settings/env 均未配置 → model_route 为 null。
    expect(bootstrap.model_route).toBeNull();
    // 走查 BUG2：setup_progress 全新态——无管理员、零完成、模型未配置。
    expect(bootstrap.setup_progress).toEqual({
      admin_created: false,
      steps_done: 0,
      steps_total: 4, // Owner 需求 2026-09-25：git 检测步骤加入
      model_configured: false,
    });

    const { steps } = await client.setup.steps();
    expect(steps.map((step) => step.id)).toEqual(['ffmpeg', 'python-env', 'git', 'whisper-model']);
    expect(steps.every((step) => step.status === 'pending')).toBe(true);
  } finally {
    s.dispose();
  }
});

test('setup_progress 三态推进：建管理员 / 完成向导步骤 / 配置模型路由', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    // 态 2：管理员已建（allow_anonymous 缺省关），向导完成 1/4。
    await client.setup.createAdmin({ username: 'boss', password: 'secret66' });
    updateWizardProgress(s.db, 'ffmpeg', { status: 'done' });
    let progress = (await client.bootstrap()).setup_progress;
    expect(progress).toEqual({
      admin_created: true,
      steps_done: 1,
      steps_total: 4, // Owner 需求 2026-09-25：git 检测步骤加入
      model_configured: false,
    });

    // 态 3：settings 表 llm_* 四键齐备 → model_configured=true（env 单边不算）。
    putSetting(s.db, 'llm_provider', 'zhipu');
    putSetting(s.db, 'llm_base_url', 'https://x/api');
    putSetting(s.db, 'llm_api_key', 'k1');
    putSetting(s.db, 'llm_model', 'glm-5.3-flash');
    progress = (await client.bootstrap()).setup_progress;
    expect(progress.model_configured).toBe(true);
    expect(progress.steps_done).toBe(1);
    expect(progress.admin_created).toBe(true);
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
    // 走查 2026-09-24：complete 不再受 setupGated 拦截（needs_setup 建管理员后即翻
    // false，旧实现令「完成安装」恒 403 静默失败）——完成后仍可幂等补写标记。
    expect((await client.setup.complete()).ok).toBe(true);
    expect(getSetting(s.db, 'setup_completed')).toBe('1');
    await expect(
      client.setup.createAdmin({ username: 'other', password: 'secret66' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  } finally {
    s.dispose();
  }
});

test('setup.complete：管理员未建时拒绝；已建后幂等写标记', async () => {
  const s = createServices();
  try {
    const client = clientFor(s.context());
    // 防全新站点误触：无非匿名用户时 complete 拒绝。
    await expect(client.setup.complete()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await client.setup.createAdmin({ username: 'boss', password: 'secret66' });
    expect((await client.setup.complete()).ok).toBe(true);
    expect(getSetting(s.db, 'setup_completed')).toBe('1');
    // 幂等：重复完成不抛。
    expect((await client.setup.complete()).ok).toBe(true);
  } finally {
    s.dispose();
  }
});
