/**
 * 大模型服务多路由契约（走查五轮 2026-09-24，对齐 skill-creator-v2 DshModelRoute
 * 体系）：routes[]（每路由 = provider + 协议 + 端点 + 模型清单）+ default（默认
 * 模型，活动模型由前台任务对话框按任务选择，不进服务配置）。
 * 安全：apiKey 只经 save 输入（空串=保留旧值），任何输出面都以 hasKey 布尔回显。
 */
import { z } from 'zod';
import { IdSchema } from '../common.js';

/** zhumo 支持的 wire 协议（走查五轮 · 三：补 openai-responses）。 */
export const ROUTE_APIS = ['anthropic-messages', 'openai-completions', 'openai-responses'] as const;
export const RouteApiSchema = z.enum(ROUTE_APIS);
export type RouteApi = z.infer<typeof RouteApiSchema>;

/** 模型输入模态（走查五轮 · 五）：text 恒支持；image = 视觉输入（讲评截图等）。 */
export const MODEL_INPUT_TYPES = ['text', 'image'] as const;
export const ModelInputTypeSchema = z.enum(MODEL_INPUT_TYPES);
/** 输出模态：text 恒支持；image 留作图像生成模型扩展。 */
export const MODEL_OUTPUT_TYPES = ['text', 'image'] as const;
export const ModelOutputTypeSchema = z.enum(MODEL_OUTPUT_TYPES);

/** 路由内单模型条目（富字段：上下文窗口/模态/efforts）。 */
export const ModelsModelSchema = z.object({
  id: z.string().min(1),
  /** 展示名；缺省由 id 派生。 */
  name: z.string().optional(),
  /** 上下文窗口（token 数；0.5M/128k 由 UI 简写换算）。 */
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** reasoning effort 档。 */
  efforts: z.array(z.string().min(1)).optional(),
  inputTypes: z.array(ModelInputTypeSchema).optional(),
  outputTypes: z.array(ModelOutputTypeSchema).optional(),
});
export type ModelsModel = z.infer<typeof ModelsModelSchema>;

/** 单条模型路由（apiKey 不出库——输出面恒 hasKey）。 */
export const ModelsRouteSchema = z.object({
  provider: IdSchema,
  api: RouteApiSchema,
  baseURL: z.string().min(1),
  /** models.dev 图标 URL（可离线缺失，UI 回退字母头像）。 */
  iconUrl: z.string().optional(),
  models: z.array(ModelsModelSchema).min(1),
});
export type ModelsRoute = z.infer<typeof ModelsRouteSchema>;

/** 输出面的路由（+ 密钥在场位）。 */
export const ModelsRouteViewSchema = ModelsRouteSchema.extend({
  hasKey: z.boolean(),
});
export type ModelsRouteView = z.infer<typeof ModelsRouteViewSchema>;

/** 默认模型（后台选择；活动模型按任务由前台覆盖，不落此处）。 */
export const ModelsDefaultSchema = z.object({
  provider: IdSchema,
  model: z.string().min(1),
});
export type ModelsDefault = z.infer<typeof ModelsDefaultSchema>;

/** admin.models.get 出参。 */
export const ModelsConfigOutputSchema = z.object({
  routes: z.array(ModelsRouteViewSchema),
  default: ModelsDefaultSchema.nullable(),
});
export type ModelsConfigOutput = z.infer<typeof ModelsConfigOutputSchema>;

/** admin.models.save 入参：apiKey 空串/缺省 = 保留旧密钥；非空 = 更新。 */
export const ModelsRouteSaveSchema = ModelsRouteSchema.extend({
  apiKey: z.string().optional(),
});
export const ModelsSaveInputSchema = z.object({
  routes: z.array(ModelsRouteSaveSchema).min(0),
  default: ModelsDefaultSchema.nullable(),
});
export type ModelsSaveInput = z.infer<typeof ModelsSaveInputSchema>;

/**
 * 连接测试（走查五轮 · 一，对齐 skill-creator-v2 probe 矩阵）：按协议发最小
 * completion 请求，HTTP 2xx = ok（附延迟）；非 2xx/网络错误/超时 = failed。
 * apiKey 可直传（测试用完即弃）；缺省时 daemon 从已存密钥注入。
 */
export const ModelsTestInputSchema = z.object({
  provider: IdSchema.optional(),
  api: RouteApiSchema,
  baseURL: z.string().min(1),
  apiKey: z.string().optional(),
  modelId: z.string().min(1),
});
export type ModelsTestInput = z.infer<typeof ModelsTestInputSchema>;

export const ModelsTestOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), latencyMs: z.number().int().nonnegative() }),
  z.object({ ok: z.literal(false), detail: z.string() }),
]);
export type ModelsTestOutput = z.infer<typeof ModelsTestOutputSchema>;

/**
 * 可用模型清单（requireActiveUser，前台任务对话框选择用）：已配置路由的模型
 * 扁平投影；活动模型按任务从其中选，默认跟随后台默认模型。
 */
export const AvailableModelSchema = z.object({
  provider: IdSchema,
  model: z.string(),
  name: z.string(),
  contextWindow: z.number().int().positive().optional(),
  inputTypes: z.array(ModelInputTypeSchema).optional(),
  /** 思考强度档（2026-09-25 前台对齐：zcode 转录的 reasoningLevel 档位）。 */
  efforts: z.array(z.string().min(1)).optional(),
  iconUrl: z.string().optional(),
});
export type AvailableModel = z.infer<typeof AvailableModelSchema>;

export const ModelsAvailableOutputSchema = z.object({
  models: z.array(AvailableModelSchema),
  default: ModelsDefaultSchema.nullable(),
});
export type ModelsAvailableOutput = z.infer<typeof ModelsAvailableOutputSchema>;

/**
 * 预设目录条目（zcode 轮，2026-09-25 Owner 裁决：目录主体对齐 ZCode Registry，
 * pi-ai 内置长尾退出；source 不进输出面——它只是后端数据管道的替换单位标记：
 * zcode = 生成文件整体随 scripts/extract-zcode-presets.mjs 重跑全量换新，
 * models.dev = settings 缓存整体随刷新换新，均无需逐条标识）。
 * 模型带 contextWindow/inputTypes/efforts（ZCode reasoningLevel 档位转录）。
 */
export const ModelPresetModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  inputTypes: z.array(ModelInputTypeSchema).optional(),
  efforts: z.array(z.string().min(1)).optional(),
});
export const ModelPresetSchema = z.object({
  provider: z.string(),
  name: z.string(),
  baseURL: z.string().optional(),
  api: z.string().optional(),
  iconUrl: z.string().optional(),
  models: z.array(ModelPresetModelSchema),
});
export type ModelPreset = z.infer<typeof ModelPresetSchema>;

export const ModelCatalogOutputSchema = z.object({
  presets: z.array(ModelPresetSchema),
  fetched_at: z.string().nullable(),
});
export type ModelCatalogOutput = z.infer<typeof ModelCatalogOutputSchema>;
