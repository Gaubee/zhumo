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
  /** W10b 队列面板：next-step 桶内 steer/inject 同桶不可辨——投递时按
   * messageId 记模式（缺省 queue；条目被内核消费后自动失时效，map 只增不减
   * 无碍——id 全局唯一）。 */
  queueModes: Map<string, 'steer' | 'inject'>;
  /** 编辑冻结段（Owner 设计 2026-09-27）：编辑某条排队消息时，该条及其后
   * 全部暂离内核 inbox（当前轮结束后不再自动开轮），暂存于此；确认/取消
   * 后按原序放回（放回走 followup 逐条投递——冻结段必为 next-turn 队尾
   * 连续段，append 语义无损，idle 时首条即唤醒）。 */
  frozenQueue: unknown[];
  frozenEditingId: string | null;
}

export function createTaskSessions(deps: TaskSessionDeps) {
  const retention = deps.retention ?? DEFAULT_RETENTION;
  const live = new Map<string, LiveTaskSession>();
  let firehoseBound = false;

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
      queueModes: new Map(),
      frozenQueue: [],
      frozenEditingId: null,
    };
    registerPanelAnswerer(entry);
    live.set(handle.agent.session.id, entry);
    return entry;
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

    /** / 与 $ 面板目录（DSH 官方一致性：命令/技能注册表出自内核，非产品硬编码）。 */
    listCommands,
    listUserSkills,


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
    entry.agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }) as never,
    );
  },

  /**
   * 引导当前轮（W10，DSH 内核 steer）：运行中的 driver 在下一 step 边界消费，
   * idle 时等价开新轮。与 followup 不同：不做 / 与 $ 分流——面板语义
   * （命令执行/技能注入）属于整轮对话，引导是中途改口的裸文本。
   * 不在册时抛错（调用方复活后重试，与 followup 同约定）。
   * 投递消息记 queueModes（W10b 队列面板按 id 辨 steer/inject）。
   */
  steer(sessionId: string, text: string): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    });
    entry.queueModes.set((message as { id?: string }).id ?? '', 'steer');
    entry.agent.steer(message as never);
  },

  // ------------------------------------------------ 队列面板（W10b，内核 inbox）

  /** 队列视图：next-turn（排队，逐条生效序）在前 + next-step（steer/inject
   * 挂起项）在后；冻结段暂离 inbox 不在视图（editing 字段告知悬置）。 */
  queueView(
    sessionId: string,
  ): { items: Array<{ messageId: string; mode: 'queue' | 'steer' | 'inject'; text: string }>; editing: string | null } {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    const items = [
      ...entry.agent.inbox.nextTurn.map((m) => ({
        messageId: inboxMessageId(m),
        mode: 'queue' as const,
        text: inboxMessageText(m),
      })),
      ...entry.agent.inbox.nextStep.map((m) => {
        const id = inboxMessageId(m);
        return {
          messageId: id,
          mode: entry.queueModes.get(id) ?? 'steer',
          text: inboxMessageText(m),
        };
      }),
    ];
    return { items, editing: entry.frozenEditingId };
  },

  /** 冻结（进入编辑，Owner 设计）：该条及其后的排队消息暂离 inbox——当前轮
   * 结束后不再自动开轮。返回编辑文本。仅 queue 模式条目（steer/inject 是
   * step 边界挂起项，无逐条生效序，不参与冻结）。 */
  queueFreeze(sessionId: string, messageId: string): string {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    if (entry.frozenEditingId !== null) throw new Error('已有编辑中的队列条目（先确认或取消）');
    const turn = entry.agent.inbox.nextTurn;
    const idx = turn.findIndex((m) => inboxMessageId(m) === messageId);
    if (idx < 0) throw new Error(`队列中没有该排队条目：${messageId}`);
    entry.frozenQueue = entry.agent.inbox.splice('next-turn', idx, turn.length - idx, []);
    entry.frozenEditingId = messageId;
    return inboxMessageText(entry.frozenQueue[0]);
  },

  /** 放回冻结段（确认/取消共用）：按原序逐条 followup 投递——冻结段必为原
   * next-turn 队尾连续段，append 语义无损还原位置；idle 时首条唤醒开轮、
   * 其余排队。确认时首条文本换新（firstText=null 为取消，原样放回）。 */
  queueUnfreeze(sessionId: string, firstText: string | null): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    const frozen = entry.frozenQueue;
    entry.frozenQueue = [];
    entry.frozenEditingId = null;
    frozen.forEach((message, i) => {
      const text = i === 0 && firstText !== null ? firstText : inboxMessageText(message);
      entry.agent.followup(
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }) as never,
      );
    });
  },

  /** 删除一条（排队/挂起皆可；不在队列幂等成功）。 */
  queueRemove(sessionId: string, messageId: string): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    entry.queueModes.delete(messageId);
    entry.agent.inbox.remove(messageId);
  },

  /** 修改投递模式（Owner 设计：可改成注入或引导）：取出→按新模式重投。
   * 三个高层方法各自处理桶归属与唤醒；新消息 id 记 queueModes 辨识。 */
  queueSetMode(sessionId: string, messageId: string, mode: 'queue' | 'steer' | 'inject'): void {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    const message = [...entry.agent.inbox.nextTurn, ...entry.agent.inbox.nextStep].find(
      (m) => inboxMessageId(m) === messageId,
    );
    if (message === undefined) throw new Error(`队列中没有该条目：${messageId}`);
    entry.queueModes.delete(messageId);
    entry.agent.inbox.remove(messageId);
    const rebuilt = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: inboxMessageText(message) }],
    });
    const rebuiltId = (rebuilt as { id?: string }).id ?? '';
    if (mode === 'queue') entry.agent.followup(rebuilt as never);
    else {
      entry.queueModes.set(rebuiltId, mode);
      if (mode === 'steer') entry.agent.steer(rebuilt as never);
      else entry.agent.inject(rebuilt as never);
    }
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
