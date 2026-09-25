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

/** 安装进度快照（走查 BUG2，2026-09-23）：bootstrap 随站点态下发，SPA 刷新后由此
 * 恢复安装向导所在步骤，无需新增端点。 */
export const SetupProgressSchema = z.object({
  /** 存在非匿名用户（管理员已建）。 */
  admin_created: z.boolean(),
  /** wizard_steps 中 status='done' 的条数。 */
  steps_done: z.number().int(),
  /** wizard_steps 总条数。 */
  steps_total: z.number().int(),
  /** 模型路由已配置（resolveModelRouteInfo 非 null）。 */
  model_configured: z.boolean(),
});
export type SetupProgress = z.infer<typeof SetupProgressSchema>;

export const BootstrapOutputSchema = z.object({
  needs_setup: z.boolean(),
  allow_anonymous: z.boolean(),
  site_name: z.string(),
  model_route: ModelRouteInfoSchema.nullable(),
  setup_progress: SetupProgressSchema,
  /** 走查 2026-09-24：完成标记（settings.setup_completed）——完成后 /setup 属残废
   * 向导（步 2 无凭证必败），SPA 反向弹登录。注意 needs_setup 在建管理员后即翻
   * false，不能作此判定。 */
  setup_completed: z.boolean(),
});
export type BootstrapOutput = z.infer<typeof BootstrapOutputSchema>;

/**
 * whisper 转写模型目录（走查四轮，2026-09-25）：管线真消费方是转录引擎
 * （audio.transcribe → HF 仓库，落 HF 标准缓存 ~/.cache/huggingface/hub，
 * 与 transformers 等生态共享）。此前向导下载的 whisper.cpp ggml 文件无任何
 * 消费方，已退役。体积为 fp16 权重近似值。
 *
 * W9（2026-09-27）平台最优引擎：repo 字段是 darwin/arm64（mlx-whisper）一族；
 * win/linux（faster-whisper / CTranslate2）经 WHISPER_FASTER_REPO_MAP 映射到
 * Systran/faster-whisper-* 同档位仓库，型号档位 id 两平台共用。
 */
export const WHISPER_MODEL_CATALOG = [
  { id: 'whisper-tiny', repo: 'mlx-community/whisper-tiny', sizeMb: 65, memoryHint: '约 0.3GB 内存 · 最快' },
  { id: 'whisper-base', repo: 'mlx-community/whisper-base', sizeMb: 142, memoryHint: '约 0.5GB 内存 · 基线' },
  { id: 'whisper-small', repo: 'mlx-community/whisper-small', sizeMb: 466, memoryHint: '约 1GB 内存' },
  { id: 'whisper-large-v3-turbo', repo: 'mlx-community/whisper-large-v3-turbo', sizeMb: 1620, memoryHint: '约 2.4GB 内存 · 默认推荐' },
  { id: 'whisper-large-v3-2023', repo: 'mlx-community/whisper-large-v3-2023', sizeMb: 3090, memoryHint: '约 4.5GB 内存 · 效果最好' },
] as const;

/** faster-whisper（win/linux）档位 → 仓库。CTranslate2 权重与 mlx 档位一一对应；
 * large-v3-2023 在 Systran 侧的仓库名无年份后缀（即初版 large-v3）。
 * turbo 换 deepdml 镜像（2026-09-25 Windows 实证）：Systran 原仓库转 gated，
 * 匿名 401「Invalid username or password」且 hf-mirror 全路径 308 回源不再
 * 镜像；deepdml/faster-whisper-large-v3-turbo-ct2 为同权重 CT2 直转
 * （gated:false，hf-mirror 可下，实测转录质量与 mlx turbo 档对齐）。 */
export const WHISPER_FASTER_REPO_MAP: Readonly<Record<string, string>> = {
  'whisper-tiny': 'Systran/faster-whisper-tiny',
  'whisper-base': 'Systran/faster-whisper-base',
  'whisper-small': 'Systran/faster-whisper-small',
  'whisper-large-v3-turbo': 'deepdml/faster-whisper-large-v3-turbo-ct2',
  'whisper-large-v3-2023': 'Systran/faster-whisper-large-v3',
};

/** 型号 id → 引擎族仓库全名；未知型号返回 undefined（调用方报可选列表）。 */
export function whisperRepoFor(modelId: string, engine: 'mlx' | 'faster'): string | undefined {
  return engine === 'mlx'
    ? WHISPER_MODEL_CATALOG.find((m) => m.id === modelId)?.repo
    : WHISPER_FASTER_REPO_MAP[modelId];
}

/** 仓库全名 → 型号 id（mlx/faster 两族都认；识别不出 null）。 */
export function whisperModelIdFromRepo(repo: string): string | null {
  const mlx = WHISPER_MODEL_CATALOG.find((m) => m.repo === repo)?.id;
  if (mlx) return mlx;
  return Object.keys(WHISPER_FASTER_REPO_MAP).find((k) => WHISPER_FASTER_REPO_MAP[k] === repo) ?? null;
}

/** whisper 镜像源（走查四轮）：base = HF_ENDPOINT 值，亦是模型页 URL 前缀
 * （HF_ENDPOINT 是 huggingface_hub 官方文档的镜像机制）。 */
export const WHISPER_MIRRORS = [
  { id: 'official', label: '官方源（HuggingFace）', base: 'https://huggingface.co' },
  { id: 'cn', label: '国内镜像（hf-mirror.com）', base: 'https://hf-mirror.com' },
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
  /** 全量执行日志（走查 BUG1，2026-09-23）：逐行追加、64KB 截断；下载进度行
   * 原位替换（同一下载会话只留最新进度），命令输出与终态行永久保留。 */
  last_log: z.string().nullable(),
  updated_at: IsoDateTimeSchema,
  /** 走查 2026-09-24 · 三轮：download 步骤存在 .download 残差（取消/中断遗留）；
   * UI 据此显示「恢复下载」（无残差=「开始下载」）。command 恒 false。 */
  resumable: z.boolean(),
});
export type WizardStep = z.infer<typeof WizardStepSchema>;

export const WizardStepsOutputSchema = z.object({ steps: z.array(WizardStepSchema) });
export type WizardStepsOutput = z.infer<typeof WizardStepsOutputSchema>;

export const WizardRunInputSchema = z.object({
  id: IdSchema,
  /** 强制执行：嗅探跳过与「已完成」都重跑；download 步骤强制=覆盖下载
   * （丢弃 .download 残差从头下载，走查 2026-09-24 · 三轮）。 */
  force: z.boolean().default(false),
  /** download 参数化（whisper-model）：模型型号（WHISPER_MODEL_CATALOG.id → 当前引擎族仓库），缺省保持行上既有。 */
  model: z.string().optional(),
  /** download 参数化（whisper-model）：镜像源，缺省保持行上既有。 */
  mirror: z.enum(['official', 'cn']).optional(),
});
export type WizardRunInput = z.infer<typeof WizardRunInputSchema>;

/** 取消运行中的向导步骤（走查 2026-09-24）：命令组杀/下载 abort，状态回 pending。 */
export const WizardCancelInputSchema = z.object({ id: IdSchema });
export type WizardCancelInput = z.infer<typeof WizardCancelInputSchema>;

export const CreateAdminInputSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(6).max(128),
  /** 匿名访问开关（走查 BUG6，Owner 2026-09-23 安全默认）：缺省=关闭。
   * 建管理员时写入 settings.allow_anonymous；安装向导 UI 提供显式开关。 */
  allow_anonymous: z.boolean().optional(),
});
export type CreateAdminInput = z.infer<typeof CreateAdminInputSchema>;

/** 建管理员成功即视为配置完成，直接签发管理员 JWT。 */
export const CreateAdminOutputSchema = TokenOutputSchema;
export type CreateAdminOutput = z.infer<typeof CreateAdminOutputSchema>;

export const SetupCompleteOutputSchema = z.object({ ok: z.literal(true) });
export type SetupCompleteOutput = z.infer<typeof SetupCompleteOutputSchema>;
