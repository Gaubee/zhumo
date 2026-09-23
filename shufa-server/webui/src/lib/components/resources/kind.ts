/**
 * 资源种类与展示辅助（W5 资源管理器）。
 * 正交意图：
 *   [1] kindOf：按目录/徽标/扩展名判定资源种类（图标与双击行为共用）。
 *   [2] 展示格式化（大小、修改时间）。
 */
import type { ResourceItem } from "$lib/types";

export type ResourceKind = "dir" | "shufa" | "video" | "image" | "audio" | "other";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".bmp"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"]);

export function kindOf(item: ResourceItem): ResourceKind {
  if (item.is_dir) return item.meta ? "shufa" : "dir";
  const dot = item.name.lastIndexOf(".");
  const ext = dot > 0 ? item.name.slice(dot).toLowerCase() : "";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "other";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
