/**
 * oRPC-over-WebSocket 路由表（PRODUCT_DESIGN.md §4 API 矩阵）。
 * 原始需求 2026-09-23（W2' 地基 / W4 tasks 实装 / W5 res 实装）：bootstrap/setup/auth/me
 * /admin 全量端点；tasks 四端点接 TaskService（创建含视频直传、详情含帧回放）；
 * res 六端点接 ResourceService（树/建目/改名/移动/删除/上传，认证 + 仅本人资源，
 * admin 可带 owner 参数）。token 经 WS upgrade ?token= 查询参数进入 context。
 * 正交意图：
 *   [1] context 与守卫中间件（requireAuth / requireAdmin / setupGated）。
 *   [2] 公开与认证端点：bootstrap、setup 全族、auth 全族、me。
 *   [3] admin 端点：用户 CRUD、settings、改密、向导重跑。
 *   [4] tasks 四端点与 res 六端点（服务未装配时 501）。
 */
import { ORPCError, os } from '@orpc/server';
import {
  ChangePasswordInputSchema,
  CreateAdminInputSchema,
  CreateUserInputSchema,
  LoginInputSchema,
  RefreshInputSchema,
  ResDeleteInputSchema,
  ResMkdirInputSchema,
  ResMoveInputSchema,
  ResRenameInputSchema,
  ResTreeInputSchema,
  ResUploadInputSchema,
  SettingGetInputSchema,
  SettingPutInputSchema,
  TaskCancelInputSchema,
  TaskCreateInputSchema,
  TaskFollowupInputSchema,
  TaskGetInputSchema,
  UpdateUserInputSchema,
  WizardRunInputSchema,
} from '@zhumo/contracts';
import { ANONYMOUS_USERNAME } from '@zhumo/contracts';
import type {
  BootstrapOutput,
  SettingKey,
  UserInfo,
} from '@zhumo/contracts';
import type { SqliteDb } from './db/database.js';
import {
  createUser,
  getUserByUsername,
  getUserById,
  listSettings,
  listUsers,
  getSetting,
  putSetting,
  updateUserCredentials,
  type UserRow,
} from './db/store.js';
import {
  authenticate,
  hashPassword,
  isAllowAnonymous,
  signJwt,
  verifyPassword,
} from './auth.js';
import { needsSetup, saveEnvValues, type AppConfig } from './config.js';
import { randomBytes } from 'node:crypto';
import type { WizardRunner } from './wizard.js';
import { resolveModelRouteInfo } from './tasks/service.js';
import type { TaskService } from './tasks/service.js';
import type { ResourceService } from './resources.js';
import { lanUrls } from './lan.js';

/** 每个 WS 连接（或测试调用）注入的初始 context。 */
export interface RpcContext {
  config: AppConfig;
  db: SqliteDb;
  /** JWT 签名密钥（config.jwtSecret 为空时由启动装配生成临时值）。 */
  secret: string;
  wizard: WizardRunner;
  /** 连接上携带的 JWT（upgrade ?token=）。 */
  token?: string;
  /** requireAuth 之后注入。 */
  user?: UserRow;
  /** W4 任务编排服务（未装配时 tasks 端点 501）。 */
  tasks?: TaskService;
  /** W5 资源管理器服务（未装配时 res 端点 501）。 */
  resources?: ResourceService;
}

const base = os.$context<RpcContext>();

function toUserInfo(user: UserRow): UserInfo {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: user.disabled === 1,
    created_at: user.created_at,
  };
}

async function issueToken(context: RpcContext, user: UserRow) {
  const { token, expiresAt } = await signJwt(context.secret, { sub: user.id, role: user.role });
  return { token, expires_at: expiresAt, user: toUserInfo(user) };
}

/** 未配置态之后的 setup 端点一律 403（§4「完成后 403」）。 */
const setupGated = base.use(async ({ context, next }) => {
  if (!needsSetup(context.config)) {
    throw new ORPCError('FORBIDDEN', { message: '安装已完成，setup 端点不可用' });
  }
  return next();
});

const requireAuth = base.use(async ({ context, next }) => {
  const user = context.user ?? (await authenticate(context.secret, context.db, context.token));
  if (!user) throw new ORPCError('UNAUTHORIZED', { message: '需要登录' });
  // 走查 BUG1（2026-09-23）：匿名 JWT 是开关开启时签发的，关闭开关不会撤回旧
  // token——认证面必须就地校验开关，旧匿名凭证立即失效（authAnonymous 的 403
  // 只挡新签发，挡不住已持有的 token）。
  if (user.role === 'anonymous' && !isAllowAnonymous(context.db)) {
    throw new ORPCError('UNAUTHORIZED', { message: '匿名访问已关闭，请登录后使用' });
  }
  return next({ context: { ...context, user } });
});

const requireAdmin = requireAuth.use(async ({ context, next }) => {
  if (context.user?.role !== 'admin') {
    throw new ORPCError('FORBIDDEN', { message: '需要管理员权限' });
  }
  return next();
});

// ---------------------------------------------------------------- bootstrap / setup

const bootstrap = base.handler(async ({ context }): Promise<BootstrapOutput> => {
  return {
    needs_setup: needsSetup(context.config),
    allow_anonymous: isAllowAnonymous(context.db),
    site_name: getSetting(context.db, 'site_name') ?? '朱墨',
    // 走查 BUG2（2026-09-23）：模型路由透明化——provider/model/来源对外可见
    // （与 resolveModelRouteFromStore 同一读取链；api key 永不出现在此）。
    model_route: resolveModelRouteInfo(context.db, context.config),
  };
});

const setupCreateAdmin = setupGated
  .input(CreateAdminInputSchema)
  .handler(async ({ context, input }) => {
    if (getUserByUsername(context.db, input.username)) {
      throw new ORPCError('CONFLICT', { message: `用户名已存在：${input.username}` });
    }
    // 向导第 1 步：写 .env + 落 users 表（§1）。JWT_SECRET 为空则生成并一并落盘。
    const jwtSecret = context.config.jwtSecret || randomBytes(32).toString('hex');
    saveEnvValues(context.config.envFile, {
      ADMIN_USERNAME: input.username,
      ADMIN_PASSWORD: input.password,
      JWT_SECRET: jwtSecret,
    });
    context.config.adminUsername = input.username;
    context.config.adminPassword = input.password;
    context.config.jwtSecret = jwtSecret;
    const admin = createUser(context.db, {
      username: input.username,
      passwordHash: hashPassword(input.password),
      role: 'admin',
    });
    return issueToken(context, admin);
  });

const setupSteps = setupGated.handler(async ({ context }) => {
  return { steps: context.wizard.list() };
});

const setupRunStep = setupGated.input(WizardRunInputSchema).handler(async ({ context, input }) => {
  return context.wizard.run(input.id, input.force, { model: input.model, mirror: input.mirror });
});

const setupComplete = setupGated.handler(async ({ context }) => {
  putSetting(context.db, 'setup_completed', '1');
  return { ok: true as const };
});

// ---------------------------------------------------------------- auth / me

const authLogin = base.input(LoginInputSchema).handler(async ({ context, input }) => {
  if (input.username === ANONYMOUS_USERNAME) {
    throw new ORPCError('FORBIDDEN', { message: '内置匿名账号不可直接登录' });
  }
  const user = getUserByUsername(context.db, input.username);
  if (!user || !verifyPassword(input.password, user.password_hash)) {
    throw new ORPCError('UNAUTHORIZED', { message: '用户名或密码错误' });
  }
  if (user.disabled) throw new ORPCError('UNAUTHORIZED', { message: '账号已禁用' });
  return issueToken(context, user);
});

const authAnonymous = base.handler(async ({ context }) => {
  if (!isAllowAnonymous(context.db)) {
    throw new ORPCError('FORBIDDEN', { message: '匿名访问已关闭' });
  }
  const anonymous = getUserByUsername(context.db, ANONYMOUS_USERNAME);
  if (!anonymous || anonymous.disabled) {
    throw new ORPCError('FORBIDDEN', { message: '匿名账号不可用' });
  }
  return issueToken(context, anonymous);
});

const authRefresh = base.input(RefreshInputSchema).handler(async ({ context, input }) => {
  const token = input.token ?? context.token;
  const user = await authenticate(context.secret, context.db, token);
  if (!user) throw new ORPCError('UNAUTHORIZED', { message: '凭证无效或已过期' });
  return issueToken(context, user);
});

const me = requireAuth.handler(({ context }) => toUserInfo(context.user as UserRow));

// ---------------------------------------------------------------- admin

const adminUserList = requireAdmin.handler(({ context }) => {
  return { users: listUsers(context.db).map(toUserInfo) };
});

const adminUserCreate = requireAdmin
  .input(CreateUserInputSchema)
  .handler(async ({ context, input }) => {
    if (getUserByUsername(context.db, input.username)) {
      throw new ORPCError('CONFLICT', { message: `用户名已存在：${input.username}` });
    }
    const user = createUser(context.db, {
      username: input.username,
      passwordHash: hashPassword(input.password),
      role: input.role,
    });
    return toUserInfo(user);
  });

const adminUserUpdate = requireAdmin
  .input(UpdateUserInputSchema)
  .handler(async ({ context, input }) => {
    const target = getUserById(context.db, input.id);
    if (!target) throw new ORPCError('NOT_FOUND', { message: `用户不存在：${input.id}` });
    const touchesAnonymous =
      target.username === ANONYMOUS_USERNAME &&
      (input.role !== undefined || input.disabled !== undefined || input.password !== undefined);
    if (touchesAnonymous) {
      throw new ORPCError('CONFLICT', { message: '内置匿名账号不可修改' });
    }
    const demotesSelf =
      target.id === context.user?.id &&
      (input.disabled === true || (input.role !== undefined && input.role !== 'admin'));
    if (demotesSelf) {
      throw new ORPCError('CONFLICT', { message: '不能禁用或降级当前登录的管理员自己' });
    }
    updateUserCredentials(context.db, target.id, {
      passwordHash: input.password ? hashPassword(input.password) : undefined,
      disabled: input.disabled,
      role: input.role,
    });
    return toUserInfo(getUserById(context.db, target.id) as UserRow);
  });

/** 运行时设置白名单（站点三键 + W7 联调补：llm_* 模型路由四键——settings 表
 * 是 resolveModelRouteFromStore 的第一优先信源，webui Models 配置经此落库）。 */
const SETTING_KEY_WHITELIST: readonly SettingKey[] = [
  'site_name',
  'site_base_url',
  'allow_anonymous',
  'llm_provider',
  'llm_base_url',
  'llm_api_key',
  'llm_api',
  'llm_model',
];

const adminSettingGet = requireAdmin.input(SettingGetInputSchema).handler(({ context, input }) => {
  return { key: input.key, value: getSetting(context.db, input.key) ?? '' };
});

const adminSettingPut = requireAdmin.input(SettingPutInputSchema).handler(({ context, input }) => {
  if (input.key === 'allow_anonymous' && input.value !== '0' && input.value !== '1') {
    throw new ORPCError('BAD_REQUEST', { message: 'allow_anonymous 仅接受 1 或 0' });
  }
  putSetting(context.db, input.key, input.value);
  return { key: input.key, value: input.value };
});

const adminSettingList = requireAdmin.handler(({ context }) => {
  const values = new Map(listSettings(context.db).map((s) => [s.key, s.value]));
  return {
    settings: SETTING_KEY_WHITELIST.map((key) => ({ key, value: values.get(key) ?? '' })),
  };
});

/** 局域网访问链接（走查 BUG3，2026-09-23）：各网卡 IPv4 + mDNS 主机名。
 * SITE_BASE_URL 不掺和——那是站点域名配置自己的展示。 */
const adminSettingLan = requireAdmin.handler(({ context }) => {
  return { urls: lanUrls(context.config.port) };
});

const adminPassword = requireAdmin
  .input(ChangePasswordInputSchema)
  .handler(async ({ context, input }) => {
    const admin = context.user as UserRow;
    if (!verifyPassword(input.old_password, admin.password_hash)) {
      throw new ORPCError('FORBIDDEN', { message: '原密码不正确' });
    }
    updateUserCredentials(context.db, admin.id, {
      passwordHash: hashPassword(input.new_password),
    });
    return { ok: true as const };
  });

const adminWizardSteps = requireAdmin.handler(({ context }) => {
  return { steps: context.wizard.list() };
});

const adminWizardRun = requireAdmin.input(WizardRunInputSchema).handler(async ({ context, input }) => {
  return context.wizard.run(input.id, input.force, { model: input.model, mirror: input.mirror });
});

// ---------------------------------------------------------------- tasks（W4 实装）/ res（W5 实装）

function notImplemented(area: string): never {
  throw new ORPCError('NOT_IMPLEMENTED', { message: `${area} 将在后续波次落地（501）` });
}

function requireResourceService(context: RpcContext): ResourceService {
  if (!context.resources) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: '资源管理器未装配' });
  }
  return context.resources;
}

function requireTaskService(context: RpcContext): TaskService {
  if (!context.tasks) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: '任务编排未装配（内核未启用）' });
  }
  return context.tasks;
}

/** 业务错误（任务不存在/无权访问等 Error）投影 BAD_REQUEST；ORPCError 原样透传。 */
const taskOwnedException = (error: unknown): never => {
  if (error instanceof ORPCError) throw error;
  throw new ORPCError('BAD_REQUEST', {
    message: error instanceof Error ? error.message : String(error),
  });
};

const tasksList = requireAuth.handler(({ context }) => {
  return { tasks: requireTaskService(context).list(context.user as UserRow) };
});

const tasksCreate = requireAuth
  .input(TaskCreateInputSchema)
  .handler(async ({ context, input }) => {
    try {
      return await requireTaskService(context).create(context.user as UserRow, input);
    } catch (error) {
      return taskOwnedException(error);
    }
  });

const tasksGet = requireAuth.input(TaskGetInputSchema).handler(async ({ context, input }) => {
  try {
    return await requireTaskService(context).get(context.user as UserRow, input.id, input.after_seq);
  } catch (error) {
    return taskOwnedException(error);
  }
});

const tasksCancel = requireAuth.input(TaskCancelInputSchema).handler(async ({ context, input }) => {
  try {
    return await requireTaskService(context).cancel(context.user as UserRow, input.id);
  } catch (error) {
    return taskOwnedException(error);
  }
});

const tasksFollowup = requireAuth.input(TaskFollowupInputSchema).handler(async ({ context, input }) => {
  try {
    return await requireTaskService(context).followup(context.user as UserRow, input);
  } catch (error) {
    return taskOwnedException(error);
  }
});

// ---------------------------------------------------------------- res（资源管理器，§4「认证（仅本人文件夹）」）

const resTree = requireAuth.input(ResTreeInputSchema).handler(({ context, input }) => {
  return requireResourceService(context).tree(context.user as UserRow, input);
});

const resMkdir = requireAuth.input(ResMkdirInputSchema).handler(({ context, input }) => {
  return { item: requireResourceService(context).mkdir(context.user as UserRow, input) };
});

const resRename = requireAuth.input(ResRenameInputSchema).handler(({ context, input }) => {
  return { item: requireResourceService(context).rename(context.user as UserRow, input) };
});

const resMove = requireAuth.input(ResMoveInputSchema).handler(({ context, input }) => {
  return { item: requireResourceService(context).move(context.user as UserRow, input) };
});

const resDelete = requireAuth.input(ResDeleteInputSchema).handler(({ context, input }) => {
  return requireResourceService(context).remove(context.user as UserRow, input);
});

const resUpload = requireAuth.input(ResUploadInputSchema).handler(({ context, input }) => {
  return requireResourceService(context).upload(context.user as UserRow, input);
});

// ---------------------------------------------------------------- 路由表

export const router = {
  bootstrap,

  setup: {
    createAdmin: setupCreateAdmin,
    steps: setupSteps,
    runStep: setupRunStep,
    complete: setupComplete,
  },

  auth: {
    login: authLogin,
    anonymous: authAnonymous,
    refresh: authRefresh,
  },

  me,

  admin: {
    users: {
      list: adminUserList,
      create: adminUserCreate,
      update: adminUserUpdate,
    },
    settings: {
      get: adminSettingGet,
      put: adminSettingPut,
      list: adminSettingList,
      lan: adminSettingLan,
    },
    password: adminPassword,
    wizard: {
      steps: adminWizardSteps,
      runStep: adminWizardRun,
    },
  },

  tasks: {
    list: tasksList,
    create: tasksCreate,
    get: tasksGet,
    cancel: tasksCancel,
    followup: tasksFollowup,
  },

  res: {
    tree: resTree,
    mkdir: resMkdir,
    rename: resRename,
    move: resMove,
    delete: resDelete,
    upload: resUpload,
  },
};

export type AppRouter = typeof router;
