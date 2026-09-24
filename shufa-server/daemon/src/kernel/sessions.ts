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

export interface TaskSessionDeps {
  kernel: () => ShufaKernelHandle | null;
  /** 模型选择（null = 未配置，内核用缺省路由）。 */
  /** 模型选择（五轮）：按任务——任务覆盖（model_* 列）优先，缺省回落默认模型。 */
  modelSelection: (taskId: string) => Promise<{ provider: string; model: string } | null>;
  retention?: number;
  /** agent turn 以 error 终止时的失败回调（W7 联调：任务失败路径不悬挂）。 */
  onSessionFailure?: (sessionId: string, reason: string) => void;
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
  cancel(cause: unknown, options?: unknown): void;
}

interface AgentsServiceLike {
  create(options: {
    sessionId: string;
    meta?: { cwd?: string; agentPreset?: string };
    agentOptions?: { provider?: string; model?: string };
    setup?: (agentCtx: Context) => void;
  }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>;
  resume(options: {
    resumeSessionId: string;
    agentOptions?: { provider?: string; model?: string };
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
}

export function createTaskSessions(deps: TaskSessionDeps) {
  const retention = deps.retention ?? DEFAULT_RETENTION;
  const live = new Map<string, LiveTaskSession>();
  let firehoseBound = false;

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
      // turn/end reason.kind='error'：agent 运行失败（如 LLM 不可达）→ 失败回调。
      // 走查 R3：reason.error.message/code 一并提取（此前只传字面 "error"，
      // 用户「任务失败看不到任何异常」——404/网络错误等明文直达任务记录）。
      if (event.type === 'turn/end') {
        const checked = TurnEndEventSchema.safeParse(event.data);
        if (checked.success && checked.data.reason?.kind === 'error') {
          const error = (checked.data.reason as { error?: { message?: string; code?: string } })
            .error;
          const detail =
            error?.message !== undefined
              ? error.code !== undefined
                ? `${error.message}（${error.code}）`
                : error.message
              : checked.data.reason.kind;
          deps.onSessionFailure?.(session.id, detail);
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
    };
    registerPanelAnswerer(entry);
    live.set(handle.agent.session.id, entry);
    return entry;
  }

  return {
    /** 内核挂载后首个会话操作前调用（幂等）。 */
    attach(kernel: ShufaKernelHandle): void {
      bindFirehose(kernel);
    },

    /**
     * 创建任务会话：cwd=用户根目录（架构调整 2026-09-23：shell 工作目录/相对
     * 路径解析基准——agent 里 pwd=users/<username>/；.shufa 任务目录只作为
     * 进程面 cwd 由 capability 层钉住）+ 首 prompt 启动。
     */
    async createTaskSession(taskId: string, input: TaskSessionStartInput): Promise<{ sessionId: string }> {
      const kernel = requireKernel();
      bindFirehose(kernel);
      const agents = agentsService(kernel.ctx);
      const sessionId = `task-${randomUUID()}`;
      const model = await deps.modelSelection(taskId);
      const handle = await agents.create({
        sessionId,
        meta: { cwd: input.cwd, agentPreset: 'shufa' },
        ...(model ? { agentOptions: { provider: model.provider, model: model.model } } : {}),
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
      const kernel = requireKernel();
      bindFirehose(kernel);
      const agents = agentsService(kernel.ctx);
      const model = await deps.modelSelection(taskId);
      const handle = await agents.resume({
        resumeSessionId: input.sessionId,
        ...(model ? { agentOptions: { provider: model.provider, model: model.model } } : {}),
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
    entry.agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }) as never,
    );
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
