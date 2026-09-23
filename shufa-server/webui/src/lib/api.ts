/**
 * 统一 API 出口（webui ↔ daemon 契约的浏览器侧唯一入口）。
 * 原始需求 [2026-09-23]；W7 联调：RpcApi 实装（@orpc/client RPCLink over
 * WebSocket 连同源 /ws/rpc?token=，JWT 存 localStorage，401 自动 refresh 一次）。
 * mock 保留为逃生口：URL 带 ?mock=1 时启用（tests/离线演示）。
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
  TaskCreateInput,
  TaskFollowupInput,
  TaskFollowupOutput,
  TaskGetInput,
  TaskGetOutput,
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
  runWizardStepMock,
} from "$lib/mock/data";
import { mockResources } from "$lib/mock/resources";
import type {
  AdminSettings,
  BootstrapInfo,
  DshModelRoute,
  Frame,
  ModelRouteInfo,
  ModelsSettings,
  ResTreeOutput as ResTreeOutputView,
  ResUploadOutput as ResUploadOutputView,
  ResourceItem,
  ResultInfo,
  SessionInfo,
  Task,
  UserInfo,
  WizardRunParams,
  WizardStep,
} from "$lib/types";

/** mock 逃生口：默认走真 RPC；?mock=1 才启用 mock（联调期测试/离线演示用）。 */
export const USE_MOCK = new URLSearchParams(location.search).has("mock");

// ---- oRPC 客户端手写面（端点形状以 contracts 为准；不引 daemon 源码类型，
//      避免 server 依赖类型穿透进 webui 类型检查） ----

interface ResItemOutputView {
  item: ResourceItem;
}

interface ShufaRpc {
  bootstrap(): Promise<BootstrapOutput>;
  setup: {
    createAdmin(input: CreateAdminInput): Promise<TokenOutput>;
    steps(): Promise<WizardStepsOutput>;
    runStep(input: WizardRunInput): Promise<ContractWizardStep>;
    complete(): Promise<{ ok: true }>;
  };
  auth: {
    login(input: { username: string; password: string }): Promise<TokenOutput>;
    anonymous(): Promise<TokenOutput>;
    refresh(input: RefreshInput): Promise<TokenOutput>;
  };
  me(): Promise<ContractUserInfo>;
  admin: {
    users: {
      list(): Promise<{ users: ContractUserInfo[] }>;
      create(input: CreateUserInput): Promise<ContractUserInfo>;
      update(input: UpdateUserInput): Promise<ContractUserInfo>;
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
    };
  };
  tasks: {
    list(): Promise<{ tasks: TaskItem[] }>;
    create(input: TaskCreateInput): Promise<TaskItem>;
    get(input: TaskGetInput): Promise<TaskGetOutput>;
    cancel(input: TaskCancelInput): Promise<TaskItem>;
    followup(input: TaskFollowupInput): Promise<TaskFollowupOutput>;
  };
  res: {
    tree(input: ResTreeInput): Promise<ContractResTreeOutput>;
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
  createAdmin(username: string, password: string): Promise<void>;
  getWizardSteps(): Promise<WizardStep[]>;
  /** params 仅 whisper-model 步骤携带（model/mirror），其余步骤不传。 */
  runWizardStep(id: string, force: boolean, params?: WizardRunParams): Promise<void>;
  subscribeWizardSteps(onChange: () => void): () => void;
  completeSetup(): Promise<void>;
  listUsers(): Promise<UserInfo[]>;
  createUser(username: string, password: string, role: UserInfo["role"]): Promise<UserInfo>;
  changeUserPassword(userId: string, nextPassword: string): Promise<void>;
  updateAdminSettings(patch: Partial<AdminSettings>): Promise<AdminSettings>;
  getModels(): Promise<ModelsSettings>;
  saveModels(next: ModelsSettings): Promise<void>;
  /** 局域网访问链接（BUG3）；失败由调用方降级隐藏（不报错弹脸）。 */
  getLanUrls(): Promise<string[]>;
  listTasks(): Promise<Task[]>;
  getTaskFrames(taskId: string): Promise<Frame[]>;
  subscribeTaskFrames(taskId: string, onFrame: (frame: Frame) => void): () => void;
  sendTaskPrompt(taskId: string, prompt: string): Promise<void>;
  createTask(prompt: string, video: File | null): Promise<Task>;
  cancelTask(taskId: string): Promise<void>;
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
}

const fail = (msg: string): never => {
  throw new Error(msg);
};

/** mock bootstrap 的生效路由投影：active 指向现存路由 → settings 来源；否则 null。 */
function toMockModelRoute(): ModelRouteInfo | null {
  const { routes, active } = mockDb.models;
  const route = routes.find((candidate) => candidate.provider === active.provider);
  if (route === undefined || active.model.length === 0) return null;
  return { provider: route.provider, model: active.model, source: "settings" };
}

class MockApi implements ShufaApi {
  async getBootstrap(): Promise<BootstrapInfo> {
    // dev 覆盖（仅 mock 层；真 API 无此逻辑）：?installed=1 跳过安装门控，
    // ?as=admin 模拟管理员会话——供冒烟截图与联调直达页面。
    const devParams = new URLSearchParams(location.search);
    if (devParams.has("installed")) mockDb.installed = true;
    if (devParams.get("as") === "admin") {
      mockDb.session = { userId: "u-admin", username: "admin", role: "admin" };
    }
    return {
      needsSetup: !mockDb.installed,
      allowAnonymous: mockDb.adminSettings.allowAnonymous,
      siteName: mockDb.siteName,
      // mock 与真 API 同形：路由清空后前台进入「未配置」阻断态（R4 自测口）。
      modelRoute: toMockModelRoute(),
    };
  }

  async login(username: string, password: string): Promise<SessionInfo> {
    // 演示口令：admin/admin123、王老师/user123；真实实现走 POST /api/auth/login（scrypt 校验）。
    const known: Record<string, string> = { admin: "admin123", 王老师: "user123" };
    if (known[username] !== password) fail("用户名或密码错误");
    const user = mockDb.users.find((u) => u.username === username) ?? fail("账号不存在");
    if (user.disabled) fail("账号已被禁用");
    mockDb.session = { userId: user.id, username: user.username, role: user.role };
    return mockDb.session;
  }

  async loginAnonymous(): Promise<SessionInfo> {
    if (!mockDb.adminSettings.allowAnonymous) fail("本站未开启匿名访问");
    mockDb.session = { userId: "u-anon", username: "匿名", role: "anonymous" };
    return mockDb.session;
  }

  async logout(): Promise<void> {
    mockDb.session = null;
  }

  async me(): Promise<SessionInfo | null> {
    return mockDb.session;
  }

  async createAdmin(username: string, _password: string): Promise<void> {
    mockDb.users.unshift({
      id: "u-admin",
      username,
      role: "admin",
      disabled: false,
      createdAt: new Date().toISOString(),
    });
  }

  async getWizardSteps(): Promise<WizardStep[]> {
    return structuredClone(mockDb.wizardSteps);
  }

  async runWizardStep(id: string, force: boolean, params?: WizardRunParams): Promise<void> {
    void runWizardStepMock(id, force, params);
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
      id: `u-${mockDb.users.length + 1}`,
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

  async getModels(): Promise<ModelsSettings> {
    return structuredClone(mockDb.models);
  }

  async saveModels(next: ModelsSettings): Promise<void> {
    mockDb.models = structuredClone(next);
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

  async createTask(prompt: string, video: File | null): Promise<Task> {
    const task: Task = {
      id: `t-${mockDb.tasks.length + 1}-${Date.now() % 1000}`,
      title: prompt.slice(0, 18) || "新任务",
      status: "queued",
      prompt,
      videoName: video?.name ?? "演示素材.mp4",
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
  return { userId: user.id, username: user.username, role: user.role };
}

function toUserView(user: ContractUserInfo): UserInfo {
  return { ...user, createdAt: user.created_at };
}

/**
 * 从下载类 running 日志解析进度百分比：形如「已下载 12.3MB / 148.0MB（8%）」
 * 取括号内百分比；缺百分比时按 MB 比值折算；解析不出保持 0（轨道空但不碍事）。
 */
function parseDownloadProgress(log: string): number {
  const clamp = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));
  const percent = /（(\d+(?:\.\d+)?)%）/.exec(log);
  if (percent !== null) {
    const value = Number.parseFloat(percent[1] ?? "");
    if (Number.isFinite(value)) return clamp(value);
  }
  const ratio = /已下载\s*([\d.]+)\s*(?:KB|MB|GB)\s*\/\s*([\d.]+)\s*(?:KB|MB|GB)/.exec(log);
  if (ratio !== null) {
    const downloaded = Number.parseFloat(ratio[1] ?? "");
    const total = Number.parseFloat(ratio[2] ?? "");
    if (Number.isFinite(downloaded) && Number.isFinite(total) && total > 0) {
      return clamp((downloaded / total) * 100);
    }
  }
  return 0;
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
    progress:
      step.status === "done"
        ? 100
        : step.status === "running"
          ? parseDownloadProgress(step.last_log ?? "")
          : 0,
    detected: step.status === "done" && (step.last_log ?? "").includes("嗅探"),
    updatedAt: step.updated_at,
  };
}

function toTaskView(task: TaskItem): Task {
  return {
    id: task.id,
    title: (task.prompt ?? "").slice(0, 18) || "新任务",
    status: task.status,
    prompt: task.prompt ?? "",
    videoName: task.video_resource_id !== null ? "素材视频" : "未附视频",
    createdAt: task.created_at,
    updatedAt: task.updated_at,
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

  async createAdmin(username: string, password: string): Promise<void> {
    const out = await rpc().setup.createAdmin({ username, password });
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

  /** Models 配置 ↔ settings 表 llm_* 五键（单路由投影；api 为 wire 协议，缺省由桥接定）。 */
  async getModels(): Promise<ModelsSettings> {
    const stored = await this.readAdminSettings();
    const value = (key: SettingKey): string => stored.get(key) ?? "";
    if (value("llm_provider").length === 0 && value("llm_base_url").length === 0) {
      return { routes: [], active: { provider: "", model: "" } };
    }
    const route: DshModelRoute = {
      provider: value("llm_provider") || "default",
      baseURL: value("llm_base_url"),
      apiKey: value("llm_api_key") || undefined,
      // 缺省显式化为 anthropic-messages（与 daemon 桥接一致），UI 单选不再留空。
      api: value("llm_api") || "anthropic-messages",
      models: value("llm_model") ? [{ id: value("llm_model") }] : [],
    };
    return { routes: [route], active: { provider: route.provider, model: value("llm_model") } };
  }

  async saveModels(next: ModelsSettings): Promise<void> {
    const route = next.routes.find((candidate) => candidate.provider === next.active.provider) ?? next.routes[0];
    // 活动模型未显式选择时回退该路由首个模型，避免「编辑了模型列表但保存后丢失」。
    const activeModel = next.active.model || route?.models[0]?.id || "";
    const puts: Array<[SettingKey, string]> = [
      ["llm_provider", route?.provider ?? ""],
      ["llm_base_url", route?.baseURL ?? ""],
      ["llm_api_key", route?.apiKey ?? ""],
      ["llm_api", route?.api ?? ""],
      ["llm_model", activeModel],
    ];
    for (const [key, value] of puts) await rpc().admin.settings.put({ key, value });
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

  /** 前台续聊（W7b）：running 排队投递；done/failed 先 resume（任务回 running）。 */
  async sendTaskPrompt(taskId: string, text: string): Promise<void> {
    await rpc().tasks.followup({ id: taskId, text });
  }

  async createTask(prompt: string, video: File | null): Promise<Task> {
    if (video === null) throw new Error("请先选择素材视频（创建任务必须附带视频）");
    const item = await rpc().tasks.create({
      prompt,
      video: { filename: video.name, data_base64: await fileToBase64(video) },
    });
    return toTaskView(item);
  }

  async cancelTask(taskId: string): Promise<void> {
    await rpc().tasks.cancel({ id: taskId });
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

}

/** 页面层唯一取用点：api.xxx()；切换实现不改调用方。 */
export function getApi(): ShufaApi {
  return USE_MOCK ? new MockApi() : new RpcApi();
}

export const api: ShufaApi = getApi();
