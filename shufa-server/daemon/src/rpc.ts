/**
 * oRPC-over-WebSocket 路由表（PRODUCT_DESIGN.md §4 API 矩阵）。
 * 原始需求 2026-09-23（W2' 地基 / W4 tasks 实装 / W5 res 实装）：bootstrap/setup/auth/me
 * /admin 全量端点；tasks 四端点接 TaskService（创建含视频直传、详情含帧回放）；
 * res 六端点接 ResourceService（树/建目/改名/移动/删除/上传，认证 + 仅本人资源，
 * admin 可带 owner 参数）。token 经 WS upgrade ?token= 查询参数进入 context。
 * 走查修订 2026-09-23：BUG2 bootstrap.setup_progress / BUG5 禁用读写分离 +
 * admin.users.delete 级联 + __anonymous__ 三禁 / BUG6 匿名默认关 / BUG4 models 目录。
 * 正交意图：
 *   [1] context 与守卫中间件（requireAuth / requireAdmin / requireActiveUser / setupGated）。
 *   [2] 公开与认证端点：bootstrap、setup 全族、auth 全族、me。
 *   [3] admin 端点：用户 CRUD（含删除级联）、settings、改密、向导重跑、models 目录。
 *   [4] tasks 四端点与 res 六端点（服务未装配时 501；写操作挂 requireActiveUser）。
 */
import { ORPCError, os } from '@orpc/server';
import { rmSync } from 'node:fs';
import path from 'node:path';
import {
  ChangePasswordInputSchema,
  CreateAdminInputSchema,
  CreateUserInputSchema,
  DeleteUserInputSchema,
  LoginInputSchema,
  RefreshInputSchema,
  ResDeleteInputSchema,
  ResMkdirInputSchema,
  ResMoveInputSchema,
  ResRenameInputSchema,
  AttachmentUploadInputSchema,
  ResTreeInputSchema,
  ResUploadInputSchema,
  SettingGetInputSchema,
  SettingPutInputSchema,
  TaskCancelInputSchema,
  TaskSetModelInputSchema,
  TaskCreateInputSchema,
  TaskFollowupInputSchema,
  TaskGetInputSchema,
  UpdateUserInputSchema,
  WizardCancelInputSchema,
  WizardRunInputSchema,
  KbGroupSaveInputSchema,
  KbGroupDeleteInputSchema,
  KbEntrySaveInputSchema,
  KbEntryDeleteInputSchema,
  KbRevisionGetInputSchema,
  KbRestoreInputSchema,
} from '@zhumo/contracts';
import { ANONYMOUS_USERNAME } from '@zhumo/contracts';
import type {
  BootstrapOutput,
  DeleteUserOutput,
  SettingKey,
  UserInfo,
} from '@zhumo/contracts';
import type { SqliteDb } from './db/database.js';
import {
  createUser,
  deleteUserRow,
  getUserByUsername,
  getUserById,
  hasNonAnonymousUser,
  listSettings,
  listUsers,
  getSetting,
  putSetting,
  updateUserCredentials,
  wizardProgressStats,
  type UserRow,
} from './db/store.js';
import {
  authenticate,
  hashPassword,
  isAllowAnonymous,
  SETTING_ALLOW_ANONYMOUS,
  signJwt,
  verifyPassword,
} from './auth.js';
import { needsSetup, saveEnvValues, type AppConfig } from './config.js';
import { randomBytes } from 'node:crypto';
import type { WizardRunner } from './wizard.js';
import { modelsRouteInfo } from './tasks/service.js';
import type { TaskService } from './tasks/service.js';
import type { ResourceService } from './resources.js';
import type { BlobStore } from './db/blobs.js';
import { modelCatalog, refreshModelsDevCache } from './models-catalog.js';
import {
  buildRoutesBundle,
  loadKeys,
  loadModelsConfig,
  saveModelsConfig,
} from './models-store.js';
import { testRouteConnection } from './test-route-connection.js';
import { syncModelRoutesCredentials, syncModelRoutesSettings } from './kernel/model-route.js';
import {
  ModelsSaveInputSchema,
  ModelsTestInputSchema,
} from '@zhumo/contracts';
import type {
  ModelsConfigOutput,
  ModelsTestOutput,
  ModelsAvailableOutput,
} from '@zhumo/contracts';
import { lanUrls } from './lan.js';
import type { KbStore } from './kb/store.js';

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
  /** 内容寻址存储（admin.users.delete 的 blob 引用释放需要；未装配时删除 501）。 */
  blobs?: BlobStore;
  /** models.dev 刷新的 fetch 注入口（测试用；缺省全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 书法领域知识库（admin.kb.* 数据面；Owner 2026-09-22）。 */
  kb?: KbStore;
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

/**
 * 活跃用户守卫（走查 BUG5，2026-09-23 禁用语义重定义）：禁用 ≠ 不能登录——
 * 禁用用户可登录、可读（任务列表/详情/已公开结果），仅禁止写操作。
 * 挂在任务创建/续聊/取消、资源变更/上传、向导执行等写路由上。
 */
const requireActiveUser = requireAuth.use(async ({ context, next }) => {
  if (context.user?.disabled) {
    throw new ORPCError('FORBIDDEN', {
      message: '账号已被禁用：不能新建任务，仍可查看已有任务',
    });
  }
  return next();
});

/** requireActiveUser 的 admin 变体（admin 向导重跑等管理面写操作）。 */
const requireActiveAdmin = requireAdmin.use(async ({ context, next }) => {
  if (context.user?.disabled) {
    throw new ORPCError('FORBIDDEN', {
      message: '账号已被禁用：不能新建任务，仍可查看已有任务',
    });
  }
  return next();
});

// ---------------------------------------------------------------- bootstrap / setup

const bootstrap = base.handler(async ({ context }): Promise<BootstrapOutput> => {
  // 走查 BUG2（2026-09-23）：安装进度随站点态下发，SPA 刷新后由此恢复向导位置。
  const steps = wizardProgressStats(context.db);
  return {
    needs_setup: needsSetup(context.config),
    allow_anonymous: isAllowAnonymous(context.db),
    site_name: getSetting(context.db, 'site_name') ?? '朱墨',
    // 走查 BUG2（2026-09-23）：模型路由透明化——provider/model/来源对外可见
    // （五轮起多路由：routes 的 default 优先，旧 llm_* 兜底；key 永不出现在此）。
    model_route: modelsRouteInfo(context.db, context.config),
    setup_progress: {
      admin_created: hasNonAnonymousUser(context.db),
      steps_done: steps.done,
      steps_total: steps.total,
      model_configured: modelsRouteInfo(context.db, context.config) !== null,
    },
    // 走查 2026-09-24：完成标记随 bootstrap 下发（SPA 反向门控 /setup → 登录）。
    setup_completed: getSetting(context.db, 'setup_completed') === '1',
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
    // 走查 BUG6（Owner 2026-09-23 安全默认）：匿名访问缺省关闭，安装向导第 1 步
    // 显式勾选（allow_anonymous: true）才写入开启；无论开关都落键（消除缺省歧义）。
    putSetting(context.db, SETTING_ALLOW_ANONYMOUS, input.allow_anonymous ? '1' : '0');
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

// 取消运行中的步骤（走查 2026-09-24）：不经 setupGated——与 complete 同因，
// needs_setup 建管理员后即翻 false，而准备步骤在完成安装前仍可取消重跑。
const setupCancelStep = base.input(WizardCancelInputSchema).handler(async ({ context, input }) => {
  return context.wizard.cancel(input.id);
});

// 完成标记不能挂 setupGated：needs_setup 在建管理员后即翻 false，complete 会恒
// 403（实证 2026-09-24：向导「完成安装」静默失败、settings.setup_completed 从未
// 落库）。改为校验管理员已建（防全新站点误触），幂等写标记。
const setupComplete = base.handler(async ({ context }) => {
  if (!hasNonAnonymousUser(context.db)) {
    throw new ORPCError('FORBIDDEN', { message: '尚未创建管理员账号，无法完成安装' });
  }
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
  // 走查 BUG5（2026-09-23）：禁用 ≠ 不能登录——签发 token，写操作由
  // requireActiveUser 拦截（禁用用户可读任务列表/详情/已公开结果）。
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
    // 走查 BUG5 __anonymous__ 三禁：禁改密 / 禁禁用 / 禁改角色（匿名开合只走
    // allow_anonymous 设置，匿名身份本身不可被后台改动）。
    if (target.username === ANONYMOUS_USERNAME) {
      if (input.password !== undefined) {
        throw new ORPCError('CONFLICT', { message: '内置匿名账号不可改密' });
      }
      if (input.disabled !== undefined) {
        throw new ORPCError('CONFLICT', {
          message: '内置匿名账号不可禁用（匿名访问开关走 allow_anonymous 设置）',
        });
      }
      if (input.role !== undefined) {
        throw new ORPCError('CONFLICT', { message: '内置匿名账号不可改角色' });
      }
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

/**
 * 删除用户 = 数据级联清理（走查 BUG5，2026-09-23）：results/tasks/resources 行
 * （连带 .shufa 元数据，它存在于 resources.meta）→ users 行 → blob 引用计数递减
 * （归零由 BlobStore 回收实体文件）→ 磁盘 DATA_ROOT/users/<username>/ 整目录。
 * __anonymous__ 与当前登录管理员自己不可删。外键（foreign_keys=ON）决定顺序：
 * tasks.result_id ↔ results.task_id 循环引用先解空，再按引用方向反序删行。
 */
const adminUserDelete = requireAdmin
  .input(DeleteUserInputSchema)
  .handler(async ({ context, input }): Promise<DeleteUserOutput> => {
    const blobs = context.blobs;
    if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配' });
    const target = getUserById(context.db, input.id);
    if (!target) throw new ORPCError('NOT_FOUND', { message: `用户不存在：${input.id}` });
    if (target.username === ANONYMOUS_USERNAME) {
      throw new ORPCError('CONFLICT', { message: '内置匿名账号不可删除' });
    }
    if (target.id === context.user?.id) {
      throw new ORPCError('CONFLICT', { message: '不能删除当前登录的管理员自己' });
    }
    const db = context.db;
    // 1) 解开 tasks ↔ results 的循环外键引用。
    db.prepare('UPDATE tasks SET result_id = NULL WHERE owner_id = ?').run(target.id);
    db.prepare('UPDATE results SET task_id = NULL WHERE owner_id = ?').run(target.id);
    // 2) 文件资源行先收集（每行持有一个 blob 引用，逐行释放才算得清计数）。
    const hashRows = db
      .prepare('SELECT content_hash FROM resources WHERE owner_id = ? AND content_hash IS NOT NULL')
      .all(target.id) as Array<{ content_hash: string }>;
    // 3) 按外键引用方向反序删行：results → tasks → resources → users。
    db.prepare('DELETE FROM results WHERE owner_id = ?').run(target.id);
    db.prepare('DELETE FROM tasks WHERE owner_id = ?').run(target.id);
    db.prepare('DELETE FROM resources WHERE owner_id = ?').run(target.id);
    deleteUserRow(db, target.id);
    // 4) blob 引用计数递减（归零回收实体文件与行，见 db/blobs.ts releaseRef）。
    for (const row of hashRows) blobs.releaseRef(row.content_hash);
    // 5) 磁盘：整目录移除（资源树/任务目录/.shufa 会话与结果包都在其中）。
    rmSync(path.join(context.config.dataRoot, 'users', target.username), {
      recursive: true,
      force: true,
    });
    return { ok: true };
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

const adminWizardRun = requireActiveAdmin
  .input(WizardRunInputSchema)
  .handler(async ({ context, input }) => {
    return context.wizard.run(input.id, input.force, { model: input.model, mirror: input.mirror });
  });

const adminWizardCancel = requireActiveAdmin
  .input(WizardCancelInputSchema)
  .handler(async ({ context, input }) => {
    return context.wizard.cancel(input.id);
  });

// ---------------------------------------------------------------- models 目录（走查 BUG4）

/** 预设目录：builtin（pi-ai 内嵌）恒在 + models.dev 缓存追加（公开面，无敏感值）。 */
const adminModelsCatalog = requireAdmin.handler(({ context }) => {
  return modelCatalog(context.db);
});

/**
 * 模型配置守卫（五轮 R2）：管理员，或「安装向导语境」——管理员已建但
 * setup_completed 未标记（向导步 2 的 ModelsConfig 在无登录会话下读写；
 * createAdmin 不建会话，走查实证 2026-09-24：向导步 2 曾恒 403 只剩错误卡）。
 * 窗口风险与 setupGated 同级（安装流程内、局域网部署）；完成安装后恢复
 * 仅管理员。仅限 models get/save/test 三端点——用户/站点管理不适用。
 */
const requireAdminOrWizard = base.use(async ({ context, next }) => {
  const inWizard =
    !needsSetup(context.config) && getSetting(context.db, 'setup_completed') !== '1';
  if (inWizard) return next();
  const user = context.user ?? (await authenticate(context.secret, context.db, context.token));
  if (!user || user.role !== 'admin') {
    throw new ORPCError('FORBIDDEN', { message: '需要管理员权限' });
  }
  return next({ context: { ...context, user } });
});

/** 多路由配置读面（五轮）：密钥只投影 hasKey。 */
const adminModelsGet = requireAdminOrWizard.handler(({ context }): ModelsConfigOutput => {
  return loadModelsConfig(context.db);
});

/** 多路由配置写面：apiKey 空/缺省=保留旧值；保存后桥接面随新会话生效。 */
const adminModelsSave = requireAdminOrWizard
  .input(ModelsSaveInputSchema)
  .handler(async ({ context, input }) => {
    saveModelsConfig(context.db, input);
    // 桥接面即时重写（settings.yaml/.credentials.yaml 行热加载，无需重启）。
    const bundle = buildRoutesBundle(context.db);
    if (bundle.routes.length > 0) {
      const home = path.join(context.config.dataRoot, 'dsh-home');
      syncModelRoutesSettings(home, bundle);
      syncModelRoutesCredentials(home, bundle.routes);
    }
    return loadModelsConfig(context.db);
  });

/** 连接测试（五轮 · 一）：apiKey 直传优先，缺省从已存密钥注入。 */
const adminModelsTest = requireAdminOrWizard
  .input(ModelsTestInputSchema)
  .handler(async ({ context, input }): Promise<ModelsTestOutput> => {
    const apiKey =
      input.apiKey && input.apiKey.length > 0
        ? input.apiKey
        : loadKeys(context.db)[input.provider ?? ''] ?? '';
    return testRouteConnection({ ...input, apiKey });
  });

/** 可用模型清单（登录用户；前台任务对话框的活动模型选择）。 */
const modelsAvailable = requireActiveUser.handler(({ context }): ModelsAvailableOutput => {
  const config = loadModelsConfig(context.db);
  return {
    models: config.routes.flatMap((route) =>
      route.models.map((model) => ({
        provider: route.provider,
        model: model.id,
        name: model.name ?? model.id,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.inputTypes !== undefined ? { inputTypes: model.inputTypes } : {}),
        ...(route.iconUrl !== undefined ? { iconUrl: route.iconUrl } : {}),
      })),
    ),
    default: config.default,
  };
});

/** models.dev 在线刷新：成功返回合并目录；网络失败中文报错且不伤 builtin/旧缓存。 */
const adminModelsCatalogRefresh = requireAdmin.handler(async ({ context }) => {
  try {
    await refreshModelsDevCache(context.db, context.fetchImpl ?? fetch);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ORPCError('BAD_REQUEST', {
      message: `models.dev 预设刷新失败：${detail}（可稍后重试，内置预设不受影响）`,
    });
  }
  return modelCatalog(context.db);
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

// 写操作挂 requireActiveUser（走查 BUG5：禁用用户禁写，list/get 保持可读）。
const tasksCreate = requireActiveUser
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

const tasksCancel = requireActiveUser
  .input(TaskCancelInputSchema)
  .handler(async ({ context, input }) => {
    try {
      return await requireTaskService(context).cancel(context.user as UserRow, input.id);
    } catch (error) {
      return taskOwnedException(error);
    }
  });

/** 聊天中切换任务模型（走查 R6）。 */
const tasksSetModel = requireActiveUser
  .input(TaskSetModelInputSchema)
  .handler(async ({ context, input }) => {
    try {
      const task = await requireTaskService(context).setModel(context.user as UserRow, {
        taskId: input.task_id,
        provider: input.provider,
        model: input.model,
      });
      return { task };
    } catch (error) {
      return taskOwnedException(error);
    }
  });

const tasksFollowup = requireActiveUser
  .input(TaskFollowupInputSchema)
  .handler(async ({ context, input }) => {
    try {
      return await requireTaskService(context).followup(context.user as UserRow, input);
    } catch (error) {
      return taskOwnedException(error);
    }
  });

// ---------------------------------------------------------------- res（资源管理器，§4「认证（仅本人文件夹）」）

/** 附件上传（走查 R7）：登录用户；blob + 资源树登记，返回 agent 可读路径。 */
const resAttachmentUpload = requireAuth
  .input(AttachmentUploadInputSchema)
  .handler(({ context, input }) => {
    const service = context.resources;
    if (!service) throw new ORPCError('NOT_IMPLEMENTED', { message: '资源管理器未装配' });
    return service.attachmentUpload(context.user as UserRow, input);
  });

const resTree = requireAuth.input(ResTreeInputSchema).handler(({ context, input }) => {
  return requireResourceService(context).tree(context.user as UserRow, input);
});

// 变更面/上传挂 requireActiveUser（走查 BUG5：禁用用户禁写，树浏览保持可读）。
const resMkdir = requireActiveUser.input(ResMkdirInputSchema).handler(({ context, input }) => {
  return { item: requireResourceService(context).mkdir(context.user as UserRow, input) };
});

const resRename = requireActiveUser.input(ResRenameInputSchema).handler(({ context, input }) => {
  return { item: requireResourceService(context).rename(context.user as UserRow, input) };
});

const resMove = requireActiveUser.input(ResMoveInputSchema).handler(({ context, input }) => {
  return { item: requireResourceService(context).move(context.user as UserRow, input) };
});

const resDelete = requireActiveUser.input(ResDeleteInputSchema).handler(({ context, input }) => {
  return requireResourceService(context).remove(context.user as UserRow, input);
});

const resUpload = requireActiveUser.input(ResUploadInputSchema).handler(({ context, input }) => {
  return requireResourceService(context).upload(context.user as UserRow, input);
});

// ---------------------------------------------------------------- kb 知识库（Owner 2026-09-22：文件夹 + git 历史；实时读、写必留痕）

function requireKb(context: RpcContext): KbStore {
  if (!context.kb) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: '知识库未装配' });
  }
  return context.kb;
}

/** 业务错误（分组/条目不存在等）→ BAD_REQUEST；ORPCError 透传。 */
function kbException(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  throw new ORPCError('BAD_REQUEST', {
    message: error instanceof Error ? error.message : String(error),
  });
}

const adminKbList = requireAdmin.handler(({ context }) => {
  return { groups: requireKb(context).listAll() };
});

const adminKbSaveGroup = requireAdmin
  .input(KbGroupSaveInputSchema)
  .handler(async ({ context, input }) => {
    try {
      await requireKb(context).upsertGroup(input, `admin:${context.user?.username ?? '?'}`);
      return { groups: requireKb(context).listAll() };
    } catch (error) {
      kbException(error);
    }
  });

const adminKbDeleteGroup = requireAdmin
  .input(KbGroupDeleteInputSchema)
  .handler(async ({ context, input }) => {
    try {
      await requireKb(context).deleteGroup(input.name, `admin:${context.user?.username ?? '?'}`);
      return { groups: requireKb(context).listAll() };
    } catch (error) {
      kbException(error);
    }
  });

const adminKbSaveEntry = requireAdmin
  .input(KbEntrySaveInputSchema)
  .handler(async ({ context, input }) => {
    try {
      await requireKb(context).upsertEntry(input, `admin:${context.user?.username ?? '?'}`);
      return { groups: requireKb(context).listAll() };
    } catch (error) {
      kbException(error);
    }
  });

const adminKbDeleteEntry = requireAdmin
  .input(KbEntryDeleteInputSchema)
  .handler(async ({ context, input }) => {
    try {
      await requireKb(context).deleteEntry(input.group, input.key, `admin:${context.user?.username ?? '?'}`);
      return { groups: requireKb(context).listAll() };
    } catch (error) {
      kbException(error);
    }
  });

const adminKbRevisions = requireAdmin.handler(async ({ context }) => {
  return requireKb(context).revisions();
});

const adminKbRevisionGet = requireAdmin
  .input(KbRevisionGetInputSchema)
  .handler(async ({ context, input }) => {
    try {
      return await requireKb(context).revisionDetail(input.id);
    } catch (error) {
      kbException(error);
    }
  });

const adminKbRestore = requireAdmin
  .input(KbRestoreInputSchema)
  .handler(async ({ context, input }) => {
    try {
      await requireKb(context).restore(input.id, `admin:${context.user?.username ?? '?'}`);
      return { ok: true as const };
    } catch (error) {
      kbException(error);
    }
  });

// ---------------------------------------------------------------- 路由表

export const router = {
  bootstrap,

  setup: {
    createAdmin: setupCreateAdmin,
    steps: setupSteps,
    runStep: setupRunStep,
    cancelStep: setupCancelStep,
    complete: setupComplete,
  },

  auth: {
    login: authLogin,
    anonymous: authAnonymous,
    refresh: authRefresh,
  },

  me,

  // 登录用户面（非 admin）：前台任务对话框选活动模型用。
  models: {
    available: modelsAvailable,
  },

  admin: {
    users: {
      list: adminUserList,
      create: adminUserCreate,
      update: adminUserUpdate,
      delete: adminUserDelete,
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
      cancelStep: adminWizardCancel,
    },
    models: {
      catalog: adminModelsCatalog,
      catalogRefresh: adminModelsCatalogRefresh,
      get: adminModelsGet,
      save: adminModelsSave,
      test: adminModelsTest,
    },
    kb: {
      list: adminKbList,
      saveGroup: adminKbSaveGroup,
      deleteGroup: adminKbDeleteGroup,
      saveEntry: adminKbSaveEntry,
      deleteEntry: adminKbDeleteEntry,
      revisions: adminKbRevisions,
      revisionGet: adminKbRevisionGet,
      restore: adminKbRestore,
    },
  },

  tasks: {
    list: tasksList,
    create: tasksCreate,
    get: tasksGet,
    cancel: tasksCancel,
    setModel: tasksSetModel,
    followup: tasksFollowup,
  },

  res: {
    tree: resTree,
    attachmentUpload: resAttachmentUpload,
    mkdir: resMkdir,
    rename: resRename,
    move: resMove,
    delete: resDelete,
    upload: resUpload,
  },
};

export type AppRouter = typeof router;
