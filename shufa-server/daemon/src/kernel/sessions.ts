/**
 * 内核任务会话服务（PRODUCT_DESIGN.md §3/§7；照 skill-creator-v2
 * kernel/agent-sessions.ts 最小可行形态裁剪）。
 * 原始需求 2026-09-23（W4）：createTaskSession（cwd=用户根目录，架构调整
 * 2026-09-23 前为 .shufa 任务目录）/resume/
 * firehose→Frame 投影（Zod safeParse，畸形丢弃+有界诊断）/环形缓冲 + jsonl
 * 落盘/afterSeq 回放/审批（ask_user）/cancel。
 * 正交意图：
 *   [1] 会话生命周期：create/resume/cancel/dispose（内核 agents 服务 unknown 收窄）。
 *   [2] 帧投影：session/event → Frame（120ms delta 合并；reasoning 先于 text；
 *       轮内 usage 累计 → turn/end 帧 payload.usage 药丸数据）。
 *   [3] 帧提交单点：环形 retention + FrameStore jsonl + 订阅者通知。
 *   [4] 审批：user-questions/request → approval-request 帧 + answer 回填。
 * 妥协声明：跨 cordis 服务访问按结构化 unknown 收窄（宿主服务形状无公开 TS 面）。
 */
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { isUserInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill';
import { z } from 'zod';
import type { Frame } from '@zhumo/contracts';
import type { ShufaKernelHandle } from './boot.js';
import { FrameStore } from './frame-store.js';
import { productToolDenyList } from './tool-surface.js';
import {
  AgentChunkEventSchema,
  AttemptUsageEventSchema,
  MessageEventSchema,
  MessageUsageEventSchema,
  ObjectPayloadEventSchema,
  SessionTitleEventSchema,
  TodoWriteEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  TurnEndEventSchema,
  logDroppedEvent,
  usageOfAttemptStream,
} from './firehose-events.js';
import type { TokenUsageSample } from './firehose-events.js';

/** delta 合并窗口（ms）。 */
const DELTA_FLUSH_MS = 120;
const DEFAULT_RETENTION = 200;

/** 内核命令描述（CommandDescriptor 最小投影：name 不含斜杠）。 */
export interface KernelCommandInfo {
  name: string;
  description: string;
}

/** 内核技能摘要（SkillSummary 最小投影；仅 user-invocable）。 */
export interface KernelSkillInfo {
  name: string;
  description: string;
  whenToUse?: string;
}

/** 内核 ctx.services 侧面（commands/skills；dsh-base bundle 自带，缺省缺席）。 */
interface KernelCommandServiceLike {
  list(agent: unknown): readonly { name: string; description: string }[] | undefined;
  execute(
    agent: unknown,
    line: string,
    attachments: readonly unknown[],
    signal: AbortSignal,
  ): Promise<unknown>;
}

interface KernelSkillServiceLike {
  list(options?: unknown): Promise<
    ReadonlyArray<{ name: string; description: string; whenToUse?: string; invocation: unknown }>
  >;
  get(name: string, options?: unknown): Promise<
    | {
        name: string;
        description: string;
        whenToUse?: string;
        content: string;
        invocation: unknown;
        resourceBase?: unknown;
        provider: string;
      }
    | undefined
  >;
}

function kernelCommands(ctx: Context): KernelCommandServiceLike | undefined {
  return (ctx as Context & { commands?: KernelCommandServiceLike }).commands;
}

function kernelSkills(ctx: Context): KernelSkillServiceLike | undefined {
  return (ctx as Context & { skills?: KernelSkillServiceLike }).skills;
}

/** W10k 统一队列条目（Owner 语义 2026-09-28，ZCode×Codex 讨论定稿）：
 * 单一有序序列，每条只有 kind ∈ {anchor=开轮, attach=补充}；attach 的投递
 * 效果 effect ∈ {steer, inject}（inject 降为 attach 属性，不再是第三类）。
 * attach 隐式绑定前方最近的 anchor（无则=当前轮槽位），重排/删除/改 kind 后
 * 绑定按序重算（派生不存储）。state：queued=待投（daemon 持有）；
 * admitted=anchor 已 followup 交内核未开轮（单航次）；inflight=attach 已
 * steer/inject 交内核（下一 step 边界生效，轮结束清扫）。 */
export interface W10kQueueItem {
  /** 条目 id（enqueue 生成，永不改写——UI/编辑/锁定寻址稳定）。 */
  id: string;
  /** 内核 inbox 里的真实消息 id（交付时生成；撤回 inbox.remove 用）。 */
  kernelId?: string;
  text: string;
  kind: 'anchor' | 'attach';
  effect?: 'steer' | 'inject';
  state: 'queued' | 'admitted' | 'inflight';
}

export interface TaskSessionDeps {
  kernel: () => ShufaKernelHandle | null;
  /** 模型选择（null = 未配置，内核用缺省路由）。 */
  /** 模型选择（五轮）：按任务——任务覆盖（model_* 列）优先，缺省回落默认模型。
   * effort（2026-09-25 前台对齐）：任务级思考强度档（model_effort 列；null=不覆盖）。 */
  modelSelection: (
    taskId: string,
  ) => Promise<{ provider: string; model: string; effort?: string } | null>;
  retention?: number;
  /** agent turn 以 error 终止时的失败回调（W7 联调：任务失败路径不悬挂）。 */
  onSessionFailure?: (sessionId: string, reason: string) => void;
  /** agent turn 以 completed 终止且队列无待投消息（W10f：agent 已空闲等待
   * 输入——任务行回 done，「分析中」指示器不再在轮间空闲期空转）。队列非空时内核
   * 自动续跑下一轮，不回调。 */
  onSessionIdle?: (sessionId: string) => void;
  /** W10k 统一队列持久化：队列每次变更后落库（daemon 单一事实源，重启恢复）。 */
  onQueuePersist?: (sessionId: string, taskId: string, items: W10kQueueItem[], lockBoundaryId: string | null) => void;
  /** W10k 队列恢复：会话装配时读回持久化序列（null=无存档）。 */
  onQueueRestore?: (sessionId: string, taskId: string) => { items: W10kQueueItem[]; lockBoundaryId: string | null } | null;
  /** 内核 session/title 帧回调（2026-09-25 三轮：标题落任务行）。 */
  onSessionTitle?: (sessionId: string, title: string) => void;
}

export interface TaskSessionStartInput {
  /** agent 会话工作目录（= 用户根目录；内核 shell 工具面/相对路径解析基准）。 */
  cwd: string;
  framesFile: string;
  prompt: string;
}

export interface TaskSessionResumeInput {
  sessionId: string;
  framesFile: string;
}

export type SessionLiveStatus = 'running' | 'idle' | 'persisted';

/**
 * 轮内 usage 累计器（turn/start 清零 → assistant/message + assistant/attempt
 * 逐次尝试样本相加 → turn/end 收割进帧 payload）。口径对齐 dsh-token-meter
 * TurnTokenUsage 的 attempt 聚合：in = 未缓存输入，cacheRead/cacheWrite 仅在
 * 样本上报时累计（可选桶，缺失不算 0）。
 */
interface TurnUsageAccumulator {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 内核 Agent/Session 最小结构面（unknown 收窄）。 */
interface AgentLike {
  id: string;
  status: string;
  session: { id: string; header: { cwd?: string; createdAt?: number | string } };
  followup(message: unknown): void;
  steer(message: unknown): void;
  inject(message: unknown): void;
  cancel(cause: unknown, options?: unknown): void;
  /** 排队工作读写面（W10b 队列面板）。消息以内核 UserMessage 形状流转
   * （unknown 收窄；text 提取/重建由本模块负责）。 */
  inbox: {
    readonly nextTurn: readonly unknown[];
    readonly nextStep: readonly unknown[];
    remove(messageId: string): boolean;
    replace(messageId: string, newMessage: unknown): boolean;
    splice(target: 'next-turn' | 'next-step', start: number, deleteCount: number, inserted: unknown[]): unknown[];
  };
}

/** 内核 UserMessage 的产品侧收窄（content.text 块拼接为面板文本）。 */
function inboxMessageText(message: unknown): string {
  const blocks = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function inboxMessageId(message: unknown): string {
  return String((message as { id?: unknown }).id ?? '');
}

/**
 * 演示 agent（走查基建，Owner 需求 2026-09-27：「确定可以了再给我」需要不烧
 * 真实 LLM 的浏览器走查开关）：与内核 agent 同构的最小面（内存 inbox 读写 +
 * followup/steer/inject/cancel），不调 LLM——followup 入队后按 demoDelayMs
 * 定时「消费」队头并经 onFrames 产帧（user-text 消费时落 + assistant-text
 * 演示回复 + turn-end），与真实内核「排队不落 log、开轮才落」语义一致。
 * 队列数后端管理：走查的队列/打断/立刻发送/重排全走真实 API 面，仅把
 * LLM 换成定时器。demoDelayMs=0（默认）时永不启用。
 */
class DemoAgent implements AgentLike {
  id: string;
  status: string = 'idle';
  session: { id: string; header: { cwd?: string; createdAt?: number | string } };
  inbox = {
    nextTurn: [] as unknown[],
    nextStep: [] as unknown[],
    remove: (messageId: string): boolean => {
      const idx = this.inbox.nextTurn.findIndex((m) => inboxMessageId(m) === messageId);
      if (idx >= 0) {
        this.inbox.nextTurn.splice(idx, 1);
        return true;
      }
      const s = this.inbox.nextStep.findIndex((m) => inboxMessageId(m) === messageId);
      if (s >= 0) {
        this.inbox.nextStep.splice(s, 1);
        return true;
      }
      return false;
    },
    replace: (messageId: string, newMessage: unknown): boolean => {
      const idx = this.inbox.nextTurn.findIndex((m) => inboxMessageId(m) === messageId);
      if (idx >= 0) {
        this.inbox.nextTurn[idx] = newMessage;
        return true;
      }
      return false;
    },
    splice: (
      target: 'next-turn' | 'next-step',
      start: number,
      deleteCount: number,
      inserted: unknown[],
    ): unknown[] => {
      const list = target === 'next-turn' ? this.inbox.nextTurn : this.inbox.nextStep;
      return list.splice(start, deleteCount, ...inserted);
    },
  };
  /** 帧产出回调（makeEntry 后接 commitFrames）。 */
  onFrames: ((frames: Frame[]) => void) | null = null;
  /** 队列消费至空（W10f：任务回 done 的 demo 侧同语义）。 */
  onIdle: (() => void) | null = null;
  /** makeEntry 的 registerPanelAnswerer 会挂审批监听——demo 无审批，no-op 订阅。 */
  ctx = { on: (): (() => void) => () => {} };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;

  constructor(
    sessionId: string,
    private demoDelayMs: number,
  ) {
    this.id = sessionId;
    this.session = { id: sessionId, header: { cwd: '/', createdAt: Date.now() } };
  }

  followup(message: unknown): void {
    this.inbox.nextTurn.push(message);
    this.schedule();
  }

  /** W10k 对齐内核语义：idle 时 steer 等价开新轮（入 nextTurn 起表）；
   * 运行中入 next-step 桶（consumeHead 轮起点吸收——demo 无独立 step 边界）。 */
  steer(message: unknown): void {
    if (this.status !== 'running') {
      this.inbox.nextTurn.push(message);
      this.schedule();
      return;
    }
    this.inbox.nextStep.push(message);
  }

  inject(message: unknown): void {
    this.inbox.nextStep.push(message);
  }

  cancel(_cause: unknown, options?: unknown): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // keepInbox（打断语义）：排队保留，收敛后自动续跑队头——demo 同构。
    if ((options as { keepInbox?: boolean } | undefined)?.keepInbox) this.schedule();
    else this.inbox.nextTurn.length = 0;
    this.status = 'idle';
  }

  /** 入队/续跑统一调度：有队头且无在途定时器才起表。 */
  private schedule(): void {
    if (this.paused || this.timer !== null || this.inbox.nextTurn.length === 0) return;
    this.status = 'running';
    this.timer = setTimeout(() => {
      this.timer = null;
      this.consumeHead();
    }, this.demoDelayMs);
  }

  /** 暂停消费（前端拖动排序期间——Owner 设计：拖动时队列稳定不抖，松手恢复）。 */
  pause(): void {
    this.paused = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.status = 'idle';
  }

  /** 恢复消费（松手）。 */
  resume(): void {
    this.paused = false;
    this.schedule();
  }

  private consumeHead(): void {
    const head = this.inbox.nextTurn.shift();
    if (head === undefined) {
      this.status = 'idle';
      this.onIdle?.();
      return;
    }
    // W10k 两批投帧：批1 turn-start 单独先行——onFrames 提交后 daemon 的队列
    // 钩子把该轮 attach 组 steer 进来；批2 吸收为本轮补充 + 轮体。
    this.onFrames?.([{ at: Date.now(), seq: 0, kind: 'turn-start', text: '' }]);
    const supplements = this.inbox.nextStep.splice(0);
    const frames: Frame[] = [
      { at: Date.now(), seq: 0, kind: 'user-text', text: inboxMessageText(head) },
      ...supplements.map((m) => ({
        at: Date.now(),
        seq: 0,
        kind: 'user-text' as const,
        text: `${inboxMessageText(m)}（补充）`,
      })),
      {
        at: Date.now(),
        seq: 0,
        kind: 'assistant-text',
        text: `（演示回复，未调用真实模型）已收到：「${inboxMessageText(head).slice(0, 60)}」${supplements.length > 0 ? `（含补充 ${supplements.length} 条）` : ''}`,
      },
      { at: Date.now(), seq: 0, kind: 'turn-end', text: 'completed' },
    ];
    this.onFrames?.(frames);
    if (this.inbox.nextTurn.length === 0 && this.inbox.nextStep.length === 0) {
      this.status = 'idle';
      this.onIdle?.();
    } else this.schedule();
  }

  disposeOf(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.status = 'idle';
  }
}

interface AgentsServiceLike {
  create(options: {
    sessionId: string;
    meta?: { cwd?: string; agentPreset?: string };
    agentOptions?: { provider?: string; model?: string; reasoningEffort?: string };
    setup?: (agentCtx: Context) => void;
  }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>;
  resume(options: {
    resumeSessionId: string;
    agentOptions?: { provider?: string; model?: string; reasoningEffort?: string };
    setup?: (agentCtx: Context) => void;
  }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>;
}

interface SessionEventLike {
  seq: number;
  type: string;
  data: unknown;
}

/** 会话 live 记录（帧环 + live agent 引用 + 投影工作集）。 */
interface LiveTaskSession {
  agent: AgentLike;
  dispose(): Promise<void>;
  taskId: string;
  store: FrameStore;
  frames: Frame[];
  frameSeq: number;
  toolNames: Map<string, string>;
  deltaBuffer: string[];
  reasoningBuffer: string[];
  toolArgBuffers: Map<string, { name?: string; parts: string[] }>;
  /** 当前 turn 的 usage 累计（undefined = 本轮尚无样本）。 */
  turnUsage: TurnUsageAccumulator | undefined;
  deltaAt: number;
  pending: Map<number, { resolve: (answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> }) => void }>;
  subscribers: Set<(frame: Frame) => void>;
  /** W10k 统一队列：单一有序序列（daemon 单一事实源）。内核 inbox 只是瞬时
   * 投递缓冲（admitted anchor + inflight attach），不再作为队列事实源。
   * 锁定段 = 序列中 lockBoundaryId 条及其后的连续后缀（held 由位置派生，
   * 不逐条存储）；锁=只是不自动投递，编辑/删除/改模式/拖动/立刻发送全开放。 */
  queue: W10kQueueItem[];
  lockBoundaryId: string | null;
  /** 单航次投递游标：已 followup 交内核、尚未 turn/start 确认的 anchor。 */
  admittedAnchorId: string | null;
  /** 当前轮对应的 anchor（turn/start 配对；轮结束清除；null=当前轮非队列
   * 起源，如任务初始 prompt）。 */
  activeAnchorId: string | null;
  /** 内核 turn 进行中（firehose turn/start~turn/end 维护；装配时 false）。 */
  turnRunning: boolean;
}

export function createTaskSessions(deps: TaskSessionDeps) {
  const retention = deps.retention ?? DEFAULT_RETENTION;
  const live = new Map<string, LiveTaskSession>();
  let firehoseBound = false;
  /** 演示延迟（Owner 走查开关，URL query 经 rpc demo.setDelay 设置；0=关闭）。
   * >0 时新建/复活会话用 DemoAgent（不调真实 LLM）。 */
  let demoDelayMs = 0;

  /** demo 会话装配：DemoAgent + makeEntry + 帧回调接线。 */
  function makeDemoEntry(sessionId: string, taskId: string, store: FrameStore, seeded: Frame[]): void {
    const agent = new DemoAgent(sessionId, demoDelayMs);
    const handle = { agent: agent as AgentLike, dispose: async () => agent.disposeOf() };
    makeEntry(handle, taskId, store, seeded);
    const entry = live.get(sessionId)!;
    agent.onFrames = (frames) => {
      const dated = frames.map((f, i) => ({ ...f, seq: entry.frameSeq + i }));
      entry.frameSeq += dated.length;
      commitFrames(entry, dated);
      // W10k 队列钩子（demo 轮事件经帧流而非 firehose）：turn-start 批先行
      // ——钩子里 pump 已把该轮 attach 组 steer 进 DemoAgent（consumeHead 批
      // 间吸收为补充）；turn-end 清扫 inflight + pump 续跑。
      for (const frame of frames) {
        if (frame.kind === 'turn-start') onQueueTurnStart(entry);
        if (frame.kind === 'turn-end') onQueueTurnEnd(entry);
      }
    };
    // demo idle 与真实内核同守卫：队列头仍可投（如仅剩锁定段外的下一批）
    // 时不报空闲——pump 在轮事件里已续跑，这里只兜底漏网。
    agent.onIdle = () => {
      if (!hasDeliverableHead(entry)) deps.onSessionIdle?.(sessionId);
    };
  }

  /** `$name` 交付：命中 user-invocable 技能 → 官方双消息注入；否则原样回落。 */
  async function deliverSkillInvocation(
    entry: LiveTaskSession,
    name: string,
    userWords: string,
    originalText: string,
  ): Promise<void> {
    const sendPlain = (text: string): void => {
      entry.agent.followup(
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }) as never,
      );
    };
    try {
      const kernel = requireKernel();
      const skills = kernelSkills(kernel.ctx);
      const definition = skills === undefined ? undefined : await skills.get(name);
      if (definition === undefined || !isUserInvocable(definition as never)) {
        sendPlain(originalText);
        return;
      }
      // 官方语义（dsh-skill SkillInvocationSource）：用户原话普通消息在前，
      // 技能体以 instructions 形、skill-invocation 源注入在后。
      if (userWords.length > 0) sendPlain(userWords);
      entry.agent.followup(
        createUserMessage({
          source: { kind: 'skill-invocation', name, form: 'instructions' },
          content: [{ type: 'text', text: renderSkillContent(definition as never) }],
        }) as never,
      );
    } catch {
      sendPlain(originalText);
    }
  }

  function requireKernel(): ShufaKernelHandle {
    const kernel = deps.kernel();
    if (!kernel) throw new Error('agent kernel is not mounted');
    return kernel;
  }

  function agentsService(ctx: Context): AgentsServiceLike {
    const service = (ctx as Context & { agents?: unknown }).agents;
    if (!service) throw new Error('kernel ctx.agents service missing');
    return service as AgentsServiceLike;
  }

  /** 订阅 session/event firehose → 帧投影（内核生命周期内绑定一次）。 */
  function bindFirehose(kernel: ShufaKernelHandle): void {
    if (firehoseBound) return;
    firehoseBound = true;
    type FirehoseContext = Context & {
      on: (event: 'session/event', listener: (session: { id: string }, event: SessionEventLike) => void) => () => void;
    };
    (kernel.ctx as FirehoseContext).on('session/event', (session, event) => {
      const entry = live.get(session.id);
      if (!entry) return;
      // W10k 队列钩子：turn/start 配对承认 anchor + 投 attach 组；turn/end
      // 清扫 inflight + pump 续跑（须先于 idle 判定——pump 可能已承认下一条）。
      if (event.type === 'turn/start') onQueueTurnStart(entry);
      // turn/end reason.kind='error'：agent 运行失败（如 LLM 不可达）→ 失败回调。
      // 走查 R3：reason.error.message/code 一并提取（此前只传字面 "error"，
      // 用户「任务失败看不到任何异常」——404/网络错误等明文直达任务记录）。
      if (event.type === 'turn/end') {
        const checked = TurnEndEventSchema.safeParse(event.data);
        const failed = checked.success && checked.data.reason?.kind === 'error';
        onQueueTurnEnd(entry, failed);
        if (failed && checked.success) {
          const error = (checked.data.reason as { error?: { message?: string; code?: string } })
            .error;
          const detail =
            error?.message !== undefined
              ? error.code !== undefined
                ? `${error.message}（${error.code}）`
                : error.message
              : String(checked.data.reason?.kind ?? 'error');
          deps.onSessionFailure?.(session.id, detail);
        } else if (checked.data?.reason?.kind === 'completed') {
          // W10f→W10k：轮完成且队列头不可自动投递（空/全锁/仅 idle-inject）=
          // agent 空闲等待输入，任务行回 done；队列可投时 pump 已承认下一条，
          // 保持 running。
          if (!hasDeliverableHead(entry)) {
            deps.onSessionIdle?.(session.id);
          }
        }
      }
      if (event.type === 'assistant/chunk') {
        const checked = AgentChunkEventSchema.safeParse(event.data);
        if (!checked.success) {
          logDroppedEvent(session.id, event.type, event.data);
          return;
        }
        absorbChunk(entry, checked.data.chunk);
        return;
      }
      absorbTurnUsage(entry, event);
      flushDeltas(entry);
      commitFrames(entry, projectEvent(entry, event));
    });
  }

  /**
   * 轮内 usage 吸收（turn-end 药丸数据源，2026-09-22）：
   * - turn/start 清零（新轮重新累计）；
   * - assistant/message 取 data.usage（SDK：成功尝试的精确计数随消息走）；
   * - assistant/attempt 取流末 usage chunk（失败/重试尝试的计数只嵌在流里）；
   * - 事件 data 为 SDK 外部输入，照例 safeParse；畸形样本静默跳过不产诊断
   *   （usage 是旁路数据，不影响帧投影主链路）。
   */
  function absorbTurnUsage(entry: LiveTaskSession, event: SessionEventLike): void {
    switch (event.type) {
      case 'turn/start':
        entry.turnUsage = undefined;
        return;
      case 'assistant/message': {
        const checked = MessageUsageEventSchema.safeParse(event.data);
        if (checked.success) addUsageSample(entry, checked.data.usage);
        return;
      }
      case 'assistant/attempt': {
        const checked = AttemptUsageEventSchema.safeParse(event.data);
        if (checked.success) addUsageSample(entry, usageOfAttemptStream(checked.data.stream));
        return;
      }
    }
  }

  /** 单样本累加（超安全整数即放弃整轮 usage——宁缺毋错，不展示假数）。 */
  function addUsageSample(entry: LiveTaskSession, usage: TokenUsageSample | undefined): void {
    if (usage === undefined) return;
    const acc = entry.turnUsage ?? { in: 0, out: 0 };
    acc.in += usage.inputTokens;
    acc.out += usage.outputTokens;
    if (usage.cacheReadTokens !== undefined) acc.cacheRead = (acc.cacheRead ?? 0) + usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined) acc.cacheWrite = (acc.cacheWrite ?? 0) + usage.cacheWriteTokens;
    entry.turnUsage = Number.isSafeInteger(acc.in) && Number.isSafeInteger(acc.out) ? acc : undefined;
  }

  /** 流式分片入缓冲（text/reasoning 同窗合并；tool-call-delta 按 callId 分桶）。 */
  function absorbChunk(
    entry: LiveTaskSession,
    chunk: { type: string; text?: string; id?: string; name?: string; argumentsDelta?: string },
  ): void {
    if (
      typeof chunk.text === 'string' &&
      chunk.text.length > 0 &&
      (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
    ) {
      const buffer = chunk.type === 'text-delta' ? entry.deltaBuffer : entry.reasoningBuffer;
      buffer.push(chunk.text);
      if (Date.now() - entry.deltaAt >= DELTA_FLUSH_MS) flushDeltas(entry);
      return;
    }
    if (chunk.type === 'tool-call-delta' && typeof chunk.argumentsDelta === 'string') {
      const key =
        typeof chunk.id === 'string' && chunk.id.length > 0
          ? chunk.id
          : typeof chunk.name === 'string' && chunk.name.length > 0
            ? chunk.name
            : undefined;
      if (key !== undefined) {
        const bucket = entry.toolArgBuffers.get(key) ?? { parts: [] };
        if (bucket.name === undefined && typeof chunk.name === 'string') bucket.name = chunk.name;
        bucket.parts.push(chunk.argumentsDelta);
        entry.toolArgBuffers.set(key, bucket);
      }
      if (Date.now() - entry.deltaAt >= DELTA_FLUSH_MS) flushDeltas(entry);
    }
  }

  /** 冲刷增量缓冲（reasoning 先于 text，text 先于工具参数）。 */
  function flushDeltas(entry: LiveTaskSession): void {
    if (entry.deltaBuffer.length === 0 && entry.reasoningBuffer.length === 0 && entry.toolArgBuffers.size === 0) {
      return;
    }
    entry.deltaAt = Date.now();
    if (entry.reasoningBuffer.length > 0) {
      commitFrames(entry, [frameOf(entry, 'assistant-reasoning-delta', { text: entry.reasoningBuffer.join('') })]);
      entry.reasoningBuffer = [];
    }
    if (entry.deltaBuffer.length > 0) {
      commitFrames(entry, [frameOf(entry, 'assistant-delta', { text: entry.deltaBuffer.join('') })]);
      entry.deltaBuffer = [];
    }
    if (entry.toolArgBuffers.size > 0) {
      const frames: Frame[] = [];
      for (const [callKey, bucket] of entry.toolArgBuffers) {
        frames.push(
          frameOf(entry, 'tool-args-delta', {
            text: bucket.parts.join(''),
            ...(bucket.name ? { toolName: bucket.name } : {}),
            payload: { call_id: callKey },
          }),
        );
      }
      entry.toolArgBuffers.clear();
      commitFrames(entry, frames);
    }
  }

  /** 帧提交单点：环形 trim + jsonl append + 订阅者通知。 */
  function commitFrames(entry: LiveTaskSession, frames: readonly Frame[]): void {
    for (const frame of frames) {
      entry.frames.push(frame);
      if (entry.frames.length > retention) {
        entry.frames.splice(0, entry.frames.length - retention);
      }
      entry.store.append(frame);
      // 会话标题回写（2026-09-25 三轮）：内核 session/title 帧落任务行
      //（deps.onSessionTitle；标题更新不打断帧流，异常只记日志）。
      if (frame.kind === 'session-title' && typeof frame.text === 'string' && frame.text.length > 0) {
        try {
          deps.onSessionTitle?.(entry.agent.session.id, frame.text);
        } catch (error) {
          console.warn('[sessions] 会话标题回写失败：', error instanceof Error ? error.message : error);
        }
      }
      for (const subscriber of entry.subscribers) {
        try {
          subscriber(frame);
        } catch {
          // 单订阅者异常不拖垮投影。
        }
      }
    }
  }

  function frameOf(
    entry: LiveTaskSession,
    kind: Frame['kind'],
    fields: { text?: string; toolName?: string; payload?: unknown },
  ): Frame {
    return {
      at: Date.now(),
      seq: entry.frameSeq++,
      kind,
      ...(fields.text !== undefined ? { text: fields.text } : {}),
      ...(fields.toolName !== undefined ? { toolName: fields.toolName } : {}),
      ...(fields.payload !== undefined ? { payload: fields.payload } : {}),
    };
  }

  /** 单事件 → 有序帧列表投影（空数组 = 丢弃）。 */
  function projectEvent(entry: LiveTaskSession, event: SessionEventLike): Frame[] {
    const sessionId = entry.agent.session.id;
    const data: unknown = event.data;
    switch (event.type) {
      case 'turn/start': {
        if (!ObjectPayloadEventSchema.safeParse(data).success) {
          logDroppedEvent(sessionId, event.type, data);
          return [];
        }
        return [frameOf(entry, 'turn-start', {})];
      }
      case 'turn/end': {
        const checked = TurnEndEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return [];
        }
        // 轮内 usage 收割：与既有 payload 字段（turn/reason passthrough）共存；
        // 无样本（历史会话/未上报/溢出放弃）时缺省——webui 药丸只显时长。
        const usage = entry.turnUsage;
        entry.turnUsage = undefined;
        const payload =
          usage === undefined ? checked.data : { ...checked.data, usage: usagePayloadOf(usage) };
        return [frameOf(entry, 'turn-end', { text: checked.data.reason?.kind, payload })];
      }
      case 'todo/write': {
        const checked = TodoWriteEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return [];
        }
        const cleaned = checked.data.todos.map((todo) => ({
          content: todo.content,
          status: todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending',
        }));
        return [frameOf(entry, 'todo-snapshot', { payload: { todos: cleaned } })];
      }
      case 'session/title': {
        const checked = SessionTitleEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return [];
        }
        const title = checked.data.title?.trim() ?? '';
        if (title.length === 0) return [];
        return [frameOf(entry, 'session-title', { text: title })];
      }
      case 'agent/status': {
        if (!ObjectPayloadEventSchema.safeParse(data).success) {
          logDroppedEvent(sessionId, event.type, data);
          return [];
        }
        return [frameOf(entry, 'status', { payload: data })];
      }
      case 'user/message': {
        const checked = MessageEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return [];
        }
        if (checked.data.source?.kind !== 'user') return [];
        const text = textOf(checked.data);
        if (text === undefined || text.length === 0) return [];
        return [frameOf(entry, 'user-text', { text })];
      }
      case 'assistant/message': {
        const checked = MessageEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return [];
        }
        const reasoning = blocksOf(checked.data, 'reasoning');
        const text = textOf(checked.data);
        if (reasoning === undefined && (text === undefined || text.length === 0)) return [];
        const frames: Frame[] = [];
        if (reasoning !== undefined) {
          frames.push(frameOf(entry, 'assistant-reasoning', { text: reasoning }));
        }
        if (text !== undefined && text.length > 0) {
          frames.push(frameOf(entry, 'assistant-text', { text }));
        }
        return frames;
      }
      case 'tool/call': {
        const checked = ToolCallEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return [];
        }
        let parsedArgs: unknown = checked.data.arguments;
        try {
          parsedArgs = JSON.parse(checked.data.arguments) as unknown;
        } catch {
          parsedArgs = checked.data.arguments;
        }
        entry.toolNames.set(checked.data.callId, checked.data.name);
        return [
          frameOf(entry, 'tool-call', { toolName: checked.data.name, payload: { call_id: checked.data.callId, arguments: parsedArgs } }),
        ];
      }
      case 'tool/result': {
        const checked = ToolResultEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return [];
        }
        const message = checked.data.message;
        const block = message.content[0] as { type: string; text?: string; content: Array<{ type: string; text?: string }> };
        let text: string | undefined;
        for (const part of block.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            text = part.text;
            break;
          }
        }
        return [
          frameOf(entry, 'tool-result', {
            toolName: entry.toolNames.get(message.source.callId),
            text,
            payload: { call_id: message.source.callId },
          }),
        ];
      }
      default:
        return [];
    }
  }

  /** 消息 content 块拼接（type 判别 + text）。 */
  function textOf(message: { content: Array<{ type: string; text?: string }> }): string | undefined {
    const parts = message.content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text as string);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  /** 累计器 → 帧 payload usage（桶名 snake_case，对齐 payload 线格式惯例 call_id 等）。 */
  function usagePayloadOf(acc: TurnUsageAccumulator): { in: number; out: number; cache_read?: number; cache_write?: number } {
    return {
      in: acc.in,
      out: acc.out,
      ...(acc.cacheRead !== undefined ? { cache_read: acc.cacheRead } : {}),
      ...(acc.cacheWrite !== undefined ? { cache_write: acc.cacheWrite } : {}),
    };
  }

  function blocksOf(message: { content: Array<{ type: string; text?: string }> }, type: string): string | undefined {
    const parts = message.content.filter((block) => block.type === type && typeof block.text === 'string').map((block) => block.text as string);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  /** 审批应答面：user-questions/request 挂起为 approval-request 帧，answer() 回填。 */
  function registerPanelAnswerer(entry: LiveTaskSession): void {
    type AnswerContext = {
      ctx: {
        on: (
          event: 'user-questions/request',
          listener: (
            request: { questions?: unknown },
            next: () => Promise<unknown>,
          ) => Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }>,
        ) => () => void;
      };
    };
    (entry.agent as unknown as AnswerContext).ctx.on('user-questions/request', async (request) => {
      const requestSeq = entry.frameSeq++;
      const requestFrame: Frame = {
        at: Date.now(),
        seq: requestSeq,
        kind: 'approval-request',
        payload: { questions: request.questions ?? [] },
      };
      commitFrames(entry, [requestFrame]);
      return await new Promise((resolve) => {
        entry.pending.set(requestSeq, { resolve });
      });
    });
  }

  /** 工具面收窄 setup：全局继承工具按 deny-list restrict（MCP scoped 注册不受影响）。 */
  function setupToolSurface(agentCtx: Context): void {
    const tools = (
      agentCtx as Context & {
        tools?: { schemas?: () => Array<{ name?: string }>; restrict?: (filter: { deny: string[] }) => () => void };
      }
    ).tools;
    if (!tools?.restrict) return;
    const globalNames = (tools.schemas?.() ?? [])
      .map((schema) => schema?.name)
      .filter((name): name is string => typeof name === 'string');
    const deny = productToolDenyList(globalNames);
    if (deny.length > 0) tools.restrict({ deny });
  }

  function entryFramesFromDisk(store: FrameStore): Frame[] {
    return store.readAfter(0).slice(-retention);
  }

  function makeEntry(
    handle: { agent: AgentLike; dispose(): Promise<void> },
    taskId: string,
    store: FrameStore,
    seeded: Frame[],
  ): LiveTaskSession {
    const entry: LiveTaskSession = {
      agent: handle.agent,
      dispose: handle.dispose,
      taskId,
      store,
      frames: seeded,
      frameSeq: (seeded.at(-1)?.seq ?? 0) + 1,
      toolNames: new Map(),
      deltaBuffer: [],
      reasoningBuffer: [],
      toolArgBuffers: new Map(),
      turnUsage: undefined,
      deltaAt: Date.now(),
      pending: new Map(),
      subscribers: new Set(),
      queue: [],
      lockBoundaryId: null,
      admittedAnchorId: null,
      activeAnchorId: null,
      turnRunning: false,
    };
    registerPanelAnswerer(entry);
    live.set(handle.agent.session.id, entry);
    // W10k 装配即恢复：DB 存档回填 + 收养内核 inbox 遗留（旧模型/崩溃残留：
    // nextTurn→anchor、nextStep→attach(steer 缺省)，drain 后内核 inbox 清空），
    // pump 续跑（崩溃恢复语义：未投完的序列继续投）。
    const restored = deps.onQueueRestore?.(handle.agent.session.id, taskId) ?? null;
    const adoptedTurn = [...handle.agent.inbox.nextTurn];
    const adoptedStep = [...handle.agent.inbox.nextStep];
    if (adoptedTurn.length > 0 || adoptedStep.length > 0) {
      handle.agent.inbox.splice('next-turn', 0, adoptedTurn.length, []);
      handle.agent.inbox.splice('next-step', 0, adoptedStep.length, []);
    }
    // 恢复只回填 queued 态：admitted/inflight 崩溃前在内核 inbox，收养
    // 已重新纳入（DB 行跳过——Codex P1：防同一消息双重投递）。另按
    // kernelId 精确去重 + kind/text 兜底（v6 旧行无 kernelId——迁移窗口
    // 内核与 DB 同条并存时内核侧为真，DB 行剔除）。
    const adoptedIds = new Set([...adoptedTurn, ...adoptedStep].map((m) => inboxMessageId(m)));
    // 文本兜底（仅 v6 旧行 kernelId 为空）：计数制——每条收养消息只抵扣一条
    // 同文本旧行，多出的合法重复行保留（Codex 终审：防过度删除丢消息）。
    const legacyTextBudget = new Map<string, number>();
    for (const m of adoptedTurn) {
      const key = `anchor:${inboxMessageText(m)}`;
      legacyTextBudget.set(key, (legacyTextBudget.get(key) ?? 0) + 1);
    }
    for (const m of adoptedStep) {
      const key = `attach:${inboxMessageText(m)}`;
      legacyTextBudget.set(key, (legacyTextBudget.get(key) ?? 0) + 1);
    }
    entry.queue = [
      ...adoptedStep.map((m) => ({
        id: inboxMessageId(m),
        text: inboxMessageText(m),
        kind: 'attach' as const,
        effect: 'steer' as const,
        state: 'queued' as const,
      })),
      ...adoptedTurn.map((m) => ({
        id: inboxMessageId(m),
        text: inboxMessageText(m),
        kind: 'anchor' as const,
        state: 'queued' as const,
      })),
      ...(restored?.items ?? []).filter((i) => {
        if (i.state !== 'queued') return false;
        if (i.kernelId !== undefined) return !adoptedIds.has(i.kernelId); // v8 行只精确匹配
        const key = `${i.kind}:${i.text}`;
        const budget = legacyTextBudget.get(key) ?? 0;
        if (budget > 0) {
          legacyTextBudget.set(key, budget - 1); // 抵扣一条
          return false;
        }
        return true;
      }),
    ];
    entry.lockBoundaryId = restored?.lockBoundaryId ?? null;
    persistQueueState(entry);
    pumpQueue(entry);
    return entry;
  }

  // ------------------------------------------------ W10k 统一队列核心

  /** 锁定 = 序列中边界条及其后的连续后缀（位置派生）。 */
  function isHeld(entry: LiveTaskSession, item: W10kQueueItem): boolean {
    if (entry.lockBoundaryId === null) return false;
    const boundary = entry.queue.findIndex((q) => q.id === entry.lockBoundaryId);
    if (boundary < 0) return false;
    return entry.queue.indexOf(item) >= boundary;
  }

  function queueMessage(text: string): unknown {
    return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
  }

  /** attach 交付（steer/inject 按效果；idle 时 steer 等价开新轮——内核语义，
   * 乐观置位 turnRunning 防投递与轮事件间的双驱动窗口）。 */
  function deliverAttach(entry: LiveTaskSession, item: W10kQueueItem): void {
    const message = queueMessage(item.text);
    item.kernelId = (message as { id?: string }).id ?? undefined;
    if (item.effect === 'inject') entry.agent.inject(message as never);
    else {
      if (!entry.turnRunning) entry.turnRunning = true;
      entry.agent.steer(message as never);
    }
    item.state = 'inflight';
  }

  /** 单一投递游标（W10k 唯一的自动消费入口）：
   * 1) 队头连续 attach（未锁）：运行中→立即投当前轮；idle→steer 开新轮、
   *    inject 不唤醒保持 pending（等下一次活动轮）；
   * 2) 队头 anchor（未锁、无单航次在途、当前轮已结束）：followup 承认——
   *    忙期不承认（Codex 单航次规则：anchor 未收到开轮确认前不投下一个），
   *    轮结束事件里 pump 续跑。 */
  function pumpQueue(entry: LiveTaskSession): void {
    let mutated = false;
    // 头部 attach 连续段：跳过 inflight（已交付不阻断同轮后续补充）与 held/
    // idle-inject（保持 pending），其余投给当前轮；遇 anchor 停（绑定它，待其开轮）。
    let idx = 0;
    while (idx < entry.queue.length) {
      const item = entry.queue[idx]!;
      if (item.kind === 'anchor') break;
      if (item.state === 'inflight' || isHeld(entry, item)) {
        idx += 1;
        continue;
      }
      if (!entry.turnRunning && item.effect === 'inject') {
        idx += 1; // inject 不唤醒：保持 pending 等下一次活动轮
        continue;
      }
      deliverAttach(entry, item);
      mutated = true;
      idx += 1;
    }
    const head = entry.queue[0];
    if (
      head !== undefined &&
      head.kind === 'anchor' &&
      head.state === 'queued' &&
      !isHeld(entry, head) &&
      entry.admittedAnchorId === null &&
      !entry.turnRunning &&
      // 内核轮位空闲（next-turn 空=无在途轮/待开轮）——消除任务初始 prompt
      // 异步开轮窗口内承认 anchor 的假配对。
      entry.agent.inbox.nextTurn.length === 0
    ) {
      const message = queueMessage(head.text);
      head.kernelId = (message as { id?: string }).id ?? undefined;
      head.state = 'admitted';
      entry.admittedAnchorId = head.id;
      entry.agent.followup(message as never);
      mutated = true;
    }
    if (mutated) persistQueueState(entry);
  }

  /** 轮开始（firehose/demo 帧）：承认的 anchor 配对为当前轮（从队列移除——
   * 转录面板的 user-text 帧同期呈现），随后 pump 把它身后的 attach 组投进
   * 该轮（下一 step 边界生效=「跟随开轮一起发出」）。非队列起源轮
   * （初始 prompt 等）同样受益：队头 attach 绑定当前槽位立即投。 */
  function onQueueTurnStart(entry: LiveTaskSession): void {
    entry.turnRunning = true;
    if (entry.admittedAnchorId !== null) {
      entry.activeAnchorId = entry.admittedAnchorId;
      entry.admittedAnchorId = null;
      const idx = entry.queue.findIndex((q) => q.id === entry.activeAnchorId);
      if (idx >= 0) {
        entry.queue.splice(idx, 1);
        persistQueueState(entry); // 无条件：anchor 已消费必须即刻落库（防重启复活）
      }
    }
    pumpQueue(entry);
  }

  /** 轮结束：清扫 inflight attach（已交内核的随本轮终结——取消/完成同理，
   * 不重放），游标复位，pump 续跑下一 anchor/attach。failed=true（LLM 错误
   * 等）不 pump——队列冻结（任务失败，重试由用户触发）。admittedAnchorId
   * 不清——它在途（内核 nextTurn 待开轮），turn/start 才是它的配对点。 */
  function onQueueTurnEnd(entry: LiveTaskSession, failed = false): void {
    entry.turnRunning = false;
    entry.activeAnchorId = null;
    const before = entry.queue.length;
    entry.queue = entry.queue.filter((q) => q.state !== 'inflight');
    if (!failed) pumpQueue(entry);
    if (entry.queue.length !== before) persistQueueState(entry);
  }

  /** 队列头是否可自动投递（不可投=任务空闲：全空/全锁定/仅 idle-inject）。 */
  function hasDeliverableHead(entry: LiveTaskSession): boolean {
    if (entry.admittedAnchorId !== null) return true;
    const head = entry.queue[0];
    if (head === undefined) return false;
    if (isHeld(entry, head)) return false;
    if (head.kind === 'anchor') return head.state === 'queued';
    return entry.turnRunning || head.effect === 'steer';
  }

  function persistQueueState(entry: LiveTaskSession): void {
    deps.onQueuePersist?.(entry.agent.session.id, entry.taskId, entry.queue, entry.lockBoundaryId);
  }

  /** enqueue + pump（followup/steer 入口共用）。 */
  function enqueue(entry: LiveTaskSession, item: W10kQueueItem): void {
    entry.queue.push(item);
    pumpQueue(entry);
  }

  /** 撤回在途承认的 anchor（从内核 next-turn 取回、回 queued、清游标）——
   * setMode/sendNow/reorder 等重排类操作的前置，防 stale 游标阻断 pump 或
   * 被外生轮 turn/start 假配对消费。撤不回（已被消费/开轮中）→ 条目随
   * 该轮终结，从队列移除（Codex 复核 P1：内核寻址必须 kernelId ?? id）。 */
  function withdrawAdmitted(entry: LiveTaskSession): void {
    if (entry.admittedAnchorId === null) return;
    const idx = entry.queue.findIndex((q) => q.id === entry.admittedAnchorId);
    entry.admittedAnchorId = null;
    if (idx < 0) return;
    const item = entry.queue[idx]!;
    if (item.state !== 'admitted') return;
    if (entry.agent.inbox.remove(item.kernelId ?? item.id)) {
      item.state = 'queued';
    } else {
      entry.queue.splice(idx, 1); // 已被内核消费：随轮终结，不残留队列
    }
  }

  /** 统一撤回原语（Codex 复评 P1-A）：从内核取回在途条目。
   * 'withdrawn' = 取回成功回 queued；'consumed' = 内核已消费（随轮终结，
   * 从队列移除）。游标匹配即清。 */
  function withdrawItem(entry: LiveTaskSession, item: W10kQueueItem): 'withdrawn' | 'consumed' {
    if (entry.admittedAnchorId === item.id) entry.admittedAnchorId = null;
    if (entry.agent.inbox.remove(item.kernelId ?? item.id)) {
      item.state = 'queued';
      return 'withdrawn';
    }
    const idx = entry.queue.indexOf(item);
    if (idx >= 0) entry.queue.splice(idx, 1);
    return 'consumed';
  }

  /** 锁定前撤回后缀全部在途条目（Codex 复核 P1：只撤边界条会漏掉其后的
   * inflight attach——锁定后仍会在 step 边界执行）。撤不回的=已消费，随轮
   * 终结移除。 */
  function withdrawSuffixInFlight(entry: LiveTaskSession, fromIndex: number): void {
    for (let i = entry.queue.length - 1; i >= fromIndex; i -= 1) {
      const item = entry.queue[i]!;
      if (item.state === 'queued') continue;
      withdrawItem(entry, item);
    }
  }

  /** 命令目录缓存（内核命令注册表静态——插件装载后不变；boot 探针一次）。 */
  let commandCatalog: readonly KernelCommandInfo[] | null = null;

  /** 内核命令注册表（/ 面板数据源）：探针 agent 取 global 层后立即释放。 */
  async function listCommands(): Promise<readonly KernelCommandInfo[]> {
    if (commandCatalog !== null) return commandCatalog;
    const kernel = requireKernel();
    const commands = kernelCommands(kernel.ctx);
    if (commands === undefined) {
      commandCatalog = [];
      return commandCatalog;
    }
    const agents = agentsService(kernel.ctx);
    const handle = await agents.create({
      sessionId: `probe-${randomUUID()}`,
      meta: { cwd: process.cwd() },
    });
    try {
      const list = commands.list(handle.agent) ?? [];
      commandCatalog = [...list]
        .map((command) => ({ name: command.name, description: command.description }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } finally {
      await handle.dispose().catch(() => undefined);
    }
    return commandCatalog;
  }

  /** 内核技能注册表的 user-invocable 投影（$ 面板数据源）。 */
  async function listUserSkills(): Promise<readonly KernelSkillInfo[]> {
    const kernel = requireKernel();
    const skills = kernelSkills(kernel.ctx);
    if (skills === undefined) return [];
    const all = await skills.list().catch(() => []);
    return all
      .filter((skill) => isUserInvocable(skill as never))
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
      }));
  }

  return {
    /** 内核挂载后首个会话操作前调用（幂等）。 */
    attach(kernel: ShufaKernelHandle): void {
      bindFirehose(kernel);
    },

    /** 演示延迟设置（Owner 走查开关；毫秒，0=关闭）。只影响其后新建/复活的会话。 */
    setDemoDelay(ms: number): void {
      demoDelayMs = Math.max(0, Math.min(ms, 600_000));
    },

    /** 演示模式是否激活（tasks.create 门控豁免依据）。 */
    isDemoActive(): boolean {
      return demoDelayMs > 0;
    },

    /** 拖动排序期暂停消费（Owner 设计：拖动时队列稳定，松手恢复）。
     * DemoAgent 支持真暂停；真实内核 agent 无暂停原语——no-op（drop 时
     * queueReorder 集合校验兜底并发消费）。 */
    setQueueReordering(sessionId: string, paused: boolean): void {
      const entry = live.get(sessionId);
      if (!entry) return;
      const agent = entry.agent as unknown as { pause?: () => void; resume?: () => void };
      if (paused && typeof agent.pause === 'function') agent.pause();
      else if (!paused && typeof agent.resume === 'function') agent.resume();
    },

    /** / 与 $ 面板目录（DSH 官方一致性：命令/技能注册表出自内核，非产品硬编码）。 */
    listCommands,
    listUserSkills,


    /**
     * 创建任务会话：cwd=用户根目录（架构调整 2026-09-23：shell 工作目录/相对
     * 路径解析基准——agent 里 pwd=users/<username>/；.shufa 任务目录只作为
     * 进程面 cwd 由 capability 层钉住）+ 首 prompt 启动。
     */
    async createTaskSession(taskId: string, input: TaskSessionStartInput): Promise<{ sessionId: string }> {
      // 演示模式（走查开关）：不建内核 agent、不选模型、不调 LLM。
      if (demoDelayMs > 0) {
        const sessionId = `task-${randomUUID()}`;
        makeDemoEntry(sessionId, taskId, new FrameStore(input.framesFile), []);
        live.get(sessionId)!.agent.followup(
          { id: `demo-${randomUUID()}`, role: 'user', content: [{ type: 'text', text: input.prompt }], source: { kind: 'user' } },
        );
        return { sessionId };
      }
      const kernel = requireKernel();
      bindFirehose(kernel);
      const agents = agentsService(kernel.ctx);
      const sessionId = `task-${randomUUID()}`;
      const model = await deps.modelSelection(taskId);
      const handle = await agents.create({
        sessionId,
        meta: { cwd: input.cwd, agentPreset: 'shufa' },
        ...(model
          ? {
              agentOptions: {
                provider: model.provider,
                model: model.model,
                ...(model.effort ? { reasoningEffort: model.effort } : {}),
              },
            }
          : {}),
        setup: setupToolSurface,
      });
      const store = new FrameStore(input.framesFile);
      makeEntry(handle, taskId, store, []);
      handle.agent.followup(
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: input.prompt }] }) as never,
      );
      return { sessionId };
    },

    /** 复活持久会话（内核 session log 重建 LLM 历史；帧环由 jsonl 末尾 seed）。 */
    async resumeTaskSession(taskId: string, input: TaskSessionResumeInput): Promise<{ sessionId: string }> {
      // 演示模式：daemon 重启后的 demo 会话续聊——空 inbox 重建，历史帧回放。
      if (demoDelayMs > 0) {
        makeDemoEntry(input.sessionId, taskId, new FrameStore(input.framesFile), entryFramesFromDisk(new FrameStore(input.framesFile)));
        return { sessionId: input.sessionId };
      }
      const kernel = requireKernel();
      bindFirehose(kernel);
      const agents = agentsService(kernel.ctx);
      const model = await deps.modelSelection(taskId);
      const handle = await agents.resume({
        resumeSessionId: input.sessionId,
        ...(model
          ? {
              agentOptions: {
                provider: model.provider,
                model: model.model,
                ...(model.effort ? { reasoningEffort: model.effort } : {}),
              },
            }
          : {}),
        setup: setupToolSurface,
      });
      const store = new FrameStore(input.framesFile);
      makeEntry(handle, taskId, store, entryFramesFromDisk(store));
      return { sessionId: handle.agent.session.id };
    },

    /** 取消当前活动（幂等；排队消息存活）。 */
    cancel(sessionId: string): void {
      const entry = live.get(sessionId);
      if (!entry) throw new Error(`agent session not found: ${sessionId}`);
      entry.agent.cancel('user', { keepInbox: true });
    },

    /**
     * 会话内换模型（走查 R6）：仅 dispose live handle（帧 jsonl 不动）；
     * 上层随后 resumeTaskSession 以新 agentOptions 重建（modelSelection 读
     * 任务表新值）。不在册时 no-op（daemon 重启后的会话由 resume 自然带新模型）。
     */
    async disposeLive(sessionId: string): Promise<void> {
      const entry = live.get(sessionId);
      if (!entry) return;
      live.delete(sessionId);
      await entry.dispose();
    },

  /**
   * 追加用户消息（W7b 前台续聊）：live 会话排队投递；不在册时抛错
   * （调用方决定先 resume 再重试）。
   */
  followup(sessionId: string, text: string): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    // slash 命令分流（2026-09-25 前台对齐，skill-creator-v2 同法）："/compact" 等
    // 经内核 ctx.commands 执行（不进 LLM）；非命令（返回 undefined）回落普通消息。
    if (text.startsWith('/')) {
      const kernel = requireKernel();
      const commands = (
        kernel.ctx as Context & {
          commands?: {
            execute: (
              agent: unknown,
              line: string,
              attachments: readonly unknown[],
              signal: AbortSignal,
            ) => Promise<unknown>;
          };
        }
      ).commands;
      if (commands) {
        // 命令执行异步化：吞掉 rejection 由帧流呈现（与消息发送同异步面）；
        // 同步签名保持 void——resolve 后未命中命令再补投消息。
        void commands
          .execute(entry.agent, text, [], new AbortController().signal)
          .then((executed) => {
            if (executed === undefined) {
              entry.agent.followup(
                createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }) as never,
              );
            }
          })
          .catch(() => {
            entry.agent.followup(
              createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }) as never,
            );
          });
        return;
      }
    }
    // `$skill` 显式调用（2026-09-25 前台对齐·二轮，DSH 官方语义）：用户原话普通
    // 消息在前 + 技能体以 skill-invocation 源注入在后（renderSkillContent 的
    // <skill_content> 与模型侧 skill 工具同形）。未命中/不可用户调用 → 原样普通消息。
    if (text.startsWith('$')) {
      const matched = /^(\$\S+)(?:\s+([\s\S]*))?$/.exec(text);
      if (matched !== null) {
        void deliverSkillInvocation(entry, matched[1]!.slice(1), (matched[2] ?? '').trim(), text);
        return;
      }
    }
    // W10k：非命令消息入统一队列（anchor=开轮）。slash/$skill 分流直投内核
    // （命令/技能语义=立即执行，不占队列序）。
    enqueue(entry, {
      id: randomUUID(),
      text,
      kind: 'anchor',
      state: 'queued',
    });
  },

  /**
   * 引导当前轮（W10，DSH 内核 steer；W10k 入统一队列 attach）：运行中在下一
   * step 边界生效，idle 等价开新轮。与 followup 不同：不做 / 与 $ 分流——
   * 面板语义（命令执行/技能注入）属于整轮对话，引导是中途改口的裸文本。
   * 不在册时抛错（调用方复活后重试，与 followup 同约定）。
   */
  steer(sessionId: string, text: string): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    enqueue(entry, {
      id: randomUUID(),
      text,
      kind: 'attach',
      effect: 'steer',
      state: 'queued',
    });
  },

  // ------------------------------------------------ 队列面板（W10k 统一序列）

  /** 队列视图（单一序列投影）：mode=anchor→queue / attach→effect；held=锁定
   * 后缀（位置派生）；inflight=已交内核（下一 step 边界生效，轮终清扫——
   * 前端只读呈现）。 */
  queueView(
    sessionId: string,
  ): {
    items: Array<{
      messageId: string;
      mode: 'queue' | 'steer' | 'inject';
      text: string;
      held: boolean;
      inflight: boolean;
    }>;
    lockBoundary: string | null;
  } {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    const items = entry.queue.map((item) => ({
      messageId: item.id,
      mode: item.kind === 'anchor' ? ('queue' as const) : (item.effect ?? ('steer' as const)),
      text: item.text,
      held: isHeld(entry, item),
      inflight: item.state === 'inflight',
    }));
    return { items, lockBoundary: entry.lockBoundaryId };
  },

  /**
   * 锁定/解锁（Owner 设计 2026-09-28 定稿：锁=只是不自动投递，其余全开放）：
   * 边界条及其后的连续后缀 held（位置派生，条目不搬家）。null=解锁，pump
   * 立即续投队头。在途条目（admitted anchor / inflight attach）先从内核
   * inbox 撤回再锁（撤不回=已被消费/开轮——抛错，前端刷新重试）。
   */
  queueLock(sessionId: string, messageId: string | null): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    if (messageId === null) {
      if (entry.lockBoundaryId === null) return;
      entry.lockBoundaryId = null;
      pumpQueue(entry);
      persistQueueState(entry);
      return;
    }
    const idx = entry.queue.findIndex((q) => q.id === messageId);
    if (idx < 0) throw new Error(`队列中没有该条目：${messageId}`);
    // 撤回边界及其后全部在途（Codex P1：漏掉的 inflight 锁定后仍会执行）；
    // 撤不回的（已消费）随轮终结移除——锁定的是剩余序列。
    withdrawSuffixInFlight(entry, idx);
    entry.lockBoundaryId = entry.queue[idx] !== undefined ? entry.queue[idx]!.id : null;
    persistQueueState(entry);
  },

  /** 编辑入口：锁定段内目标文本（调用方 service 负责先锁定未锁条目）。 */
  queueHeldText(sessionId: string, messageId: string): string {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    const item = entry.queue.find((q) => q.id === messageId);
    if (item === undefined || !isHeld(entry, item)) {
      throw new Error(`该条目不在锁定段：${messageId}`);
    }
    return item.text;
  },

  /** 确认编辑：锁定段内目标条换文本（id 不变——寻址稳定）。 */
  queueEditApply(sessionId: string, messageId: string, text: string): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    const item = entry.queue.find((q) => q.id === messageId);
    if (item === undefined || !isHeld(entry, item)) {
      throw new Error(`该条目不在锁定段：${messageId}`);
    }
    item.text = text;
    persistQueueState(entry);
  },

  /** 删除一条（inflight/admitted 需同时撤内核 inbox；不在队列幂等成功）。
   * 边界条被删→边界移到其原后继（锁定后缀仍连续）；后缀删空自动解锁。
   * attach 的 anchor 被删→attach 原地保留（绑定按序重算：前方最近 anchor
   * 或当前轮槽位）。 */
  queueRemove(sessionId: string, messageId: string): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    const idx = entry.queue.findIndex((q) => q.id === messageId);
    if (idx < 0) return;
    const [removed] = entry.queue.splice(idx, 1);
    if (removed !== undefined && removed.state !== 'queued') {
      entry.agent.inbox.remove(removed.kernelId ?? messageId);
      // Codex P1：删除在途承认项必须清游标，否则 pump 被假阻断 + 后续
      // turn/start 假配对已删条目。
      if (entry.admittedAnchorId === messageId) entry.admittedAnchorId = null;
    }
    if (
      entry.lockBoundaryId !== null &&
      !entry.queue.some((q) => q.id === entry.lockBoundaryId)
    ) {
      entry.lockBoundaryId = entry.queue[idx]?.id ?? null;
    }
    pumpQueue(entry);
    persistQueueState(entry);
  },

  /** 修改投递模式（W10k 正交减法）：位置不动，只改 kind/effect——queue→
   * anchor（开轮），steer/inject→attach（补充，效果为 mode）。绑定随位置
   * 自动重算；锁定不因改模式越过（锁=不自动投递）。在途（inflight/
   * admitted）先撤内核回 queued 再改。 */
  queueSetMode(sessionId: string, messageId: string, mode: 'queue' | 'steer' | 'inject'): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    const item = entry.queue.find((q) => q.id === messageId);
    if (item === undefined) throw new Error(`队列中没有该条目：${messageId}`);
    if (item.state !== 'queued' && withdrawItem(entry, item) === 'consumed') {
      // 拒绝前先落库清理后的队列（Codex 终审：防重启从旧 DB 行复活已消费条目）。
      persistQueueState(entry);
      throw new Error('该条目已生效，无法修改模式（请刷新）');
    }
    if (mode === 'queue') {
      item.kind = 'anchor';
      delete item.effect;
    } else {
      item.kind = 'attach';
      item.effect = mode;
    }
    pumpQueue(entry);
    persistQueueState(entry);
  },

  /** 立刻发送（发送意图越过锁定；组语义）：
   * - anchor：它+其后连续 attach 组整体提到队首（组内序保持；移到边界前=
   *   held 随位置解除）；运行中先 cancel{user,keepInbox}（轮收敛后 turn/end
   *   →pump 承认新队首），idle 直接 pump 承认。
   * - attach：提到队首（绑当前轮槽位）；pump 立即投——运行中入当前轮下一
   *   step，idle 时 steer 开新轮（inject 不唤醒，等价入列 pending）。
   * - 边界收敛：被移动项之后的原锁定段若失去边界参照，重算到剩余 held 后缀
   *   首条或解锁。 */
  queueSendNow(sessionId: string, messageId: string): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    const idx = entry.queue.findIndex((q) => q.id === messageId);
    if (idx < 0) throw new Error(`队列中没有该排队条目：${messageId}`);
    const item = entry.queue[idx]!;
    let group: W10kQueueItem[];
    let oldSuccessor: W10kQueueItem | undefined;
    if (item.kind === 'anchor') {
      let end = idx + 1;
      while (end < entry.queue.length && entry.queue[end]!.kind === 'attach') end += 1;
      group = entry.queue.splice(idx, end - idx);
      oldSuccessor = entry.queue[idx];
    } else {
      group = entry.queue.splice(idx, 1);
      oldSuccessor = entry.queue[idx];
    }
    entry.queue.unshift(...group);
    // 撤回一切在途（组内 admitted 与组外 stale 承认——next-turn 必须让位给
    // 新队首，否则内核会先跑旧承认项破坏组语义）。组员已消费=随轮终结，
    // 从组中剔除（不重投）；目标自身已消费=拒绝本次操作。
    withdrawAdmitted(entry);
    const consumedIds = new Set<string>();
    for (const member of group) {
      if (member.state !== 'queued' && withdrawItem(entry, member) === 'consumed') {
        consumedIds.add(member.id);
      }
    }
    if (consumedIds.has(messageId)) {
      persistQueueState(entry); // 同上：拒绝前落库清理结果
      throw new Error('该条目已生效，无法立刻发送（请刷新）');
    }
    group = group.filter((m) => !consumedIds.has(m.id));
    // 边界收敛：组来自锁定段时，原后继（旧序中组后第一条，必仍在锁定段）
    // 接班边界；组原本就是队尾则解锁。
    if (entry.lockBoundaryId !== null) {
      const boundaryInGroup = group.some((m) => m.id === entry.lockBoundaryId);
      const boundaryGone = !entry.queue.some((q) => q.id === entry.lockBoundaryId);
      if (boundaryInGroup || boundaryGone) {
        entry.lockBoundaryId = oldSuccessor?.id ?? null;
      }
    }
    if (item.kind === 'anchor' && entry.turnRunning) {
      entry.agent.cancel({ kind: 'user' }, { keepInbox: true });
    } else {
      pumpQueue(entry);
    }
    persistQueueState(entry);
  },

  /** 全局重排（拖动排序）：orderedIds 与当前非 inflight 条目恰为同集合
   * （inflight 已交内核在途不参与——前端列表已过滤）。admitted（在途
   * anchor，暂停消费时队头常态）先撤内核回 queued 再排——拖动期间一切
   * 可见条目皆可排。重排后绑定按序重算；边界条 id 不变（held 后缀随排）。 */
  queueReorder(sessionId: string, orderedIds: string[]): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    // 先撤回在途承认（Codex 复评 P1-A：remove 失败=已消费，剔除后再校验——
    // 集合漂移自然走「队列已变化」拒绝，不重投已消费消息）。
    for (const item of entry.queue.filter((q) => q.state === 'admitted')) {
      withdrawItem(entry, item);
    }
    const reorderableIds = entry.queue
      .filter((q) => q.state !== 'inflight')
      .map((q) => q.id);
    if (
      orderedIds.length !== reorderableIds.length ||
      new Set(orderedIds).size !== orderedIds.length ||
      orderedIds.some((id) => !reorderableIds.includes(id))
    ) {
      persistQueueState(entry); // 撤回已改内存（含已消费剔除）——先落库再拒绝
      throw new Error('队列已变化（可能有消息正在被消费），请刷新后重试');
    }
    const byId = new Map(entry.queue.map((q) => [q.id, q]));
    const reordered = orderedIds.map((id) => byId.get(id)!);
    const inFlight = entry.queue.filter((q) => q.state === 'inflight');
    entry.queue = [...reordered, ...inFlight];
    pumpQueue(entry);
    persistQueueState(entry);
  },

    /** 回答一个待答请求（未知/已解决返回 false）。 */
    answer(
      sessionId: string,
      requestSeq: number,
      answers: Array<{ id: string; selected: string[]; custom?: string }>,
    ): boolean {
      const entry = live.get(sessionId);
      if (!entry) return false;
      const pending = entry.pending.get(requestSeq);
      if (!pending) return false;
      entry.pending.delete(requestSeq);
      commitFrames(entry, [frameOf(entry, 'approval-resolved', { payload: { answers } })]);
      pending.resolve({ answers });
      return true;
    },

    /** 产品侧补帧（任务状态机 status / result 帧）：走同一提交单点。 */
    emit(
      sessionId: string,
      frame: Omit<Frame, 'at' | 'seq'>,
    ): void {
      const entry = live.get(sessionId);
      if (!entry) return;
      commitFrames(entry, [{ ...frame, at: Date.now(), seq: entry.frameSeq++ }]);
    },

    /** live 状态（persisted = 无 live 句柄，可经 resume 复活）。 */
    liveStatusOf(sessionId: string): SessionLiveStatus {
      const entry = live.get(sessionId);
      if (!entry) return 'persisted';
      return entry.agent.status === 'running' ? 'running' : 'idle';
    },

    /** 增量帧读取：live 环优先，否则 jsonl 回放。 */
    stream(sessionId: string, framesFile: string, afterSeq: number): { frames: Frame[]; status: SessionLiveStatus } {
      const entry = live.get(sessionId);
      if (entry) {
        return { frames: entry.frames.filter((frame) => frame.seq > afterSeq), status: this.liveStatusOf(sessionId) };
      }
      return { frames: new FrameStore(framesFile).readAfter(afterSeq), status: 'persisted' };
    },

    /** 订阅 live 帧（WS 推送用）；返回退订函数。 */
    subscribe(sessionId: string, cb: (frame: Frame) => void): () => void {
      const entry = live.get(sessionId);
      if (!entry) return () => {};
      entry.subscribers.add(cb);
      return () => entry.subscribers.delete(cb);
    },

    /** 会话是否在册（live）。 */
    isLive(sessionId: string): boolean {
      return live.has(sessionId);
    },

    /** 有界销毁（daemon stop）：待答请求以空答案释放，agent 逐个回收。 */
    async dispose(): Promise<void> {
      for (const entry of live.values()) {
        for (const pending of entry.pending.values()) pending.resolve({ answers: [] });
        entry.pending.clear();
      }
      await Promise.allSettled([...live.values()].map((entry) => entry.dispose()));
      live.clear();
    },
  };
}

export type TaskSessions = ReturnType<typeof createTaskSessions>;
