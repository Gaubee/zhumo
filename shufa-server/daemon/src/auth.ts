/**
 * 认证域：scrypt 口令哈希 + JWT(HS256) + 内置匿名账号（PRODUCT_DESIGN.md §4/§2）。
 * 原始需求 2026-09-23（W2'）：JWT 载荷 {sub, role, exp}；匿名=内置账号
 * `__anonymous__` 自动签发；开关关闭时匿名登录 403。
 * 正交意图：
 *   [1] scrypt 口令哈希（`scrypt$salt$hash` 格式，timingSafeEqual 校验）。
 *   [2] JWT 签发与校验（jose HS256，7 天过期）。
 *   [3] 匿名账号保障与匿名开关（settings.allow_anonymous；走查 BUG6 默认关）。
 *   [4] token → 用户视图鉴权（禁用用户也放行，BUG5 语义：禁写不禁读），供 rpc 消费。
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@zhumo/contracts';
import type { SqliteDb } from './db/database.js';
import { getUserByUsername, getUserById, putSetting, createUser, type UserRow } from './db/store.js';
import { ANONYMOUS_USERNAME } from '@zhumo/contracts';

const SCRYPT_KEYLEN = 32;
const JWT_TTL_SECONDS = 7 * 24 * 3600;
export const SETTING_ALLOW_ANONYMOUS = 'allow_anonymous';

// ---------------------------------------------------------------- scrypt

/** 哈希格式 `scrypt$<salt hex>$<hash hex>`（N=16384, r=8, p=1）。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1] ?? '', 'hex');
  const expected = Buffer.from(parts[2] ?? '', 'hex');
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- jwt

export interface TokenClaims {
  sub: string;
  role: Role;
}

/** 签发 HS256 JWT；返回 token 与过期时刻（epoch ms）。 */
export async function signJwt(
  secret: string,
  claims: TokenClaims,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + JWT_TTL_SECONDS * 1000;
  const key = new TextEncoder().encode(secret);
  const token = await new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(key);
  return { token, expiresAt };
}

/** 校验失败（签名/过期/形状）返回 null，不抛异常。 */
export async function verifyJwt(secret: string, token: string): Promise<TokenClaims | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    const sub = payload.sub;
    const role = payload['role'];
    if (typeof sub !== 'string' || typeof role !== 'string') return null;
    if (role !== 'admin' && role !== 'user' && role !== 'anonymous') return null;
    return { sub, role };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- anonymous

export function isAllowAnonymous(db: SqliteDb): boolean {
  // 走查 BUG6（Owner 2026-09-23 安全默认决策）：匿名开关默认**关闭**——settings
  // 无该键或值为 '0' 均视为关，仅显式写入 '1'（安装向导勾选 / 后台开关）才开启。
  // 原语义「缺省开」已废弃：全新安装不再默认暴露匿名入口。
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_ALLOW_ANONYMOUS) as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

export function setAllowAnonymous(db: SqliteDb, allowed: boolean): void {
  putSetting(db, SETTING_ALLOW_ANONYMOUS, allowed ? '1' : '0');
}

/** 内置匿名账号不存在则创建（幂等；被改名/删除后自愈）。 */
export function ensureAnonymousUser(db: SqliteDb): UserRow {
  const existing = getUserByUsername(db, ANONYMOUS_USERNAME);
  if (existing) return existing;
  return createUser(db, {
    username: ANONYMOUS_USERNAME,
    passwordHash: hashPassword(randomBytes(24).toString('hex')),
    role: 'anonymous',
  });
}

// ---------------------------------------------------------------- 鉴权入口

/**
 * token → 有效用户行；签名无效、用户缺失一律 null。
 * 走查 BUG5（2026-09-23）禁用语义重定义：禁用 = 禁写不禁登录不禁读——被禁用
 * 用户持有的 token 仍可认证（读任务列表/详情/已公开结果），写操作由 rpc 层
 * requireActiveUser 中间件拦截，认证面不再因 disabled 拒绝。
 */
export async function authenticate(
  secret: string,
  db: SqliteDb,
  token: string | null | undefined,
): Promise<UserRow | null> {
  if (!token) return null;
  const claims = await verifyJwt(secret, token);
  if (!claims) return null;
  const user = getUserById(db, claims.sub);
  if (!user) return null;
  return user;
}
