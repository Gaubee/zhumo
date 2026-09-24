/**
 * 前台输入框目录契约（2026-09-25 前台对齐 · 二轮修正：对齐 DSH 内核官方行为）：
 * `/` 面板 = 内核命令注册表（ctx.commands.list，插件系统注册——compact/feedback/
 * goal 等，非硬编码）；`$` 面板 = 内核技能注册表（ctx.skills.list，user-invocable
 * 过滤；技能引导 agent 经 MCP/CLI 查知识库——知识库条目不进面板）。
 * `@` 面板已按 Owner 裁决撤除（2026-09-25：DSH 无此面板语义——保留的触发面
 * 只保留 DSH 官方两种：命令 / 与技能 $）。
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

