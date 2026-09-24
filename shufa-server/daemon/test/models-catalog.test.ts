/**
 * Models 预设目录测试：zcode 策展主体（ZCode Registry 静态提取，2026-09-25 对齐
 * 裁决：pi-ai 内置长尾退出）、models.dev 刷新映射与 settings 缓存、catalog 合并
 * 读面、RPC 权限与失败语义。
 */
import {
  MODELS_DEV_API_URL,
  SETTING_MODELS_DEV_CACHE,
  SETTING_MODELS_DEV_FETCHED_AT,
  PRESET_MODEL_LIMIT,
  fetchModelsDevPresets,
  modelCatalog,
  refreshModelsDevCache,
} from '../src/models-catalog.js';
import { zcodePresets } from '../src/zcode-presets.js';
import { getSetting } from '../src/db/store.js';
import { clientFor, createServices } from './helpers.js';
import { expect, describe, test } from 'vitest';

/** 构造 models.dev/api.json 形状的响应（实测结构：provider.api=服务端点）。 */
function modelsDevPayload() {
  const manyModels: Record<string, { id: string; name: string }> = {};
  for (let i = 1; i <= 15; i += 1) {
    manyModels[`many-${i}`] = { id: `many-${i}`, name: `Many ${i}` };
  }
  return {
    zhipuai: {
      id: 'zhipuai',
      name: 'Zhipu AI',
      api: 'https://open.bigmodel.cn/api/paas/v4',
      models: {
        // 五轮：limit.context → contextWindow；modalities.input 含 image → 视觉输入。
        'glm-5.3-flash': {
          id: 'glm-5.3-flash',
          name: 'GLM-5.3 Flash',
          limit: { context: 131072, output: 8192 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
        'glm-5.2': {
          id: 'glm-5.2',
          name: 'GLM-5.2',
          limit: { context: 2000000 },
          modalities: { input: ['text'] },
        },
      },
    },
    // 无 api 字段（如实测的 openai/anthropic 在 models.dev 上不带端点）→ 过滤。
    noEndpoint: { id: 'noEndpoint', name: 'No Endpoint', models: { m1: { id: 'm1', name: 'M1' } } },
    // 非 http api → 过滤。
    weird: { id: 'weird', name: 'Weird', api: 'ftp://not-http', models: { m1: { id: 'm1', name: 'M1' } } },
    // 模型数超上限 → 截到 PRESET_MODEL_LIMIT。
    many: { id: 'many', name: 'Many', api: 'https://many.example/v1', models: manyModels },
    // 无模型 → 过滤。
    empty: { id: 'empty', name: 'Empty', api: 'https://empty.example/v1', models: {} },
  };
}

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('catalog 主体：zcode 预设（ZCode Registry 静态提取）', () => {
  test('无缓存时目录 = zcode 20 模板，无任何旧 builtin 长尾，fetched_at=null', () => {
    const s = createServices();
    try {
      const catalog = modelCatalog(s.db);
      expect(catalog.fetched_at).toBeNull();
      expect(catalog.presets).toEqual([...zcodePresets]);
      expect(catalog.presets.every((p) => p.source === 'zcode')).toBe(true);
      // pi-ai 内置长尾退出目录的回归锚（曾以 source='builtin' 混入一百余家）。
      expect(catalog.presets.some((p) => (p as { source?: string }).source === 'builtin')).toBe(false);
    } finally {
      s.dispose();
    }
  });

  test('20 模板全量在内，协议名全部落在 ROUTE_APIS 语义内', () => {
    expect(zcodePresets.length).toBe(20);
    const apis = new Set(zcodePresets.flatMap((p) => (p.api ? [p.api] : [])));
    expect([...apis].sort()).toEqual(['anthropic-messages', 'openai-completions', 'openai-responses']);
    for (const preset of zcodePresets) {
      expect(preset.baseURL).toMatch(/^https:\/\//);
      expect(preset.models.length).toBeGreaterThan(0);
      expect(preset.source).toBe('zcode');
    }
  });

  test('coding plan 双端点：zai-api 走 anthropic 兼容端点，zai-standard-api 走 paas/v4', () => {
    const zaiApi = zcodePresets.find((p) => p.provider === 'zai-api');
    const zaiStd = zcodePresets.find((p) => p.provider === 'zai-standard-api');
    expect(zaiApi?.baseURL).toBe('https://api.z.ai/api/anthropic');
    expect(zaiApi?.api).toBe('anthropic-messages');
    expect(zaiStd?.baseURL).toBe('https://api.z.ai/api/paas/v4');
    expect(zaiStd?.api).toBe('openai-completions');
  });

  test('模型富字段经规则链求值：GLM-5.3 带 1M 窗口/视觉/档位；efforts 全覆盖', () => {
    const glm53 = zcodePresets
      .find((p) => p.provider === 'zai-api')
      ?.models.find((m) => m.id === 'GLM-5.3');
    expect(glm53?.contextWindow).toBeGreaterThan(0);
    expect(glm53?.inputTypes).toContain('image');
    expect(glm53?.efforts?.length).toBeGreaterThan(0);
    const all = zcodePresets.flatMap((p) => p.models);
    expect(all.length).toBeGreaterThan(200);
    // 规则链兜底保证每模型都有档位（disabled/enabled 这类开关型档也如实转录）。
    expect(all.every((m) => (m.efforts ?? []).length > 0)).toBe(true);
    expect(all.every((m) => m.contextWindow !== undefined)).toBe(true);
  });
});

describe('models.dev 刷新与缓存（广度补充，手动触发）', () => {
  test('映射过滤：只收 http api 的 provider；模型截到上限；缓存与 fetched_at 落 settings', async () => {
    const s = createServices();
    try {
      const seen: string[] = [];
      const fetchImpl = (async (input: unknown) => {
        seen.push(String(input));
        return okResponse(modelsDevPayload());
      }) as unknown as typeof fetch;

      await refreshModelsDevCache(s.db, fetchImpl);
      expect(seen).toEqual([MODELS_DEV_API_URL]);
      expect(getSetting(s.db, SETTING_MODELS_DEV_FETCHED_AT)).toBeTruthy();

      const cached = JSON.parse(getSetting(s.db, SETTING_MODELS_DEV_CACHE) ?? '[]') as Array<{
        provider: string;
      }>;
      expect(cached.map((p) => p.provider).sort()).toEqual(['many', 'zhipuai']);

      // catalog 合并：zcode 主体在前 + models.dev 追加；fetched_at 非空。
      const catalog = modelCatalog(s.db);
      expect(catalog.fetched_at).toBe(getSetting(s.db, SETTING_MODELS_DEV_FETCHED_AT));
      const sources = new Set(catalog.presets.map((p) => p.source));
      expect(sources.has('zcode')).toBe(true);
      expect(sources.has('models.dev')).toBe(true);
      const zhipu = catalog.presets.find((p) => p.provider === 'zhipuai');
      expect(zhipu?.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4');
      expect(zhipu?.name).toBe('Zhipu AI');
      expect(zhipu?.models).toEqual([
        {
          id: 'glm-5.3-flash',
          name: 'GLM-5.3 Flash',
          contextWindow: 131072,
          inputTypes: ['text', 'image'],
        },
        { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 2000000, inputTypes: ['text'] },
      ]);
      expect(zhipu?.iconUrl).toBe('https://models.dev/logos/zhipuai.svg');
      const many = catalog.presets.find((p) => p.provider === 'many');
      expect(many?.models.length).toBe(PRESET_MODEL_LIMIT);
      expect(many?.models[0]?.id).toBe('many-1');
      // zcode 主体前缀不受缓存影响。
      expect(catalog.presets.slice(0, zcodePresets.length)).toEqual([...zcodePresets]);
    } finally {
      s.dispose();
    }
  });

  test('fetchModelsDevPresets 直接映射；网络失败中文报错且缓存不受污染', async () => {
    const s = createServices();
    try {
      const direct = await fetchModelsDevPresets(
        (async () => okResponse(modelsDevPayload())) as unknown as typeof fetch,
      );
      expect(direct.map((p) => p.provider).sort()).toEqual(['many', 'zhipuai']);
      expect(direct.every((p) => p.source === 'models.dev')).toBe(true);

      // HTTP 非 200 → 中文报错。
      await expect(
        fetchModelsDevPresets((async () => new Response('boom', { status: 503 })) as unknown as typeof fetch),
      ).rejects.toThrow(/models\.dev 返回 HTTP 503/);

      // 网络异常 → 中文报错。
      await expect(
        fetchModelsDevPresets((async () => {
          throw new Error('EAI_AGAIN lookup failed');
        }) as unknown as typeof fetch),
      ).rejects.toThrow(/EAI_AGAIN/);

      // 失败后缓存键不被写入（旧缓存若有则保留——此处为从未刷新）。
      expect(getSetting(s.db, SETTING_MODELS_DEV_CACHE)).toBeNull();
      expect(modelCatalog(s.db).fetched_at).toBeNull();
      // zcode 主体不受影响。
      expect(modelCatalog(s.db).presets.length).toBe(zcodePresets.length);
    } finally {
      s.dispose();
    }
  });

  test('缓存损坏按未刷新处理（zcode 主体不受影响）', () => {
    const s = createServices();
    try {
      s.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        SETTING_MODELS_DEV_CACHE,
        'not-json{',
      );
      s.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        SETTING_MODELS_DEV_FETCHED_AT,
        '2026-09-23T00:00:00.000Z',
      );
      const catalog = modelCatalog(s.db);
      expect(catalog.presets).toEqual([...zcodePresets]);
      expect(catalog.fetched_at).toBe('2026-09-23T00:00:00.000Z');
    } finally {
      s.dispose();
    }
  });
});

describe('RPC 面：admin.models.catalog / catalogRefresh', () => {
  test('非 admin 403；admin 读取 zcode 主体；刷新经注入 fetch 合并目录', async () => {
    const s = createServices();
    try {
      const boot = clientFor(s.context());
      const issued = await boot.setup.createAdmin({ username: 'boss', password: 'secret66' });
      const admin = clientFor(s.context({ token: issued.token }));

      // 门控：未认证 401（先于 admin 判定）。
      await expect(clientFor(s.context()).admin.models.catalog()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      // 普通用户（登录后）403。
      await admin.admin.users.create({ username: 'alice', password: 'alice-pw', role: 'user' });
      const alice = await boot.auth.login({ username: 'alice', password: 'alice-pw' });
      await expect(
        clientFor(s.context({ token: alice.token })).admin.models.catalog(),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const catalog = await admin.admin.models.catalog();
      expect(catalog.fetched_at).toBeNull();
      expect(catalog.presets.length).toBe(zcodePresets.length);
      expect(catalog.presets.some((p) => p.provider === 'zai-api' && p.source === 'zcode')).toBe(true);

      // 刷新走 context 注入的 fetchImpl（RpcContext 测试注入口）。
      const refreshAdmin = clientFor(
        s.context({
          token: issued.token,
          fetchImpl: (async () => okResponse(modelsDevPayload())) as unknown as typeof fetch,
        }),
      );
      const refreshed = await refreshAdmin.admin.models.catalogRefresh();
      expect(refreshed.fetched_at).toBeTruthy();
      expect(refreshed.presets.some((p) => p.provider === 'zhipuai' && p.source === 'models.dev')).toBe(true);
      expect(refreshed.presets.some((p) => p.source === 'zcode')).toBe(true);
    } finally {
      s.dispose();
    }
  });

  test('刷新失败 → BAD_REQUEST 中文报错，zcode 主体与旧缓存保留', async () => {
    const s = createServices();
    try {
      const boot = clientFor(s.context());
      const issued = await boot.setup.createAdmin({ username: 'boss', password: 'secret66' });
      const admin = clientFor(
        s.context({
          token: issued.token,
          fetchImpl: (async () => new Response('down', { status: 500 })) as unknown as typeof fetch,
        }),
      );

      await expect(admin.admin.models.catalogRefresh()).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('models.dev 预设刷新失败'),
      });

      // zcode 主体完好；fetched_at 仍为空。
      const catalog = await admin.admin.models.catalog();
      expect(catalog.presets.length).toBe(zcodePresets.length);
      expect(catalog.fetched_at).toBeNull();
    } finally {
      s.dispose();
    }
  });
});
