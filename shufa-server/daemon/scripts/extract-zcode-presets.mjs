#!/usr/bin/env node
/**
 * ZCode Registry 预设提取脚本（2026-09-22 调查结论落地）：
 * 从 zai-org/ZCode 的 zcode-builtin.json（Provider/Model Registry 数据发布）
 * 静态提取 20 个 provider 模板 → daemon/src/zcode-presets.ts。
 *
 * 提取范围（有意收窄，只转录本项目契约用得上的叶子）：
 *   provider = templateId（作路由 provider 标识，天然区分 zai-api/zai-standard-api）
 *   name     = templateNameMap["zh-CN"] ?? en-US
 *   baseURL  = api.baseUrl；api = 协议名映射（openai-chat-completions → 本项目 openai-completions）
 *   iconUrl  = models.dev logo（templateId → slug 硬编码对照表，缺失则字母头像回退）
 *   模型清单 = builtinModelIds ∪ templateModelRules（去重保序），富字段按 ZCode
 *   规则引擎的有序叠加语义静态求值：modelRules → modelApiRules → providerSiteRules
 *   → templateModelRules（后者覆盖前者；叠加语义 = undefined 继承 / 其他替换），
 *   取 contextWindow / supportsImage / reasoningLevel.values / maxOutputTokens.max。
 *   account:* providerRules（账号登录型）不提取——本项目路由只支持 apiKey。
 *
 * 用法：node scripts/extract-zcode-presets.mjs [zcode-builtin.json 路径]
 *   缺省从 GitHub raw main 分支拉取最新；建议随上游 revision 升级时重跑。
 * 上游：https://github.com/zai-org/ZCode（Apache-2.0）config/provider/zcode-builtin.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW_URL = 'https://raw.githubusercontent.com/zai-org/ZCode/main/config/provider/zcode-builtin.json';
const OUT_FILE = new URL('../src/zcode-presets.ts', import.meta.url);

/** 协议名映射：ZCode 三型 → 本项目 ROUTE_APIS（仅 chat-completions 不同名）。 */
const API_NAME_MAP = {
  'anthropic-messages': 'anthropic-messages',
  'openai-chat-completions': 'openai-completions',
  'openai-responses': 'openai-responses',
};

/** templateId → models.dev logo slug（逐一经 models.dev api.json 核对存在）。 */
const LOGO_SLUGS = {
  'zai-api': 'zai',
  'zai-standard-api': 'zai',
  'bigmodel-api': 'zhipuai',
  'bigmodel-standard-api': 'zhipuai',
  'moonshot-kimi': 'moonshotai',
  minimax: 'minimax',
  deepseek: 'deepseek',
  'qwen-alibaba-model-studio-cn': 'alibaba-cn',
  'qwen-alibaba-model-studio-intl': 'alibaba',
  'xiaomi-mimo': 'xiaomi',
  openai: 'openai',
  anthropic: 'anthropic',
  xai: 'xai',
  openrouter: 'openrouter',
  'opencode-go-chat': 'opencode-go',
  'opencode-go-messages': 'opencode-go',
  'opencode-go-responses': 'opencode-go',
  'opencode-zen-responses': 'opencode',
  'opencode-zen-messages': 'opencode',
  'opencode-zen-chat': 'opencode',
};

// ---------------------------------------------------------------- 规则叠加求值

/** ZCode overlayValue 语义的叶子版：undefined=继承旧值，其余（含 null 清空）替换。 */
function overlayValue(prev, next) {
  return next === undefined ? prev : next;
}

/** 把一条规则 config 的可提取叶子叠加进 acc（形状与 zcode-builtin.json 对齐）。 */
function overlayRuleLeaves(acc, config) {
  if (!config) return acc;
  const props = config.properties ?? {};
  acc.contextWindow = overlayValue(acc.contextWindow, props.contextWindow);
  acc.supportsImage = overlayValue(
    acc.supportsImage,
    props.inputFormat?.supportsImage,
  );
  const values = config.optionSpecs?.reasoningLevel?.values;
  if (values !== undefined) acc.reasoningValues = overlayValue(acc.reasoningValues, values);
  const max = config.optionSpecs?.maxOutputTokens?.max;
  if (max !== undefined) acc.maxOutputTokens = overlayValue(acc.maxOutputTokens, max);
  return acc;
}

/** ZCode matchesRule：pattern 锚定全串正则。 */
function matches(pattern, value, ignoreCase = false) {
  try {
    return new RegExp(`^(?:${pattern})$`, ignoreCase ? 'i' : undefined).test(value);
  } catch {
    return false;
  }
}

/** URL 规范化（ZCode normalizeBaseURLForRuleMatch 语义：去尾斜杠，保留 path/query）。 */
function normalizeBaseUrl(value) {
  try {
    const parsed = new URL(value);
    const suffix = `${parsed.search}${parsed.hash}`;
    const serialized = parsed.toString();
    const endpoint = suffix.length === 0 ? serialized : serialized.slice(0, -suffix.length);
    return `${endpoint.replace(/\/+$/, '')}${suffix}`;
  } catch {
    return undefined;
  }
}

/**
 * 按模板上下文对单模型求值全部通用规则 + 模板精确规则
 * （顺序与 ModelConfigRules.composeEffective 的 builtin 序一致，后到先得）。
 */
function resolveModelLeaves(rules, { templateId, modelId, apiType, baseUrl }) {
  const acc = { contextWindow: undefined, supportsImage: undefined, reasoningValues: undefined, maxOutputTokens: undefined };
  const normalizedBase = baseUrl == null ? undefined : normalizeBaseUrl(baseUrl);
  for (const rule of rules) {
    if (rule.type === 'model') {
      if (matches(rule.modelMatch, modelId, true)) overlayRuleLeaves(acc, rule.config);
    } else if (rule.type === 'model-api') {
      if (
        matches(rule.modelMatch, modelId) &&
        (rule.apiTypeMatch === undefined ||
          (apiType != null && matches(rule.apiTypeMatch, apiType)))
      )
        overlayRuleLeaves(acc, rule.config);
    } else if (rule.type === 'provider-site') {
      if (
        matches(rule.modelMatch, modelId) &&
        (rule.apiTypeMatch === undefined
          ? true
          : apiType != null && matches(rule.apiTypeMatch, apiType)) &&
        normalizedBase !== undefined &&
        matches(rule.baseUrlMatch, normalizedBase)
      )
        overlayRuleLeaves(acc, rule.config);
    } else if (rule.type === 'template-model') {
      if (rule.templateId === templateId && rule.modelId === modelId)
        overlayRuleLeaves(acc, rule.config);
    }
    // provider-model / manual-provider-model：providerId 精确（account:* 体系），不适用模板提取。
  }
  return acc;
}

// ---------------------------------------------------------------- 主流程

async function loadBuiltin() {
  const argFile = process.argv[2];
  if (argFile) {
    return { raw: await readFile(argFile, 'utf8'), origin: `local:${argFile}` };
  }
  const response = await fetch(RAW_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`拉取 zcode-builtin.json 失败：HTTP ${response.status}`);
  return { raw: await response.text(), origin: RAW_URL };
}

function extract(release) {
  const config = release?.config ?? {};
  const providerRules = config.providerConfigRules ?? {};
  const templates = providerRules.templateRules ?? [];
  const modelRules = config.modelConfigRules ?? {};

  // 规则平铺成带 type 的有序列表（叠加顺序 = 各数组先后）。
  const orderedRules = [
    ...(modelRules.modelRules ?? []).map((r) => ({ ...r, type: 'model' })),
    ...(modelRules.modelApiRules ?? []).map((r) => ({ ...r, type: 'model-api' })),
    ...(modelRules.providerSiteRules ?? []).map((r) => ({ ...r, type: 'provider-site' })),
    ...(modelRules.templateModelRules ?? []).map((r) => ({ ...r, type: 'template-model' })),
  ];

  const presets = [];
  let modelCount = 0;
  for (const template of templates) {
    const templateId = template.templateId;
    const cfg = template.config ?? {};
    const api = cfg.api ?? {};
    const mappedApi = API_NAME_MAP[api.type];
    if (!api.baseUrl || !mappedApi) {
      throw new Error(`模板 ${templateId} 缺 baseUrl 或协议不可映射：${api.type}`);
    }
    const names = template.templateNameMap ?? {};
    const preset = {
      provider: templateId,
      name: names['zh-CN'] ?? names['en-US'] ?? templateId,
      baseURL: api.baseUrl,
      api: mappedApi,
      ...(LOGO_SLUGS[templateId]
        ? { iconUrl: `https://models.dev/logos/${LOGO_SLUGS[templateId]}.svg` }
        : {}),
      models: [],
      source: 'zcode',
    };

    // 模型清单：builtinModelIds 保序在前，templateModelRules 的增量补后。
    const ids = [...(cfg.builtinModelIds ?? [])];
    for (const rule of modelRules.templateModelRules ?? []) {
      if (rule.templateId === templateId && !ids.includes(rule.modelId)) ids.push(rule.modelId);
    }
    for (const modelId of ids) {
      const leaves = resolveModelLeaves(orderedRules, {
        templateId,
        modelId,
        apiType: api.type,
        baseUrl: api.baseUrl,
      });
      preset.models.push({
        id: modelId,
        ...(leaves.contextWindow !== undefined ? { contextWindow: leaves.contextWindow } : {}),
        inputTypes: leaves.supportsImage === true ? ['text', 'image'] : ['text'],
        ...(leaves.reasoningValues !== undefined && leaves.reasoningValues !== null
          ? { efforts: [...leaves.reasoningValues] }
          : {}),
      });
    }
    if (preset.models.length === 0) {
      throw new Error(`模板 ${templateId} 模型清单为空`);
    }
    modelCount += preset.models.length;
    presets.push(preset);
  }
  return { presets, modelCount, revision: release?.revision };
}

async function main() {
  const { raw, origin } = await loadBuiltin();
  const release = JSON.parse(raw);
  const { presets, modelCount, revision } = extract(release);
  const generatedAt = new Date().toISOString().slice(0, 10);

  const body = `/**
 * ZCode Registry 预设（生成文件，勿手改）——由 daemon/scripts/extract-zcode-presets.mjs
 * 从 zai-org/ZCode 的 zcode-builtin.json 静态提取。重跑：pnpm --filter daemon exec node
 * scripts/extract-zcode-presets.mjs [本地 json 路径]（缺省拉 GitHub raw main）。
 * 上游 Apache-2.0；数据源：${origin}
 * 上游 revision ${revision}；${presets.length} 模板 / ${modelCount} 模型；生成于 ${generatedAt}。
 * 语义备注：模型 efforts = ZCode reasoningLevel 档位（含 disabled/enabled 这类开关型档）；
 * account:* 账号型 provider 不在内（本项目路由仅支持 apiKey）。
 */
import type { ModelPreset } from '@zhumo/contracts';

export const ZCODE_PRESET_SOURCE_URL = '${origin}';

export const zcodePresets: readonly ModelPreset[] = ${JSON.stringify(presets, null, 2)};
`;

  const outPath = fileURLToPath(OUT_FILE);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, body, 'utf8');
  process.stdout.write(
    `已生成 ${path.relative(process.cwd(), outPath)}：${presets.length} 模板 / ${modelCount} 模型（revision ${revision}）\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
