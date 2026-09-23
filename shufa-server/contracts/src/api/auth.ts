/**
 * 认证与用户视图契约（PRODUCT_DESIGN.md §4 auth/me 路由、§2 匿名开关）。
 * 原始需求 2026-09-23。JWT 载荷 {sub, role, exp}；oRPC-over-WS 通道下
 * token 经 WS upgrade 的 ?token= 查询参数传入（connect 期一次性鉴权）。
 * 正交意图：
 *   [1] 用户视图（脱敏，无 password_hash）。
 *   [2] login / anonymous / refresh / me 四端点的请求响应形状。
 */
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, RoleSchema } from '../common.js';

export const UserInfoSchema = z.object({
  id: IdSchema,
  username: z.string(),
  role: RoleSchema,
  disabled: z.boolean(),
  created_at: IsoDateTimeSchema,
});
export type UserInfo = z.infer<typeof UserInfoSchema>;

export const LoginInputSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

/** 签发结果：token + 过期时刻（epoch ms）+ 用户视图。 */
export const TokenOutputSchema = z.object({
  token: z.string(),
  expires_at: z.number(),
  user: UserInfoSchema,
});
export type TokenOutput = z.infer<typeof TokenOutputSchema>;

/** refresh：不传 token 时复用连接上已携带的 JWT。 */
export const RefreshInputSchema = z.object({
  token: z.string().optional(),
});
export type RefreshInput = z.infer<typeof RefreshInputSchema>;

export const MeOutputSchema = UserInfoSchema;
export type MeOutput = z.infer<typeof MeOutputSchema>;
