/**
 * 多路由模型配置存储（走查五轮 2026-09-24）：settings 表三个 JSON 键——
 *   models_routes  路由清单（不含密钥）
 *   models_keys    {provider: apiKey}（密钥；任何 RPC 输出面都不回值，只回 hasKey）
 *   models_default {provider, model}（默认模型；活动模型由前台按任务选择）
 * 兼容迁移：models_routes 为空且旧 llm_* 五键齐备时自动收编为一条路由（.env
 * LLM_* 引导同链），旧数据不丢；收编在首次读取时物化落库。
 */
import type { ModelsDefault, ModelsModel, ModelsRoute, ModelsRouteView, RouteApi } from '@zhumo/contracts';
import type { ModelRoutesBundle } from './kernel/model-route.js';
import type { SqliteDb } from './db/database.js';
import { getSetting, putSetting } from './db/store.js';

const KEY_ROUTES = 'models_routes';
const KEY_KEYS = 'models_keys';
const KEY_DEFAULT = 'models_default';

/** 存储态路由（密钥分离存 models_keys）。 */
export interface StoredRoute extends Omit<ModelsRoute, 'models'> {
  models: ModelsModel[];
}

/** 读面：路由视图（hasKey 投影）+ 默认模型。 */
export function loadModelsConfig(db: SqliteDb): { routes: ModelsRouteView[]; default: ModelsDefault | null } {
  const routes = loadRoutes(db);
  const keys = loadKeys(db);
  return {
    routes: routes.map((route) => ({ ...route, hasKey: Boolean(keys[route.provider]) })),
    default: loadDefault(db, routes),
  };
}

/** 路由清单（含迁移收编物化）。 */
export function loadRoutes(db: SqliteDb): StoredRoute[] {
  const routes = parseJson(getSetting(db, KEY_ROUTES), []);
  if (routes.length > 0) return routes;
  // 迁移：旧 llm_* 五键（settings 表或 .env 引导值）齐备 → 收编物化。
  const legacy = legacyRoute(db);
  if (legacy) {
    putSetting(db, KEY_ROUTES, JSON.stringify([legacy]));
    putSetting(db, KEY_KEYS, JSON.stringify({ [legacy.provider]: legacyKey(db) ?? '' }));
    putSetting(db, KEY_DEFAULT, JSON.stringify({ provider: legacy.provider, model: legacy.models[0]!.id }));
    return [legacy];
  }
  return [];
}

/** 密钥表（仅 daemon 内部使用；不经 RPC 出参）。 */
export function loadKeys(db: SqliteDb): Record<string, string> {
  return parseJson(getSetting(db, KEY_KEYS), {});
}

export function loadDefault(db: SqliteDb, routes?: StoredRoute[]): ModelsDefault | null {
  const value = parseJson<ModelsDefault | null>(getSetting(db, KEY_DEFAULT), null);
  const list = routes ?? loadRoutes(db);
  if (value && list.some((route) => route.provider === value.provider)) return value;
  return null;
}

/**
 * 写面：routes/default 整体覆盖；apiKey 空串/缺省 = 保留旧密钥，非空 = 更新；
 * 路由被删时对应密钥一并清（不留无主密钥）。
 */
export function saveModelsConfig(
  db: SqliteDb,
  input: { routes: Array<StoredRoute & { apiKey?: string }>; default: ModelsDefault | null },
): void {
  const previousKeys = loadKeys(db);
  const keys: Record<string, string> = {};
  const routes: StoredRoute[] = [];
  for (const route of input.routes) {
    const { apiKey, ...rest } = route;
    routes.push(rest);
    if (apiKey !== undefined && apiKey.length > 0) keys[route.provider] = apiKey;
    else if (previousKeys[route.provider]) keys[route.provider] = previousKeys[route.provider]!;
  }
  putSetting(db, KEY_ROUTES, JSON.stringify(routes));
  putSetting(db, KEY_KEYS, JSON.stringify(keys));
  // default 校验：必须指向存在路由（防悬空引用）。
  const valid =
    input.default && routes.some((route) => route.provider === input.default!.provider)
      ? input.default
      : null;
  putSetting(db, KEY_DEFAULT, JSON.stringify(valid));
}

/** 按 (provider, model) 取完整路由（含该模型的 contextWindow；缺省 128k）。 */
export function resolveRouteFor(
  db: SqliteDb,
  provider: string,
  model: string,
): { provider: string; api: string; baseURL: string; apiKey: string; model: string; contextWindow: number } | null {
  const route = loadRoutes(db).find((candidate) => candidate.provider === provider);
  const key = loadKeys(db)[provider] ?? '';
  if (!route || !key) return null;
  const entry = route.models.find((candidate) => candidate.id === model);
  if (!entry) return null;
  return {
    provider: route.provider,
    api: route.api,
    baseURL: route.baseURL,
    apiKey: key,
    model: entry.id,
    contextWindow: entry.contextWindow ?? 131072,
  };
}

/** boot 桥接载荷：全量路由（多模型 + 密钥）+ 默认模型。 */
export function buildRoutesBundle(db: SqliteDb): ModelRoutesBundle {
  const routes = loadRoutes(db);
  const keys = loadKeys(db);
  return {
    routes: routes
      .filter((route) => Boolean(keys[route.provider]))
      .map((route) => ({
        provider: route.provider,
        api: route.api,
        baseURL: route.baseURL,
        apiKey: keys[route.provider]!,
        models: route.models.map((model) => ({
          id: model.id,
          ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        })),
      })),
    default: loadDefault(db, routes),
  };
}

// ---------------------------------------------------------------- 内部工具

function legacyRoute(db: SqliteDb): (StoredRoute & { legacy?: true }) | null {
  const provider = (getSetting(db, 'llm_provider') ?? '').trim();
  const baseURL = (getSetting(db, 'llm_base_url') ?? '').trim();
  const model = (getSetting(db, 'llm_model') ?? '').trim();
  if (!provider || !baseURL || !model) return null;
  const api = (getSetting(db, 'llm_api') ?? '').trim();
  return { provider, api: normalizeApi(api), baseURL, models: [{ id: model }] };
}

function legacyKey(db: SqliteDb): string | null {
  return (getSetting(db, 'llm_api_key') ?? '').trim() || null;
}

/** 旧数据协议值收编归一（未知/空值回落 anthropic-messages——与旧解析缺省一致）。 */
function normalizeApi(api: string): RouteApi {
  if (api === 'anthropic-messages' || api === 'openai-responses' || api === 'openai-completions') {
    return api;
  }
  return 'anthropic-messages';
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback; // 坏 JSON 按空处理（下次保存覆盖）。
  }
}
