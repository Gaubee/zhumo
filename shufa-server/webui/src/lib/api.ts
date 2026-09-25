/**
 * 统一 API 出口（webui ↔ daemon 契约的浏览器侧唯一入口）。
 * 原始需求 [2026-09-23]；W7 联调：RpcApi 实装（@orpc/client RPCLink over
 * WebSocket 连同源 /ws/rpc?token=，JWT 存 localStorage，401 自动 refresh 一次）。
 * mock 保留为逃生口：URL 带 ?mock=1 时启用（tests/离线演示）。
 * 朱墨前端改造 [2026-09-24]：setup_progress / 匿名默认关（createAdmin 随提交）/
 * 账号禁用与删除 / 模型预设目录（models.dev）；下载进度解析扩展 current/total 文案。
 * 正交意图：
 *   [1] ShufaApi 接口（bootstrap/auth/setup/admin/tasks/results/res 契约，PRODUCT_DESIGN §4）。
 *   [2] mock 实现（?mock=1 时驱动 lib/mock/*；与真 API 同签名）。
 *   [3] RpcApi：WS 客户端生命周期（token 变更重建连接）+ 契约↔视图映射
 *       （WizardStep/UserInfo/Task 的 W3 mock 命名 → contracts snake_case）。
 */
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type {
  BootstrapOutput,
  CreateAdminInput,
  CreateUserInput,
  LanUrlsOutput,
  ResDeleteInput,
  ResDeleteOutput,
  ResMkdirInput,
  ResMoveInput,
  ResRenameInput,
  ResTreeInput,
  ResUploadInput,
  RefreshInput,
  SettingKey,
  TaskCancelInput,
  TaskStopInput,
  TaskQueueEditInput,
  TaskQueueEditConfirmInput,
  TaskQueueEditCancelInput,
  TaskQueueRemoveInput,
  TaskQueueSetModeInput,
  TaskQueueReorderInput,
  TaskQueueSendNowInput,
  TaskCreateInput,
  TaskFollowupInput,
  TaskFollowupOutput,
  TaskGetInput,
  TaskGetOutput,
  TaskQueueListOutput,
  TaskQueueMode,
  TaskItem,
  TokenOutput,
  UpdateUserInput,
  UserInfo as ContractUserInfo,
  WizardRunInput,
  WizardStep as ContractWizardStep,
  WizardStepsOutput,
} from "@zhumo/contracts";
// 撞名收口：契约的 ResTreeOutput/ResUploadOutput 与 webui 视图同名，别名区分。
import type {
  ResTreeOutput as ContractResTreeOutput,
  ResUploadOutput as ContractResUploadOutput,
} from "@zhumo/contracts";
import {
  mockDb,
  onTaskFrame,
  onWizardStepChange,
  replayAgentTurn,
  cancelWizardStepMock,
  runWizardStepMock,
} from "$lib/mock/data";
import { mockResources } from "$lib/mock/resources";
import type {
  AdminSettings,
  BootstrapInfo,
  Frame,
  ModelRouteInfo,
  ModelsCatalog,
  ModelsSettings,
  SetupProgress,
  ResTreeOutput as ResTreeOutputView,
  ResUploadOutput as ResUploadOutputView,
  ResourceItem,
  ResultInfo,
  SessionInfo,
  Task,
  UserInfo,
  WizardRunParams,
  WizardStep,
  AvailableModel,
  ModelsTestResult,
  Attachment,
  ComposerCatalog,
  KbGroupView,
  KbRevisionDetailView,
  KbRevisionView,
  TaskResultRefView,
} from "$lib/types";

/** mock 逃生口：默认走真 RPC；?mock=1 才启用 mock（联调期测试/离线演示用）。 */
export const USE_MOCK = new URLSearchParams(location.search).has("mock");

// ---- 契约宽化镜像（daemon 代理并行落地中，2026-09-24）----
// BootstrapOutput.setup_progress / CreateAdminInput.allow_anonymous / admin.users.delete /
// admin.models.catalog 契约字段落地后，此处宽化可收敛回契约类型；形状以改造简报为准。
type CreateAdminRpcInput = CreateAdminInput & { allow_anonymous?: boolean };
type BootstrapRpcOutput = BootstrapOutput & { setup_progress?: SetupProgress };

interface ResItemOutputView {
  item: ResourceItem;
}

interface ShufaRpc {
  bootstrap(): Promise<BootstrapRpcOutput>;
  setup: {
    createAdmin(input: CreateAdminRpcInput): Promise<TokenOutput>;
    steps(): Promise<WizardStepsOutput>;
    runStep(input: WizardRunInput): Promise<ContractWizardStep>;
    cancelStep(input: { id: string }): Promise<{ ok: true }>;
    complete(): Promise<{ ok: true }>;
  };
  auth: {
    login(input: { username: string; password: string }): Promise<TokenOutput>;
    anonymous(): Promise<TokenOutput>;
    refresh(input: RefreshInput): Promise<TokenOutput>;
  };
  me(): Promise<ContractUserInfo>;
  /** 五轮：登录用户面——可用模型清单（活动模型选择）。 */
  models: {
    available(): Promise<{ models: AvailableModel[]; default: { provider: string; model: string } | null }>;
  };
  admin: {
    users: {
      list(): Promise<{ users: ContractUserInfo[] }>;
      create(input: CreateUserInput): Promise<ContractUserInfo>;
      update(input: UpdateUserInput): Promise<ContractUserInfo>;
      /** BUG5：删除账号（数据级联清理：任务、资源与结果页一并移除）。 */
      delete(input: { id: string }): Promise<{ ok: boolean }>;
    };
    models: {
      /** BUG4：预设目录（builtin 常量 + models.dev 已拉取缓存）。 */
      catalog(): Promise<ModelsCatalog>;
      /** 强制重拉 models.dev（预设列表刷新按钮）。 */
      catalogRefresh(): Promise<ModelsCatalog>;
      /** 五轮：多路由配置读面（hasKey 投影，密钥不出库）。 */
      get(): Promise<ModelsSettings>;
      /** 五轮：保存（apiKey 空=保留）。 */
      save(input: unknown): Promise<ModelsSettings>;
      /** 五轮：连接测试。 */
      test(input: { api: string; baseURL: string; modelId: string; apiKey?: string; provider?: string }): Promise<ModelsTestResult>;
    };
    settings: {
      get(input: { key: SettingKey }): Promise<{ key: string; value: string }>;
      put(input: { key: SettingKey; value: string }): Promise<{ key: string; value: string }>;
      list(): Promise<{ settings: Array<{ key: string; value: string }> }>;
      /** 局域网访问链接（BUG3）：daemon 未部署时调用会抛错，调用方须 catch 静默降级。 */
      lan(): Promise<LanUrlsOutput>;
    };
    wizard: {
      steps(): Promise<WizardStepsOutput>;
      runStep(input: WizardRunInput): Promise<ContractWizardStep>;
      cancelStep(input: { id: string }): Promise<{ ok: true }>;
    };
    /** 知识库（Owner 2026-09-22：两级结构 + git 修订；契约 kb.ts 对应）。 */
    kb: {
      list(): Promise<{ groups: KbGroupView[] }>;
      saveGroup(input: { name: string; note?: string; newName?: string }): Promise<{ groups: KbGroupView[] }>;
      deleteGroup(input: { name: string }): Promise<{ groups: KbGroupView[] }>;
      saveEntry(input: { group: string; key: string; value: string; newKey?: string }): Promise<{ groups: KbGroupView[] }>;
      deleteEntry(input: { group: string; key: string }): Promise<{ groups: KbGroupView[] }>;
      revisions(): Promise<{ available: boolean; revisions: KbRevisionView[] }>;
      revisionGet(input: { id: string }): Promise<KbRevisionDetailView>;
      restore(input: { id: string }): Promise<{ ok: boolean }>;
    };
  };
  /** 前台输入框目录（2026-09-25 二轮）。 */
  composer: {
    list(): Promise<ComposerCatalog>;
  };
  tasks: {
    list(): Promise<{ tasks: TaskItem[] }>;
    create(input: TaskCreateInput): Promise<TaskItem>;
    get(input: TaskGetInput): Promise<TaskGetOutput>;
    cancel(input: TaskCancelInput): Promise<TaskItem>;
    stop(input: TaskStopInput): Promise<TaskItem>;
    queueList(input: { id: string }): Promise<TaskQueueListOutput>;
    queueEdit(input: TaskQueueEditInput): Promise<{ text: string }>;
    queueEditConfirm(input: TaskQueueEditConfirmInput): Promise<{ accepted: true }>;
    queueEditCancel(input: TaskQueueEditCancelInput): Promise<{ accepted: true }>;
    queueRemove(input: TaskQueueRemoveInput): Promise<{ accepted: true }>;
    queueSetMode(input: TaskQueueSetModeInput): Promise<{ accepted: true }>;
    queueReorder(input: TaskQueueReorderInput): Promise<{ accepted: true }>;
    queueSendNow(input: TaskQueueSendNowInput): Promise<{ accepted: true }>;
    followup(input: TaskFollowupInput): Promise<TaskFollowupOutput>;
    setModel(input: { task_id: string; provider: string; model: string }): Promise<{ task: TaskItem }>;
  };

  res: {
    tree(input: ResTreeInput): Promise<ContractResTreeOutput>;
    attachmentUpload(input: { filename: string; data_base64: string }): Promise<{
      resource_id: string;
      name: string;
      path: string;
      size: number;
    }>;
    mkdir(input: ResMkdirInput): Promise<ResItemOutputView>;
    rename(input: ResRenameInput): Promise<ResItemOutputView>;
    move(input: ResMoveInput): Promise<ResItemOutputView>;
    delete(input: ResDeleteInput): Promise<ResDeleteOutput>;
    upload(input: ResUploadInput): Promise<ContractResUploadOutput>;
  };
}

export interface ShufaApi {
  getBootstrap(): Promise<BootstrapInfo>;
  login(username: string, password: string): Promise<SessionInfo>;
  loginAnonymous(): Promise<SessionInfo>;
  logout(): Promise<void>;
  me(): Promise<SessionInfo | null>;
  /** allowAnonymous：安装向导步 1 的「允许匿名访问」开关（BUG2）；缺省 false（安全默认）。 */
  createAdmin(username: string, password: string, allowAnonymous?: boolean): Promise<void>;
  getWizardSteps(): Promise<WizardStep[]>;
  /** params 仅 whisper-model 步骤携带（model/mirror），其余步骤不传。 */
  runWizardStep(id: string, force: boolean, params?: WizardRunParams): Promise<void>;
  /** 取消运行中的步骤（走查 2026-09-24）：命令组杀/下载 abort，状态回 pending。 */
  cancelWizardStep(id: string): Promise<void>;
  subscribeWizardSteps(onChange: () => void): () => void;
  completeSetup(): Promise<void>;
  listUsers(): Promise<UserInfo[]>;
  createUser(username: string, password: string, role: UserInfo["role"]): Promise<UserInfo>;
  changeUserPassword(userId: string, nextPassword: string): Promise<void>;
  /** BUG5：禁用/启用账号（禁用可登录可读、禁止新建任务）。 */
  setUserDisabled(userId: string, disabled: boolean): Promise<void>;
  /** BUG5：删除账号（数据级联清理，不可恢复）。 */
  deleteUser(userId: string): Promise<{ ok: boolean }>;
  /** BUG4：模型预设目录（builtin + models.dev 缓存）。 */
  getModelsCatalog(): Promise<ModelsCatalog>;
  /** BUG4：强制重拉 models.dev 后返回新目录。 */
  refreshModelsCatalog(): Promise<ModelsCatalog>;
  updateAdminSettings(patch: Partial<AdminSettings>): Promise<AdminSettings>;
  getModels(): Promise<ModelsSettings>;
  saveModels(next: ModelsSettings): Promise<void>;
  /** 连接测试（五轮）：直传测试密钥优先（不落盘），缺省用已存密钥。 */
  testModelRoute(input: { api: string; baseURL: string; modelId: string; apiKey?: string; provider?: string }): Promise<ModelsTestResult>;
  /** 可用模型清单（五轮活动模型：前台任务对话框选择面）。 */
  getAvailableModels(): Promise<{ models: AvailableModel[]; default: { provider: string; model: string } | null }>;
  /** 局域网访问链接（BUG3）；失败由调用方降级隐藏（不报错弹脸）。 */
  getLanUrls(): Promise<string[]>;
  listTasks(): Promise<Task[]>;
  getTaskFrames(taskId: string): Promise<Frame[]>;
  subscribeTaskFrames(taskId: string, onFrame: (frame: Frame) => void): () => void;
  sendTaskPrompt(taskId: string, prompt: string, mode?: "followup" | "steer"): Promise<void>;
  /** 打断当前轮（W10）：任务回 done 可续聊；区别于终态取消。 */
  stopTask(taskId: string): Promise<void>;
  /** 队列面板（W10b）：视图/编辑（冻结）/确认/取消/删除/改模式。 */
  taskQueue(taskId: string): Promise<TaskQueueListOutput>;
  taskQueueEdit(taskId: string, messageId: string): Promise<string>;
  taskQueueEditConfirm(taskId: string, text: string): Promise<void>;
  taskQueueEditCancel(taskId: string): Promise<void>;
  taskQueueRemove(taskId: string, messageId: string): Promise<void>;
  taskQueueSetMode(taskId: string, messageId: string, mode: TaskQueueMode): Promise<void>;
  taskQueueReorder(taskId: string, orderedIds: string[]): Promise<void>;
  taskQueueSendNow(taskId: string, messageId: string): Promise<void>;
  createTask(
    prompt: string,
    video: File | null,
    model?: { provider: string; model: string; effort?: string },
  ): Promise<Task>;
  cancelTask(taskId: string): Promise<void>;
  /** 附件上传（走查 R7）：blob + 资源树登记；rawUrl 供预览。 */
  uploadAttachment(file: { name: string; dataBase64: string }): Promise<Attachment>;
  /** 聊天中切换任务模型（走查 R6）：更新覆盖并热切会话（idle 态）。 */
  setTaskModel(taskId: string, provider: string, model: string, effort?: string | null): Promise<Task>;
  /** 前台输入框目录（/ 命令注册表 + $ 技能注册表；内核未挂载 = 空表）。 */
  composerList(): Promise<ComposerCatalog>;
  /** 任务的导出结果列表（新→旧；右侧标签页数据源）。 */
  getTaskResults(taskId: string): Promise<TaskResultRefView[]>;
  getResult(publicId: string): Promise<ResultInfo>;
  // ---- 资源管理器（W5；owner 仅 admin 传他人 username） ----
  resTree(owner?: string, parent?: string): Promise<ResTreeOutputView>;
  resMkdir(parent: string, name: string): Promise<ResourceItem>;
  resRename(id: string, name: string): Promise<ResourceItem>;
  resMove(id: string, newParent: string): Promise<ResourceItem>;
  resDelete(id: string): Promise<ResDeleteOutput>;
  resUpload(parent: string, file: File): Promise<ResUploadOutputView>;
  /** 预览/下载 URL；无实体（目录/未上传内容）返回 null。 */
  resRawUrl(id: string): Promise<string | null>;
  // ---- 知识库（admin；Owner 2026-09-22：分组→键值 + git 修订历史） ----
  listKb(): Promise<KbGroupView[]>;
  saveKbGroup(input: { name: string; note?: string; newName?: string }): Promise<KbGroupView[]>;
  deleteKbGroup(name: string): Promise<KbGroupView[]>;
  saveKbEntry(input: { group: string; key: string; value: string; newKey?: string }): Promise<KbGroupView[]>;
  deleteKbEntry(group: string, key: string): Promise<KbGroupView[]>;
  listKbRevisions(): Promise<{ available: boolean; revisions: KbRevisionView[] }>;
  getKbRevision(id: string): Promise<KbRevisionDetailView>;
  restoreKb(id: string): Promise<void>;
}

const fail = (msg: string): never => {
  throw new Error(msg);
};

/** mock bootstrap 的生效路由投影：default 指向现存路由 → settings 来源；否则 null。 */
function toMockModelRoute(): ModelRouteInfo | null {
  const def = mockDb.models.default;
  if (def === null) return null;
  const route = mockDb.models.routes.find((candidate) => candidate.provider === def.provider);
  if (route === undefined) return null;
  return { provider: route.provider, model: def.model, source: "settings" };
}

/** mock setup_progress（BUG2）：由内存库状态实时投影（管理员/步骤完成度/模型配置）。 */
function toMockSetupProgress(): SetupProgress {
  return {
    admin_created: mockDb.users.some((user) => user.role === "admin"),
    steps_done: mockDb.wizardSteps.filter(
      (step) => step.status === "done" || step.status === "skipped",
    ).length,
    steps_total: mockDb.wizardSteps.length,
    model_configured: (mockDb.models.default?.model ?? "").length > 0,
  };
}

class MockApi implements ShufaApi {
  async getBootstrap(): Promise<BootstrapInfo> {
    // dev 覆盖（仅 mock 层；真 API 无此逻辑）：?installed=1 跳过安装门控，
    // ?as=admin 模拟管理员会话——供冒烟截图与联调直达页面。
    const devParams = new URLSearchParams(location.search);
    if (devParams.has("installed")) mockDb.installed = true;
    if (devParams.get("as") === "admin") {
      mockDb.session = { userId: "u-admin", username: "admin", role: "admin", disabled: false };
    }
    return {
      needsSetup: !mockDb.installed,
      allowAnonymous: mockDb.adminSettings.allowAnonymous,
      setupCompleted: mockDb.installed,
      siteName: mockDb.siteName,
      // mock 与真 API 同形：路由清空后前台进入「未配置」阻断态（R4 自测口）。
      modelRoute: toMockModelRoute(),
      setupProgress: toMockSetupProgress(),
    };
  }

  async login(username: string, password: string): Promise<SessionInfo> {
    // 演示口令：admin/admin123、王老师/user123；真实实现走 POST /api/auth/login（scrypt 校验）。
    // 语义变更（BUG5）：禁用账号可登录可读，仅新建任务被拦（前端+daemon 双重拦截）。
    const known: Record<string, string> = { admin: "admin123", 王老师: "user123" };
    if (known[username] !== password) fail("用户名或密码错误");
    const user = mockDb.users.find((u) => u.username === username) ?? fail("账号不存在");
    mockDb.session = {
      userId: user.id,
      username: user.username,
      role: user.role,
      disabled: user.disabled,
    };
    return mockDb.session;
  }

  async loginAnonymous(): Promise<SessionInfo> {
    if (!mockDb.adminSettings.allowAnonymous) fail("本站未开启匿名访问");
    mockDb.session = { userId: "u-anon", username: "匿名", role: "anonymous", disabled: false };
    return mockDb.session;
  }

  async logout(): Promise<void> {
    mockDb.session = null;
  }

  async me(): Promise<SessionInfo | null> {
    return mockDb.session;
  }

  async createAdmin(username: string, _password: string, allowAnonymous?: boolean): Promise<void> {
    if (mockDb.users.some((u) => u.role === "admin")) fail("管理员已存在");
    mockDb.users.unshift({
      id: "u-admin",
      username,
      role: "admin",
      disabled: false,
      createdAt: new Date().toISOString(),
    });
    // BUG2：步 1「允许匿名访问」开关随 createAdmin 提交（缺省 false=安全默认）。
    mockDb.adminSettings.allowAnonymous = allowAnonymous ?? false;
  }

  async getWizardSteps(): Promise<WizardStep[]> {
    // 与 RPC 面同构：进度/文案由 lastLog 统一派生（progressText 含 current/total）。
    return structuredClone(mockDb.wizardSteps).map((step) => ({
      ...step,
      ...deriveStepProgress(step.status, step.lastLog),
    }));
  }

  async runWizardStep(id: string, force: boolean, params?: WizardRunParams): Promise<void> {
    void runWizardStepMock(id, force, params);
  }

  async cancelWizardStep(id: string): Promise<void> {
    await cancelWizardStepMock(id);
  }

  subscribeWizardSteps(onChange: () => void): () => void {
    return onWizardStepChange(onChange);
  }

  async completeSetup(): Promise<void> {
    mockDb.installed = true;
  }

  async listUsers(): Promise<UserInfo[]> {
    return structuredClone(mockDb.users);
  }

  async createUser(username: string, _password: string, role: UserInfo["role"]): Promise<UserInfo> {
    if (mockDb.users.some((u) => u.username === username)) fail("用户名已存在");
    const user: UserInfo = {
      id: `u-user-${(mockDb.userIdSeq += 1)}`,
      username,
      role,
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    mockDb.users.push(user);
    return structuredClone(user);
  }

  async changeUserPassword(_userId: string, _nextPassword: string): Promise<void> {
    // mock：无副作用（真实实现写入 scrypt 哈希）。
  }

  async setUserDisabled(userId: string, disabled: boolean): Promise<void> {
    const user = mockDb.users.find((candidate) => candidate.id === userId) ?? fail("账号不存在");
    user.disabled = disabled;
  }

  async deleteUser(userId: string): Promise<{ ok: boolean }> {
    mockDb.users.find((candidate) => candidate.id === userId) ?? fail("账号不存在");
    mockDb.users = mockDb.users.filter((candidate) => candidate.id !== userId);
    // 级联清理（mock 简化）：会话引用置空；任务/资源/结果的数据级联由 daemon 落实。
    if (mockDb.session?.userId === userId) mockDb.session = null;
    return { ok: true };
  }

  async getModelsCatalog(): Promise<ModelsCatalog> {
    return structuredClone(mockDb.modelsCatalog);
  }

  async refreshModelsCatalog(): Promise<ModelsCatalog> {
    // mock：模拟 models.dev 重拉成功（presets 原样，fetched_at 刷新）。
    mockDb.modelsCatalog.fetched_at = new Date().toISOString();
    return structuredClone(mockDb.modelsCatalog);
  }

  async updateAdminSettings(patch: Partial<AdminSettings>): Promise<AdminSettings> {
    mockDb.adminSettings = { ...mockDb.adminSettings, ...patch };
    return { ...mockDb.adminSettings };
  }

  // ---- 资源管理器（mock 引擎见 mock/resources.ts；owner 缺省 = 当前会话用户） ----

  private resOwner(owner?: string): string {
    return owner ?? mockDb.session?.username ?? "";
  }

  async resTree(resOwner?: string, parent?: string): Promise<ResTreeOutputView> {
    return mockResources.tree(this.resOwner(resOwner), parent);
  }

  async resMkdir(parent: string, name: string): Promise<ResourceItem> {
    return mockResources.mkdir(this.resOwner(), parent, name);
  }

  async resRename(id: string, name: string): Promise<ResourceItem> {
    return mockResources.rename(id, name);
  }

  async resMove(id: string, newParent: string): Promise<ResourceItem> {
    return mockResources.move(id, newParent);
  }

  async resDelete(id: string): Promise<ResDeleteOutput> {
    return mockResources.remove(id);
  }

  async resUpload(parent: string, file: File): Promise<ResUploadOutputView> {
    const b64 = await fileToBase64(file);
    return mockResources.upload(this.resOwner(), parent, file.name, b64, file.type || "application/octet-stream");
  }

  async resRawUrl(id: string): Promise<string | null> {
    return mockResources.rawUrl(id);
  }

  // ---- 知识库（mock：内存两级库 + 模拟修订流；无 git） ----

  private kbGroups = (): KbGroupView[] => mockDb.kbGroups as KbGroupView[];

  async listKb(): Promise<KbGroupView[]> {
    return structuredClone(this.kbGroups());
  }

  async saveKbGroup(input: { name: string; note?: string; newName?: string }): Promise<KbGroupView[]> {
    const groups = this.kbGroups();
    const existing = groups.find((g) => g.name === input.name);
    if (!existing) {
      groups.push({ name: input.name, note: input.note ?? "", entries: [] });
      mockDb.kbRevisions.unshift({ id: Math.random().toString(16).slice(2, 9), at: new Date().toISOString(), actor: "admin:admin", summary: `新增分组「${input.name}」` });
    } else {
      if (input.newName && input.newName !== input.name) existing.name = input.newName;
      if (input.note !== undefined) existing.note = input.note;
      mockDb.kbRevisions.unshift({ id: Math.random().toString(16).slice(2, 9), at: new Date().toISOString(), actor: "admin:admin", summary: `更新分组「${input.name}」` });
    }
    return structuredClone(groups);
  }

  async deleteKbGroup(name: string): Promise<KbGroupView[]> {
    mockDb.kbGroups = mockDb.kbGroups.filter((g: KbGroupView) => g.name !== name);
    mockDb.kbRevisions.unshift({ id: Math.random().toString(16).slice(2, 9), at: new Date().toISOString(), actor: "admin:admin", summary: `删除分组「${name}」` });
    return structuredClone(this.kbGroups());
  }

  async saveKbEntry(input: { group: string; key: string; value: string; newKey?: string }): Promise<KbGroupView[]> {
    const group = this.kbGroups().find((g) => g.name === input.group);
    if (!group) throw new Error(`分组不存在：${input.group}`);
    const entry = group.entries.find((e) => e.key === input.key);
    const finalKey = input.newKey ?? input.key;
    if (entry) {
      entry.key = finalKey;
      entry.value = input.value;
    } else {
      group.entries.push({ key: finalKey, value: input.value });
    }
    mockDb.kbRevisions.unshift({ id: Math.random().toString(16).slice(2, 9), at: new Date().toISOString(), actor: "admin:admin", summary: `${entry ? "更新" : "新增"}条目「${input.group}/${finalKey}」` });
    return structuredClone(this.kbGroups());
  }

  async deleteKbEntry(group: string, key: string): Promise<KbGroupView[]> {
    const g = this.kbGroups().find((x) => x.name === group);
    if (g) g.entries = g.entries.filter((e) => e.key !== key);
    mockDb.kbRevisions.unshift({ id: Math.random().toString(16).slice(2, 9), at: new Date().toISOString(), actor: "admin:admin", summary: `删除条目「${group}/${key}」` });
    return structuredClone(this.kbGroups());
  }

  async listKbRevisions(): Promise<{ available: boolean; revisions: KbRevisionView[] }> {
    return { available: true, revisions: structuredClone(mockDb.kbRevisions) };
  }

  async getKbRevision(id: string): Promise<KbRevisionDetailView> {
    const revision = mockDb.kbRevisions.find((r) => r.id === id);
    if (!revision) throw new Error(`修订不存在：${id}`);
    return {
      revision,
      changes: [{ path: "总结模式/兜底·通用讲评.md", status: "modified" }],
      snapshot: structuredClone(this.kbGroups()),
    };
  }

  async restoreKb(id: string): Promise<void> {
    void id;
  }

  async getModels(): Promise<ModelsSettings> {
    return structuredClone(mockDb.models);
  }

  async saveModels(next: ModelsSettings): Promise<void> {
    mockDb.models = structuredClone(next);
  }

  async testModelRoute(input: { api: string; baseURL: string; modelId: string }): Promise<ModelsTestResult> {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return input.baseURL.includes("bad")
      ? { ok: false, detail: "HTTP 401: invalid key" }
      : { ok: true, latencyMs: 240 };
  }

  async getAvailableModels() {
    const { routes, default: def } = mockDb.models;
    return {
      models: routes.flatMap((route) =>
        route.models.map((model) => ({
          provider: route.provider,
          model: model.id,
          name: model.name ?? model.id,
          ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
          ...(model.inputTypes !== undefined ? { inputTypes: model.inputTypes } : {}),
          ...(route.iconUrl !== undefined ? { iconUrl: route.iconUrl } : {}),
        })),
      ),
      default: def,
    };
  }

  async getLanUrls(): Promise<string[]> {
    // mock：以当前访问 host 推两条演示链接（IPv4 风格 + mDNS 主机名风格）。
    const port = location.port.length > 0 ? `:${location.port}` : "";
    return [`http://192.168.1.10${port}`, `http://${location.hostname}.local${port}`];
  }

  async listTasks(): Promise<Task[]> {
    return structuredClone(
      [...mockDb.tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
  }

  async getTaskFrames(taskId: string): Promise<Frame[]> {
    return [...(mockDb.frames.get(taskId) ?? [])];
  }

  subscribeTaskFrames(taskId: string, onFrame: (frame: Frame) => void): () => void {
    return onTaskFrame(taskId, onFrame);
  }

  async sendTaskPrompt(taskId: string, prompt: string): Promise<void> {
    void replayAgentTurn(taskId, prompt);
  }

  async stopTask(taskId: string): Promise<void> {
    const task = mockDb.tasks.find((t) => t.id === taskId);
    if (task && task.status === "running") task.status = "done";
  }

  async taskQueue(): Promise<TaskQueueListOutput> {
    return { items: [], editing: null };
  }

  async taskQueueEdit(): Promise<string> {
    return "";
  }

  async taskQueueEditConfirm(): Promise<void> {}

  async taskQueueEditCancel(): Promise<void> {}

  async taskQueueRemove(): Promise<void> {}

  async taskQueueSetMode(): Promise<void> {}

  async taskQueueReorder(): Promise<void> {}

  async taskQueueSendNow(): Promise<void> {}

  async createTask(
    prompt: string,
    video: File | null,
    model?: { provider: string; model: string; effort?: string },
  ): Promise<Task> {
    const task: Task = {
      id: `t-${mockDb.tasks.length + 1}-${Date.now() % 1000}`,
      title: prompt.slice(0, 18) || "新任务",
      status: "queued",
      prompt,
      videoName: video?.name ?? "演示素材.mp4",
      videoResourceId: null, // mock 无资源树联动（真后端由资源 id 驱动预览播放）
      modelProvider: model?.provider ?? null,
      modelModel: model?.model ?? null,
      modelEffort: model?.effort ?? null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mockDb.tasks.unshift(task);
    mockDb.frames.set(task.id, []);
    return structuredClone(task);
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = mockDb.tasks.find((t) => t.id === taskId);
    if (task) task.status = "cancelled";
  }

  async uploadAttachment(file: { name: string; dataBase64: string }): Promise<Attachment> {
    return {
      resourceId: `res-mock-${Date.now() % 1000}`,
      name: file.name,
      path: `/tmp/zhumo-mock/${file.name}`,
      size: Math.round(file.dataBase64.length * 0.75),
      rawUrl: (width?: number) => `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${width ?? 96}' height='${width ?? 96}'%3E%3Crect fill='%23ddd' width='100%25' height='100%25'/%3E%3C/svg%3E`,
    };
  }

  async setTaskModel(taskId: string, provider: string, model: string, effort?: string | null): Promise<Task> {
    const task = mockDb.tasks.find((t) => t.id === taskId);
    if (task === undefined) throw new Error("任务不存在");
    task.modelProvider = provider;
    task.modelModel = model;
    task.modelEffort = effort === undefined ? task.modelEffort : effort;
    return { ...task };
  }

  async composerList(): Promise<ComposerCatalog> {
    return {
      commands: [
        { name: "compact", description: "压缩对话历史以释放上下文" },
        { name: "feedback", description: "提交反馈" },
      ],
      skills: [
        {
          name: "shufa",
          description: "书法/作业讲评视频分析管线手册",
          when_to_use: "分析书法讲评视频时",
        },
      ],
    };
  }

  async getTaskResults(taskId: string): Promise<TaskResultRefView[]> {
    return mockDb.taskResults.get(taskId) ?? [];
  }

  async getResult(publicId: string): Promise<ResultInfo> {
    return mockDb.results.get(publicId) ?? fail("结果不存在或已下架");
  }
}

/** mock 上传：File → base64（分块拼接避开 String.fromCharCode 栈上限）。 */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------- RpcApi（W7 实装）

const TOKEN_KEY = "shufa.jwt";

function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string | null): void {
  if (token === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
  cachedRpc = null; // token 变更 → 重建 WS 连接（token 在 upgrade query 上）
}

let cachedRpc: ShufaRpc | null = null;

/** 同源 oRPC-over-WS 客户端；daemon 托管 webui 时天然同源（ws(s)://host/ws/rpc）。 */
function rpc(): ShufaRpc {
  if (cachedRpc !== null) return cachedRpc;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const token = getToken();
  const ws = new WebSocket(
    `${proto}//${location.host}/ws/rpc${token ? `?token=${encodeURIComponent(token)}` : ""}`,
  );
  const link = new RPCLink({ websocket: ws });
  cachedRpc = createORPCClient(link) as unknown as ShufaRpc;
  return cachedRpc;
}

function isForbiddenOrUnauthorized(error: unknown): boolean {
  return isUnauthorized(error) || (error as { code?: string })?.code === "FORBIDDEN";
}

function isUnauthorized(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === "UNAUTHORIZED" || /UNAUTHORIZED|401/i.test(error instanceof Error ? error.message : String(error));
}

/** 契约 ↔ W3 视图命名映射（mock 时代 camelCase 字段在此收敛为唯一出参）。 */
function toSession(user: ContractUserInfo): SessionInfo {
  return { userId: user.id, username: user.username, role: user.role, disabled: user.disabled };
}

function toUserView(user: ContractUserInfo): UserInfo {
  return { ...user, createdAt: user.created_at };
}

interface DownloadProgress {
  /** 0-100 浮点（两位小数精度，走查 2026-09-24 · 三轮：badge「下载中 nn.nn%」）。 */
  percent: number;
  /** 「12.3MB / 148.0MB（8.31%）」进度文案；解析不出为 null（命令类步骤/无进度行）。 */
  text: string | null;
}

/**
 * 从下载类日志解析进度（BUG1 扩展）：后端格式「已下载 12.3MB / 148.0MB（8%）」，
 * 同时取百分比与 current/total 文案。日志为追加式，取最后一次匹配（最新进度）；
 * 缺百分比时按 MB 比值折算；续传时 total 不变、current 从偏移起跳，正则原样兼容。
 */
function parseDownloadProgress(log: string): DownloadProgress {
  // 不再取整：MB 比值折算保留两位小数（走查 2026-09-24 · 三轮），显式整数百分比
  // 仅在 MB 缺失时兜底。
  const clamp = (value: number): number => Math.min(100, Math.max(0, value));
  const re =
    /已下载\s*([\d.]+)\s*(KB|MB|GB)\s*\/\s*([\d.]+)\s*(KB|MB|GB)(?:\s*（(\d+(?:\.\d+)?)%）)?/g;
  let last: RegExpExecArray | null = null;
  for (let match = re.exec(log); match !== null; match = re.exec(log)) last = match;
  if (last === null) return { percent: 0, text: null };
  const current = `${last[1]}${last[2]}`;
  const total = `${last[3]}${last[4]}`;
  const downloaded = Number.parseFloat(last[1] ?? "0");
  const totalNumber = Number.parseFloat(last[3] ?? "0");
  const explicit = last[5] === undefined ? null : Number.parseFloat(last[5] ?? "");
  const percent =
    totalNumber > 0
      ? clamp((downloaded / totalNumber) * 100)
      : explicit !== null && Number.isFinite(explicit)
        ? clamp(explicit)
        : 0;
  return { percent, text: `${current} / ${total}（${percent.toFixed(2)}%）` };
}

/**
 * 步骤进度统一派生（RPC 与 mock 共用，BUG1）：done→100（文案保留最后一行进度，
 * 不清空）；running/failed→按日志解析（failed 保留已达到的进度，呈现失败态）；
 * pending/skipped→0。
 */
function deriveStepProgress(
  status: WizardStep["status"],
  lastLog: string,
): { progress: number; progressText?: string } {
  if (status === "pending" || status === "skipped") return { progress: 0 };
  const parsed = parseDownloadProgress(lastLog);
  if (status === "done") return { progress: 100, progressText: parsed.text ?? undefined };
  return { progress: parsed.percent, progressText: parsed.text ?? undefined };
}

/** admin.models.get 出参 → ModelsSettings 视图（字段同名直投）。 */
function toModelsView(out: { routes: unknown[]; default: unknown }): ModelsSettings {
  return out as ModelsSettings;
}

function toWizardStepView(step: ContractWizardStep): WizardStep {
  return {
    id: step.id,
    kind: step.kind,
    title: step.title,
    command: step.command ?? undefined,
    url: step.url ?? undefined,
    targetDir: step.target_dir,
    status: step.status,
    lastLog: step.last_log ?? "",
    ...deriveStepProgress(step.status, step.last_log ?? ""),
    detected: step.status === "done" && (step.last_log ?? "").includes("嗅探"),
    resumable: step.resumable ?? false,
    updatedAt: step.updated_at,
  };
}

function toTaskView(task: TaskItem): Task {
  return {
    id: task.id,
    title: task.title ?? ((task.prompt ?? "").slice(0, 18) || "新任务"),
    status: task.status,
    prompt: task.prompt ?? "",
    videoName: task.video_name ?? "未附视频",
    videoResourceId: task.video_resource_id,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    error: task.error ?? null,
    modelProvider: task.model_provider ?? null,
    modelModel: task.model_model ?? null,
    modelEffort: task.model_effort ?? null,
  };
}

class RpcApi implements ShufaApi {
  /** 帧游标（task → 已见最大 seq）：subscribe 从此增量，避免回放重复。 */
  private readonly frameCursor = new Map<string, number>();

  async getBootstrap(): Promise<BootstrapInfo> {
    const out = await rpc().bootstrap();
    return {
      needsSetup: out.needs_setup,
      allowAnonymous: out.allow_anonymous,
      siteName: out.site_name,
      // 契约 BootstrapOutput.model_route 必填可空；?? null 兜底旧 daemon 缺字段。
      modelRoute: out.model_route ?? null,
      // BUG2：setup_progress 契约由 daemon 并行落地；缺字段时归一 null（向导自由步进）。
      setupProgress: out.setup_progress ?? null,
      setupCompleted: out.setup_completed ?? false,
    };
  }

  async login(username: string, password: string): Promise<SessionInfo> {
    const out = await rpc().auth.login({ username, password });
    setToken(out.token);
    return toSession(out.user);
  }

  async loginAnonymous(): Promise<SessionInfo> {
    const out = await rpc().auth.anonymous();
    setToken(out.token);
    return toSession(out.user);
  }

  async logout(): Promise<void> {
    setToken(null);
  }

  async me(): Promise<SessionInfo | null> {
    const token = getToken();
    if (token === null) return null;
    try {
      return toSession(await rpc().me());
    } catch (error) {
      if (!isUnauthorized(error)) return null;
      try {
        const refreshed = await rpc().auth.refresh({ token });
        setToken(refreshed.token);
        return toSession(refreshed.user);
      } catch {
        setToken(null);
        return null;
      }
    }
  }

  async createAdmin(username: string, password: string, allowAnonymous?: boolean): Promise<void> {
    // BUG2：allow_anonymous 随建管理员提交；缺省 false（安全默认：未开匿名则必须登录）。
    const input: CreateAdminRpcInput = { username, password, allow_anonymous: allowAnonymous ?? false };
    const out = await rpc().setup.createAdmin(input);
    setToken(out.token);
  }

  /** 向导步骤面：setup 优先（未配置态，匿名 token 也可读）；完成后 403 → 回退 admin 面。 */
  async getWizardSteps(): Promise<WizardStep[]> {
    try {
      return (await rpc().setup.steps()).steps.map(toWizardStepView);
    } catch (error) {
      if (!isForbiddenOrUnauthorized(error)) throw error;
      return (await rpc().admin.wizard.steps()).steps.map(toWizardStepView);
    }
  }

  async runWizardStep(id: string, force: boolean, params?: WizardRunParams): Promise<void> {
    // 契约 WizardRunInput 已含可选 model/mirror（whisper-model 参数化下载）。
    const input: WizardRunInput = { id, force, ...params };
    try {
      await rpc().setup.runStep(input);
    } catch (error) {
      if (!isForbiddenOrUnauthorized(error)) throw error;
      await rpc().admin.wizard.runStep(input);
    }
  }

  async cancelWizardStep(id: string): Promise<void> {
    // 与 runStep 同型的 setup 优先回退（完成后 setup 面 403 → admin 面）。
    try {
      await rpc().setup.cancelStep({ id });
    } catch (error) {
      if (!isForbiddenOrUnauthorized(error)) throw error;
      await rpc().admin.wizard.cancelStep({ id });
    }
  }

  subscribeWizardSteps(onChange: () => void): () => void {
    return onWizardStepChange(onChange);
  }

  async completeSetup(): Promise<void> {
    await rpc().setup.complete();
  }

  async listUsers(): Promise<UserInfo[]> {
    const out = await rpc().admin.users.list();
    return out.users.map(toUserView);
  }

  async createUser(username: string, password: string, role: UserInfo["role"]): Promise<UserInfo> {
    if (role === "anonymous") throw new Error("匿名角色不可创建");
    return toUserView(await rpc().admin.users.create({ username, password, role }));
  }

  async changeUserPassword(userId: string, nextPassword: string): Promise<void> {
    await rpc().admin.users.update({ id: userId, password: nextPassword });
  }

  async setUserDisabled(userId: string, disabled: boolean): Promise<void> {
    await rpc().admin.users.update({ id: userId, disabled });
  }

  async deleteUser(userId: string): Promise<{ ok: boolean }> {
    // 契约 admin.users.delete（daemon 并行落地）：删除=任务/资源/结果页数据级联清理。
    return rpc().admin.users.delete({ id: userId });
  }

  async getModelsCatalog(): Promise<ModelsCatalog> {
    return rpc().admin.models.catalog();
  }

  async refreshModelsCatalog(): Promise<ModelsCatalog> {
    return rpc().admin.models.catalogRefresh();
  }

  async getModels(): Promise<ModelsSettings> {
    return toModelsView(await rpc().admin.models.get());
  }

  async saveModels(next: ModelsSettings): Promise<void> {
    // 保存面：apiKey 字段仅在非空时上送（空=保留旧密钥）；hasKey 不上行。
    await rpc().admin.models.save({
      routes: next.routes.map((route) => ({
        provider: route.provider,
        api: route.api,
        baseURL: route.baseURL,
        ...(route.iconUrl !== undefined ? { iconUrl: route.iconUrl } : {}),
        models: route.models,
        ...(route.apiKey !== undefined && route.apiKey.length > 0 ? { apiKey: route.apiKey } : {}),
      })),
      default: next.default,
    });
  }

  async testModelRoute(input: { api: string; baseURL: string; modelId: string; apiKey?: string; provider?: string }): Promise<ModelsTestResult> {
    return rpc().admin.models.test(input);
  }

  async getAvailableModels() {
    return rpc().models.available();
  }

  private async readAdminSettings(): Promise<Map<string, string>> {
    const { settings } = await rpc().admin.settings.list();
    return new Map(settings.map((entry) => [entry.key, entry.value]));
  }

  async updateAdminSettings(patch: Partial<AdminSettings>): Promise<AdminSettings> {
    const stored = await this.readAdminSettings();
    const current: AdminSettings = {
      siteBaseUrl: stored.get("site_base_url") ?? "",
      allowAnonymous: (stored.get("allow_anonymous") ?? "1") === "1",
    };
    const puts: Array<[SettingKey, string]> = [];
    if (patch.siteBaseUrl !== undefined && patch.siteBaseUrl !== current.siteBaseUrl) {
      puts.push(["site_base_url", patch.siteBaseUrl]);
    }
    if (patch.allowAnonymous !== undefined && patch.allowAnonymous !== current.allowAnonymous) {
      puts.push(["allow_anonymous", patch.allowAnonymous ? "1" : "0"]);
    }
    for (const [key, value] of puts) await rpc().admin.settings.put({ key, value });
    return { ...current, ...patch };
  }

  async getLanUrls(): Promise<string[]> {
    const out = await rpc().admin.settings.lan();
    return out.urls;
  }

  async listTasks(): Promise<Task[]> {
    const { tasks } = await rpc().tasks.list();
    for (const task of tasks) {
      if (task.agent_session_id === null) this.frameCursor.delete(task.id);
    }
    return tasks.map(toTaskView);
  }

  async getTaskFrames(taskId: string): Promise<Frame[]> {
    const out = await rpc().tasks.get({ id: taskId, after_seq: 0 });
    let last = 0;
    const frames = out.frames.map((frame) => {
      last = Math.max(last, frame.seq);
      return frame as unknown as Frame;
    });
    this.frameCursor.set(taskId, last);
    return frames;
  }

  /** /ws/tasks/{id}?token=&after_seq= 原生 WS 推送（daemon 现成实现）。 */
  subscribeTaskFrames(taskId: string, onFrame: (frame: Frame) => void): () => void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const token = getToken();
    const afterSeq = this.frameCursor.get(taskId) ?? 0;
    const ws = new WebSocket(
      `${proto}//${location.host}/ws/tasks/${encodeURIComponent(taskId)}?after_seq=${afterSeq}${token ? `&token=${encodeURIComponent(token)}` : ""}`,
    );
    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data) as Frame;
        this.frameCursor.set(taskId, Math.max(this.frameCursor.get(taskId) ?? 0, frame.seq));
        onFrame(frame);
      } catch {
        // 畸形帧丢弃
      }
    };
    return () => ws.close();
  }

  /** 前台续聊（W7b；W10 加 mode）：followup=排队（缺省）/ steer=引导当前轮。 */
  async sendTaskPrompt(taskId: string, text: string, mode?: "followup" | "steer"): Promise<void> {
    await rpc().tasks.followup({ id: taskId, text, ...(mode === "steer" ? { mode } : {}) });
  }

  /** 打断当前轮（W10）：后端 cancel{user}+keepInbox，任务回 done 可续聊。 */
  async stopTask(taskId: string): Promise<void> {
    await rpc().tasks.stop({ id: taskId });
  }

  taskQueue(taskId: string): Promise<TaskQueueListOutput> {
    return rpc().tasks.queueList({ id: taskId });
  }

  async taskQueueEdit(taskId: string, messageId: string): Promise<string> {
    const out = await rpc().tasks.queueEdit({ id: taskId, message_id: messageId });
    return out.text;
  }

  async taskQueueEditConfirm(taskId: string, text: string): Promise<void> {
    await rpc().tasks.queueEditConfirm({ id: taskId, text });
  }

  async taskQueueEditCancel(taskId: string): Promise<void> {
    await rpc().tasks.queueEditCancel({ id: taskId });
  }

  async taskQueueRemove(taskId: string, messageId: string): Promise<void> {
    await rpc().tasks.queueRemove({ id: taskId, message_id: messageId });
  }

  async taskQueueSetMode(taskId: string, messageId: string, mode: TaskQueueMode): Promise<void> {
    await rpc().tasks.queueSetMode({ id: taskId, message_id: messageId, mode });
  }

  async taskQueueReorder(taskId: string, orderedIds: string[]): Promise<void> {
    await rpc().tasks.queueReorder({ id: taskId, ordered_ids: orderedIds });
  }

  async taskQueueSendNow(taskId: string, messageId: string): Promise<void> {
    await rpc().tasks.queueSendNow({ id: taskId, message_id: messageId });
  }

  async createTask(
    prompt: string,
    video: File | null,
    model?: { provider: string; model: string; effort?: string },
  ): Promise<Task> {
    if (video === null) throw new Error("请先选择素材视频（创建任务必须附带视频）");
    const item = await rpc().tasks.create({
      prompt,
      video: { filename: video.name, data_base64: await fileToBase64(video) },
      ...(model ? { model } : {}),
    });
    return toTaskView(item);
  }

  async cancelTask(taskId: string): Promise<void> {
    await rpc().tasks.cancel({ id: taskId });
  }

  async uploadAttachment(file: { name: string; dataBase64: string }): Promise<Attachment> {
    const out = await rpc().res.attachmentUpload({
      filename: file.name,
      data_base64: file.dataBase64,
    });
    return {
      resourceId: out.resource_id,
      name: out.name,
      path: out.path,
      size: out.size,
      rawUrl: (width?: number) => {
        const token = encodeURIComponent(getToken() ?? "");
        const w = width !== undefined ? `&w=${width}` : "";
        return `/api/res/${out.resource_id}/raw?token=${token}${w}`;
      },
    };
  }

  async setTaskModel(taskId: string, provider: string, model: string, effort?: string | null): Promise<Task> {
    const out = await rpc().tasks.setModel({
      task_id: taskId,
      provider,
      model,
      ...(effort !== undefined ? { effort } : {}),
    });
    return toTaskView(out.task);
  }

  async composerList(): Promise<ComposerCatalog> {
    return rpc().composer.list();
  }

  /** 任务的导出结果列表（新→旧）。after_seq 取极大值 = 只取 results 不回放帧。 */
  async getTaskResults(taskId: string): Promise<TaskResultRefView[]> {
    const out = await rpc().tasks.get({ id: taskId, after_seq: Number.MAX_SAFE_INTEGER });
    return out.results.map((r) => ({
      publicId: r.public_id,
      title: r.title ?? null,
      createdAt: r.created_at,
    }));
  }

  /** 结果页公开元数据走公开 HTTP 面（/api/results/{public_id}，匿名可读）。 */
  async getResult(publicId: string): Promise<ResultInfo> {
    const response = await fetch(`/api/results/${encodeURIComponent(publicId)}`);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `结果不存在或已下架（HTTP ${response.status}）`);
    }
    const body = (await response.json()) as { public_id: string; title: string | null; created_at: string };
    return { publicId: body.public_id, title: body.title ?? "", createdAt: body.created_at };
  }

  // ---- 资源管理器（真后端） ----

  async resTree(resOwner?: string, parent?: string): Promise<ResTreeOutputView> {
    return (await rpc().res.tree({ owner: resOwner, parent })) as unknown as ResTreeOutputView;
  }

  async resMkdir(parent: string, name: string): Promise<ResourceItem> {
    return (await rpc().res.mkdir({ parent, name })).item;
  }

  async resRename(id: string, name: string): Promise<ResourceItem> {
    return (await rpc().res.rename({ id, name })).item;
  }

  async resMove(id: string, newParent: string): Promise<ResourceItem> {
    return (await rpc().res.move({ id, new_parent: newParent })).item;
  }

  async resDelete(id: string): Promise<ResDeleteOutput> {
    return rpc().res.delete({ id });
  }

  async resUpload(parent: string, file: File): Promise<ResUploadOutputView> {
    const out = await rpc().res.upload({
      parent,
      filename: file.name,
      b64: await fileToBase64(file),
    });
    return out as unknown as ResUploadOutputView;
  }

  async resRawUrl(id: string): Promise<string | null> {
    const token = getToken();
    if (token === null) return null;
    return `/api/res/${encodeURIComponent(id)}/raw?token=${encodeURIComponent(token)}`;
  }

  // ---- 知识库（真后端：admin.kb.*） ----

  async listKb(): Promise<KbGroupView[]> {
    return (await rpc().admin.kb.list()).groups;
  }

  async saveKbGroup(input: { name: string; note?: string; newName?: string }): Promise<KbGroupView[]> {
    return (await rpc().admin.kb.saveGroup(input)).groups;
  }

  async deleteKbGroup(name: string): Promise<KbGroupView[]> {
    return (await rpc().admin.kb.deleteGroup({ name })).groups;
  }

  async saveKbEntry(input: { group: string; key: string; value: string; newKey?: string }): Promise<KbGroupView[]> {
    return (await rpc().admin.kb.saveEntry(input)).groups;
  }

  async deleteKbEntry(group: string, key: string): Promise<KbGroupView[]> {
    return (await rpc().admin.kb.deleteEntry({ group, key })).groups;
  }

  async listKbRevisions(): Promise<{ available: boolean; revisions: KbRevisionView[] }> {
    return rpc().admin.kb.revisions();
  }

  async getKbRevision(id: string): Promise<KbRevisionDetailView> {
    return rpc().admin.kb.revisionGet({ id });
  }

  async restoreKb(id: string): Promise<void> {
    await rpc().admin.kb.restore({ id });
  }

}

/** 页面层唯一取用点：api.xxx()；切换实现不改调用方。 */
export function getApi(): ShufaApi {
  return USE_MOCK ? new MockApi() : new RpcApi();
}

export const api: ShufaApi = getApi();
