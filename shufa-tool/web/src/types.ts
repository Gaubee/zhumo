/**
 * 意图：分析包 data.json 的强类型定义 + 轻量运行时校验（原始需求 2026-09-22）。
 * 校验器逐字段构造类型化对象，不使用 any/断言；缺字段抛中文错误供页面展示排查建议。
 * 字段对照真实分析包（.shufa-work 下各 bundle 的 data.json）。
 */

/** 页头视频元信息 */
export interface VideoMeta {
  name: string;
  duration: string;
  resolution: string;
}

/** 播放器时间轴条目：转录分段 */
export interface PlayerSegEntry {
  type: "seg";
  t0: number;
  t1: number;
  text: string;
  grids: string[];
}

/** 播放器时间轴条目：关键帧（老师添加旁注的时刻） */
export interface PlayerKfEntry {
  type: "kf";
  t: number;
  thumb: string;
  title: string;
  desc: string;
  grids: string[];
}

export type PlayerEntry = PlayerSegEntry | PlayerKfEntry;

/** 进度条悬停预览帧（约每 1s 一张） */
export interface PreviewFrame {
  t: number;
  src: string;
}

/** player 字段：回放剪辑与时间轴 */
export interface PlayerData {
  video: string;
  duration: number;
  entries: PlayerEntry[];
  /** 进度条 hover 预览帧；旧分析包可缺省（缺省时 Popover 仅显示时间） */
  previews?: PreviewFrame[];
}

/** 检出的田字格（生字） */
export interface CharItem {
  idx: number;
  row: number;
  col: number;
  visibility: number;
  note: string;
  label: string;
  crop: string;
}

/** 旁注簇 */
export interface Annotation {
  idx: number;
  first_ts: number;
  desc: string;
  grids: string[];
  crop: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  model: string;
  segments: TranscriptSegment[];
}

export interface Summary {
  topic: string;
  paragraphs: string[];
  key_points: string[];
  source: string;
}

/** 分析包数据根对象 */
export interface AnalysisData {
  version: string;
  generated_at: string;
  video: VideoMeta;
  orientation_note: string;
  enhance_note: string;
  player: PlayerData;
  chars: CharItem[];
  focus_grid_idx: number;
  focus_char: string;
  annotations: Annotation[];
  transcript: Transcript;
  summary: Summary;
  ink_curve: number[];
  frame_ts: number[];
  limitations: string[];
  raw_stats: Record<string, number>;
}

/** 数据校验失败（中文 message 直接面向用户展示） */
export class DataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataValidationError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asObject(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) {
    throw new DataValidationError(`分析数据字段 "${path}" 缺失或不是对象`);
  }
  return v;
}

function reqString(o: Record<string, unknown>, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== "string") {
    throw new DataValidationError(`分析数据缺少字段 "${path}"（应为字符串）`);
  }
  return v;
}

function reqNumber(o: Record<string, unknown>, key: string, path: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new DataValidationError(`分析数据缺少字段 "${path}"（应为有限数字）`);
  }
  return v;
}

function reqArray(o: Record<string, unknown>, key: string, path: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) {
    throw new DataValidationError(`分析数据缺少字段 "${path}"（应为数组）`);
  }
  return v;
}

function reqNumberArray(o: Record<string, unknown>, key: string, path: string): number[] {
  return reqArray(o, key, path).map((v, i) => {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new DataValidationError(`分析数据字段 "${path}[${i}]" 不是数字`);
    }
    return v;
  });
}

/** 允许缺省的字符串数组（grids/limitations），缺省按空数组处理 */
function optStringArray(o: Record<string, unknown>, key: string, path: string): string[] {
  const v = o[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new DataValidationError(`分析数据字段 "${path}" 应为字符串数组`);
  }
  return v.map((s, i) => {
    if (typeof s !== "string") {
      throw new DataValidationError(`分析数据字段 "${path}[${i}]" 不是字符串`);
    }
    return s;
  });
}

function validateVideo(v: unknown): VideoMeta {
  const o = asObject(v, "video");
  return {
    name: reqString(o, "name", "video.name"),
    duration: reqString(o, "duration", "video.duration"),
    resolution: reqString(o, "resolution", "video.resolution"),
  };
}

function validateEntry(v: unknown, path: string): PlayerEntry {
  const o = asObject(v, path);
  const type = reqString(o, "type", `${path}.type`);
  const grids = optStringArray(o, "grids", `${path}.grids`);
  if (type === "seg") {
    return {
      type: "seg",
      t0: reqNumber(o, "t0", `${path}.t0`),
      t1: reqNumber(o, "t1", `${path}.t1`),
      text: reqString(o, "text", `${path}.text`),
      grids,
    };
  }
  if (type === "kf") {
    return {
      type: "kf",
      t: reqNumber(o, "t", `${path}.t`),
      thumb: reqString(o, "thumb", `${path}.thumb`),
      title: reqString(o, "title", `${path}.title`),
      desc: reqString(o, "desc", `${path}.desc`),
      grids,
    };
  }
  throw new DataValidationError(`分析数据字段 "${path}.type" 未知：${type}（应为 seg 或 kf）`);
}

function validatePreviews(v: unknown, path: string): PreviewFrame[] {
  if (!Array.isArray(v)) {
    throw new DataValidationError(`分析数据字段 "${path}" 应为数组`);
  }
  return v.map((f, i) => {
    const p = `${path}[${i}]`;
    const fo = asObject(f, p);
    return {
      t: reqNumber(fo, "t", `${p}.t`),
      src: reqString(fo, "src", `${p}.src`),
    };
  });
}

function validatePlayer(v: unknown): PlayerData {
  const o = asObject(v, "player");
  return {
    video: reqString(o, "video", "player.video"),
    duration: reqNumber(o, "duration", "player.duration"),
    entries: reqArray(o, "entries", "player.entries").map((e, i) =>
      validateEntry(e, `player.entries[${i}]`),
    ),
    previews: o.previews === undefined ? undefined : validatePreviews(o.previews, "player.previews"),
  };
}

function validateChar(v: unknown, i: number): CharItem {
  const p = `chars[${i}]`;
  const o = asObject(v, p);
  return {
    idx: reqNumber(o, "idx", `${p}.idx`),
    row: reqNumber(o, "row", `${p}.row`),
    col: reqNumber(o, "col", `${p}.col`),
    visibility: reqNumber(o, "visibility", `${p}.visibility`),
    note: reqString(o, "note", `${p}.note`),
    label: reqString(o, "label", `${p}.label`),
    crop: reqString(o, "crop", `${p}.crop`),
  };
}

function validateAnnotation(v: unknown, i: number): Annotation {
  const p = `annotations[${i}]`;
  const o = asObject(v, p);
  return {
    idx: reqNumber(o, "idx", `${p}.idx`),
    first_ts: reqNumber(o, "first_ts", `${p}.first_ts`),
    desc: reqString(o, "desc", `${p}.desc`),
    grids: optStringArray(o, "grids", `${p}.grids`),
    crop: reqString(o, "crop", `${p}.crop`),
  };
}

function validateTranscript(v: unknown): Transcript {
  const o = asObject(v, "transcript");
  const segments = reqArray(o, "segments", "transcript.segments").map((s, i) => {
    const p = `transcript.segments[${i}]`;
    const so = asObject(s, p);
    return {
      start: reqNumber(so, "start", `${p}.start`),
      end: reqNumber(so, "end", `${p}.end`),
      text: reqString(so, "text", `${p}.text`),
    };
  });
  return { model: reqString(o, "model", "transcript.model"), segments };
}

function validateSummary(v: unknown): Summary {
  const o = asObject(v, "summary");
  return {
    topic: reqString(o, "topic", "summary.topic"),
    paragraphs: reqArray(o, "paragraphs", "summary.paragraphs").map((p, i) => {
      if (typeof p !== "string") {
        throw new DataValidationError(`分析数据字段 "summary.paragraphs[${i}]" 不是字符串`);
      }
      return p;
    }),
    key_points: reqArray(o, "key_points", "summary.key_points").map((p, i) => {
      if (typeof p !== "string") {
        throw new DataValidationError(`分析数据字段 "summary.key_points[${i}]" 不是字符串`);
      }
      return p;
    }),
    source: reqString(o, "source", "summary.source"),
  };
}

function validateRawStats(v: unknown): Record<string, number> {
  const o = asObject(v, "raw_stats");
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(o)) {
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new DataValidationError(`分析数据字段 "raw_stats.${k}" 不是数字`);
    }
    out[k] = val;
  }
  return out;
}

/** 校验并构造 AnalysisData；失败抛 DataValidationError（中文 message） */
export function validateAnalysisData(input: unknown): AnalysisData {
  const o = asObject(input, "root");
  return {
    version: reqString(o, "version", "version"),
    generated_at: reqString(o, "generated_at", "generated_at"),
    video: validateVideo(o.video),
    orientation_note: reqString(o, "orientation_note", "orientation_note"),
    enhance_note: reqString(o, "enhance_note", "enhance_note"),
    player: validatePlayer(o.player),
    chars: reqArray(o, "chars", "chars").map((c, i) => validateChar(c, i)),
    focus_grid_idx: reqNumber(o, "focus_grid_idx", "focus_grid_idx"),
    focus_char: reqString(o, "focus_char", "focus_char"),
    annotations: reqArray(o, "annotations", "annotations").map((a, i) => validateAnnotation(a, i)),
    transcript: validateTranscript(o.transcript),
    summary: validateSummary(o.summary),
    ink_curve: reqNumberArray(o, "ink_curve", "ink_curve"),
    frame_ts: reqNumberArray(o, "frame_ts", "frame_ts"),
    limitations: optStringArray(o, "limitations", "limitations"),
    raw_stats: validateRawStats(o.raw_stats),
  };
}
