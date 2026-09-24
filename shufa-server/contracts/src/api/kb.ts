/**
 * 书法领域知识库契约（Owner 需求 2026-09-22：防过拟合的结构化知识面）。
 * 设计约束（Owner 原话归纳）：
 *   - 两级结构：分组 → 组内 key-value（图书馆模型：组名=书架类别，key=书名）；
 *     不做更深的层级，单条 value 是短文本（LLM 直读，无机器解析格式）。
 *   - 领域知识与「总结模式」沉淀在后台可管理的库里长期演进；SKILL.md 只保留
 *     稳定工作流，不固化任何具体案例——知识库的迭代不要求改代码。
 *   - agent 经 MCP 消费：kb_list 只给「组名+key」（廉价扫描面），命中后 kb_get
 *     取单条内容；写操作只在 admin RPC（agent 侧 readonly）。
 * 正交意图：
 *   [1] agent 读面：KbListOutput（keys-only）/ KbGetInput / KbGetOutput。
 *   [2] admin 管理面：全量读（含 value）+ 分组/条目 upsert/delete（rename 经
 *       newName/newKey 字段表达；外键 ON UPDATE CASCADE 承接改名传播）。
 */
import { z } from 'zod';

/** 分组名/key 的短标识约束（中文可用；空串/纯空白非法）。 */
const KbNameSchema = z.string().trim().min(1).max(64);
const KbKeySchema = z.string().trim().min(1).max(128);

// ---------------------------------------------------------------- agent 读面

/** 组名 + 组内 key 清单（书架类别 + 书名；不含 value）。 */
export const KbListOutputSchema = z.object({
  groups: z.array(
    z.object({
      name: z.string(),
      note: z.string(),
      keys: z.array(z.string()),
    }),
  ),
});
export type KbListOutput = z.infer<typeof KbListOutputSchema>;

export const KbGetInputSchema = z.object({
  group: KbNameSchema,
  key: KbKeySchema,
});
export type KbGetInput = z.infer<typeof KbGetInputSchema>;

export const KbGetOutputSchema = z.object({
  entry: z.object({ group: z.string(), key: z.string(), value: z.string() }),
});
export type KbGetOutput = z.infer<typeof KbGetOutputSchema>;

// ---------------------------------------------------------------- admin 管理面

/** 全量知识库（含 value；后台编辑器数据源）。 */
export const KbAdminListOutputSchema = z.object({
  groups: z.array(
    z.object({
      name: z.string(),
      note: z.string(),
      entries: z.array(z.object({ key: z.string(), value: z.string() })),
    }),
  ),
});
export type KbAdminListOutput = z.infer<typeof KbAdminListOutputSchema>;

/** 分组 upsert：name 已存在=更新 note（可携 newName 改名）；不存在=创建。 */
export const KbGroupSaveInputSchema = z.object({
  name: KbNameSchema,
  note: z.string().max(500).optional(),
  newName: KbNameSchema.optional(),
});
export type KbGroupSaveInput = z.infer<typeof KbGroupSaveInputSchema>;

export const KbGroupDeleteInputSchema = z.object({ name: KbNameSchema });
export type KbGroupDeleteInput = z.infer<typeof KbGroupDeleteInputSchema>;

/** 条目 upsert：value 全量替换（可携 newKey 改名）；group 必须已存在。 */
export const KbEntrySaveInputSchema = z.object({
  group: KbNameSchema,
  key: KbKeySchema,
  value: z.string().min(1).max(20000),
  newKey: KbKeySchema.optional(),
});
export type KbEntrySaveInput = z.infer<typeof KbEntrySaveInputSchema>;

export const KbEntryDeleteInputSchema = z.object({
  group: KbNameSchema,
  key: KbKeySchema,
});
export type KbEntryDeleteInput = z.infer<typeof KbEntryDeleteInputSchema>;

// ---------------------------------------------------------------- 历史（git 修订）

/** 变更来源：后台管理员 / agent 会话 / 系统种子 / 恢复操作。 */
export const KbRevisionSchema = z.object({
  /** git commit 短哈希（历史引擎为 git；见 Owner 2026-09-22「毕竟要用 git」）。 */
  id: z.string(),
  at: z.string(),
  actor: z.string(),
  summary: z.string(),
});
export type KbRevision = z.infer<typeof KbRevisionSchema>;

/** available=false：目标设备缺 git——知识库读写不受影响，历史面提示安装。 */
export const KbRevisionsOutputSchema = z.object({
  available: z.boolean(),
  revisions: z.array(KbRevisionSchema),
});
export type KbRevisionsOutput = z.infer<typeof KbRevisionsOutputSchema>;

export const KbRevisionGetInputSchema = z.object({ id: z.string().regex(/^[0-9a-f]{4,40}$/) });
export type KbRevisionGetInput = z.infer<typeof KbRevisionGetInputSchema>;

/** 修订详情：变更文件清单（A/M/D）+ 该版全量快照（UI 端与当前态比对求差）。 */
export const KbRevisionGetOutputSchema = z.object({
  revision: KbRevisionSchema,
  changes: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['added', 'modified', 'deleted']),
    }),
  ),
  snapshot: z.array(
    z.object({
      name: z.string(),
      note: z.string(),
      entries: z.array(z.object({ key: z.string(), value: z.string() })),
    }),
  ),
});
export type KbRevisionGetOutput = z.infer<typeof KbRevisionGetOutputSchema>;

/** 恢复到指定修订（生成新修订，不丢弃历史）。 */
export const KbRestoreInputSchema = z.object({ id: z.string().regex(/^[0-9a-f]{4,40}$/) });
export type KbRestoreInput = z.infer<typeof KbRestoreInputSchema>;
export const KbRestoreOutputSchema = z.object({ ok: z.boolean() });
export type KbRestoreOutput = z.infer<typeof KbRestoreOutputSchema>;
