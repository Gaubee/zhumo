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

/** 前台续聊（W7b）：running 任务排队投递；done/failed 任务先 resume 再投递。 */
export const TaskFollowupInputSchema = z.object({
  id: IdSchema,
  text: z.string().min(1).max(20000),
});
export type TaskFollowupInput = z.infer<typeof TaskFollowupInputSchema>;

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
