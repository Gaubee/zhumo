/**
 * 多路由模型存储与连接测试（走查五轮 2026-09-24）：
 *   [1] models-store：保存语义（apiKey 空=保留 / 非空=更新 / 删路由清密钥）、
 *       default 悬空防御、旧 llm_* 收编物化、resolveRouteFor 按 (provider, model)。
 *   [2] test-route-connection：三协议探测矩阵（路径/头/body）、2xx=ok、
 *       非 2xx=failed 带脱敏、无密钥=failed、超时。
 */
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServices, type TestServices } from './helpers.js';
import { getSetting, putSetting } from '../src/db/store.js';
import {
  loadModelsConfig,
  loadRoutes,
  resolveRouteFor,
  saveModelsConfig,
} from '../src/models-store.js';
import { testRouteConnection } from '../src/test-route-connection.js';
import { syncModelRoutesSettings } from '../src/kernel/model-route.js';
import { parse as parseYaml } from 'yaml';

let s: TestServices;
beforeEach(() => {
  s = createServices();
});
afterEach(() => {
  s.dispose();
});

describe('五轮 models-store：保存与密钥语义', () => {
  it('保存：apiKey 空=保留旧值，非空=更新；删路由清密钥；default 悬空归 null', () => {
    saveModelsConfig(s.db, {
      routes: [
        { provider: 'zai', api: 'openai-completions', baseURL: 'https://z.ai/api/paas/v4', apiKey: 'k-zai', models: [{ id: 'glm-5.3-flash', contextWindow: 131072, inputTypes: ['text'] }] },
      ],
      default: { provider: 'zai', model: 'glm-5.3-flash' },
    });
    // 空 apiKey（保留语义）
    saveModelsConfig(s.db, {
      routes: [
        { provider: 'zai', api: 'openai-completions', baseURL: 'https://z.ai/api/paas/v4', models: [{ id: 'glm-5.3-flash' }] },
      ],
      default: { provider: 'zai', model: 'glm-5.3-flash' },
    });
    let view = loadModelsConfig(s.db);
    expect(view.routes[0]?.hasKey).toBe(true);
    // 输出面（RPC 投影）绝不含密钥值
    expect(JSON.stringify(view)).not.toContain('k-zai');
    expect(resolveRouteFor(s.db, 'zai', 'glm-5.3-flash')?.apiKey).toBe('k-zai');
    // 更新密钥
    saveModelsConfig(s.db, {
      routes: [
        { provider: 'zai', api: 'openai-completions', baseURL: 'https://z.ai/api/paas/v4', apiKey: 'k-new', models: [{ id: 'glm-5.3-flash' }] },
      ],
      default: null,
    });
    expect(resolveRouteFor(s.db, 'zai', 'glm-5.3-flash')?.apiKey).toBe('k-new');
    // default 悬空（指到不存在的 provider）→ 归 null
    saveModelsConfig(s.db, {
      routes: [
        { provider: 'zai', api: 'openai-completions', baseURL: 'https://z.ai/api/paas/v4', models: [{ id: 'glm-5.3-flash' }] },
      ],
      default: { provider: 'ghost', model: 'x' },
    });
    expect(loadModelsConfig(s.db).default).toBeNull();
    // 删光路由 → 密钥清、hasKey false
    saveModelsConfig(s.db, { routes: [], default: null });
    const after = loadModelsConfig(s.db);
    expect(after.routes).toHaveLength(0);
    expect(after.default).toBeNull();
    expect(resolveRouteFor(s.db, 'zai', 'glm-5.3-flash')).toBeNull();
  });

  it('迁移收编：旧 llm_* 五键齐备 → 首次读取物化为单路由 + default + 密钥', () => {
    putSetting(s.db, 'llm_provider', 'zhipu');
    putSetting(s.db, 'llm_base_url', 'https://open.bigmodel.cn/api/paas/v4');
    putSetting(s.db, 'llm_api_key', 'k-legacy');
    putSetting(s.db, 'llm_api', 'openai-completions');
    putSetting(s.db, 'llm_model', 'glm-5.3-flash');
    const routes = loadRoutes(s.db);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ provider: 'zhipu', api: 'openai-completions' });
    // 物化落库：settings 表出现 models_routes / models_default
    expect(getSetting(s.db, 'models_routes')).toContain('zhipu');
    expect(getSetting(s.db, 'models_default')).toContain('glm-5.3-flash');
    expect(resolveRouteFor(s.db, 'zhipu', 'glm-5.3-flash')?.apiKey).toBe('k-legacy');
  });
});

describe('五轮 多路由桥接：settings.yaml 形状', () => {
  it('providers 全量 + 模型带 contextWindow + agent-default-model', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'zhumo-dsh-'));
    syncModelRoutesSettings(home, {
      routes: [
        {
          provider: 'zai',
          api: 'openai-completions',
          baseURL: 'https://z.ai/api/paas/v4',
          apiKey: 'k',
          models: [
            { id: 'glm-5.3-flash', contextWindow: 131072 },
            { id: 'glm-4.7' },
          ],
        },
      ],
      default: { provider: 'zai', model: 'glm-4.7' },
    });
    const doc = parseYaml(readFileSync(path.join(home, 'settings.yaml'), 'utf8')) as Record<string, any>;
    const provider = doc['llm-pi-ai']?.providers?.zai;
    expect(provider?.api).toBe('openai-completions');
    expect(provider?.models).toEqual([
      { id: 'glm-5.3-flash', contextWindow: 131072 },
      { id: 'glm-4.7' },
    ]);
    // 密钥只以 env 引用出现，明文不落 settings.yaml
    expect(JSON.stringify(doc)).not.toContain('"k"');
    expect(provider?.apiKeyEnv).toBe('ZAI_API_KEY');
    expect(doc['agent-default-model']).toEqual({ provider: 'zai', model: 'glm-4.7' });
  });
});

describe('五轮 连接测试 probe', () => {
  let server: http.Server;
  let base: string;
  let hits: Array<{ url: string; auth: string | undefined; xApiKey: string | undefined; body: any }>;

  beforeEach(async () => {
    hits = [];
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        hits.push({
          url: req.url ?? '',
          auth: req.headers.authorization,
          xApiKey: req.headers['x-api-key'] as string | undefined,
          body: raw ? JSON.parse(raw) : null,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(() => server.close());

  it('三协议探测矩阵：路径与鉴权头逐协议正确；2xx = ok 附延迟', async () => {
    const cases = [
      { api: 'anthropic-messages' as const, path: '/v1/messages', keyHeader: 'xApiKey', key: 'sk-ant' },
      { api: 'openai-completions' as const, path: '/chat/completions', keyHeader: 'auth', key: 'sk-oai' },
      { api: 'openai-responses' as const, path: '/responses', keyHeader: 'auth', key: 'sk-resp' },
    ];
    for (const c of cases) {
      const out = await testRouteConnection({
        api: c.api,
        baseURL: base,
        apiKey: c.key,
        modelId: 'm-1',
      });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.latencyMs).toBeGreaterThanOrEqual(0);
      const hit = hits.at(-1)!;
      expect(hit.url).toBe(c.path);
      if (c.keyHeader === 'xApiKey') expect(hit.xApiKey).toBe(c.key);
      else expect(hit.auth).toBe(`Bearer ${c.key}`);
    }
    // responses 协议 body 是 {model, input}（非 messages）
    expect(hits[2]?.body).toMatchObject({ model: 'm-1', input: 'ping' });
  });

  it('无密钥 → failed；非 2xx → failed 带脱敏 detail；错误体截断', async () => {
    const noKey = await testRouteConnection({ api: 'openai-completions', baseURL: base, modelId: 'm' });
    expect(noKey).toMatchObject({ ok: false });

    server.close();
    server = http.createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `bad key sk-secret-abc ${'x'.repeat(300)}` }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fail = await testRouteConnection({
      api: 'openai-completions',
      baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      apiKey: 'sk-secret-abc',
      modelId: 'm',
    });
    expect(fail.ok).toBe(false);
    if (!fail.ok) {
      expect(fail.detail).toContain('HTTP 401');
      expect(fail.detail).not.toContain('sk-secret-abc');
      expect(fail.detail).toContain('[redacted]');
      expect(fail.detail.length).toBeLessThanOrEqual(200);
    }
  });
});
