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
  grids: z.array(z.string()),
  crop: z.string(),
});
export type AnalysisAnnotation = z.infer<typeof AnalysisAnnotationSchema>;

export const AnalysisTranscriptSchema = z.object({
  model: z.string(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
});
export type AnalysisTranscript = z.infer<typeof AnalysisTranscriptSchema>;

/** 总结（agent 亲自撰写注入，source='injected'）。 */
export const AnalysisSummarySchema = z.object({
  topic: z.string(),
  paragraphs: z.array(z.string()),
  key_points: z.array(z.string()),
  source: z.string().optional(),
});
export type AnalysisSummary = z.infer<typeof AnalysisSummarySchema>;

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
  raw_stats: AnalysisRawStatsSchema,
});
export type AnalysisData = z.infer<typeof AnalysisDataSchema>;
