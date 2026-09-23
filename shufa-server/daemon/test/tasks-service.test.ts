/**
 * 任务创建→会话创建调用链测试（W4，mock 内核/会话）。
 * 原始需求 2026-09-23：上传视频进资源树 + 建 .shufa 任务目录 + 建会话（cwd/
 * framesFile/提示词注入：视频路径+摘要由你撰写）+ 状态推进；capability 绑定
 * （findTaskByDir/onExported）；rpc tasks 端点接线（未装配 501）。
 * 正交意图：
 *   [1] TaskService.create 的落盘/落库/调用链断言。
 *   [2] onExported 结果收尾（results 行 + result 帧 + done）。
 *   [3] rpc 路由与 TaskService 的接线（含归属拒绝）。
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Frame } from '@zhumo/contracts';
import { createServices, TEST_SECRET, type TestServices } from './helpers.js';
import { clientFor } from './helpers.js';
import { TaskService, resolveModelRouteFromStore, resolveModelRouteInfo } from '../src/tasks/service.js';
import type { TaskSessions } from '../src/kernel/sessions.js';
import { ensureAnonymousUser, hashPassword } from '../src/auth.js';
import { createUser, putSetting } from '../src/db/store.js';
import { BlobStore } from '../src/db/blobs.js';
import { FrameStore } from '../src/kernel/frame-store.js';

function fakeSessions() {
  const created: Array<{ taskId: string; cwd: string; framesFile: string; prompt: string }> = [];
  const emitted: Frame[] = [];
  const service = {
    attach: vi.fn(),
    createTaskSession: vi.fn(async (taskId: string, input: { cwd: string; framesFile: string; prompt: string }) => {
      created.push({ taskId, ...input });
      return { sessionId: `task-${created.length}` };
    }),
    resumeTaskSession: vi.fn(async (_taskId: string, input: { sessionId: string; framesFile: string }) => ({ sessionId: input.sessionId })),
    cancel: vi.fn(),
    answer: vi.fn(() => false),
    emit: vi.fn((_sessionId: string, frame: Omit<Frame, 'at' | 'seq'>) => {
      emitted.push({ ...frame, at: Date.now(), seq: emitted.length + 1 } as Frame);
    }),
    liveStatusOf: vi.fn(() => 'persisted' as const),
    stream: vi.fn((sessionId: string, framesFile: string, afterSeq: number) => ({
      frames: new FrameStore(framesFile).readAfter(afterSeq),
      status: 'persisted' as const,
    })),
    subscribe: vi.fn((_sessionId: string, _cb: (frame: Frame) => void) => () => {}),
    isLive: vi.fn(() => false),
    dispose: vi.fn(async () => {}),
  };
  return { service: service as unknown as TaskSessions, created, emitted, raw: service };
}

describe('TaskService 创建链', () => {
  let env: TestServices;
  let user: ReturnType<typeof createUser>;
  let sessions: ReturnType<typeof fakeSessions>;
  let service: TaskService;

  beforeEach(() => {
    env = createServices();
    ensureAnonymousUser(env.db);
    user = createUser(env.db, { username: 'alice', passwordHash: hashPassword('pw'), role: 'user' });
    sessions = fakeSessions();
    // BUG2 门控前提：settings 表配置完整模型路由（create 的前置条件；个别用例
    // 自建全新 env 验证未配置态）。
    putSetting(env.db, 'llm_provider', 'zhipu');
    putSetting(env.db, 'llm_base_url', 'https://x/api');
    putSetting(env.db, 'llm_api_key', 'k1');
    putSetting(env.db, 'llm_model', 'glm-5.3-flash');
    service = new TaskService({
      config: env.config,
      db: env.db,
      blobs: new BlobStore(env.config.dataRoot, env.db),
      sessions: sessions.service,
      kernelMounted: () => true,
    });
  });

  afterEach(() => {
    env.dispose();
  });

  it('create：视频 blob + 三行资源 + 任务行 + 会话调用（cwd/framesFile/提示词）', async () => {
    const bytes = Buffer.from('fake-video-bytes');
    const item = await service.create(user, {
      prompt: '帮我讲评',
      video: { filename: 'lecture.mp4', data_base64: bytes.toString('base64') },
    });
    expect(item.status).toBe('running');
    expect(item.agent_session_id).toMatch(/^task-/);

    // 会话调用链：cwd=用户根目录（架构调整：agent pwd=users/<username>）、
    // frames.jsonl 路径、提示词含相对视频路径与摘要要求。
    const call = sessions.created[0] as { taskId: string; cwd: string; framesFile: string; prompt: string };
    expect(call.taskId).toBe(item.id);
    expect(call.cwd).toBe(path.join(env.config.dataRoot, 'users', 'alice'));
    expect(existsSync(call.cwd)).toBe(true);
    const folder = path.basename(path.dirname(path.dirname(call.framesFile)));
    expect(call.framesFile).toBe(path.join(call.cwd, folder, '.shufa', 'frames.jsonl'));
    expect(call.prompt).toContain('帮我讲评');
    // 架构调整不变量（相对路径口径）：提示词只含相对 cwd（用户根目录）的路径
    // ——任务目录名 + 视频文件名，绝不含数据根前缀；并带 cwd 口径句。
    expect(call.prompt).toContain(path.join(folder, 'lecture.mp4'));
    expect(call.prompt).toContain(path.join(folder, '.shufa'));
    expect(call.prompt).toContain('所有路径均相对于当前工作目录（你的 cwd，即用户根目录）');
    expect(call.prompt).not.toContain(env.config.dataRoot);
    expect(call.prompt).not.toContain('绝对路径');
    // 视频链入任务根目录（capability 收容要求 video 在 taskRoot 内），绝不再指
    // blobs 实体（首轮真实联调 25 分钟死循环根因）。
    expect(call.prompt).not.toContain('blobs');
    expect(existsSync(path.join(call.cwd, folder, 'lecture.mp4'))).toBe(true);
    expect(call.prompt).toContain('mcp__shufa__summary_write');
    expect(call.prompt).toContain('result_url');

    // 资源行：任务目录（dir）→ .shufa（dir，meta）+ 视频文件（blob）。
    const rows = env.db.prepare('SELECT * FROM resources ORDER BY rowid').all() as Array<{
      name: string;
      is_dir: number;
      meta: string | null;
      content_hash: string | null;
    }>;
    const videoRow = rows.find((r) => r.name === 'lecture.mp4');
    expect(videoRow?.is_dir).toBe(0);
    expect(videoRow?.content_hash).toBeTypeOf('string');
    const shufaRow = rows.find((r) => r.name === '.shufa');
    const meta = JSON.parse(shufaRow?.meta ?? '{}') as Record<string, unknown>;
    expect(meta.task_id).toBe(item.id);
    expect(meta.agent_session_id).toBe(item.agent_session_id);
    expect(existsSync(String(meta.dir))).toBe(true);

    // 任务行 + 状态帧。
    const taskRow = env.db.prepare('SELECT * FROM tasks WHERE id = ?').get(item.id) as { status: string; video_resource_id: string };
    expect(taskRow.status).toBe('running');
    expect(taskRow.video_resource_id).toBeTypeOf('string');
    expect(sessions.emitted.some((f) => f.kind === 'status')).toBe(true);
  });

  it('内核未挂载：create 拒绝（不落任务）', async () => {
    const disabled = new TaskService({
      config: env.config,
      db: env.db,
      blobs: new BlobStore(env.config.dataRoot, env.db),
      sessions: sessions.service,
      kernelMounted: () => false,
    });
    await expect(
      disabled.create(user, { prompt: 'x', video: { filename: 'a.mp4', data_base64: Buffer.from('b').toString('base64') } }),
    ).rejects.toThrow(/内核未挂载/);
    const count = (env.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('capability 绑定：create 后 findTaskByDir 命中（绝对与相对）；逃逸/未知目录拒绝', async () => {
    const item = await service.create(user, {
      prompt: 'x',
      video: { filename: 'v.mp4', data_base64: Buffer.from('bytes').toString('base64') },
    });
    const shufaRow = (env.db.prepare("SELECT * FROM resources WHERE name = '.shufa'").get() as { meta: string });
    const dir = (JSON.parse(shufaRow.meta) as { dir: string }).dir;
    expect(service.findTaskByDir(dir)).toMatchObject({ taskId: item.id });
    // 架构调整相对口径：相对 cwd（alice 用户根目录）的 workdir 命中同一绑定。
    const folder = path.basename(path.dirname(dir));
    expect(service.findTaskByDir(path.join(folder, '.shufa'))).toMatchObject({ taskId: item.id, userRoot: path.join(env.config.dataRoot, 'users', 'alice') });
    // 跨用户目录相对逃逸：'..' 跳出 alice 用户根、指向他人未登记目录 → 不命中。
    expect(service.findTaskByDir(path.join('..', 'bob', 'elsewhere', '.shufa'))).toBeNull();
    expect(service.findTaskByDir('/tmp/nowhere')).toBeNull();
    expect(service.capabilities.names()).toContain('shufa.probe');
    expect(service.capabilities.names()).not.toContain('shufa.summary'); // summary 不提供步骤工具
  });

  it('BUG2 门控：settings/env 均空 → create 拒绝（不落任务）且 bootstrap model_route=null', async () => {
    const bare = createServices();
    try {
      const bob = createUser(bare.db, { username: 'bob', passwordHash: hashPassword('pw'), role: 'user' });
      const bareService = new TaskService({
        config: bare.config,
        db: bare.db,
        blobs: new BlobStore(bare.config.dataRoot, bare.db),
        sessions: sessions.service,
        kernelMounted: () => true,
      });
      await expect(
        bareService.create(bob, {
          prompt: 'x',
          video: { filename: 'v.mp4', data_base64: Buffer.from('b').toString('base64') },
        }),
      ).rejects.toThrow(/管理员尚未配置大模型服务，请先在后台「设置 → 大模型服务」完成配置/);
      expect((bare.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(0);
      const boot = await clientFor(bare.context()).bootstrap();
      expect(boot.model_route).toBeNull();
    } finally {
      bare.dispose();
    }
  });

  it('BUG2 来源：settings 四键齐备 → settings；仅 .env LLM_* 齐备 → env', async () => {
    const bare = createServices();
    try {
      expect(resolveModelRouteInfo(bare.db, bare.config)).toBeNull();
      // 仅 .env 引导值齐备：source='env'（settings 表为空）。
      const envConfig = {
        ...bare.config,
        fileEnv: { LLM_PROVIDER: 'zhipu', LLM_BASE_URL: 'https://env/api', LLM_API_KEY: 'env-key', LLM_MODEL: 'glm-env' },
      };
      expect(resolveModelRouteInfo(bare.db, envConfig)).toEqual({ provider: 'zhipu', model: 'glm-env', source: 'env' });
      // settings 表四键落库后翻转为 settings 来源，bootstrap 同步呈现。
      putSetting(bare.db, 'llm_provider', 'zhipu');
      putSetting(bare.db, 'llm_base_url', 'https://x/api');
      putSetting(bare.db, 'llm_api_key', 'k1');
      putSetting(bare.db, 'llm_model', 'glm-5.3-flash');
      expect(resolveModelRouteInfo(bare.db, bare.config)).toEqual({ provider: 'zhipu', model: 'glm-5.3-flash', source: 'settings' });
      const boot = await clientFor(bare.context()).bootstrap();
      expect(boot.model_route).toEqual({ provider: 'zhipu', model: 'glm-5.3-flash', source: 'settings' });
    } finally {
      bare.dispose();
    }
  });

  it('onExported：bundle → results 行 + public_id + result 帧 + done', async () => {
    const item = await service.create(user, {
      prompt: 'x',
      video: { filename: 'v.mp4', data_base64: Buffer.from('bytes').toString('base64') },
    });
    const bundle = path.join(env.root, 'bundle-out');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, 'data.json'), '{"video":{}}', 'utf8');
    const outcome = service.onExported(item.id, bundle);
    expect(outcome?.public_id).toHaveLength(12);
    expect(outcome?.url).toContain(`/r/${outcome?.public_id}`);
    const taskRow = env.db.prepare('SELECT * FROM tasks WHERE id = ?').get(item.id) as { status: string; result_id: string };
    expect(taskRow.status).toBe('done');
    expect(taskRow.result_id).toBeTypeOf('string');
    const result = env.db.prepare('SELECT * FROM results WHERE public_id = ?').get(outcome?.public_id) as { bundle_path: string };
    expect(result.bundle_path).toBe(bundle);
    expect(sessions.emitted.some((f) => f.kind === 'result')).toBe(true);
    // 无 data.json 的 bundle：收尾返回 null。
    expect(service.onExported(item.id, path.join(env.root, 'nope'))).toBeNull();
  });

  it('get：afterSeq 帧回放走 jsonl；cancel 推 cancelled 状态帧', async () => {
    const item = await service.create(user, {
      prompt: 'x',
      video: { filename: 'v.mp4', data_base64: Buffer.from('bytes').toString('base64') },
    });
    const framesFile = sessions.created[0]?.framesFile ?? '';
    new FrameStore(framesFile).append({ at: 1, seq: 1, kind: 'tool-call', toolName: 'shufa_probe', payload: {} });
    const detail = await service.get(user, item.id, 0);
    expect(detail.frames.map((f) => f.kind)).toContain('tool-call');
    const incremental = await service.get(user, item.id, 1);
    expect(incremental.frames.filter((f) => f.kind === 'tool-call')).toHaveLength(0);

    sessions.raw.isLive.mockReturnValue(true);
    const cancelled = await service.cancel(user, item.id);
    expect(cancelled.status).toBe('cancelled');
    expect(sessions.raw.cancel).toHaveBeenCalledWith(`task-${1}`);
    expect(sessions.emitted.some((f) => f.kind === 'status' && (f.payload as { status: string }).status === 'cancelled')).toBe(true);
  });

  it('rpc 接线：tasks.list 走服务；未装配 tasks 返回 501', async () => {
    const client = clientFor(env.context({ user, tasks: service, secret: TEST_SECRET }));
    await service.create(user, {
      prompt: 'x',
      video: { filename: 'v.mp4', data_base64: Buffer.from('bytes').toString('base64') },
    });
    const listed = await client.tasks.list();
    expect(listed.tasks).toHaveLength(1);

    const bare = clientFor(env.context({ user, secret: TEST_SECRET }));
    await expect(bare.tasks.get({ id: 'nope' })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('resolveModelRouteFromStore：settings 表优先，.env 兜底，缺项为 null', () => {
    // 独立 env：本 describe 的 beforeEach 已给主 env 配好 settings，null 态需全新库。
    const fresh = createServices();
    try {
      expect(resolveModelRouteFromStore(fresh.db, fresh.config)).toBeNull();
      putSetting(fresh.db, 'llm_provider', 'zhipu');
      putSetting(fresh.db, 'llm_base_url', 'https://x/api');
      putSetting(fresh.db, 'llm_api_key', 'k1');
      putSetting(fresh.db, 'llm_model', 'glm-5.3-flash');
      const route = resolveModelRouteFromStore(fresh.db, fresh.config);
      expect(route).toMatchObject({ provider: 'zhipu', model: 'glm-5.3-flash', api: 'anthropic-messages' });
      // W7b：llm_api 协议键可覆盖（openai-completions 网关）。
      putSetting(fresh.db, 'llm_api', 'openai-completions');
      expect(resolveModelRouteFromStore(fresh.db, fresh.config)).toMatchObject({ api: 'openai-completions' });
      expect(readFileSync(fresh.envFile, 'utf8')).toBeTruthy();
    } finally {
      fresh.dispose();
    }
  });
});
