/**
 * Models 预设目录（2026-09-25 Owner 裁决：目录主体对齐 ZCode Registry）：
 * catalog = zcode 静态策展（20 模板/244 模型，恒在）+ models.dev 手动刷新缓存（追加）。
 * pi-ai 内置长尾已整体退出目录（原 builtinModelPresets 撤除）——范围广但非策展，
 * 自定义端点仍可手填任意 provider。
 * models.dev 刷新：GET api.json → presets（baseURL 取 provider.api 字段）→
 * settings 缓存（models_dev_cache / models_dev_fetched_at，内部键不进 API 白名单）。
 * zcode 数据随上游 revision 升级：重跑 scripts/extract-zcode-presets.mjs。
 */
import type { ModelCatalogOutput, ModelPreset } from '@zhumo/contracts';
import type { SqliteDb } from './db/database.js';
import { getSetting, nowIso, putSetting } from './db/store.js';
import { zcodePresets } from './zcode-presets.js';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
/** settings 表内部缓存键（不进 admin.settings 白名单，属内部状态）。 */
export const SETTING_MODELS_DEV_CACHE = 'models_dev_cache';
export const SETTING_MODELS_DEV_FETCHED_AT = 'models_dev_fetched_at';
/** 每家预设收录的代表型号上限。 */
export const PRESET_MODEL_LIMIT = 12;

/** models.dev logo URL（在线图标源；UI 离线缺失时回退字母头像）。 */
export function modelsDevLogo(providerId: string): string {
  return `https://models.dev/logos/${providerId}.svg`;
}

/**
 * 拉取 models.dev 并映射为 presets（不入库；写库见 refreshModelsDevCache）。
 * models.dev/api.json 真实结构：{ [providerId]: { id, name, api?, npm?, env?,
 * models: { [modelId]: { id, name, ... } } } }——服务端点在 provider 的 `api`
 * 字段（http URL），223 家里 196 家有；模型名在 model.name。
 */
export async function fetchModelsDevPresets(
  fetchImpl: typeof fetch = fetch,
): Promise<ModelPreset[]> {
  const response = await fetchImpl(MODELS_DEV_API_URL, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`models.dev 返回 HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('models.dev 响应不是预期 JSON 对象');
  }
  const presets: ModelPreset[] = [];
  for (const [providerId, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const provider = value as {
      id?: unknown;
      name?: unknown;
      api?: unknown;
      models?: unknown;
    };
    // 过滤：只收有服务端点的 provider（models.dev 的 baseUrl 叫 `api` 字段）。
    const baseURL =
      typeof provider.api === 'string' && provider.api.startsWith('http') ? provider.api : undefined;
    if (!baseURL) continue;
    const models: ModelPreset['models'] = [];
    if (typeof provider.models === 'object' && provider.models !== null) {
      for (const [modelKey, modelValue] of Object.entries(
        provider.models as Record<string, unknown>,
      )) {
        if (models.length >= PRESET_MODEL_LIMIT) break;
        if (typeof modelValue !== 'object' || modelValue === null) continue;
        // 五轮：模型带 contextWindow（limit.context）与输入模态（modalities.input）。
        const model = modelValue as {
          id?: unknown;
          name?: unknown;
          limit?: { context?: unknown } | null;
          modalities?: { input?: unknown } | null;
        };
        const id = typeof model.id === 'string' && model.id ? model.id : modelKey;
        const context =
          typeof model.limit?.context === 'number' && model.limit.context > 0
            ? Math.round(model.limit.context)
            : undefined;
        const rawInputs = Array.isArray(model.modalities?.input)
          ? (model.modalities.input as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        models.push({
          id,
          name: typeof model.name === 'string' ? model.name : undefined,
          ...(context !== undefined ? { contextWindow: context } : {}),
          inputTypes: rawInputs.includes('image') ? ['text', 'image'] : ['text'],
        });
      }
    }
    if (models.length === 0) continue;
    presets.push({
      provider: providerId,
      name: typeof provider.name === 'string' && provider.name ? provider.name : providerId,
      baseURL,
      iconUrl: modelsDevLogo(providerId),
      models,
      source: 'models.dev',
    });
  }
  if (presets.length === 0) throw new Error('models.dev 响应中没有可用的 provider 预设');
  return presets;
}

/** 刷新 models.dev 缓存：映射结果连同 fetched_at 写入 settings 表（内部键）。 */
export async function refreshModelsDevCache(
  db: SqliteDb,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const presets = await fetchModelsDevPresets(fetchImpl);
  putSetting(db, SETTING_MODELS_DEV_CACHE, JSON.stringify(presets));
  putSetting(db, SETTING_MODELS_DEV_FETCHED_AT, nowIso());
}

/** 目录读面：zcode 策展恒在（目录主体）；models.dev 缓存有则追加；fetched_at 为缓存时间或 null。 */
export function modelCatalog(db: SqliteDb): ModelCatalogOutput {
  let cached: ModelPreset[] = [];
  const raw = getSetting(db, SETTING_MODELS_DEV_CACHE);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) cached = parsed as ModelPreset[];
    } catch {
      // 缓存损坏按未刷新处理（zcode 主体不受影响，下次刷新覆盖）。
    }
  }
  return {
    presets: [...zcodePresets, ...cached],
    fetched_at: getSetting(db, SETTING_MODELS_DEV_FETCHED_AT),
  };
}
