/**
 * WebSocket 事件帧模型（PRODUCT_DESIGN.md §7，照搬 skill-creator-v2 Frame）。
 * 原始需求 2026-09-23：统一帧 + afterSeq 游标重放；任务状态机事件与步骤级
 * 进度由同名帧承载。
 * 正交意图：
 *   [1] Frame 帧结构（环形缓冲 / jsonl 落盘 / WS 推送三处共用的线格式）。
 *   [2] 已知帧 kind 值域（§7 列举 + status/step；W4 接 dsh 内核投影面扩展：
 *       turn-start/assistant-reasoning(-delta)/tool-args-delta/session-title/
 *       approval-request/approval-resolved/result）。
 * 契约扩展 2026-09-23（W4）：result 帧承载 export 产物链接（payload 含
 * public_id/url/task_id）；status 帧复用 TaskStatusPayload。
 */

import { z } from 'zod';
import { TaskStatusSchema } from './common.js';

/**
 * 帧 kind 值域。§7 以「…」结尾表示开放集合：新增 kind 属契约扩展，
 * 消费端必须对未知 kind 容忍（这里校验的是已知投影面）。
 */
export const FrameKindSchema = z.enum([
  'user-text',
  'assistant-delta',
  'assistant-text',
  'assistant-reasoning',
  'assistant-reasoning-delta',
  'tool-call',
  'tool-args-delta',
  'tool-result',
  'todo-snapshot',
  'status',
  'step',
  'turn-start',
  'turn-end',
  'session-title',
  'approval-request',
  'approval-resolved',
  'result',
]);
export type FrameKind = z.infer<typeof FrameKindSchema>;

/** 任务状态机事件载荷（kind='status' 时挂 payload）。 */
export const TaskStatusPayloadSchema = z.object({
  task_id: z.string(),
  status: TaskStatusSchema,
});
export type TaskStatusPayload = z.infer<typeof TaskStatusPayloadSchema>;

/** export 产物帧载荷（kind='result'；url 语义 = SITE_BASE_URL + /r/{public_id}）。 */
export const ResultFramePayloadSchema = z.object({
  task_id: z.string(),
  public_id: z.string(),
  url: z.string(),
});
export type ResultFramePayload = z.infer<typeof ResultFramePayloadSchema>;

/**
 * 统一事件帧。seq 为单会话/单任务内的单调递增序号（afterSeq 游标重放的依据）；
 * at 为 epoch 毫秒。
 */
export const FrameSchema = z.object({
  at: z.number(),
  seq: z.number(),
  kind: FrameKindSchema,
  text: z.string().optional(),
  toolName: z.string().optional(),
  payload: z.unknown().optional(),
});
export type Frame = z.infer<typeof FrameSchema>;

/** afterSeq 增量重放请求（WS 订阅参数）。 */
export const FrameReplayInputSchema = z.object({
  task_id: z.string(),
  after_seq: z.number().int().min(0).default(0),
});
export type FrameReplayInput = z.infer<typeof FrameReplayInputSchema>;
