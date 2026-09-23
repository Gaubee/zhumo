/**
 * 资源管理器契约（PRODUCT_DESIGN.md §2 /admin/resources + §4 /api/res/** + §5 resources 表）。
 * 原始需求 2026-09-23（W5）：树/建目/改名/移动/删除/上传六端点的线格式。
 * 正交意图：
 *   [1] 资源节点视图（复用 tasks.ts 的 ResourceItemSchema；meta 为 .shufa 徽标投影）。
 *   [2] res.tree：owner（username，admin 专用）+ parent 游标 → 根 + 面包屑路径 + 单层子项。
 *   [3] 变更端点：mkdir / rename / move / delete（级联计数 + blob 释放计数）。
 *   [4] res.upload：base64 直传入库（去重标记；上限 256MB 由 daemon 校验）。
 */
import { z } from 'zod';
import { IdSchema } from '../common.js';
import { ResourceItemSchema } from './tasks.js';

export type { ResourceItem } from './tasks.js';

/** 资源名标量：禁路径分隔符与点项（'.''..'），防穿越；入库前后两端共用。 */
export const ResourceNameSchema = z
  .string()
  .trim()
  .min(1, '名称不能为空')
  .max(255, '名称最长 255 字符')
  .refine((name) => !name.includes('/') && !name.includes('\\') && !name.includes('\0'), {
    message: '名称不能包含路径分隔符',
  })
  .refine((name) => name !== '.' && name !== '..', { message: '名称不能为 . 或 ..' });
export type ResourceName = z.infer<typeof ResourceNameSchema>;

/** 资源属主视图（res.tree owner 解析结果；admin 可指定任意 username）。 */
export const ResOwnerSchema = z.object({ id: IdSchema, username: z.string() });
export type ResOwner = z.infer<typeof ResOwnerSchema>;

// ---------------------------------------------------------------- res.tree

export const ResTreeInputSchema = z.object({
  /** 目标用户 username（缺省 = 当前登录用户；非 admin 传他人 → 403）。 */
  owner: z.string().min(1).optional(),
  /** 目录资源 id（缺省 = 该用户根文件夹）。 */
  parent: IdSchema.optional(),
});
export type ResTreeInput = z.infer<typeof ResTreeInputSchema>;

/** 根 + 根到 parent 的面包屑链（含根含 parent）+ parent 的单层子项（文件夹优先、名称排序）。 */
export const ResTreeOutputSchema = z.object({
  owner: ResOwnerSchema,
  root: ResourceItemSchema,
  path: z.array(ResourceItemSchema),
  items: z.array(ResourceItemSchema),
});
export type ResTreeOutput = z.infer<typeof ResTreeOutputSchema>;

// ---------------------------------------------------------------- 变更端点

export const ResMkdirInputSchema = z.object({ parent: IdSchema, name: ResourceNameSchema });
export type ResMkdirInput = z.infer<typeof ResMkdirInputSchema>;

export const ResRenameInputSchema = z.object({ id: IdSchema, name: ResourceNameSchema });
export type ResRenameInput = z.infer<typeof ResRenameInputSchema>;

export const ResMoveInputSchema = z.object({ id: IdSchema, new_parent: IdSchema });
export type ResMoveInput = z.infer<typeof ResMoveInputSchema>;

export const ResDeleteInputSchema = z.object({ id: IdSchema });
export type ResDeleteInput = z.infer<typeof ResDeleteInputSchema>;
/** deleted=移除资源行数；blobs_released=引用减一后归零回收的 blob 实体数。 */
export const ResDeleteOutputSchema = z.object({ deleted: z.number().int().min(0), blobs_released: z.number().int().min(0) });
export type ResDeleteOutput = z.infer<typeof ResDeleteOutputSchema>;

export const ResUploadInputSchema = z.object({
  parent: IdSchema,
  filename: z.string().min(1),
  /** 文件字节 base64（oRPC-over-WS JSON 传输；上限 256MB 与 W4 视频直传一致）。 */
  b64: z.string().min(1),
});
export type ResUploadInput = z.infer<typeof ResUploadInputSchema>;

export const ResUploadOutputSchema = z.object({
  item: ResourceItemSchema,
  /** 内容命中已有 blob（存储去重，未重复写盘）。 */
  deduped: z.boolean(),
});
export type ResUploadOutput = z.infer<typeof ResUploadOutputSchema>;

/** 单资源变更统一出参形状。 */
export const ResItemOutputSchema = z.object({ item: ResourceItemSchema });
export type ResItemOutput = z.infer<typeof ResItemOutputSchema>;
