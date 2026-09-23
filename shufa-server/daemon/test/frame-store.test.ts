/**
 * 帧持久层测试（W4）：jsonl 落盘 + afterSeq 游标回放。
 * 原始需求 2026-09-23：损坏行丢弃、缺文件返回空、游标过滤语义（seq > afterSeq）。
 * 正交意图：
 *   [1] append/readAfter 的持久回放闭环。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FrameStore } from '../src/kernel/frame-store.js';
import type { Frame } from '@zhumo/contracts';

describe('frame-store jsonl 回放', () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'shufa-store-'));
    file = path.join(root, 'frames.jsonl');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('append 后按 afterSeq 过滤回放（seq 升序）', () => {
    const store = new FrameStore(file);
    const frames: Frame[] = [
      { at: 1, seq: 1, kind: 'user-text', text: '一' },
      { at: 2, seq: 2, kind: 'assistant-text', text: '二' },
      { at: 3, seq: 3, kind: 'turn-end', text: 'end_turn' },
    ];
    for (const frame of frames) store.append(frame);
    expect(store.readAfter(0).map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(store.readAfter(1).map((f) => f.seq)).toEqual([2, 3]);
    expect(store.readAfter(3)).toEqual([]);
  });

  it('损坏行丢弃、目录缺失自动创建、缺文件返回空', () => {
    const nested = path.join(root, 'deep', 'frames.jsonl');
    const store = new FrameStore(nested);
    store.append({ at: 1, seq: 1, kind: 'status', payload: {} });
    const raw = readFileSync(nested, 'utf8');
    writeFileSync(nested, `${raw}{broken json\n`, 'utf8');
    expect(store.readAfter(0)).toHaveLength(1);
    expect(new FrameStore(path.join(root, 'missing.jsonl')).readAfter(0)).toEqual([]);
  });
});
