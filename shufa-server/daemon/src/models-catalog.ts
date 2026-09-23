/**
 * Models 预设目录（走查 BUG4，2026-09-23；skill-creator-v2 开箱预设语义）：
 * builtin 预设从 @earendil-works/pi-ai 包内嵌 provider 数据（dist/providers/data
 * 经 `providers/all` 公共子路径导出）生成；models.dev 在线刷新映射后连同 fetched_at
 * 缓存进 settings 表；catalog = builtin 恒在 + 缓存追加。
 * 正交意图：
 *   [1] builtin：只收有 baseUrl 的 provider，每家取前若干代表型号（全量太大）。
 *   [2] models.dev 刷新：GET api.json → presets（baseURL 取 provider.api 字段）→
 *       settings 缓存（models_dev_cache / models_dev_fetched_at，内部键不进 API 白名单）。
 *   [3] catalog 读面：缓存过期与否都返回 builtin；缓存存在即追加。
 */
import { builtinProviders, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import type { ModelCatalogOutput, ModelPreset } from '@zhumo/contracts';
import type { SqliteDb } from './db/database.js';
import { getSetting, nowIso, putSetting } from './db/store.js';

export const MODELS_DEV_API_URL = 'https://models.dev/api.json';
/** settings 表内部缓存键（不进 admin.settings 白名单，属内部状态）。 */
export const SETTING_MODELS_DEV_CACHE = 'models_dev_cache';
export const SETTING_MODELS_DEV_FETCHED_AT = 'models_dev_fetched_at';
/** 每家预设收录的代表型号上限。 */
export const PRESET_MODEL_LIMIT = 12;

/**
 * builtin 预设：pi-ai 内嵌 provider 目录（有 baseUrl 的），每家取前
 * PRESET_MODEL_LIMIT 个代表型号；api 取首个型号的协议类型（openai-completions 等）。
 * Z.AI（zai）、智谱 bigmodel.cn 端点（zai-coding-cn）、DeepSeek、OpenAI、
 * Anthropic、OpenRouter 均在内。
 */
export function builtinModelPresets(): ModelPreset[] {
  // getBuiltinModels 的泛型收窄到字面量联合；此处按运行时 provider id 动态取。
  const modelsOf = getBuiltinModels as unknown as (
    provider: string,
  ) => Array<{ id: string; name?: string; api?: string }>;
  const presets: ModelPreset[] = [];
  for (const provider of builtinProviders()) {
    if (!provider.baseUrl) continue; // 过滤：只收有 baseUrl 的 provider
    const models = modelsOf(provider.id);
    if (models.length === 0) continue;
    presets.push({
      provider: provider.id,
      name: provider.name,
      baseURL: provider.baseUrl,
      api: models[0]?.api,
      models: models.slice(0, PRESET_MODEL_LIMIT).map((m) => ({ id: m.id, name: m.name })),
      source: 'builtin',
    });
  }
  return presets;
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
        const model = modelValue as { id?: unknown; name?: unknown };
        const id = typeof model.id === 'string' && model.id ? model.id : modelKey;
        models.push({ id, name: typeof model.name === 'string' ? model.name : undefined });
      }
    }
    if (models.length === 0) continue;
    presets.push({
      provider: providerId,
      name: typeof provider.name === 'string' && provider.name ? provider.name : providerId,
      baseURL,
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

/** 目录读面：builtin 恒在；settings 缓存有则追加；fetched_at 为缓存时间或 null。 */
export function modelCatalog(db: SqliteDb): ModelCatalogOutput {
  let cached: ModelPreset[] = [];
  const raw = getSetting(db, SETTING_MODELS_DEV_CACHE);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) cached = parsed as ModelPreset[];
    } catch {
      // 缓存损坏按未刷新处理（builtin 不受影响，下次刷新覆盖）。
    }
  }
  return {
    presets: [...builtinModelPresets(), ...cached],
    fetched_at: getSetting(db, SETTING_MODELS_DEV_FETCHED_AT),
  };
}
