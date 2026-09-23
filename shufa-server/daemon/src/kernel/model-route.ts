/**
 * 模型路由桥（PRODUCT_DESIGN.md §0「产品真源 + 热同步 $DSH_HOME/settings.yaml/
 * .credentials.yaml」；照 skill-creator-v2 steward/dsh-settings.ts 双层桥裁剪）。
 * 原始需求 2026-09-23（W4）：真源 = settings 表（llm_* 键）+ .env LLM_* 引导值；
 * 桥接面 = settings.yaml 的 llm-pi-ai 段 + .credentials.yaml 的 version-1 refs。
 * 正交意图：
 *   [1] 路由解析：settings 表优先，.env（LLM_*）兜底；缺项 = null（不桥接）。
 *   [2] settings.yaml 同步（llm-pi-ai.providers；key 只以 apiKeyEnv 引用）。
 *   [3] .credentials.yaml 同步（version 1 / refs 布局；顶层平铺会打挂 boot）。
 *   [4] apiKey 的 env 注入与还原（值不落 YAML）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface ShufaModelRoute {
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** 协议（pi-ai adapter）；缺省 anthropic-messages。 */
  api: string;
  contextWindow: number;
}

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
 * 路由解析：setting(key) 回调由调用方提供（settings 表 → .env fileEnv 兜底链）。
 * 四键齐备才成路由（key 缺失 = 未配置模型，内核以缺省路由运行）。
 */
export function resolveModelRoute(setting: (key: LlmSettingKey) => string | null): ShufaModelRoute | null {
  const provider = setting('llm_provider')?.trim() ?? '';
  const baseURL = setting('llm_base_url')?.trim() ?? '';
  const apiKey = setting('llm_api_key')?.trim() ?? '';
  const model = setting('llm_model')?.trim() ?? '';
  if (!provider || !baseURL || !apiKey || !model) return null;
  // 协议键（W7b 联调补）：网关只讲 openai-completions 时必须可配——
  // 实证 2026-09-23：Z.ai /api/paas/v4 走 openai-completions，硬编码 anthropic-messages 404。
  const api = setting('llm_api')?.trim() || 'anthropic-messages';
  return { provider, baseURL, apiKey, model, api, contextWindow: 131072 };
}

/** settings.yaml 同步：llm-pi-ai 段整体重写（settings-file 行热加载）。 */
export function syncModelRouteSettings(dshHome: string, route: ShufaModelRoute): void {
  const file = path.join(dshHome, 'settings.yaml');
  const doc = readYamlObject(file);
  doc['llm-pi-ai'] = {
    providers: {
      [route.provider]: {
        apiKeyEnv: apiKeyEnvFor(route.provider),
        api: route.api,
        baseURL: route.baseURL,
        models: [{ id: route.model, contextWindow: route.contextWindow }],
      },
    },
  };
  writeYamlFile(file, doc);
}

/** .credentials.yaml 同步：version-1 refs 布局（凭据必须嵌在 refs 下）。 */
export function syncModelRouteCredential(dshHome: string, route: ShufaModelRoute): void {
  const file = path.join(dshHome, '.credentials.yaml');
  const doc = readYamlObject(file);
  const refs = isRecord(doc.refs) ? doc.refs : {};
  refs[apiKeyEnvFor(route.provider)] = route.apiKey;
  doc.version = 1;
  doc.refs = refs;
  writeYamlFile(file, doc);
}

/** boot 时注入 apiKey env（dispose 时以返回的还原函数恢复）。 */
export function injectApiKeyEnv(route: ShufaModelRoute): () => void {
  const key = apiKeyEnvFor(route.provider);
  const previous = process.env[key];
  process.env[key] = route.apiKey;
  return () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  };
}

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
  // 直接覆盖写（本机单进程；桥写失败由调用方捕获降级——路由不生效不能静默）。
  writeFileSync(file, stringifyYaml(doc), { encoding: 'utf8', mode: 0o600 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
