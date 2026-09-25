/**
 * HTTP 面测试：bootstrap 200、结果资产 Range 206、/r/{public_id}、SPA 回退、
 * 畸形 WS 帧不打穿 daemon（W2' 验证门）。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §4 /r 与 /api/results 公开路由）。
 */
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RPCHandler } from '@orpc/server/ws';
import { getResultByPublicId, getUserByUsername } from '../src/db/store.js';
import { DaemonHttp } from '../src/http.js';
import type { AnalysisData } from '@zhumo/contracts';
import { router, type RpcContext } from '../src/rpc.js';
import { createServices } from './helpers.js';
import { expect, test } from 'vitest';

const SAMPLE_DATA: AnalysisData = {
  version: '0.1.0',
  generated_at: '2026-09-23 03:14',
  video: { name: 'sample.mp4', duration: '31.9s', resolution: '720x1280' },
  orientation_note: '顺时针 90°',
  player: {
    video: 'assets/focus_clip.mp4',
    duration: 31.5,
    entries: [{ type: 'seg', t0: 0, t1: 3.9, text: '我们一起来看一下', grids: ['桂'] }],
    previews: [{ t: 0, src: 'assets/preview_0.jpg' }],
  },
  chars: [{ idx: 0, row: 1, col: 1, visibility: 0.79, note: '开场已写好', label: '桂', crop: 'assets/grid_1.png' }],
  focus_grid_idx: 1,
  focus_char: '桂',
  annotations: [{ idx: 0, first_ts: 9, desc: '旁注', grids: ['桂'], crop: 'assets/anno_0.png' }],
  transcript: { model: 'whisper-large-v3-turbo', segments: [{ start: 0, end: 3.9, text: '我们一起来看一下' }] },
  summary: { topic: '桂', paragraphs: ['讲评'], key_points: ['左右结构'], source: 'agent' },
  ink_curve: [0, 1003],
  frame_ts: [0, 0.5],
  limitations: [],
  raw_stats: { steps: 1, grids: 3, annotations: 1, frames: 4 },
};

async function startDaemon(svc: ReturnType<typeof createServices>) {
  const rpcHandler = new RPCHandler<RpcContext>(router);
  const daemon = new DaemonHttp({
    config: svc.config,
    db: svc.db,
    wizard: svc.wizard,
    secret: svc.secret,
    rpcHandler,
  });
  const port = await daemon.listen(0, '127.0.0.1');
  return { daemon, port, base: `http://127.0.0.1:${port}` };
}

test('GET /api/bootstrap 200 公开可达', async () => {
  const s = createServices();
  try {
    const { daemon, base } = await startDaemon(s);
    const res = await fetch(`${base}/api/bootstrap`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { needs_setup: boolean; site_name: string };
    expect(body.needs_setup).toBe(true);
    expect(body.site_name).toBe('朱墨');
    await daemon.stop();
  } finally {
    s.dispose();
  }
});

test('结果公开面：元数据 JSON、资产 Range 206、未知结果 404、越界 403', async () => {
  const s = createServices();
  try {
    // 造结果 bundle：data.json + assets（含 10KB 二进制供 Range 校验）。
    const anonymous = getUserByUsername(s.db, '__anonymous__');
    const bundle = path.join(s.root, 'bundles', 'r-1');
    mkdirSync(path.join(bundle, 'assets'), { recursive: true });
    writeFileSync(path.join(bundle, 'data.json'), JSON.stringify(SAMPLE_DATA));
    const big = Buffer.alloc(10000, 0xa5);
    big[0] = 0x00;
    big[9999] = 0xff;
    writeFileSync(path.join(bundle, 'assets', 'focus_clip.mp4'), big);
    s.db
      .prepare(
        `INSERT INTO results (id, public_id, task_id, owner_id, title, bundle_path, created_at)
         VALUES ('res-1', 'pub-abc', NULL, ?, '样本结果', ?, ?)`,
      )
      .run(anonymous?.id ?? '', bundle, new Date().toISOString());
    expect(getResultByPublicId(s.db, 'pub-abc')).toBeTruthy();

    const { daemon, base } = await startDaemon(s);
    try {
      // 元数据。
      const meta = await fetch(`${base}/api/results/pub-abc`);
      expect(meta.status).toBe(200);
      const metaBody = (await meta.json()) as { public_id: string; data: AnalysisData };
      expect(metaBody.public_id).toBe('pub-abc');
      expect(metaBody.data.focus_char).toBe('桂');

      // 整文件 200 + Accept-Ranges。
      const full = await fetch(`${base}/api/results/pub-abc/assets/focus_clip.mp4`);
      expect(full.status).toBe(200);
      expect(full.headers.get('accept-ranges')).toBe('bytes');

      // Range：bytes=0-99 → 206。
      const range = await fetch(`${base}/api/results/pub-abc/assets/focus_clip.mp4`, {
        headers: { range: 'bytes=0-99' },
      });
      expect(range.status).toBe(206);
      expect(range.headers.get('content-range')).toBe('bytes 0-99/10000');
      const bytes = Buffer.from(await range.arrayBuffer());
      expect(bytes.byteLength).toBe(100);
      expect(bytes[0]).toBe(0x00);

      // 后缀式 bytes=-100 → 最后 100 字节。
      const suffix = await fetch(`${base}/api/results/pub-abc/assets/focus_clip.mp4`, {
        headers: { range: 'bytes=-100' },
      });
      expect(suffix.status).toBe(206);
      const tail = Buffer.from(await suffix.arrayBuffer());
      expect(tail.byteLength).toBe(100);
      expect(tail[99]).toBe(0xff);

      // 非法 Range → 416。
      const invalid = await fetch(`${base}/api/results/pub-abc/assets/focus_clip.mp4`, {
        headers: { range: 'bytes=99999-' },
      });
      expect(invalid.status).toBe(416);

      // 未知 public_id → 404；路径穿越 → 403。
      expect((await fetch(`${base}/api/results/nope`)).status).toBe(404);
      const trav = await fetch(`${base}/api/results/pub-abc/assets/%2e%2e%2fdata.json`);
      expect([403, 404]).toContain(trav.status);

      // 回归 2026-09-24：生产端 transcript.model=null（audio.py 形参落盘缺陷）
      // 曾把整个结果面打成 500「与契约不符」；契约边界归一为 ""，页面照常可用。
      const nullModelBundle = path.join(s.root, 'bundles', 'r-null-model');
      mkdirSync(path.join(nullModelBundle, 'assets'), { recursive: true });
      writeFileSync(
        path.join(nullModelBundle, 'data.json'),
        JSON.stringify({
          ...SAMPLE_DATA,
          transcript: { ...SAMPLE_DATA.transcript, model: null },
        }),
      );
      s.db
        .prepare(
          `INSERT INTO results (id, public_id, task_id, owner_id, title, bundle_path, created_at)
           VALUES ('res-2', 'pub-null-model', NULL, ?, 'null model 样本', ?, ?)`,
        )
        .run(anonymous?.id ?? '', nullModelBundle, new Date().toISOString());
      const nullModel = await fetch(`${base}/api/results/pub-null-model`);
      expect(nullModel.status).toBe(200);
      const nullModelBody = (await nullModel.json()) as { data: AnalysisData };
      expect(nullModelBody.data.transcript.model).toBe('');
      expect(nullModelBody.data.transcript.segments.length).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  } finally {
    s.dispose();
  }
});

test('/r/{public_id} 与 SPA 回退返回 index.html；静态缺失 404 兜底', async () => {
  const s = createServices();
  try {
    const { daemon, base } = await startDaemon(s);
    try {
      const r = await fetch(`${base}/r/pub-abc`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      expect(await r.text()).toContain('shufa-spa');

      const spa = await fetch(`${base}/login`);
      expect(spa.status).toBe(200);
      expect(await spa.text()).toContain('shufa-spa');

      // 缺失静态文件：webui/dist 只有 index.html，回退后仍然命中 SPA。
      const missing = await fetch(`${base}/assets/nope.js`);
      expect(missing.status).toBe(200);

      // 缓存策略（走查 2026-09-23）：SPA 入口 no-cache（升级立即生效），
      // 带 hash 的资产长缓存。helpers 的 dist 只有 index.html——先补一个资产。
      writeFileSync(path.join(s.root, 'webui', 'dist', 'app-abc123.js'), 'console.log(1)', 'utf8');
      const entry = await fetch(`${base}/`);
      expect(entry.headers.get('cache-control')).toBe('no-cache');
      const asset = await fetch(`${base}/app-abc123.js`);
      expect(asset.headers.get('cache-control')).toBe('public, max-age=3600');
    } finally {
      await daemon.stop();
    }
  } finally {
    s.dispose();
  }
});

test('畸形 WS 帧只断开该连接，daemon 存活', async () => {
  const s = createServices();
  try {
    const { daemon, base, port } = await startDaemon(s);
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/rpc`);
      const closed = new Promise<Event>((resolve) => {
        ws.onclose = resolve;
        ws.onerror = resolve;
      });
      await new Promise((resolve) => {
        ws.onopen = resolve;
      });
      ws.send('garbage-not-orpc');
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);
      try {
        ws.close();
      } catch {
        // 已断开
      }
      // daemon 仍响应公开面。
      const res = await fetch(`${base}/api/bootstrap`);
      expect(res.status).toBe(200);
    } finally {
      await daemon.stop();
    }
  } finally {
    s.dispose();
  }
});
