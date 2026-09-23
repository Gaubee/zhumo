/**
 * 模型路由桥（多路由版，走查五轮 2026-09-24；skill-creator-v2 steward/dsh-settings
 * 双层桥语义）：真源 = settings 表 models_routes/models_keys/models_default（见
 * models-store.ts）；旧 llm_* 五键仅作 .env 引导时代的兼容链（models-store 迁移
 * 收编后不再走此）。
 * 桥接面：
 *   settings.yaml   llm-pi-ai.providers 全量路由（model 条目带 contextWindow）
 *                   + agent-default-model {provider, model}（默认模型）
 *   .credentials.yaml version-1 refs 全量密钥（顶层平铺会打挂 boot）。
 * 密钥值只以 apiKeyEnv 引用/refs 落盘，settings.yaml 不含明文。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface ShufaModelRoute {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** wire 协议（anthropic-messages / openai-completions / openai-responses）。 */
  api: string;
  contextWindow: number;
}

/** 桥接路由（多模型）：一条 provider 路由携带全部模型条目。 */
export interface BridgedRoute {
  provider: string;
  api: string;
  baseURL: string;
  apiKey: string;
  models: Array<{ id: string; contextWindow?: number }>;
}

/** 多路由桥接载荷（boot 用）：全量路由 + 默认模型。 */
export interface ModelRoutesBundle {
  routes: BridgedRoute[];
  default: { provider: string; model: string } | null;
}

/** 旧 llm_* 键面（兼容链/白名单沿用；多路由真源见 models-store.ts）。 */
export const LLM_SETTING_KEYS = [
  'llm_provider',
  'llm_base_url',
  'llm_api_key',
  'llm_api',
  'llm_model',
] as const;
export type LlmSettingKey = (typeof LLM_SETTING_KEYS)[number];

/** 已知 provider → 官方惯例 env 名；其余 provider 走 <UPPER>_API_KEY。 */
const ROUTE_API_KEY_ENVS: Readonly<Record<string, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  'google-vertex': 'GOOGLE_GENERATIVE_AI_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
};

export function apiKeyEnvFor(provider: string): string {
  return ROUTE_API_KEY_ENVS[provider] ?? `${provider.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`;
}

/**
 * 单路由解析（旧 llm_* 兼容链，缺项 = null）：settings 表优先、.env LLM_* 兜底。
 * 协议缺省 anthropic-messages（实证 2026-09-23：Z.ai 网关走 openai-completions，
 * 协议必须可配）。
 */
export function resolveModelRoute(setting: (key: string) => string | null): ShufaModelRoute | null {
  const provider = setting('llm_provider')?.trim() ?? '';
  const baseURL = setting('llm_base_url')?.trim() ?? '';
  const apiKey = setting('llm_api_key')?.trim() ?? '';
  const model = setting('llm_model')?.trim() ?? '';
  if (!provider || !baseURL || !apiKey || !model) return null;
  const api = setting('llm_api')?.trim() || 'anthropic-messages';
  return { provider, baseURL, apiKey, model, api, contextWindow: 131072 };
}

/** settings.yaml 同步：providers 全量 + agent-default-model（整段重写，行热加载）。 */
export function syncModelRoutesSettings(dshHome: string, bundle: ModelRoutesBundle): void {
  const file = path.join(dshHome, 'settings.yaml');
  const doc = readYamlObject(file);
  const providers: Record<string, unknown> = {};
  for (const route of bundle.routes) {
    const models = route.models.map((entry) => ({
      id: entry.id,
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    }));
    // 默认模型不在清单（悬空防御）时补一条。
    if (bundle.default?.provider === route.provider) {
      const has = route.models.some((entry) => entry.id === bundle.default!.model);
      if (!has) models.push({ id: bundle.default.model });
    }
    providers[route.provider] = {
      apiKeyEnv: apiKeyEnvFor(route.provider),
      api: route.api,
      baseURL: route.baseURL,
      models,
    };
  }
  doc['llm-pi-ai'] = { providers };
  if (bundle.default) {
    doc['agent-default-model'] = { provider: bundle.default.provider, model: bundle.default.model };
  } else {
    delete doc['agent-default-model'];
  }
  writeYamlFile(file, doc);
}

/** .credentials.yaml 同步：version-1 refs 全量密钥。 */
export function syncModelRoutesCredentials(
  dshHome: string,
  routes: Array<{ provider: string; apiKey: string }>,
): void {
  const file = path.join(dshHome, '.credentials.yaml');
  const doc = readYamlObject(file);
  const refs = isRecord(doc.refs) ? doc.refs : {};
  for (const route of routes) {
    if (route.apiKey) refs[apiKeyEnvFor(route.provider)] = route.apiKey;
  }
  doc.version = 1;
  doc.refs = refs;
  writeYamlFile(file, doc);
}

/** 旧单路由桥接（llm_* 时代调用面保留，内部复用多路由写法）。 */
export function syncModelRouteSettings(dshHome: string, route: ShufaModelRoute): void {
  syncModelRoutesSettings(dshHome, {
    routes: [
      {
        provider: route.provider,
        api: route.api,
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        models: [{ id: route.model, contextWindow: route.contextWindow }],
      },
    ],
    default: { provider: route.provider, model: route.model },
  });
}

export function syncModelRouteCredential(dshHome: string, route: ShufaModelRoute): void {
  syncModelRoutesCredentials(dshHome, [route]);
}

/** boot 时注入全部密钥 env（dispose 时以返回的还原函数恢复）。 */
export function injectApiKeysEnv(routes: Array<{ provider: string; apiKey: string }>): () => void {
  const restores: Array<() => void> = [];
  for (const route of routes) {
    if (!route.apiKey) continue;
    const key = apiKeyEnvFor(route.provider);
    const previous = process.env[key];
    process.env[key] = route.apiKey;
    restores.push(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  return () => restores.forEach((restore) => restore());
}

// ---------------------------------------------------------------- 内部工具

function readYamlObject(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = parseYaml(readFileSync(file, 'utf8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {}; // 坏 YAML：以空文档起步（首写重建）。
  }
}

function writeYamlFile(file: string, doc: Record<string, unknown>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, stringifyYaml(doc), { encoding: 'utf8', mode: 0o600 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
