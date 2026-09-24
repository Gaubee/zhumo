/**
 * 任务编排服务（PRODUCT_DESIGN.md §3 前台任务流 + §5 tasks 表 + §6 工作流）。
 * 原始需求 2026-09-23（W4）：创建任务（视频进本人资源树 + 建 .shufa 任务目录 +
 * 建会话 + 注入提示词 + 启动）/详情（帧回放）/取消（agent.cancel("user")）/
 * export 收尾（bundle → results 行 + public_id → result 帧）/WS 帧流。
 * 走查 2026-09-23：BUG2 模型路由门控（未配置拒绝创建）+ 架构调整（用户目录为根：
 * 绑定/会话 cwd/提示词/containment 全部以 userRoot 为相对基准）。
 * 正交意图：
 *   [1] create：资源树落位（任务目录/视频 blob/.shufa 目录）+ 会话启动。
 *   [2] 读取面：list/get（含 afterSeq 帧回放）+ 归属校验（admin 豁免）。
 *   [3] cancel 与 resume（跨重启 running 任务的会话复活）。
 *   [4] capability 绑定面：findTaskByDir（containment）+ onExported（结果收尾）。
 *   [5] openFrameStream：WS 推送订阅（回放 + live 二段）。
 */
import { copyFileSync, existsSync, linkSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { ORPCError } from '@orpc/server';
import type {
  Frame,
  ModelRouteInfo,
  TaskFollowupOutput,
  TaskGetOutput,
  TaskItem,
  TaskStatus,
} from '@zhumo/contracts';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import { BlobStore } from '../db/blobs.js';
import {
  createResource,
  createTask,
  getTaskById,
  getResourceById,
  listTasksByOwner,
  parseResourceMeta,
  updateResourceMeta,
  updateTask,
  updateTaskTitleBySession,
  type ResourceRow,
  type TaskRow,
} from '../db/tasks.js';
import { createResult, getResultByTaskBundle, listResultsByTask, touchResult, type UserRow } from '../db/store.js';
import {
  resolveModelRoute,
  type ModelRoutesBundle,
} from '../kernel/model-route.js';
import { buildRoutesBundle, loadModelsConfig, resolveRouteFor } from '../models-store.js';
import { buildTaskPrompt } from '../kernel/prompts.js';
import type { TaskSessions } from '../kernel/sessions.js';
import { createAnalysisCapabilities, type TaskLocation } from '../capability/analysis.js';
import { createKnowledgeCapabilities } from '../capability/knowledge.js';
import { createCapabilityRegistry, type CapabilityRegistry } from '../capability/core.js';
import type { KbStore } from '../kb/store.js';
import { mdnsUrlFor } from '../lan.js';

const VIDEO_MAX_BYTES = 256 * 1024 * 1024;

export interface TaskServiceDeps {
  config: AppConfig;
  db: SqliteDb;
  blobs: BlobStore;
  sessions: TaskSessions;
  /** 内核是否已挂载（未挂载时 create 拒绝而非静默产出僵尸任务）。 */
  kernelMounted: () => boolean;
  /** 书法领域知识库（agent kb_* 能力的数据面；Owner 2026-09-22）。 */
  kb: KbStore;
}

/** 活跃任务绑定（capability containment 注册表；重启后由 DB 查询兜底）。 */
export interface TaskBinding {
  taskId: string;
  /** .shufa 目录（summary.json 落点；shell cwd 钉在这里，见 capability 层）。 */
  taskDir: string;
  /** 任务根目录（.shufa 父目录；containment 边界，Map 键）。 */
  taskRoot: string;
  /** 用户根目录（taskRoot 父目录，即 users/<username>/；架构调整 2026-09-23：
   * agent 会话 cwd 与相对路径解析的统一基准——资源文件跟着用户文件夹走）。 */
  userRoot: string;
  /** 管线 WORKDIR 规范路径（绝对；进程面实参一律绝对路径）。 */
  workdir: string;
  /** 任务内视频绝对路径（capability 的 probe/sample/clip/transcribe 位置参数）。 */
  video: string;
}

/** shufa-tool 仓库根解析（tasks 与向导 python-env 步骤共用；SHUFA_TOOL_DIR 可覆盖）。
 * envFile 可能在仓库根（.env）也可能在子目录（runtime/w7b.env）——固定 '..' 层数
 * 只能命中一种（实证 2026-09-23：三级 '..' 对仓库根 .env 会指到仓库外两级）。
 * 两级候选按 pyproject.toml 存在性择优（同 config.ts webuiDir 模式）。 */
export function resolveShufaToolDir(envFile: string): string {
  if (process.env.SHUFA_TOOL_DIR) return process.env.SHUFA_TOOL_DIR;
  const envDir = path.dirname(envFile);
  const candidates = [
    path.resolve(envDir, '..', 'shufa-tool'),
    path.resolve(envDir, '..', '..', 'shufa-tool'),
  ];
  return candidates.find((c) => existsSync(path.join(c, 'pyproject.toml'))) ?? candidates[0]!;
}

export class TaskService {
  private readonly bindings = new Map<string, TaskBinding>();
  /** shufa.* 能力注册表（daemon 全局工具面；MCP 投影消费）。 */
  readonly capabilities: CapabilityRegistry;

  constructor(private readonly deps: TaskServiceDeps) {
    this.capabilities = createCapabilityRegistry([
      ...createAnalysisCapabilities({
        shufaToolDir: this.shufaToolDir(),
        findTaskByDir: (taskDir) => this.findTaskByDir(taskDir),
        onExported: (taskId, bundlePath) => this.onExported(taskId, bundlePath),
        onRunaway: (taskId, detail) => this.abortRunaway(taskId, detail),
      }),
      // 知识库读写面（kb_*）：无任务 containment 的产品级共享能力。
      ...createKnowledgeCapabilities(deps.kb),
    ]);
  }

  /** 工具熔断收尾（W7b 观察：模型循环重试同错烧 token）：取消会话 + 任务收敛 failed。 */
  private abortRunaway(taskId: string, detail: string): void {
    const task = getTaskById(this.deps.db, taskId);
    if (!task || !isAwaitingRun(task.status)) return;
    console.warn(`[tasks] 工具熔断（task=${taskId}）：${detail}`);
    if (task.agent_session_id && this.deps.sessions.isLive(task.agent_session_id)) {
      this.deps.sessions.cancel(task.agent_session_id);
    }
    this.markSessionFailed(task.agent_session_id ?? '', `工具熔断：${detail}`);
  }

  /** shufa-tool 仓库根（`uv run --project` 指向；SHUFA_TOOL_DIR 可覆盖）。 */
  private shufaToolDir(): string {
    return resolveShufaToolDir(this.deps.config.envFile);
  }

  // ---------------------------------------------------------------- create

  /** 创建任务：视频进资源树 → .shufa 任务目录 → 会话 → 提示词启动。 */
  async create(
    user: UserRow,
    input: {
      prompt: string;
      video?: { filename: string; data_base64: string };
      video_resource_id?: string;
      model?: { provider: string; model: string; effort?: string };
    },
  ): Promise<TaskItem> {
    if (!this.deps.kernelMounted()) {
      throw new Error('agent 内核未挂载，暂不能创建任务（重启 daemon 或检查 dsh 安装）');
    }
    // 走查 BUG2 门控（2026-09-23；五轮沿用新链）：无任何已配置路由时拒绝创建，
    // 不再静默落入内核缺省路由（「后台没配大模型服务居然能用」的魔术根源）。
    if (modelsRouteInfo(this.deps.db, this.deps.config) === null) {
      throw new Error('管理员尚未配置大模型服务，请先在后台「设置 → 大模型服务」完成配置');
    }
    // 任务级模型覆盖（五轮活动模型）：必须命中已配置路由，防悬空引用。
    if (input.model) {
      const route = resolveRouteFor(this.deps.db, input.model.provider, input.model.model);
      if (!route) {
        throw new Error(
          `所选模型不在已配置路由中：${input.model.provider} / ${input.model.model}`,
        );
      }
    }
    const videoResource = input.video
      ? this.ingestVideo(user, input.video.filename, decodeVideo(input.video))
      : this.requireOwnedVideo(user, input.video_resource_id ?? '');
    const videoPath = this.videoPathOf(videoResource);

    // 任务目录（物理实体）：<DATA_ROOT>/users/<username>/<YYYYMMDD>-<short8>/。
    // userRoot = users/<username>/（架构调整 2026-09-23）：会话 cwd、提示词路径、
    // 相对路径解析全部以此为基准。
    const userRoot = path.join(this.deps.config.dataRoot, 'users', user.username);
    const folderName = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`;
    const taskRoot = path.join(userRoot, folderName);
    const shufaDir = path.join(taskRoot, '.shufa');
    mkdirSync(shufaDir, { recursive: true });

    // 视频链入任务根目录（W7b 真实联调修复）：capability 收容要求 video 位于
    // taskRoot 内，而 blob 实体在 DATA_ROOT/blobs 下必然违规——提示词给的路径
    // 与收容规则不能互相矛盾。硬链接零拷贝（同 FS）；跨设备退回拷贝。
    const taskVideoPath = path.join(taskRoot, path.basename(videoResource.name));
    if (existsSync(taskVideoPath)) throw new Error(`任务目录视频名冲突：${taskVideoPath}`);
    try {
      linkSync(videoPath, taskVideoPath);
    } catch {
      copyFileSync(videoPath, taskVideoPath);
    }

    const folderRow = createResource(this.deps.db, {
      ownerId: user.id,
      parentId: null,
      name: folderName,
      isDir: true,
      meta: null,
    });
    const shufaRow = createResource(this.deps.db, {
      ownerId: user.id,
      parentId: folderRow.id,
      name: '.shufa',
      isDir: true,
      meta: { dir: shufaDir, task_id: null, agent_session_id: null, result_id: null },
    });
    const task = createTask(this.deps.db, {
      ownerId: user.id,
      resourceId: shufaRow.id,
      videoResourceId: videoResource.id,
      prompt: input.prompt,
      modelProvider: input.model?.provider ?? null,
      modelModel: input.model?.model ?? null,
      modelEffort: input.model?.effort ?? null,
    });
    this.writeShufaMeta(shufaRow.id, shufaDir, task.id, null, null);

    // 会话 + 提示词启动（§6：视频路径 + 步骤清单 + SKILL.md + 摘要由你撰写）。
    // 提示词相对化（架构调整 2026-09-23）：agent 面只给相对路径（相对 cwd=
    // userRoot）；进程面（python CLI 实参）由 capability 层 resolve 成绝对路径。
    const workdir = path.join(shufaDir, '.shufa-work');
    const relativeToUserRoot = (abs: string): string => path.relative(userRoot, abs);
    const prompt = [
      input.prompt,
      '',
      buildTaskPrompt({
        videoPath: relativeToUserRoot(taskVideoPath),
        taskDir: relativeToUserRoot(shufaDir),
        workdir: relativeToUserRoot(workdir),
      }),
    ].join('\n');
    const { sessionId } = await this.deps.sessions.createTaskSession(task.id, {
      cwd: userRoot, // agent pwd = 用户根目录（shell 工作目录/相对解析基准）。
      framesFile: path.join(shufaDir, 'frames.jsonl'),
      prompt,
    });
    updateTask(this.deps.db, task.id, { agentSessionId: sessionId, status: 'running' });
    this.writeShufaMeta(shufaRow.id, shufaDir, task.id, sessionId, null);
    this.bindings.set(taskRoot, {
      taskId: task.id,
      taskDir: shufaDir,
      taskRoot,
      userRoot,
      workdir,
      video: taskVideoPath,
    });
    this.emitStatus(sessionId, task.id, 'running');
    return this.toItem(getTaskById(this.deps.db, task.id) ?? task);
  }

  /** 上传视频：内容寻址 blob + 资源行（实体在 blobs，资源树是逻辑视图）。 */
  private ingestVideo(user: UserRow, filename: string, bytes: Buffer): ResourceRow {
    const safeName = path.basename(filename) || 'video.mp4';
    const put = this.deps.blobs.put(bytes);
    return createResource(this.deps.db, {
      ownerId: user.id,
      parentId: null,
      name: safeName,
      isDir: false,
      contentHash: put.hash,
      size: put.size,
      meta: { blob: true },
    });
  }

  private requireOwnedVideo(user: UserRow, resourceId: string): ResourceRow {
    const row = getResourceById(this.deps.db, resourceId);
    if (!row || row.is_dir === 1) throw new Error(`视频资源不存在：${resourceId}`);
    if (row.owner_id !== user.id && user.role !== 'admin') throw new Error('无权访问该视频资源');
    return row;
  }

  /** 视频绝对路径（blob 实体；分析管线按路径直读）。 */
  private videoPathOf(videoResource: ResourceRow): string {
    if (!videoResource.content_hash) throw new Error('视频资源缺少内容 hash');
    return this.deps.blobs.pathFor(videoResource.content_hash);
  }

  // ---------------------------------------------------------------- read

  list(user: UserRow): TaskItem[] {
    return listTasksByOwner(this.deps.db, user.id).map((row) => this.toItem(row));
  }

  async get(
    user: UserRow,
    id: string,
    afterSeq: number,
  ): Promise<{ task: TaskItem; frames: Frame[]; results: TaskGetOutput['results'] }> {
    const task = this.requireOwnedTask(user, id);
    const sessionId = task.agent_session_id;
    if (sessionId && !this.deps.sessions.isLive(sessionId) && isAwaitingRun(task.status)) {
      await this.tryResume(task); // 跨重启复活（§0：恢复靠 resume 非文件重放）。
    }
    const frames = sessionId
      ? this.deps.sessions.stream(sessionId, this.framesFileOf(task), afterSeq).frames
      : [];
    return {
      task: this.toItem(getTaskById(this.deps.db, id) ?? task),
      frames,
      results: listResultsByTask(this.deps.db, id),
    };
  }

  // ---------------------------------------------------------------- cancel / resume

  /**
   * 会话失败收敛（W7 联调补 + 走查 R3）：agent turn 以 error 终止 → 任务 failed
   * + 错误明文落库 + 状态帧携带详情（前端转录渲染错误卡片——此前 turn-end 的
   * error payload 被前端丢弃，用户「看不到任何异常」）。
   * 仅 running/queued 任务收敛（终态不覆盖）；无 live 会话时 emit 静默（回放面仍有行状态）。
   */
  markSessionFailed(sessionId: string, reason: string): void {
    const row = this.deps.db
      .prepare('SELECT * FROM tasks WHERE agent_session_id = ?')
      .get(sessionId) as TaskRow | undefined;
    if (!row || (row.status !== 'running' && row.status !== 'queued')) return;
    console.warn(`[tasks] agent 会话失败（task=${row.id}）：${reason}`);
    updateTask(this.deps.db, row.id, { status: 'failed', error: reason });
    this.emitStatus(sessionId, row.id, 'failed', reason);
  }

  /** 会话标题回写（内核 session/title 帧到达；无匹配行静默幂等）。 */
  applySessionTitle(sessionId: string, title: string): void {
    updateTaskTitleBySession(this.deps.db, sessionId, title);
  }

  /** 前台 / 与 $ 面板目录（2026-09-25 二轮：内核命令/技能注册表，DSH 官方一致）。 */
  async composerCatalog(): Promise<{
    commands: Array<{ name: string; description: string }>;
    skills: Array<{ name: string; description: string; when_to_use?: string }>;
  }> {
    const [commands, skills] = await Promise.all([
      this.deps.sessions.listCommands(),
      this.deps.sessions.listUserSkills(),
    ]);
    return {
      commands: [...commands],
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse !== undefined ? { when_to_use: skill.whenToUse } : {}),
      })),
    };
  }

  /**
   * 聊天中切换任务模型（走查 R6）：更新任务级覆盖列 + idle 会话热切
   * （dispose → resume 以新 agentOptions 重建，历史保留）。running 拒绝
   * （对齐 skill-creator-v2「本轮结束后再切换」）；校验只要求命中已配路由
   * （key 不强制——发送失败自有错误链呈现）。
   */
  async setModel(
    user: UserRow,
    input: { taskId: string; provider: string; model: string; effort?: string | null },
  ): Promise<TaskItem> {
    const task = this.requireOwnedTask(user, input.taskId);
    if (isAwaitingRun(task.status)) {
      throw new Error('任务运行中，本轮结束后再切换模型');
    }
    const config = loadModelsConfig(this.deps.db);
    const route = config.routes.find((candidate) => candidate.provider === input.provider);
    const modelEntry = route?.models.find((entry) => entry.id === input.model);
    if (!route || !modelEntry) {
      throw new Error(`所选模型不在已配置路由中：${input.provider} / ${input.model}`);
    }
    // 档位校验：值必须在模型 efforts 内（有 efforts 目录时）；null/缺省=清除/保持。
    if (input.effort !== undefined && input.effort !== null) {
      if (modelEntry.efforts !== undefined && !modelEntry.efforts.includes(input.effort)) {
        throw new Error(`所选档位不在模型 efforts 内：${input.effort}`);
      }
    }
    updateTask(this.deps.db, task.id, {
      modelProvider: input.provider,
      modelModel: input.model,
      ...(input.effort !== undefined ? { modelEffort: input.effort } : {}),
    });
    const sessionId = task.agent_session_id;
    if (sessionId && this.deps.sessions.isLive(sessionId)) {
      await this.deps.sessions.disposeLive(sessionId);
      await this.deps.sessions.resumeTaskSession(task.id, {
        sessionId,
        framesFile: this.framesFileOf(task),
      });
      this.rebind(task);
    }
    return this.toItem(getTaskById(this.deps.db, task.id) ?? task);
  }

  async cancel(user: UserRow, id: string): Promise<TaskItem> {
    const task = this.requireOwnedTask(user, id);
    if (task.agent_session_id && this.deps.sessions.isLive(task.agent_session_id)) {
      this.deps.sessions.cancel(task.agent_session_id);
    }
    const updated = updateTask(this.deps.db, task.id, { status: 'cancelled' });
    if (task.agent_session_id) this.emitStatus(task.agent_session_id, task.id, 'cancelled');
    return this.toItem(updated ?? task);
  }

  /**
   * 前台续聊（W7b）：running/queued → live 会话排队（不在册时先复活再投递）；
   * done/failed → 先 resume（任务拉回 running + 状态帧）再排队；resume 失败置
   * failed 并向调用方抛错（不静默）。权限：仅本人（admin 豁免）。
   */
  async followup(user: UserRow, input: { id: string; text: string }): Promise<TaskFollowupOutput> {
    const task = getTaskById(this.deps.db, input.id);
    if (!task) throw new ORPCError('NOT_FOUND', { message: `任务不存在：${input.id}` });
    if (task.owner_id !== user.id && user.role !== 'admin') {
      throw new ORPCError('FORBIDDEN', { message: '无权访问该任务' });
    }
    const sessionId = task.agent_session_id;
    if (!sessionId) {
      throw new ORPCError('CONFLICT', { message: '任务没有关联的 agent 会话，不可续聊' });
    }
    if (!this.deps.kernelMounted()) {
      throw new ORPCError('BAD_REQUEST', { message: 'agent 内核未挂载，暂不能续聊（重启 daemon 或检查 dsh 安装）' });
    }
    if (task.status === 'cancelled') {
      throw new ORPCError('CONFLICT', { message: '已取消的任务不可续聊' });
    }

    let resumed = false;
    if (task.status === 'done' || task.status === 'failed') {
      try {
        await this.deps.sessions.resumeTaskSession(task.id, {
          sessionId,
          framesFile: this.framesFileOf(task),
        });
        this.rebind(task);
        resumed = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[tasks] 续聊复活失败（task=${task.id}）：${detail}`);
        updateTask(this.deps.db, task.id, { status: 'failed', error: `会话恢复失败：${detail}` });
        this.emitStatus(sessionId, task.id, 'failed', `会话恢复失败：${detail}`);
        throw new ORPCError('BAD_REQUEST', { message: `会话恢复失败：${detail}` });
      }
      updateTask(this.deps.db, task.id, { status: 'running', error: null });
      this.emitStatus(sessionId, task.id, 'running');
    }

    try {
      this.deps.sessions.followup(sessionId, input.text);
    } catch {
      // running 但会话不在册（daemon 重启后）：复活一次再投递；失败同上收敛 failed。
      try {
        await this.deps.sessions.resumeTaskSession(task.id, {
          sessionId,
          framesFile: this.framesFileOf(task),
        });
        this.rebind(task);
        resumed = true;
        this.deps.sessions.followup(sessionId, input.text);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[tasks] 续聊复活失败（task=${task.id}）：${detail}`);
        updateTask(this.deps.db, task.id, { status: 'failed', error: `会话恢复失败：${detail}` });
        this.emitStatus(sessionId, task.id, 'failed', `会话恢复失败：${detail}`);
        throw new ORPCError('BAD_REQUEST', { message: `会话恢复失败：${detail}` });
      }
    }

    const fresh = getTaskById(this.deps.db, task.id) ?? task;
    return { accepted: true, resumed, task: this.toItem(fresh) };
  }

  private async tryResume(task: TaskRow): Promise<void> {
    const sessionId = task.agent_session_id;
    if (!sessionId) return;
    try {
      await this.deps.sessions.resumeTaskSession(task.id, {
        sessionId,
        framesFile: this.framesFileOf(task),
      });
      this.rebind(task);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[tasks] 会话复活失败（task=${task.id}）：${detail}`);
      updateTask(this.deps.db, task.id, { status: 'failed', error: `会话恢复失败：${detail}` });
    }
  }

  private rebind(task: TaskRow): void {
    if (!task.agent_session_id) return;
    const taskDir = this.shufaDirOf(task);
    const taskRoot = path.dirname(taskDir);
    this.bindings.set(taskRoot, {
      taskId: task.id,
      taskDir,
      taskRoot,
      userRoot: path.dirname(taskRoot),
      workdir: path.join(taskDir, '.shufa-work'),
      video: this.taskVideoPathOf(task, taskRoot),
    });
  }

  /** 任务内视频绝对路径（硬链实体；缺失资源行时退回占位名——containment 仍会兜住）。 */
  private taskVideoPathOf(task: TaskRow, taskRoot: string): string {
    if (!task.video_resource_id) return path.join(taskRoot, 'video.mp4');
    const resource = getResourceById(this.deps.db, task.video_resource_id);
    return path.join(taskRoot, resource?.name ?? 'video.mp4');
  }

  // ---------------------------------------------------------------- capability 绑定面

  /**
   * capability containment：candidate（绝对路径，或相对某用户根目录的相对路径——
   * agent cwd=userRoot，提示词给的相对输入天然锚在本人 userRoot 上）须落在某在册
   * 任务根目录内（bindings → DB 兜底）。解析规则：逐 binding 以其 userRoot 为基准
   * `path.resolve(binding.userRoot, candidate)` 后再做 within 判断——绝对输入
   * resolve 原样保留，相对输入按各候选 userRoot 拼接；`..` 逃出任务根即不命中。
   */
  findTaskByDir(candidate: string): TaskLocation | null {
    for (const binding of this.bindings.values()) {
      if (within(binding.taskRoot, path.resolve(binding.userRoot, candidate))) return binding;
    }
    // DB 兜底（daemon 重启后 bindings 为空）：扫任务 → .shufa 资源 meta.dir。
    const rows = this.deps.db.prepare('SELECT id, resource_id FROM tasks').all() as Array<{
      id: string;
      resource_id: string | null;
    }>;
    for (const row of rows) {
      if (!row.resource_id) continue;
      const resource = getResourceById(this.deps.db, row.resource_id);
      const meta = resource ? parseResourceMeta(resource) : null;
      const dir = meta && typeof meta.dir === 'string' ? meta.dir : null;
      if (!dir) continue;
      const taskRoot = path.dirname(dir);
      const binding: TaskBinding = {
        taskId: row.id,
        taskDir: dir,
        taskRoot,
        userRoot: path.dirname(taskRoot),
        workdir: path.join(dir, '.shufa-work'),
        video: this.taskVideoPathOf(row as TaskRow, taskRoot),
      };
      if (!within(binding.taskRoot, path.resolve(binding.userRoot, candidate))) continue;
      this.bindings.set(binding.taskRoot, binding);
      return binding;
    }
    return null;
  }

  /**
   * 对外结果链接基址（走查 2026-09-25）：SITE_BASE_URL 未配置时缺省基址继承
   * HOST——daemon 绑 0.0.0.0（局域网直访常态）会拼出 http://0.0.0.0:8217/…
   * 浏览器不可达。以本机 mDNS 主机名（<hostname>.local）替换绑定通配地址；
   * 显式配置的域名/127.0.0.1 不动。
   */
  private publicBaseUrl(): string {
    const base = this.deps.config.siteBaseUrl;
    try {
      const parsed = new URL(base);
      if (parsed.hostname === '0.0.0.0' || parsed.hostname === '::' || parsed.hostname === '[::]') {
        const port = parsed.port || String(this.deps.config.port);
        return mdnsUrlFor(hostname(), Number(port));
      }
    } catch {
      // 非法基址按原样返回（不阻断导出）。
    }
    return base;
  }

  /** export 收尾：bundle → results 行 + public_id → result 帧 + 任务 done。 */
  onExported(taskId: string, bundlePath: string): { public_id: string; url: string } | null {
    const task = getTaskById(this.deps.db, taskId);
    if (!task) return null;
    // bundle 存在性由 data.json 标记（§0 结果页契约的最低要求）。
    if (!existsSync(path.join(bundlePath, 'data.json'))) return null;
    // 重导合并（Owner 2026-09-25）：同任务同 bundle 的重导复用既有结果行
    // （public_id 不变、时间刷新）——agent 会话中改摘要重导 5 次不该留下 5 个链接。
    const existing = getResultByTaskBundle(this.deps.db, task.id, bundlePath);
    const publicId = existing?.public_id ?? newPublicId();
    const row = existing
      ? (touchResult(this.deps.db, existing.id), existing)
      : createResult(this.deps.db, {
          publicId,
          taskId: task.id,
          ownerId: task.owner_id,
          title: null,
          bundlePath,
        });
    updateTask(this.deps.db, task.id, { resultId: row.id, status: 'done' });
    if (task.resource_id) {
      const resource = getResourceById(this.deps.db, task.resource_id);
      const meta = resource ? (parseResourceMeta(resource) ?? {}) : {};
      updateResourceMeta(this.deps.db, task.resource_id, { ...meta, result_id: row.id });
    }
    const url = `${this.publicBaseUrl()}/r/${publicId}`;
    if (task.agent_session_id) {
      const sessionId = task.agent_session_id;
      this.deps.sessions.emit(sessionId, {
        kind: 'result',
        payload: { task_id: task.id, public_id: publicId, url },
      });
      this.emitStatus(sessionId, task.id, 'done');
    }
    return { public_id: publicId, url };
  }

  // ---------------------------------------------------------------- WS 帧流

  /**
   * 打开帧流：先回放 afterSeq 之后的持久帧，再挂 live 订阅推送增量。
   * 返回退订函数（连接关闭时调用）。
   */
  async openFrameStream(
    user: UserRow,
    taskId: string,
    afterSeq: number,
    send: (frame: Frame) => void,
  ): Promise<() => void> {
    const task = this.requireOwnedTask(user, taskId);
    const sessionId = task.agent_session_id;
    if (!sessionId) return () => {};
    if (!this.deps.sessions.isLive(sessionId) && isAwaitingRun(task.status)) {
      await this.tryResume(task);
    }
    for (const frame of this.deps.sessions.stream(sessionId, this.framesFileOf(task), afterSeq).frames) {
      send(frame);
    }
    return this.deps.sessions.subscribe(sessionId, send);
  }

  // ---------------------------------------------------------------- internals

  private emitStatus(sessionId: string, taskId: string, status: TaskStatus, error?: string): void {
    this.deps.sessions.emit(sessionId, {
      kind: 'status',
      payload: { task_id: taskId, status, ...(error !== undefined ? { error } : {}) },
    });
  }

  private framesFileOf(task: TaskRow): string {
    return path.join(this.shufaDirOf(task), 'frames.jsonl');
  }

  private shufaDirOf(task: TaskRow): string {
    if (!task.resource_id) return path.join(this.deps.config.dataRoot, 'tasks', task.id, '.shufa');
    const resource = getResourceById(this.deps.db, task.resource_id);
    const meta = resource ? parseResourceMeta(resource) : null;
    const dir = meta && typeof meta.dir === 'string' ? meta.dir : null;
    return dir ?? path.join(this.deps.config.dataRoot, 'tasks', task.id, '.shufa');
  }

  private writeShufaMeta(
    resourceId: string,
    dir: string,
    taskId: string,
    agentSessionId: string | null,
    resultId: string | null,
  ): void {
    updateResourceMeta(this.deps.db, resourceId, {
      dir,
      task_id: taskId,
      agent_session_id: agentSessionId,
      result_id: resultId,
    });
  }

  requireOwnedTask(user: UserRow, id: string): TaskRow {
    const task = getTaskById(this.deps.db, id);
    if (!task) throw new Error(`任务不存在：${id}`);
    if (task.owner_id !== user.id && user.role !== 'admin') throw new Error('无权访问该任务');
    return task;
  }

  toItem(row: TaskRow): TaskItem {
    // video_name：资源名投影（详情播放位与列表展示；无资源 = null）。
    const resource = row.video_resource_id
      ? getResourceById(this.deps.db, row.video_resource_id)
      : null;
    return {
      id: row.id,
      owner_id: row.owner_id,
      status: row.status,
      prompt: row.prompt,
      video_resource_id: row.video_resource_id,
      video_name: resource?.name ?? null,
      title: row.title ?? null,
      agent_session_id: row.agent_session_id,
      result_id: row.result_id,
      error: row.error ?? null,
      model_provider: row.model_provider ?? null,
      model_model: row.model_model ?? null,
      model_effort: row.model_effort ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

function within(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isAwaitingRun(status: TaskStatus): boolean {
  return status === 'running' || status === 'queued';
}

/**
 * 模型路由解析（五轮多路由，boot/任务会话用）：models_routes（settings 表真源）
 * 优先；空则回落旧 llm_* 单路由链（settings 表 → .env）投影为单路由 bundle。
 */
export function resolveModelRoutesFromStore(
  db: SqliteDb,
  config: Pick<AppConfig, 'fileEnv'>,
): ModelRoutesBundle {
  const bundle = buildRoutesBundle(db);
  if (bundle.routes.length > 0) return bundle;
  const setting = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? config.fileEnv[key.toUpperCase()] ?? null;
  };
  const legacy = resolveModelRoute(setting);
  if (!legacy) return { routes: [], default: null };
  return {
    routes: [
      {
        provider: legacy.provider,
        api: legacy.api,
        baseURL: legacy.baseURL,
        apiKey: legacy.apiKey,
        models: [{ id: legacy.model, contextWindow: legacy.contextWindow }],
      },
    ],
    default: { provider: legacy.provider, model: legacy.model },
  };
}

/** 旧链专用：settings 表 llm_* 行值（trim；.env 兜底不含——来源判定）。 */
function llmTableValue(db: SqliteDb, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return (row?.value ?? '').trim();
}

/** 旧链专用：.env fileEnv LLM_* 值（trim；settings 兜底不含——来源判定）。 */
function llmEnvValue(config: Pick<AppConfig, 'fileEnv'>, key: string): string {
  return (config.fileEnv[key.toUpperCase()] ?? '').trim();
}

/**
 * 生效路由信息（bootstrap.model_route 投影，五轮多路由语义）：多路由真源
 * （models_routes）有内容 → source 'settings'（default 优先，缺省取首路由首
 * 模型）；多路由为空时旧 llm_* 链齐备才 'env'（.env 引导语义保留）；都无 →
 * null（bootstrap 呈现「未配置」+ tasks.create 门控）。
 */
export function modelsRouteInfo(
  db: SqliteDb,
  config: Pick<AppConfig, 'fileEnv'>,
): ModelRouteInfo | null {
  const bundle = resolveModelRoutesFromStore(db, config);
  if (bundle.routes.length === 0) return null;
  const first = bundle.routes[0]!;
  const provider = bundle.default?.provider ?? first.provider;
  const model =
    bundle.default?.model ??
    first.models.find((entry) => entry.id)?.id ??
    first.models[0]?.id ??
    '';
  // 多路由真源命中的路由必来自 settings 表；只有旧链投影才可能是 env 来源。
  const fromEnv = bundle.routes.length === 1 && provider === first.provider && llmTableValue(db, 'llm_provider') === '' && llmEnvValue(config, 'llm_provider') !== '';
  return { provider, model, source: fromEnv ? 'env' : 'settings' };
}

/** 上传字节解码与上限校验。 */
function decodeVideo(video: { filename: string; data_base64: string }): Buffer {
  const bytes = Buffer.from(video.data_base64, 'base64');
  if (bytes.byteLength === 0) throw new Error('视频内容为空');
  if (bytes.byteLength > VIDEO_MAX_BYTES) throw new Error('视频超过 256MB 上限');
  return bytes;
}

/** public_id：nanoid 语义的 12 位 base62（公开访问标识，§5）。 */
function newPublicId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(12);
  let id = '';
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}
