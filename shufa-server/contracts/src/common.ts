/**
 * 契约公共标量与枚举。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §4/§5/§7，W2' 落地）。
 * 正交意图：
 *   [1] 角色值域（§4 JWT role）与任务状态机（§5 tasks.status CHECK）。
 *   [2] 向导步骤 kind/status 值域（§5 wizard_steps；status 值域规格未列出，
 *       此处定义为 pending|running|done|failed，跳过语义用 done+日志承载）。
 *   [3] 通用标量（id、ISO 时间戳）。
 */
import { z } from 'zod';

export const RoleSchema = z.enum(['admin', 'user', 'anonymous']);
export type Role = z.infer<typeof RoleSchema>;

export const TaskStatusSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const WizardKindSchema = z.enum(['command', 'download']);
export type WizardKind = z.infer<typeof WizardKindSchema>;

export const WizardStatusSchema = z.enum(['pending', 'running', 'done', 'failed']);
export type WizardStatus = z.infer<typeof WizardStatusSchema>;

/** 系统内置匿名账号用户名（auth 层约定，契约层声明供两端判断）。 */
export const ANONYMOUS_USERNAME = '__anonymous__';

/** 文本 id：users/resources/tasks/results 用 nanoid/uuid 生成。 */
export const IdSchema = z.string().min(1);
export type Id = z.infer<typeof IdSchema>;

/** ISO 8601 时间戳（UTC，存库与传输统一格式）。 */
export const IsoDateTimeSchema = z.string().min(1);
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
