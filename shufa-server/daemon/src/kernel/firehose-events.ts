/**
 * firehose `session/event` 载荷的入口 schema 家族（照 skill-creator-v2
 * agent-sessions.ts 2026-09-12 收窄后的家族，按朱墨投影面裁剪）。
 * 原始需求 2026-09-23（W4）：event.data 是内核来的外部输入，必须 unknown →
 * safeParse；畸形整事件丢弃 + 有界诊断，不产帧不消耗 seq。
 * 正交意图：
 *   [1] 九类被消费事件的 Zod schema（chunk/todo/message/turn/title/status/tool）
 *       + usage 样本家族（assistant/message 顶层 usage / assistant/attempt 流
 *       末 usage chunk → dsh-llm TokenUsage 收窄）。
 *   [2] {message: M} 信封解包与丢弃诊断（≤200ch）。
 */
import { z } from 'zod';

/** assistant/chunk：text-delta / reasoning-delta / tool-call-delta 三种分片。 */
export const AgentChunkEventSchema = z.object({
  chunk: z.object({
    type: z.string().min(1),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    argumentsDelta: z.string().optional(),
  }),
});

export const TodoWriteEventSchema = z.object({
  todos: z.array(z.object({ content: z.string(), status: z.string().min(1) })),
});

/** 消息 source 消费面：kind（user/model/tool 判别）与 callId（tool/result 回填名）。 */
const MessageSourceSchema = z.object({ kind: z.string().optional(), callId: z.string().optional() }).passthrough();

/** 消息 content 块最小消费面：type 判别串 + text/name（存在即必须 string）。 */
const MessageBlockSchema = z.object({ type: z.string().min(1), text: z.string().optional(), name: z.string().optional() }).passthrough();

/** 消息外壳：source + content 块数组（content 必在且非空——空消息按畸形丢弃）。 */
const MessageShapeSchema = z.object({ source: MessageSourceSchema.optional(), content: z.array(MessageBlockSchema).min(1) }).passthrough();

/**
 * {message: M} 信封解包：M 为对象则取 M，否则 data 即 message（user/message
 * 实测是后者，assistant/message 实测是前者；等价于 `data.message ?? data`）。
 */
function messageEnvelopeOf(raw: unknown): unknown {
  if (typeof raw === 'object' && raw !== null && 'message' in raw) {
    const wrapped = (raw as { message: unknown }).message;
    if (typeof wrapped === 'object' && wrapped !== null) return wrapped;
  }
  return raw;
}

export const MessageEventSchema = z.preprocess(messageEnvelopeOf, MessageShapeSchema);

/** turn/end：reason.kind 投影为帧 text。 */
export const TurnEndEventSchema = z.object({ reason: z.object({ kind: z.string().optional() }).passthrough().optional() }).passthrough();

/**
 * usage 计数面（@deepseek-ai/dsh-llm TokenUsage，2026-09-22 实证于
 * node_modules 内 lib/types/types.d.ts）：inputTokens/outputTokens 必填，
 * totalTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens 可选
 * （缺失 = 该次尝试未上报该桶）。SDK 侧 isCount = 非负安全整数。
 */
const TokenCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** dsh-llm TokenUsage 消费面（turn-end 用量药丸数据源）。 */
export const TokenUsageSchema = z
  .object({
    inputTokens: TokenCountSchema,
    outputTokens: TokenCountSchema,
    totalTokens: TokenCountSchema.optional(),
    cacheReadTokens: TokenCountSchema.optional(),
    cacheWriteTokens: TokenCountSchema.optional(),
    reasoningTokens: TokenCountSchema.optional(),
  })
  .passthrough();
export type TokenUsageSample = z.infer<typeof TokenUsageSchema>;

/**
 * assistant/message 外层 usage：usage 挂在事件 data 顶层（{message: M} 信封
 * 之外——dsh-session SessionEventMap：'assistant/message': {…, usage?:
 * TokenUsage}，"the model output and its accounting travel together"）。
 */
export const MessageUsageEventSchema = z.object({ usage: TokenUsageSchema.optional() }).passthrough();

/** assistant/attempt 流记录最小消费面（只读判别串与 chunk 载荷）。 */
const StreamRecordSchema = z.object({ type: z.string().min(1), chunk: z.unknown().optional() }).passthrough();

/** assistant/attempt：usage 只嵌在流的末位 usage chunk 里（无独立字段）。 */
export const AttemptUsageEventSchema = z.object({ stream: z.array(StreamRecordSchema) }).passthrough();

/**
 * 从 attempt 流倒序提取末位 usage chunk（语义对齐 dsh-token-meter
 * turn-usage.js 的 streamUsage = lastAssistantStreamChunk(stream, 'usage')）。
 * chunk 形状为 {type: 'chunk', chunk: {type: 'usage', usage: TokenUsage}}。
 */
export function usageOfAttemptStream(
  stream: ReadonlyArray<{ type: string; chunk?: unknown }>,
): TokenUsageSample | undefined {
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type !== 'chunk') continue;
    const chunk = record.chunk as { type?: unknown; usage?: unknown } | undefined;
    if (typeof chunk === 'object' && chunk !== null && chunk.type === 'usage') {
      const checked = TokenUsageSchema.safeParse(chunk.usage);
      return checked.success ? checked.data : undefined;
    }
  }
  return undefined;
}

/** session/title：title 存在即必须 string；缺失/空白由分支静默丢弃。 */
export const SessionTitleEventSchema = z.object({ title: z.string().optional() }).passthrough();

/** tool/call：callId/name 非空 + arguments 原始 JSON 字符串（契约必填）。 */
export const ToolCallEventSchema = z.object({ callId: z.string().min(1), name: z.string().min(1), arguments: z.string() }).passthrough();

/**
 * tool/result：source.kind='tool' + callId 必填；content 为单个 tool-result 块，
 * 块内至少一个非空 text part（纯 image/未知块 = 无可消费内容，按畸形丢弃）。
 */
export const ToolResultEventSchema = z.object({
  message: z
    .object({
      source: z.object({ kind: z.literal('tool'), callId: z.string().min(1) }).passthrough(),
      content: z.tuple([
        z
          .object({
            type: z.literal('tool-result'),
            toolCallId: z.string().min(1),
            content: z
              .array(z.object({ type: z.string().min(1), text: z.string().optional() }).passthrough())
              .min(1)
              .refine(
                (parts) =>
                  parts.some(
                    (part) => part.type === 'text' && typeof part.text === 'string' && part.text.length > 0,
                  ),
                { message: 'tool-result block needs a consumable text part' },
              ),
          })
          .passthrough(),
      ]),
    })
    .passthrough(),
});

/** turn/start / agent/status：消费面不读字段，非对象载荷按畸形丢弃。 */
export const ObjectPayloadEventSchema = z.record(z.string(), z.unknown());

/** 诊断日志整行硬上限（绝不打印全 payload）。 */
const DROPPED_EVENT_LOG_MAX = 200;

export function logDroppedEvent(sessionId: string, type: string, data: unknown): void {
  let detail: string;
  try {
    const serialized = JSON.stringify(data);
    detail = serialized === undefined ? String(data) : serialized;
  } catch {
    detail = String(data);
  }
  let line = `[shufa-sessions] dropped malformed ${type} event for ${sessionId}: ${detail}`;
  if (line.length > DROPPED_EVENT_LOG_MAX) line = `${line.slice(0, DROPPED_EVENT_LOG_MAX - 1)}…`;
  console.warn(line);
}
