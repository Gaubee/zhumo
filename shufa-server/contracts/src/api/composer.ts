/**
 * 前台输入框目录契约（2026-09-25 前台对齐 · 二轮修正：对齐 DSH 内核官方行为）：
 * `/` 面板 = 内核命令注册表（ctx.commands.list，插件系统注册——compact/feedback/
 * goal 等，非硬编码）；`$` 面板 = 内核技能注册表（ctx.skills.list，user-invocable
 * 过滤；技能引导 agent 经 MCP/CLI 查知识库——知识库条目不进面板）。
 */
import { z } from 'zod';

/** 内核命令描述（CommandDescriptor 投影：name 不含斜杠）。 */
export const ComposerCommandSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
});
export type ComposerCommand = z.infer<typeof ComposerCommandSchema>;

/** 内核技能摘要（SkillSummary 投影：user-invocable 才下发）。 */
export const ComposerSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  when_to_use: z.string().optional(),
});
export type ComposerSkill = z.infer<typeof ComposerSkillSchema>;

/** composer.list 出参（内核未挂载/探针失败 = 空表，前端空态）。 */
export const ComposerListOutputSchema = z.object({
  commands: z.array(ComposerCommandSchema),
  skills: z.array(ComposerSkillSchema),
});
export type ComposerListOutput = z.infer<typeof ComposerListOutputSchema>;

// ---------------------------------------------------------------- composer.files（@ 面板，DSH ctx.fs 标准）

/** 目录浏览入参：dir 相对用户根的路径段（'.' 段与空串 = 用户根）。 */
export const ComposerFilesInputSchema = z.object({
  dir: z
    .string()
    .trim()
    .max(512)
    .optional()
    .refine((value) => value === undefined || !value.startsWith('/') && !value.includes('..'), {
      message: 'dir 必须是相对用户根的安全路径段',
    }),
});
export type ComposerFilesInput = z.infer<typeof ComposerFilesInputSchema>;

/** 目录条目（dsh-fs FsDirEntry 投影：kind 三值语义保留）。 */
export const ComposerFileEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['dir', 'file', 'other']),
  size: z.number().int().nonnegative().optional(),
});
export type ComposerFileEntry = z.infer<typeof ComposerFileEntrySchema>;

export const ComposerFilesOutputSchema = z.object({
  /** canonical 绝对路径（agent 可读；capability 钉在用户根内）。 */
  dir: z.string().min(1),
  entries: z.array(ComposerFileEntrySchema),
});
export type ComposerFilesOutput = z.infer<typeof ComposerFilesOutputSchema>;
