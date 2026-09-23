/**
 * config 测试：loadConfig 的路径解析面。
 * 实证 2026-09-23（Owner 走查）：webuiDir 固定取 envFile 上一级，仓库根 .env
 * 会解析到仓库外 → 前台全量 404「未找到」。修复 = 两级候选按 index.html 择优。
 * 正交意图：
 *   [1] 仓库根 .env → 同级 webui/dist 命中（本轮修复的回归钉）。
 *   [2] 子目录 .env（runtime/w7b.env、daemon/.env）→ 上一级 webui/dist 命中（既有语义）。
 *   [3] 两级都不存在 → 回退一级候选（不抛错，boot 日志可见路径诊断）。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir as home, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultDataRoot, loadConfig, volatileRootWarning } from '../src/config.js';

function makeRepoLayout(envDir: 'root' | 'sub'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'shufa-config-'));
  mkdirSync(path.join(root, 'webui', 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'webui', 'dist', 'index.html'), '<!doctype html>spa');
  const envFile =
    envDir === 'root' ? path.join(root, '.env') : path.join(root, 'runtime', 'w7b.env');
  mkdirSync(path.dirname(envFile), { recursive: true });
  return envFile;
}

describe('loadConfig webuiDir 解析', () => {
  it('仓库根 .env：webuiDir 命中同级 webui/dist（走查 404 回归）', () => {
    const envFile = makeRepoLayout('root');
    const config = loadConfig({ envFile, processEnv: {} });
    expect(config.webuiDir).toBe(path.join(path.dirname(envFile), 'webui', 'dist'));
  });

  it('子目录 .env：回退上一级 webui/dist（runtime/daemon 既有语义）', () => {
    const envFile = makeRepoLayout('sub');
    const config = loadConfig({ envFile, processEnv: {} });
    expect(config.webuiDir).toBe(path.resolve(path.dirname(envFile), '..', 'webui', 'dist'));
  });

  it('四轮：DATA_ROOT 缺省 = OS 数据目录；显式值仍按 .env 目录解析', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'shufa-config-'));
    const envFile = path.join(root, '.env');
    // 缺省（模板已注释化 DATA_ROOT）→ darwin = ~/Library/Application Support/zhumo。
    const def = loadConfig({ envFile: path.join(root, 'a', '.env'), processEnv: {} });
    expect(def.dataRoot).toBe(path.join(home(), 'Library', 'Application Support', 'zhumo'));
    // 显式相对值 → 相对 .env 所在目录（既有部署兼容）。
    const explicit = loadConfig({ envFile, processEnv: { DATA_ROOT: './mydata' } });
    expect(explicit.dataRoot).toBe(path.join(root, 'mydata'));
  });

  it('四轮：defaultDataRoot 三平台 + volatileRootWarning 易失目录护栏', () => {
    expect(defaultDataRoot('darwin')).toBe(
      path.join(home(), 'Library', 'Application Support', 'zhumo'),
    );
    expect(defaultDataRoot('linux')).toBe(path.join(home(), '.local', 'share', 'zhumo'));
    expect(defaultDataRoot('win32')).toContain('zhumo');
    expect(volatileRootWarning('/tmp/zhumo/data', '/tmp')).toMatch(/易失目录/);
    expect(volatileRootWarning('/var/tmp/x')).toMatch(/易失目录/);
    expect(volatileRootWarning('/Users/kzf/zhumo-data', '/tmp')).toBeNull();
  });

  it('两级都无 webui/dist：不抛错，落模块位置兜底候选（webui 与 daemon 恒为兄弟包）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'shufa-config-'));
    const envFile = path.join(root, '.env');
    const config = loadConfig({ envFile, processEnv: {} });
    // env 文件放任意处（如 /tmp）不再丢前台：末位候选按本模块 URL 上溯到
    // shufa-server/webui/dist（实证 2026-09-24：本地冒烟 .env 放 /tmp 全量 404）。
    expect(config.webuiDir).toBe(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../webui/dist'),
    );
  });
});
