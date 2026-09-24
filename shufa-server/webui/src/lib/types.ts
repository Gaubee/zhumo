/**
 * 领域契约类型（W3 类型先行；与 daemon W2'/W4/W5 已落地的 oRPC 契约同形）。
 * 原始需求 [2026-09-23]：朱墨 W3 webui——mock 数据层 + 类型先行，联调期切真 API。
 * 正交意图：
 *   [1] bootstrap / 认证会话契约（PRODUCT_DESIGN §4 API 权限矩阵）。
 *   [2] 安装向导准备步骤契约（PRODUCT_DESIGN §1：command|download 两类）。
 *   [3] 模型路由契约（DshModelRoute，移植自 skill-creator-v2
 *       src/shared/contracts/dsh-runtime.ts，剔除 zod 依赖保持纯类型）。
 *   [4] 用户 / 资源 / 任务 / 结果契约（PRODUCT_DESIGN §2/§3/§5；资源段镜像
 *       contracts/src/api/resources.ts 的 W5 六端点形状）。
 *   [5] 统一帧契约（PRODUCT_DESIGN §7：Frame{at,seq,kind,...}）。
 */
import type { WHISPER_MIRRORS, WHISPER_MODEL_CATALOG } from "@zhumo/contracts";

// ---- [1] bootstrap / 认证 ----

/** 生效模型路由（走查 BUG2 前端，2026-09-23；契约 ModelRouteInfoSchema 投影）。
 * source：settings=后台 Models 配置；env=.env LLM_* 引导值；null=未配置（前台阻断创建）。 */
export interface ModelRouteInfo {
  provider: string;
  model: string;
  source: "settings" | "env";
}

/**
 * 安装向导进度（BUG2 有状态向导，2026-09-24）。
 * 【本地镜像】契约 BootstrapOutput.setup_progress 由 daemon 代理并行落地中，
 * contracts 暂缺该字段——先行在此镜像形状并注明；daemon 落地后可改为直接 import。
 * admin_created=管理员已建；steps_done/steps_total=准备步骤完成度；
 * model_configured=大模型服务已配置。
 */
export interface SetupProgress {
  admin_created: boolean;
  steps_done: number;
  steps_total: number;
  model_configured: boolean;
}

/** GET /api/bootstrap（公开）：安装门控与站点信息。 */
export interface BootstrapInfo {
  needsSetup: boolean;
  allowAnonymous: boolean;
  siteName: string;
  /** 生效模型路由；null/缺省（daemon 旧实现未带字段时归一）＝未配置。 */
  modelRoute: ModelRouteInfo | null;
  /** 安装向导进度（BUG2）；旧 daemon 未带字段时归一 null（向导退化为自由步进）。 */
  setupProgress: SetupProgress | null;
  /** 安装已完成标记（走查 2026-09-24）；旧 daemon 未带字段时归一 false。 */
  setupCompleted: boolean;
}

export type UserRole = "admin" | "user" | "anonymous";

/** 当前会话（JWT 载荷投影）。 */
export interface SessionInfo {
  userId: string;
  username: string;
  role: UserRole;
  /** BUG5：禁用用户可登录可读、禁止新建任务（daemon 拦截；前端据此禁用创建入口）。 */
  disabled: boolean;
}

// ---- [2] 安装向导准备步骤 ----

/** whisper 模型目录条目类型（常量真源在契约侧 WHISPER_MODEL_CATALOG，此处仅派生类型）。 */
export type WhisperModelOption = (typeof WHISPER_MODEL_CATALOG)[number];

/** whisper 镜像源 id（official | cn）。 */
export type WhisperMirrorId = (typeof WHISPER_MIRRORS)[number]["id"];

/** 运行向导步骤的可选参数（whisper-model 步骤携带；契约 WizardRunInput 的 model/mirror 投影）。 */
export interface WizardRunParams {
  model?: string;
  mirror?: WhisperMirrorId;
}

export type WizardStepKind = "command" | "download";

export type WizardStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** 准备步骤（wizard_steps 表投影；summary 实时预览依赖 lastLog/progress）。 */
export interface WizardStep {
  id: string;
  kind: WizardStepKind;
  title: string;
  /** kind=command 时的嗅探/执行命令。 */
  command?: string;
  /** kind=download 的来源链接。 */
  url?: string;
  targetDir: string;
  status: WizardStepStatus;
  /** 命令类：尾行即 summary 实时预览（last-line-log）。 */
  lastLog: string;
  /** 下载类：0-100 进度条。 */
  progress: number;
  /** 下载类进度文案（BUG1）：形如「12.3MB / 148.0MB（8%）」；终态保留不清空。 */
  progressText?: string;
  /** 嗅探结果：命令已安装 / 文件已存在（默认跳过）。 */
  detected: boolean;
  /** download 步骤存在 .download 残差 → 按钮「恢复下载」（否则「开始下载」）。 */
  resumable: boolean;
  updatedAt: string;
}

// ---- [3] 模型路由（五轮多路由；契约 api/models.ts 的本地镜像） ----

export type RouteApi = "anthropic-messages" | "openai-completions" | "openai-responses";
export type ModelInputType = "text" | "image";

/** 路由内单模型条目。 */
export interface RouteModel {
  id: string;
  /** 展示名：缺省由 id 派生（readableModelName）。 */
  name?: string;
  /** 上下文窗口（token；UI 以 128k/0.5M 简写交互）。 */
  contextWindow?: number;
  maxOutputTokens?: number;
  /** 可用 reasoning effort 档。 */
  efforts?: string[];
  /** 输入模态（五轮）：text 恒支持；image = 视觉输入。 */
  inputTypes?: ModelInputType[];
  outputTypes?: string[];
}

/** 模型路由（密钥不在输出面——hasKey 布尔；保存时空 apiKey=保留旧值）。 */
export interface DshModelRoute {
  provider: string;
  api: RouteApi;
  baseURL: string;
  /** models.dev 图标 URL（缺失回退字母头像）。 */
  iconUrl?: string;
  hasKey?: boolean;
  /** 仅保存面：非空=更新密钥；空/缺省=保留。 */
  apiKey?: string;
  models: RouteModel[];
}

/** Models 配置（五轮）：路由集合 + 默认模型（活动模型按任务由前台选择）。 */
export interface ModelsSettings {
  routes: DshModelRoute[];
  default: { provider: string; model: string } | null;
}

/** 连接测试结果（ok 判别联合）。 */
export type ModelsTestResult = { ok: true; latencyMs: number } | { ok: false; detail: string };

/** 可用模型（前台任务对话框活动模型选择面）。 */
export interface AvailableModel {
  provider: string;
  model: string;
  name: string;
  contextWindow?: number;
  inputTypes?: ModelInputType[];
  iconUrl?: string;
}

// ---- [3'] 模型预设目录（BUG4，2026-09-24） ----
// 【本地镜像】契约 admin.models.catalog 出参由 daemon 代理并行落地中，先行镜像并注明。

/**
 * 预设路由条目（2026-09-25 对齐 ZCode Registry）：source=zcode 策展主体（coding
 * plan 双端点+档位）| models.dev 手动刷新的广度补充。pi-ai 内置长尾已退出目录。
 */
export interface ModelsCatalogPreset {
  provider: string;
  name: string;
  baseURL?: string;
  api?: string;
  iconUrl?: string;
  models: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    inputTypes?: ModelInputType[];
    efforts?: string[];
  }>;
  source: "zcode" | "models.dev";
}

/** admin.models.catalog / catalogRefresh 出参；fetched_at=null 表示从未拉取过 models.dev。 */
export interface ModelsCatalog {
  presets: ModelsCatalogPreset[];
  fetched_at: string | null;
}

// ---- [4] 用户 / 资源 / 任务 / 结果 ----

export interface UserInfo {
  id: string;
  username: string;
  role: UserRole;
  disabled: boolean;
  createdAt: string;
}

/** 后台运行时设置（settings 表投影）。 */
export interface AdminSettings {
  siteBaseUrl: string;
  allowAnonymous: boolean;
}

/** 资源条目（镜像 contracts ResourceItemSchema；meta 为 .shufa 徽标投影）。 */
export interface ResourceBadge {
  task_id: string;
  task_status: TaskStatus | null;
  agent_session_id: string | null;
  result_id: string | null;
}

export interface ResourceItem {
  id: string;
  parent_id: string | null;
  name: string;
  is_dir: boolean;
  size: number;
  meta: ResourceBadge | null;
  created_at: string;
  updated_at: string;
}

/** res.tree 的 owner 视图（admin 可指定任意用户）。 */
export interface ResOwner {
  id: string;
  username: string;
}

/** res.tree 出参：根 + 根到当前目录的面包屑链 + 当前层子项。 */
export interface ResTreeOutput {
  owner: ResOwner;
  root: ResourceItem;
  path: ResourceItem[];
  items: ResourceItem[];
}

/** res.delete 出参：移除资源行数 + 归零回收的 blob 实体数。 */
export interface ResDeleteOutput {
  deleted: number;
  blobs_released: number;
}

/** res.upload 出参：新资源行 + 内容是否命中既有 blob（存储去重）。 */
export interface ResUploadOutput {
  item: ResourceItem;
  deduped: boolean;
}

export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  prompt: string;
  videoName: string;
  /** 素材视频资源 id（null = 未附视频；raw 预览播放用）。 */
  videoResourceId: string | null;
  createdAt: string;
  updatedAt: string;
  /** 任务级模型覆盖（走查 R6：null = 跟随后台默认模型；聊天中可切换）。 */
  modelProvider: string | null;
  modelModel: string | null;
  /** 失败原因明文（走查 R3：failed 必须可见；null = 无）。 */
  error: string | null;
}

/** 任务导出结果引用（一次对话可多次导出；右侧标签页数据源）。 */
export interface TaskResultRefView {
  publicId: string;
  title: string | null;
  createdAt: string;
}

/** 结果页信息（/r/{public_id}，公开）。 */
export interface ResultInfo {
  publicId: string;
  title: string;
  createdAt: string;
}

/** 聊天附件（走查 R7：上传返回——rawUrl 供 <img> 预览，path 注入提示词）。 */
export interface Attachment {
  resourceId: string;
  name: string;
  path: string;
  size: number;
  rawUrl: (width?: number) => string;
}

// ---- [5] 统一帧（PRODUCT_DESIGN §7） ----

/** 帧 kind 值域（走查 R7 对齐 contracts FrameKindSchema 全集——流式 delta/
 *  reasoning/turn-start 等原缺席 kind 是聊天流式感的缺失根源）。 */
export type FrameKind =
  | "user-text"
  | "assistant-delta"
  | "assistant-text"
  | "assistant-reasoning"
  | "assistant-reasoning-delta"
  | "tool-call"
  | "tool-args-delta"
  | "tool-result"
  | "todo-snapshot"
  | "status"
  | "step"
  | "turn-start"
  | "turn-end"
  | "session-title"
  | "approval-request"
  | "approval-resolved"
  | "result";

/** 统一帧：WS 推送 + afterSeq 游标重放的基本单位（at 为 epoch 毫秒）。 */
export interface Frame {
  at: number;
  seq: number;
  kind: FrameKind;
  text?: string;
  toolName?: string;
  payload?: unknown;
}

// ---- 知识库（Owner 2026-09-22：两级结构 分组 → 键值；git 修订历史） ----

export interface KbEntryItem {
  key: string;
  value: string;
}

export interface KbGroupView {
  name: string;
  note: string;
  entries: KbEntryItem[];
}

export interface KbRevisionView {
  id: string;
  at: string;
  actor: string;
  summary: string;
}

export interface KbRevisionDetailView {
  revision: KbRevisionView;
  changes: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
  snapshot: KbGroupView[];
}
