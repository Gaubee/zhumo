/**
 * 任务与资源契约（PRODUCT_DESIGN.md §4 tasks/res/results 路由）。
 * 原始需求 2026-09-23。W2' 定义形状；W4 实装 tasks 端点并扩展创建/详情契约：
 *   - 创建支持「视频直传」（base64；W5 前无资源管理器上传面）与既有资源二选一；
 *   - 详情携带帧回放（after_seq 游标），与 WS 推送同一线格式。
 * 正交意图：
 *   [1] 任务视图与四端点形状（列表 / 创建 / 详情 / 取消）。
 *   [2] 视频直传载荷（文件名 + base64）。
 *   [3] 资源树节点视图（W5 的 CRUD 以此为行投影）。
 *   [4] 结果页公开元数据（HTTP /api/results/{public_id} 的 JSON 形状）。
 */
import { z } from 'zod';
import { IdSchema, IsoDateTimeSchema, TaskStatusSchema } from '../common.js';
import { AnalysisDataSchema } from '../analysis.js';
import { FrameSchema } from '../frame.js';

export const TaskItemSchema = z.object({
  id: IdSchema,
  owner_id: IdSchema,
  status: TaskStatusSchema,
  prompt: z.string().nullable(),
  video_resource_id: IdSchema.nullable(),
  /** 素材视频文件名（资源名投影；null = 未附视频）——任务详情播放位与列表展示用。 */
  video_name: z.string().nullable(),
  /** 会话标题（内核 session/title 帧落行；null = 未生成，前端回退 prompt 截断）。 */
  title: z.string().nullable(),
  agent_session_id: z.string().nullable(),
  result_id: IdSchema.nullable(),
  /** 失败原因明文（走查 R3：failed 必须可见；null = 无失败/未失败）。 */
  error: z.string().nullable(),
  /** 任务级模型覆盖（走查 R6：聊天中可切换；null = 跟随后台默认模型）。 */
  model_provider: z.string().nullable(),
  model_model: z.string().nullable(),
  /** 任务级思考强度档（2026-09-25 前台对齐：模型 efforts 档位之一；null = 不覆盖）。 */
  model_effort: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type TaskItem = z.infer<typeof TaskItemSchema>;

/** 任务关联结果引用（一次对话可多次导出——任务详情右侧标签页的数据源）。 */
export const TaskResultRefSchema = z.object({
  public_id: z.string(),
  title: z.string().nullable(),
  created_at: IsoDateTimeSchema,
});
export type TaskResultRef = z.infer<typeof TaskResultRefSchema>;

export const TaskListOutputSchema = z.object({ tasks: z.array(TaskItemSchema) });

/** 聊天中切换任务模型（走查 R6）：更新任务级覆盖并热切会话（idle 态；
 * running 由服务端拒绝，前端同款禁用）。effort：缺省 = 保持不变；显式 null =
 * 清除档位（跟随模型默认）；值 = 覆盖档位。 */
export const TaskSetModelInputSchema = z.object({
  task_id: IdSchema,
  provider: IdSchema,
  model: z.string().min(1),
  effort: z.string().min(1).nullable().optional(),
});
export type TaskSetModelInput = z.infer<typeof TaskSetModelInputSchema>;

/** 视频直传载荷：字节 base64（oRPC-over-WS JSON 传输；上限由 daemon 校验）。 */
export const TaskVideoUploadSchema = z.object({
  filename: z.string().min(1),
  data_base64: z.string().min(1),
});
export type TaskVideoUpload = z.infer<typeof TaskVideoUploadSchema>;

/** 创建任务：直传视频与既有资源 id 至少其一（W4 起直传为常态入口）。 */
export const TaskCreateInputSchema = z
  .object({
    prompt: z.string().min(1),
    video: TaskVideoUploadSchema.optional(),
    video_resource_id: IdSchema.optional(),
    /** 任务级模型覆盖（五轮活动模型）：null/缺省 = 跟随后台默认模型。
     * effort（2026-09-25）：思考强度档（该模型 efforts 之一）；缺省 = 不覆盖。 */
    model: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        effort: z.string().min(1).optional(),
      })
      .optional(),
  })
  .refine((input) => input.video !== undefined || input.video_resource_id !== undefined, {
    message: 'video 与 video_resource_id 必须提供其一',
  });
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

export const TaskCreateOutputSchema = TaskItemSchema;

export const TaskGetInputSchema = z.object({
  id: IdSchema,
  /** 帧回放游标：返回 seq > after_seq 的帧（缺省 0 = 全量）。 */
  after_seq: z.number().int().min(0).default(0),
});
export type TaskGetInput = z.infer<typeof TaskGetInputSchema>;
export const TaskGetOutputSchema = z.object({
  task: TaskItemSchema,
  frames: z.array(FrameSchema),
  /** 任务全部导出结果（新→旧；右侧标签页与详情列表共用）。 */
  results: z.array(TaskResultRefSchema),
});
export type TaskGetOutput = z.infer<typeof TaskGetOutputSchema>;

export const TaskCancelInputSchema = z.object({ id: IdSchema });
export type TaskCancelInput = z.infer<typeof TaskCancelInputSchema>;
export const TaskCancelOutputSchema = TaskItemSchema;

/** 打断当前轮（W10，对齐 DSH 内核 cancel{kind:'user'}+keepInbox）：中止生成、
 * 任务回 done（idle 等待输入、可续聊）；排队消息保留并由内核自动续跑。
 * 与终态取消（tasks.cancel → cancelled 不可续聊）语义不同。 */
export const TaskStopInputSchema = z.object({ id: IdSchema });
export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;
export const TaskStopOutputSchema = TaskItemSchema;

/** 前台续聊（W7b）：running 任务排队投递；done/failed 任务先 resume 再投递。 */
export const TaskFollowupInputSchema = z.object({
  id: IdSchema,
  text: z.string().min(1).max(20000),
  /** 投递通道（W10）：followup=排队下一轮（缺省，运行中自动进 next-turn
   * inbox）；steer=引导——运行中的 driver 在下一 step 边界消费（影响当前
   * 轮），idle 时等价开新轮。 */
  mode: z.enum(['followup', 'steer']).optional(),
});
export type TaskFollowupInput = z.infer<typeof TaskFollowupInputSchema>;

// ------------------------------------------------- 队列面板（W10b，内核 inbox）

/** 队列投递模式：queue=排队下一轮（内核 next-turn inbox，逐条生效）；
 * steer=引导当前轮（下一 step 边界消费）；inject=注入（同 step 边界但不作
 * 为对话轮唤醒）。mode 由 daemon 在投递时记录（next-step 两模式同桶不可辨）。 */
export const TaskQueueModeSchema = z.enum(['queue', 'steer', 'inject']);
export type TaskQueueMode = z.infer<typeof TaskQueueModeSchema>;

/** 队列条目（内核 inbox 消息的产品视图：id 稳定，跨编辑 replace 保持可寻址）。 */
export const TaskQueueItemSchema = z.object({
  message_id: z.string(),
  mode: TaskQueueModeSchema,
  text: z.string(),
});
export type TaskQueueItem = z.infer<typeof TaskQueueItemSchema>;

export const TaskQueueListInputSchema = z.object({ id: IdSchema });
export type TaskQueueListInput = z.infer<typeof TaskQueueListInputSchema>;
/** items 按生效序（queue 在前逐条开轮；steer/inject 为 step 边界挂起项）；
 * editing=冻结中的条目 id（编辑会话期间该条及其后暂离队列）。 */
export const TaskQueueListOutputSchema = z.object({
  items: z.array(TaskQueueItemSchema),
  editing: z.string().nullable(),
});
export type TaskQueueListOutput = z.infer<typeof TaskQueueListOutputSchema>;

/** 进入编辑（Owner 设计 2026-09-27）：该条及其后的排队消息冻结（暂离内核
 * inbox，当前轮结束后不再自动开轮）；文本回填输入框，确认/取消前队列尾部悬置。 */
export const TaskQueueEditInputSchema = z.object({ id: IdSchema, message_id: z.string() });
export type TaskQueueEditInput = z.infer<typeof TaskQueueEditInputSchema>;
export const TaskQueueEditOutputSchema = z.object({ text: z.string() });
export type TaskQueueEditOutput = z.infer<typeof TaskQueueEditOutputSchema>;

/** 确认编辑：冻结首条按新文本重建，整段按原序放回（idle 时逐条唤醒开轮）。 */
export const TaskQueueEditConfirmInputSchema = z.object({ id: IdSchema, text: z.string().min(1).max(20000) });
export type TaskQueueEditConfirmInput = z.infer<typeof TaskQueueEditConfirmInputSchema>;
export const TaskQueueEditConfirmOutputSchema = z.object({ accepted: z.literal(true) });
export type TaskQueueEditConfirmOutput = z.infer<typeof TaskQueueEditConfirmOutputSchema>;

/** 取消编辑：冻结段按原序原样放回。 */
export const TaskQueueEditCancelInputSchema = z.object({ id: IdSchema });
export type TaskQueueEditCancelInput = z.infer<typeof TaskQueueEditCancelInputSchema>;
export const TaskQueueEditCancelOutputSchema = z.object({ accepted: z.literal(true) });
export type TaskQueueEditCancelOutput = z.infer<typeof TaskQueueEditCancelOutputSchema>;

/** 删除一条（含冻结段外/next-step 挂起项）；不在队列时幂等成功。 */
export const TaskQueueRemoveInputSchema = z.object({ id: IdSchema, message_id: z.string() });
export type TaskQueueRemoveInput = z.infer<typeof TaskQueueRemoveInputSchema>;
export const TaskQueueRemoveOutputSchema = z.object({ accepted: z.literal(true) });
export type TaskQueueRemoveOutput = z.infer<typeof TaskQueueRemoveOutputSchema>;

/** 修改投递模式（Owner 设计：可改成注入或引导；排队项转 step 边界语义）。 */
export const TaskQueueSetModeInputSchema = z.object({
  id: IdSchema,
  message_id: z.string(),
  mode: TaskQueueModeSchema,
});
export type TaskQueueSetModeInput = z.infer<typeof TaskQueueSetModeInputSchema>;
export const TaskQueueSetModeOutputSchema = z.object({ accepted: z.literal(true) });
export type TaskQueueSetModeOutput = z.infer<typeof TaskQueueSetModeOutputSchema>;

/** 拖动排序（Owner 设计 2026-09-27 二轮）：提交 next-turn 全量新序。前端在
 * 拖动期间锁定面板（暂停刷新）防抖动，drop 时一次性提交；锁定（status 位）
 * 的条目由前端保持原位。队列已变化（队头被消费）时拒绝，前端刷新重试。 */
export const TaskQueueReorderInputSchema = z.object({
  id: IdSchema,
  ordered_ids: z.array(z.string()).min(1),
});
export type TaskQueueReorderInput = z.infer<typeof TaskQueueReorderInputSchema>;
export const TaskQueueReorderOutputSchema = z.object({ accepted: z.literal(true) });
export type TaskQueueReorderOutput = z.infer<typeof TaskQueueReorderOutputSchema>;

/** accepted 恒真；resumed=本次是否触发了会话复活；task=投递后的任务视图。 */
export const TaskFollowupOutputSchema = z.object({
  accepted: z.literal(true),
  resumed: z.boolean(),
  task: TaskItemSchema,
});
export type TaskFollowupOutput = z.infer<typeof TaskFollowupOutputSchema>;

/** 资源树节点（.shufa 文件夹 meta 含 agent_session_id/result_id）。 */
export const ResourceItemSchema = z.object({
  id: IdSchema,
  parent_id: IdSchema.nullable(),
  name: z.string(),
  is_dir: z.boolean(),
  size: z.number(),
  meta: z.record(z.string(), z.unknown()).nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
});
export type ResourceItem = z.infer<typeof ResourceItemSchema>;

/** 结果页公开元数据：/r/{public_id} 页面经 HTTP 拉取的 JSON。 */
export const ResultMetaOutputSchema = z.object({
  public_id: z.string(),
  title: z.string().nullable(),
  created_at: IsoDateTimeSchema,
  data: AnalysisDataSchema,
});
export type ResultMetaOutput = z.infer<typeof ResultMetaOutputSchema>;
