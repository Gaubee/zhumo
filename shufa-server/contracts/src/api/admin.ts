/**
 * 后台管理契约（PRODUCT_DESIGN.md §4 admin 路由、§2 后台三页）。
 * 原始需求 2026-09-23。全部端点仅 admin 角色。
 * 正交意图：
 *   [1] 用户 CRUD（不开放注册；匿名开关经 settings 承载）。
 *   [2] 运行时设置 GET/PUT（站点名 / 站点域名 / 匿名开关三类键，白名单收口）。
 *   [3] 管理员改密（需原密码）。
 *   [4] 准备步骤重跑（复用 §1 手风琴同一套步骤视图与执行语义）。
 */
import { z } from 'zod';
import { IdSchema, RoleSchema } from '../common.js';
import { UserInfoSchema } from './auth.js';
import {
  WizardRunInputSchema,
  WizardStepSchema,
  WizardStepsOutputSchema,
} from './setup.js';

export { WizardRunInputSchema, WizardStepsOutputSchema };
export type { WizardStep } from './setup.js';

export const UserListOutputSchema = z.object({ users: z.array(UserInfoSchema) });
export type UserListOutput = z.infer<typeof UserListOutputSchema>;

export const CreateUserInputSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(6).max(128),
  role: RoleSchema.exclude(['anonymous']),
});
export type CreateUserInput = z.infer<typeof CreateUserInputSchema>;

export const UpdateUserInputSchema = z.object({
  id: IdSchema,
  password: z.string().min(6).max(128).optional(),
  disabled: z.boolean().optional(),
  role: RoleSchema.exclude(['anonymous']).optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInputSchema>;

/** 删除用户（走查 BUG5，2026-09-23）：数据级联清理——users/tasks/results/resources
 * 行 + 磁盘 users/<username>/ 目录 + blob 引用计数递减。__anonymous__ 与当前登录
 * 管理员自己不可删（服务端 409）。 */
export const DeleteUserInputSchema = z.object({ id: IdSchema });
export type DeleteUserInput = z.infer<typeof DeleteUserInputSchema>;
export const DeleteUserOutputSchema = z.object({ ok: z.boolean() });
export type DeleteUserOutput = z.infer<typeof DeleteUserOutputSchema>;

/** 模型预设（走查 BUG4，2026-09-23）：一条 = 一个 provider 的开箱配置。
 * baseURL=服务端点；api=协议类型（如 openai-completions，models.dev 来源暂缺省）。 */
export const ModelPresetSchema = z.object({
  provider: z.string(),
  name: z.string(),
  baseURL: z.string().optional(),
  api: z.string().optional(),
  models: z.array(z.object({ id: z.string(), name: z.string().optional() })),
  source: z.enum(['builtin', 'models.dev']),
});
export type ModelPreset = z.infer<typeof ModelPresetSchema>;

/** 预设目录：builtin（pi-ai 内嵌数据）恒在；models.dev 缓存有则追加。
 * fetched_at=缓存刷新时间（ISO），从未刷新为 null。 */
export const ModelCatalogOutputSchema = z.object({
  presets: z.array(ModelPresetSchema),
  fetched_at: z.string().nullable(),
});
export type ModelCatalogOutput = z.infer<typeof ModelCatalogOutputSchema>;

/** 运行时设置键白名单（settings 表其余键属内部状态，不对 API 开放）。
 * W7 联调补：llm_* 四键为模型路由写入面（resolveModelRouteFromStore 第一信源）；
 * 偏差记录：§1 原定 Models 配置落 .env，联调期改为 settings 表承载（.env 仍作回退）。 */
export const SETTING_KEYS = [
  'site_name',
  'site_base_url',
  'allow_anonymous',
  'llm_provider',
  'llm_base_url',
  'llm_api_key',
  'llm_api',
  'llm_model',
] as const;
export const SettingKeySchema = z.enum(SETTING_KEYS);
export type SettingKey = (typeof SETTING_KEYS)[number];

export const SettingEntrySchema = z.object({ key: z.string(), value: z.string() });
export type SettingEntry = z.infer<typeof SettingEntrySchema>;

export const SettingGetInputSchema = z.object({ key: SettingKeySchema });
export const SettingGetOutputSchema = SettingEntrySchema;

export const SettingPutInputSchema = z.object({
  key: SettingKeySchema,
  /** 字符串承载：allow_anonymous 用 '1'/'0'。 */
  value: z.string(),
});
export const SettingPutOutputSchema = SettingEntrySchema;

export const SettingListOutputSchema = z.object({ settings: z.array(SettingEntrySchema) });
export type SettingListOutput = z.infer<typeof SettingListOutputSchema>;

/** 局域网访问链接（走查 BUG3，2026-09-23）：各网卡 IPv4 + mDNS 主机名（macOS/Windows 通用）。 */
export const LanUrlsOutputSchema = z.object({ urls: z.array(z.string()) });
export type LanUrlsOutput = z.infer<typeof LanUrlsOutputSchema>;

export const ChangePasswordInputSchema = z.object({
  old_password: z.string().min(1),
  new_password: z.string().min(6).max(128),
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;

export const ChangePasswordOutputSchema = z.object({ ok: z.literal(true) });

export const AdminWizardStepOutputSchema = WizardStepSchema;
