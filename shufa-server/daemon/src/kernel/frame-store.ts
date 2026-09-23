/**
 * 任务帧持久层（PRODUCT_DESIGN.md §7：jsonl 落盘 + afterSeq 游标重放）。
 * 原始需求 2026-09-23（W4）：帧 write-through 到 <task>/.shufa/frames.jsonl；
 * 损坏行按集合读取法则丢弃（照 skill-creator-v2 session-transcripts）。
 * 正交意图：
 *   [1] append：单帧逐行追加（best-effort，失败只记日志不打断 live 会话）。
 *   [2] readAfter：seq 升序回放 + afterSeq 游标过滤（FrameSchema safeParse 守门）。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FrameSchema, type Frame } from '@zhumo/contracts';

export class FrameStore {
  constructor(private readonly framesFile: string) {}

  append(frame: Frame): void {
    try {
      mkdirSync(path.dirname(this.framesFile), { recursive: true });
      appendFileSync(this.framesFile, `${JSON.stringify(frame)}\n`, { mode: 0o600 });
    } catch (error) {
      console.error(`[frame-store] append failed (${this.framesFile}):`, errorMessage(error));
    }
  }

  /** 全量读取并按游标过滤（seq 升序；损坏行丢弃）。 */
  readAfter(afterSeq: number): Frame[] {
    let raw: string;
    try {
      raw = readFileSync(this.framesFile, 'utf8');
    } catch {
      return [];
    }
    const frames: Frame[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = FrameSchema.safeParse(JSON.parse(line) as unknown);
        if (parsed.success && parsed.data.seq > afterSeq) frames.push(parsed.data);
      } catch {
        // 损坏行丢弃。
      }
    }
    return frames;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
