/**
 * AnalysisData：结果页数据类型。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §0「结果页」）；对齐真实样例
 * `/Users/kzf/Documents/书法/.shufa-work/20260922-124852/bundle/data.json`（v0.1.0）。
 * 正交意图：
 *   [1] 结果 bundle data.json 的完整结构校验（§4 /api/results/{public_id} 的 data 载荷）。
 * 资产路径（thumb/crop/preview/video 等均为 bundle 相对路径），由
 * /api/results/{public_id}/assets/* 静态解析。
 */
import { z } from 'zod';

/** 源视频元信息（duration 是带单位字符串，与 player.duration 的数值不同源）。 */
export const AnalysisVideoSchema = z.object({
  name: z.string(),
  duration: z.string(),
  resolution: z.string(),
});
export type AnalysisVideo = z.infer<typeof AnalysisVideoSchema>;

/** 播放器条目：kf=关键帧旁注卡，seg=转写分段。 */
export const AnalysisPlayerEntrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('kf'),
    t: z.number(),
    thumb: z.string(),
    title: z.string(),
    desc: z.string(),
    grids: z.array(z.string()),
  }),
  z.object({
    type: z.literal('seg'),
    t0: z.number(),
    t1: z.number(),
    text: z.string(),
    grids: z.array(z.string()),
  }),
]);
export type AnalysisPlayerEntry = z.infer<typeof AnalysisPlayerEntrySchema>;

export const AnalysisPlayerSchema = z.object({
  video: z.string(),
  duration: z.number(),
  entries: z.array(AnalysisPlayerEntrySchema),
  previews: z.array(z.object({ t: z.number(), src: z.string() })),
});
export type AnalysisPlayer = z.infer<typeof AnalysisPlayerSchema>;

/** 田字格字符格：row/col 为网格坐标，visibility 0~1。 */
export const AnalysisCharSchema = z.object({
  idx: z.number().int(),
  row: z.number().int(),
  col: z.number().int(),
  visibility: z.number(),
  note: z.string(),
  label: z.string(),
  crop: z.string(),
});
export type AnalysisChar = z.infer<typeof AnalysisCharSchema>;

/** 老师旁注（画面批注）卡。 */
export const AnalysisAnnotationSchema = z.object({
  idx: z.number().int(),
  first_ts: z.number(),
  desc: z.string(),
  /** 字级关联（转录时间窗命中的生字 label；一字多格时不区分格子）。 */
  grids: z.array(z.string()),
  /** 格级关联（旁注墨迹空间最近格 index；2026-09-28 起导出面携带，
   * 结果页优先按它精确挂格；旧 bundle 无此字段回落 grids 聚合）。 */
  grid_idx: z.number().int().optional(),
  crop: z.string(),
});
export type AnalysisAnnotation = z.infer<typeof AnalysisAnnotationSchema>;

export const AnalysisTranscriptSchema = z.object({
  // 生产端历史缺陷会写 null（audio.py 曾把未传的 model_repo 形参原样落盘）；
  // 契约边界归一为 ""，页面层 `model || "未使用"` 兜底——模型名缺失不应
  // 拖垮整个结果页（2026-09-24 两次导出 500 实证）。
  model: z.string().nullable().transform((v) => v ?? ''),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
  // 同音校正留痕（transcript_lint，2026-09-25）：导出面按生字锚点自动校正
  // 转录误转字并逐条记录——「这段话被改过什么」必须可溯源。
  lint_fixes: z
    .array(
      z.object({
        seg: z.number().int(),
        wrong: z.string(),
        right: z.string(),
        context: z.string().optional(),
      }),
    )
    .optional(),
});
export type AnalysisTranscript = z.infer<typeof AnalysisTranscriptSchema>;

/**
 * 总结。source 词表（2026-09-25 对齐生产端）：agent=模型亲写（summary_write 注入，
 * daemon 默认）/ injected=summary 文件注入（CLI 旧路径）/ heuristic=CLI 规则摘要。
 */
/** 终态写契约（Codex 五审 P1-1：写入/导出门禁用）：fact 必带非空 source
 * （转录段下标）；纯 string 不再接受。 */
export const TerminalClaimSchema = z.union([
  z.object({
    kind: z.literal('fact'),
    text: z.string().min(1),
    source: z.array(z.number().int().min(0)).min(1),
    /** 展示性标签（「结构定性」「书写要领」类前缀）：纯呈现字段，不参与
     * 证据核验（九审 P1：文本内「标签：」前缀不再豁免锚点）。 */
    label: z.string().max(12).optional(),
  }),
  z.object({ kind: z.enum(['inference', 'suggestion']), text: z.string().min(1) }),
]);
export type TerminalClaim = z.infer<typeof TerminalClaimSchema>;

/** 读契约：终态形态 + 旧 bundle 形态（纯 string＝heuristic/旧产物、无
 * source 的 fact＝中间态）——仅渲染兼容，不作为写入依据。source 若出现
 * 则必须形如非空下标数组（非法 source 不静默剥除——六审：剥除会把坏
 * 数据伪装成旧形态放行）。 */
export const AnalysisClaimSchema = z.union([
  TerminalClaimSchema,
  z.string(),
  z.object({ kind: z.literal('fact'), text: z.string(), label: z.string().max(12).optional() }).strict(),
]);
export type AnalysisClaim = z.infer<typeof AnalysisClaimSchema>;

export const AnalysisSummarySchema = z.object({
  topic: z.string(),
  paragraphs: z.array(AnalysisClaimSchema),
  key_points: z.array(AnalysisClaimSchema),
  source: z.enum(['heuristic', 'injected', 'agent']).optional(),
});
export type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;

/** 终态 summary 写契约（export 门禁用）：paragraphs/key_points 全部为
 * TerminalClaim，且非空——agent 亲写的导出产物必须达到此形态
 * （heuristic/injected 旧路径不适用此门）。 */
export const TerminalAnalysisSummarySchema = z.object({
  topic: z.string().min(1),
  paragraphs: z.array(TerminalClaimSchema).min(1),
  key_points: z.array(TerminalClaimSchema).min(1),
  source: z.enum(['agent']).optional(),
});
export type TerminalAnalysisSummary = z.infer<typeof TerminalAnalysisSummarySchema>;

export const AnalysisRawStatsSchema = z.object({
  steps: z.number().int(),
  grids: z.number().int(),
  annotations: z.number().int(),
  frames: z.number().int(),
});
export type AnalysisRawStats = z.infer<typeof AnalysisRawStatsSchema>;

export const AnalysisDataSchema = z.object({
  version: z.string(),
  generated_at: z.string(),
  video: AnalysisVideoSchema,
  orientation_note: z.string().optional(),
  enhance_note: z.string().optional(),
  player: AnalysisPlayerSchema,
  chars: z.array(AnalysisCharSchema),
  focus_grid_idx: z.number().int().nullable().optional(),
  focus_char: z.string().nullable().optional(),
  annotations: z.array(AnalysisAnnotationSchema),
  transcript: AnalysisTranscriptSchema,
  summary: AnalysisSummarySchema,
  ink_curve: z.array(z.number()),
  frame_ts: z.array(z.number()),
  limitations: z.array(z.string()).default([]),
  // 数据质量告警（export.py 自检，2026-09-25 契约补漏）：语义缺失/同音校正
  // 等曾在此被 zod 剥离——结果页从未展示，Owner 实证「未识别卡无解释」。
  warnings: z.array(z.string()).default([]),
  raw_stats: AnalysisRawStatsSchema,
});
export type AnalysisData = z.infer<typeof AnalysisDataSchema>;
