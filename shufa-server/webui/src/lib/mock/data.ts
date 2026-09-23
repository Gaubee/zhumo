/**
 * mock 数据与模拟行为（W3 类型先行；联调期整体被真 API 替换）。
 * 原始需求 [2026-09-23]：contracts/daemon 由并行子代理落地，webui 先以 mock
 * 层驱动全部页面；接口签名与未来 oRPC 契约一致。
 * 正交意图：
 *   [1] 内存数据库（bootstrap/会话/用户/设置/模型路由/资源树/任务/帧）。
 *   [2] 任务 agent 对话的脚本化帧流（sendTaskPrompt 触发 user→tool→assistant
 *       →turn-end 时序回放，模拟 WS 推送）。
 *   [3] 向导步骤的模拟执行（命令类逐行追加日志；下载类进度步进）。
 * 朱墨前端改造 [2026-09-24]：匿名默认关（adminSettings 种子）；内置 __anonymous__
 * 系统账户行；模型预设目录 mockDb.modelsCatalog（BUG4）；用户自增 id 防删除后撞号。
 * 妥协声明：帧流的时序回放写死 setTimeout 编排——真实实现是 daemon WS 推送，
 *   mock 无需抽象调度器。
 */
import type {
  AdminSettings,
  DshModelRoute,
  Frame,
  ModelsCatalog,
  ModelsSettings,
  SessionInfo,
  Task,
  UserInfo,
  WizardRunParams,
  WizardStep,
} from "$lib/types";
import { WHISPER_MIRRORS, WHISPER_MODEL_CATALOG } from "@zhumo/contracts";
import { seedMockResources } from "$lib/mock/resources";

const now = (): string => new Date().toISOString();

// 资源管理器 mock 种子（W5；引擎与语义在 mock/resources.ts）。
seedMockResources();

// ---- [1] 内存数据库 ----

export const mockDb = {
  installed: false,
  siteName: "朱墨",
  session: null as SessionInfo | null,
  users: [
    { id: "u-admin", username: "admin", role: "admin", disabled: false, createdAt: now() },
    { id: "u-1", username: "王老师", role: "user", disabled: false, createdAt: now() },
    // BUG5：内置匿名账号在账号列表可见（系统账户行：隐藏改密/删除/禁用入口）。
    { id: "u-anonymous", username: "__anonymous__", role: "anonymous", disabled: false, createdAt: now() },
  ] as UserInfo[],
  // 语义变更（2026-09-24）：匿名默认关闭（安全默认）——未开匿名前端必须登录。
  adminSettings: { siteBaseUrl: "http://localhost:8000", allowAnonymous: false } as AdminSettings,
  /** mock 自增用户 id（createUser 用，删除后重建不撞号）。 */
  userIdSeq: 0,
  /** BUG4 模型预设目录：builtin 常量 + models.dev 拉取缓存（fetched_at=null=未拉取）。 */
  modelsCatalog: {
    presets: [
      {
        provider: "zai",
        name: "智谱 GLM",
        baseURL: "https://api.z.ai/api/paas/v4",
        api: "openai-completions",
        models: [{ id: "glm-5.3-flash" }, { id: "glm-5.3" }, { id: "glm-5.3-air" }],
        source: "builtin",
      },
      {
        provider: "deepseek",
        name: "DeepSeek",
        baseURL: "https://api.deepseek.com/v1",
        api: "openai-completions",
        models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
        source: "builtin",
      },
      {
        provider: "moonshot",
        name: "月之暗面 Kimi",
        baseURL: "https://api.moonshot.cn/v1",
        api: "openai-completions",
        models: [{ id: "kimi-k2-0905-preview" }, { id: "kimi-latest" }],
        source: "builtin",
      },
      {
        provider: "openai",
        name: "OpenAI",
        baseURL: "https://api.openai.com/v1",
        api: "openai-completions",
        models: [{ id: "gpt-5.3" }, { id: "gpt-5.3-mini" }, { id: "gpt-4.1" }],
        source: "models.dev",
      },
      {
        provider: "anthropic",
        name: "Anthropic",
        baseURL: "https://api.anthropic.com",
        api: "anthropic-messages",
        models: [{ id: "claude-sonnet-4-6" }, { id: "claude-opus-4-1" }],
        source: "models.dev",
      },
    ],
    fetched_at: null,
  } as ModelsCatalog,
  models: {
    routes: [
      {
        provider: "zai",
        baseURL: "https://api.z.ai/api/paas/v4",
        apiKey: "sk-demo-zai",
        models: [
          {
            id: "glm-5.3-flash",
            contextWindow: 131072,
            maxOutputTokens: 16384,
            efforts: ["low", "high", "max"],
          },
          { id: "glm-5.3", contextWindow: 204800, maxOutputTokens: 32768, efforts: ["low", "high"] },
        ],
      },
      {
        provider: "deepseek",
        baseURL: "https://api.deepseek.com/v1",
        models: [{ id: "deepseek-chat", contextWindow: 65536, efforts: ["low", "high"] }],
      },
    ] as DshModelRoute[],
    active: { provider: "zai", model: "glm-5.3-flash" },
  } as ModelsSettings,
  tasks: [
    {
      id: "t-3",
      title: "草书笔势分析",
      status: "running",
      prompt: "分析这段草书的连笔与使转，给出练习建议",
      videoName: "草书演示.mp4",
      createdAt: "2026-09-23T09:12:00.000Z",
      updatedAt: "2026-09-23T09:14:00.000Z",
    },
    {
      id: "t-2",
      title: "楷书结构点评",
      status: "done",
      prompt: "点评这页楷书的间架结构",
      videoName: "楷书入门-横竖点.mp4",
      createdAt: "2026-09-22T14:00:00.000Z",
      updatedAt: "2026-09-22T14:06:00.000Z",
    },
    {
      id: "t-1",
      title: "兰亭序起笔分析",
      status: "done",
      prompt: "分析示范视频里的起笔角度与收笔",
      videoName: "行书示范-起笔.mp4",
      createdAt: "2026-09-21T08:30:00.000Z",
      updatedAt: "2026-09-21T08:41:00.000Z",
    },
  ] as Task[],
  frames: new Map<string, Frame[]>([
    [
      "t-1",
      [
        { at: now(), seq: 1, kind: "user-text", text: "分析示范视频里的起笔角度与收笔" },
        { at: now(), seq: 2, kind: "status", text: "任务开始 · 已接收素材 行书示范-起笔.mp4" },
        {
          at: now(),
          seq: 3,
          kind: "tool-call",
          toolName: "probe",
          text: '{"video":"行书示范-起笔.mp4"}',
        },
        {
          at: now(),
          seq: 4,
          kind: "tool-result",
          toolName: "probe",
          text: "1920x1080 · 30fps · 42s · 竖幅书写",
        },
        {
          at: now(),
          seq: 5,
          kind: "tool-call",
          toolName: "sample",
          text: '{"fps":2}',
        },
        { at: now(), seq: 6, kind: "tool-result", toolName: "sample", text: "已抽取 84 关键帧" },
        {
          at: now(),
          seq: 7,
          kind: "assistant-text",
          text: "从关键帧看，起笔以侧锋切入为主，角度约 45°，收笔多回锋收束。建议练习时注意切笔后立刻调锋，避免侧锋拖行过长。",
        },
        { at: now(), seq: 8, kind: "turn-end", text: "ok" },
      ],
    ],
    [
      "t-2",
      [
        { at: now(), seq: 1, kind: "user-text", text: "点评这页楷书的间架结构" },
        { at: now(), seq: 2, kind: "assistant-text", text: "整体结构平稳，「横」画起笔藏锋明显；「竖」画有轻微右倾，建议对帖校正。 turning…" },
        { at: now(), seq: 3, kind: "turn-end", text: "ok" },
      ],
    ],
    ["t-3", [{ at: now(), seq: 1, kind: "status", text: "排队中 → 运行中" }]],
  ]) as Map<string, Frame[]>,
  wizardSteps: [
    {
      id: "ffmpeg",
      kind: "command",
      title: "ffmpeg（视频抽帧）",
      command: "ffmpeg -version",
      targetDir: "/usr/local/bin/ffmpeg",
      // 嗅探已安装：done + 嗅探日志（前端据此显示「已安装」并锁定重跑按钮）。
      status: "done",
      lastLog: "嗅探：ffmpeg 已安装（ffmpeg version 7.1），跳过执行",
      progress: 100,
      resumable: false,
      detected: true,
      updatedAt: now(),
    },
    {
      id: "dsh",
      kind: "command",
      title: "dsh（agent 内核）",
      command: "dsh --version",
      targetDir: "~/.shufa/bin/dsh",
      status: "pending",
      lastLog: "",
      progress: 0,
      resumable: false,
      detected: false,
      updatedAt: now(),
    },
    {
      id: "whisper-model",
      kind: "download",
      title: "whisper 语音模型",
      url: `${WHISPER_MIRRORS[0].base}/${WHISPER_MODEL_CATALOG[0].repo}`,
      targetDir: "~/.cache/huggingface/hub",
      status: "pending",
      lastLog: "",
      progress: 0,
      resumable: false,
      detected: false,
      updatedAt: now(),
    },
    {
      id: "npm-install",
      kind: "command",
      title: "前端依赖安装（npm install）",
      command: "npm install",
      targetDir: "<安装目录>/webui",
      status: "pending",
      lastLog: "",
      progress: 0,
      resumable: false,
      detected: false,
      updatedAt: now(),
    },
  ] as WizardStep[],
  results: new Map([["aZ3xKq9LmP", { publicId: "aZ3xKq9LmP", title: "兰亭序起笔分析 · 结果", createdAt: now() }]]),
};

// ---- [2] 帧流监听与脚本化回放 ----

type FrameListener = (frame: Frame) => void;
const taskListeners = new Map<string, Set<FrameListener>>();
const stepListeners = new Set<FrameListener>();

export function onTaskFrame(taskId: string, listener: FrameListener): () => void {
  let set = taskListeners.get(taskId);
  if (!set) {
    set = new Set();
    taskListeners.set(taskId, set);
  }
  set.add(listener);
  return () => set?.delete(listener);
}

export function onWizardStepChange(listener: FrameListener): () => void {
  stepListeners.add(listener);
  return () => stepListeners.delete(listener);
}

function emitTask(taskId: string, frame: Frame): void {
  const frames = mockDb.frames.get(taskId) ?? [];
  frames.push(frame);
  mockDb.frames.set(taskId, frames);
  const task = mockDb.tasks.find((t) => t.id === taskId);
  if (task) task.updatedAt = frame.at;
  for (const listener of taskListeners.get(taskId) ?? []) listener(frame);
}

let seqSeed = 100;
function nextSeq(): number {
  seqSeed += 1;
  return seqSeed;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 模拟 agent 编排：user → status → tool → assistant → turn-end。 */
export async function replayAgentTurn(taskId: string, prompt: string): Promise<void> {
  const task = mockDb.tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.status = "running";
  emitTask(taskId, { at: now(), seq: nextSeq(), kind: "user-text", text: prompt });
  await sleep(400);
  emitTask(taskId, { at: now(), seq: nextSeq(), kind: "status", text: "已接收素材，开始分析" });
  await sleep(600);
  emitTask(taskId, {
    at: now(),
    seq: nextSeq(),
    kind: "tool-call",
    toolName: "sample",
    text: `{"video":"${task.videoName}","fps":2}`,
  });
  await sleep(900);
  emitTask(taskId, {
    at: now(),
    seq: nextSeq(),
    kind: "tool-result",
    toolName: "sample",
    text: "已抽取 96 关键帧",
  });
  await sleep(600);
  emitTask(taskId, {
    at: now(),
    seq: nextSeq(),
    kind: "assistant-text",
    text: `已收到指令「${prompt}」。关键帧显示运笔节奏中段偏快，收尾两字明显减速——这是章法上的呼吸感，后续波次将接真实分析管线给出逐项点评。`,
  });
  await sleep(300);
  task.status = "done";
  emitTask(taskId, { at: now(), seq: nextSeq(), kind: "turn-end", text: "ok" });
}

/**
 * 模拟准备步骤执行：命令类逐行吐日志；下载类进度步进（经 onWizardStepChange 推送）。
 * params 与真 API 同签名：whisper-model 步骤携带选中模型/镜像，mock 据此回写
 * 来源 URL（镜像 base + 模型文件，组装规则与后端一致）并回显选择。
 */
/** mock 取消标记（走查 2026-09-24）：运行循环逐拍感知，置回 pending。 */
const mockCancelled = new Set<string>();

export async function cancelWizardStepMock(stepId: string): Promise<void> {
  const step = mockDb.wizardSteps.find((s) => s.id === stepId);
  if (!step || step.status !== "running") return;
  mockCancelled.add(stepId);
}

export async function runWizardStepMock(
  stepId: string,
  force: boolean,
  params?: WizardRunParams,
): Promise<void> {
  const step = mockDb.wizardSteps.find((s) => s.id === stepId);
  if (!step) return;
  step.status = "running";
  // 三轮：下载启动即消费/覆盖 .download 残差（与 daemon rmSync/续传语义对齐）。
  step.resumable = false;
  step.updatedAt = now();
  for (const listener of stepListeners) listener({ at: now(), seq: 0, kind: "status" });
  let selectedLine = "";
  if (step.kind === "command") {
    const script =
      step.id === "ffmpeg"
        ? ["ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers", "built with Apple clang version 17"]
        : step.id === "dsh"
          ? ["resolving dsh@latest...", "added 24 packages in 6s", "dsh 0.4.2"]
          : ["added 312 packages, and audited 313 packages in 21s", "found 0 vulnerabilities"];
    for (const line of ["$ " + (step.command ?? ""), ...script]) {
      await sleep(500);
      if (mockCancelled.delete(stepId)) {
        step.status = "pending";
        step.lastLog += "\n[中断] 用户取消";
        step.updatedAt = now();
        for (const listener of stepListeners) listener({ at: now(), seq: 0, kind: "status" });
        return;
      }
      step.lastLog = (step.lastLog.length > 0 ? step.lastLog + "\n" : "") + line;
      step.updatedAt = now();
      for (const listener of stepListeners) listener({ at: now(), seq: 0, kind: "status" });
    }
    step.status = "done";
    step.detected = true;
  } else {
    if (stepId === "whisper-model") {
      const model =
        WHISPER_MODEL_CATALOG.find((candidate) => candidate.id === params?.model) ??
        WHISPER_MODEL_CATALOG[0];
      const mirror =
        WHISPER_MIRRORS.find((candidate) => candidate.id === params?.mirror) ?? WHISPER_MIRRORS[0];
      step.url = `${mirror.base}/${model.repo}`;
      selectedLine = `已选择 ${model.repo} · ${mirror.label}`;
    }
    const repo = step.url?.split("/").slice(-2).join("/") ?? "";
    const sizeMb = WHISPER_MODEL_CATALOG.find((candidate) => candidate.repo === repo)?.sizeMb ?? 65;
    const prefix = selectedLine.length > 0 ? `${selectedLine}\n` : "";
    for (let progress = 0; progress <= 100; progress += 20) {
      await sleep(400);
      if (mockCancelled.delete(stepId)) {
        step.status = "pending";
        step.resumable = true;
        step.lastLog += "\n[中断] 用户取消（已下载部分保留，可续传）";
        step.updatedAt = now();
        for (const listener of stepListeners) listener({ at: now(), seq: 0, kind: "status" });
        return;
      }
      step.progress = progress;
      step.lastLog = `${prefix}已下载 ${((sizeMb * progress) / 100).toFixed(1)}MB / ${sizeMb.toFixed(1)}MB（${progress}%）`;
      step.updatedAt = now();
      for (const listener of stepListeners) listener({ at: now(), seq: 0, kind: "status" });
    }
    step.status = "done";
    step.detected = true;
  }
  void force;
  step.updatedAt = now();
  for (const listener of stepListeners) listener({ at: now(), seq: 0, kind: "status" });
}
