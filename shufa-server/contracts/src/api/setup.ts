/**
 * bootstrap 与安装向导契约（PRODUCT_DESIGN.md §4 bootstrap/setup 路由、§1 向导）。
 * 原始需求 2026-09-23。setup 全族仅在未配置态可达，完成后一律 403。
 * 正交意图：
 *   [1] bootstrap：公开的站点态探测（是否需安装 / 是否允许匿名 / 站点名）。
 *   [2] 向导步骤视图（wizard_steps 行投影，setup 与 admin.wizard 共用）。
 *   [3] setup 四端点形状（建管理员 / 列步骤 / 跑步骤 / 完成标记）。
 */
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, WizardKindSchema, WizardStatusSchema } from '../common.js';
import { TokenOutputSchema } from './auth.js';

/** 生效模型路由（走查 BUG2，2026-09-23）：null = 未配置任何路由。
 * source：settings 表（后台 Models 配置）优先；env = .env LLM_* 引导值兜底。 */
export const ModelRouteInfoSchema = z.object({
  provider: z.string(),
  model: z.string(),
  source: z.enum(['settings', 'env']),
});
export type ModelRouteInfo = z.infer<typeof ModelRouteInfoSchema>;

export const BootstrapOutputSchema = z.object({
  needs_setup: z.boolean(),
  allow_anonymous: z.boolean(),
  site_name: z.string(),
  model_route: ModelRouteInfoSchema.nullable(),
});
export type BootstrapOutput = z.infer<typeof BootstrapOutputSchema>;

/**
 * whisper.cpp 转写模型目录（走查 R6，2026-09-22）：型号 → ggml 文件名 + 体积参考。
 * daemon 下载步骤按 id 组装 URL；webui 设置页渲染同一常量做选择器。
 */
export const WHISPER_MODEL_CATALOG = [
  { id: 'tiny', file: 'ggml-tiny.bin', sizeMb: 78, memoryHint: '约 0.4GB 内存 · 最快' },
  { id: 'base', file: 'ggml-base.bin', sizeMb: 148, memoryHint: '约 0.6GB 内存 · 默认推荐' },
  { id: 'small', file: 'ggml-small.bin', sizeMb: 488, memoryHint: '约 1.2GB 内存' },
  { id: 'medium', file: 'ggml-medium.bin', sizeMb: 1534, memoryHint: '约 2.8GB 内存' },
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', sizeMb: 1620, memoryHint: '约 3.2GB 内存 · 推荐（效果接近 large）' },
  { id: 'large-v3', file: 'ggml-large-v3.bin', sizeMb: 3094, memoryHint: '约 5GB 内存 · 效果最好' },
] as const;

/** whisper 模型镜像源（走查 R6）：官方 HuggingFace + 国内 hf-mirror。 */
export const WHISPER_MIRRORS = [
  { id: 'official', label: '官方源（HuggingFace）', base: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main' },
  { id: 'cn', label: '国内镜像（hf-mirror.com）', base: 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main' },
] as const;

export const WizardStepSchema = z.object({
  id: IdSchema,
  kind: WizardKindSchema,
  title: z.string(),
  /** command 步骤的安装命令；download 步骤为 null。 */
  command: z.string().nullable(),
  /** download 步骤的来源链接；command 步骤为 null。 */
  url: z.string().nullable(),
  target_dir: z.string(),
  status: WizardStatusSchema,
  /** summary 内嵌实时预览：命令=最后一行日志，下载=进度行。 */
  last_log: z.string().nullable(),
  updated_at: IsoDateTimeSchema,
});
export type WizardStep = z.infer<typeof WizardStepSchema>;

export const WizardStepsOutputSchema = z.object({ steps: z.array(WizardStepSchema) });
export type WizardStepsOutput = z.infer<typeof WizardStepsOutputSchema>;

export const WizardRunInputSchema = z.object({
  id: IdSchema,
  /** 强制执行：嗅探跳过与「已完成」都重跑。 */
  force: z.boolean().default(false),
  /** download 参数化（whisper-model）：模型型号（WHISPER_MODEL_CATALOG.id），缺省保持行上既有。 */
  model: z.string().optional(),
  /** download 参数化（whisper-model）：镜像源，缺省保持行上既有。 */
  mirror: z.enum(['official', 'cn']).optional(),
});
export type WizardRunInput = z.infer<typeof WizardRunInputSchema>;

export const CreateAdminInputSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(6).max(128),
});
export type CreateAdminInput = z.infer<typeof CreateAdminInputSchema>;

/** 建管理员成功即视为配置完成，直接签发管理员 JWT。 */
export const CreateAdminOutputSchema = TokenOutputSchema;
export type CreateAdminOutput = z.infer<typeof CreateAdminOutputSchema>;

export const SetupCompleteOutputSchema = z.object({ ok: z.literal(true) });
export type SetupCompleteOutput = z.infer<typeof SetupCompleteOutputSchema>;
