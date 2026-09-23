/**
 * 前台续聊测试（W7b）：tasks.followup 排队（running）与 resume 路径
 * （done/failed → 拉回 running + 状态帧）、resume 失败收敛 failed、
 * running-but-not-live 复活重投、权限（403/404）、无会话/未挂载明确错误、rpc 接线。
 * 原始需求 2026-09-23。
 * 正交意图：
 *   [1] TaskService.followup 状态机（排队 vs resume vs 失败收敛）。
 *   [2] 会话调用链断言（followup/resumeTaskSession/emit）。
 *   [3] 权限与错误语义（FORBIDDEN/NOT_FOUND/CONFLICT/BAD_REQUEST）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Frame } from '@zhumo/contracts';
import { createServices, TEST_SECRET, type TestServices } from './helpers.js';
import { clientFor } from './helpers.js';
import { TaskService } from '../src/tasks/service.js';
import type { TaskSessions } from '../src/kernel/sessions.js';
import { createResource, createTask, updateTask, type TaskRow } from '../src/db/tasks.js';
import { BlobStore } from '../src/db/blobs.js';
import { createUser } from '../src/db/store.js';
import { hashPassword } from '../src/auth.js';

function fakeSessions() {
  const emitted: Frame[] = [];
  const raw = {
    attach: vi.fn(),
    createTaskSession: vi.fn(async (_taskId: string, input: { cwd: string }) => {
      return { sessionId: `task-${Math.random().toString(16).slice(2, 8)}` };
    }),
    resumeTaskSession: vi.fn(async (_taskId: string, input: { sessionId: string }) => ({ sessionId: input.sessionId })),
    followup: vi.fn((_sessionId: string, _text: string) => undefined),
    cancel: vi.fn(),
    emit: vi.fn((_sessionId: string, frame: Omit<Frame, 'at' | 'seq'>) => {
      emitted.push({ ...frame, at: Date.now(), seq: emitted.length + 1 } as Frame);
    }),
    stream: vi.fn(() => ({ frames: [], status: 'persisted' as const })),
    subscribe: vi.fn(() => () => {}),
    isLive: vi.fn(() => false),
    dispose: vi.fn(async () => {}),
  };
  return { service: raw as unknown as TaskSessions, raw, emitted };
}

describe('TaskService.followup', () => {
  let env: TestServices;
  let alice: ReturnType<typeof createUser>;
  let bob: ReturnType<typeof createUser>;
  let root: ReturnType<typeof createUser>;
  let service: TaskService;
  let sessions: ReturnType<typeof fakeSessions>;

  beforeEach(() => {
    env = createServices();
    alice = createUser(env.db, { username: 'alice', passwordHash: hashPassword('pw'), role: 'user' });
    bob = createUser(env.db, { username: 'bob', passwordHash: hashPassword('pw'), role: 'user' });
    root = createUser(env.db, { username: 'root', passwordHash: hashPassword('pw'), role: 'admin' });
    sessions = fakeSessions();
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

  /** 直接落一个任务行（不经 create，避免内核依赖）。 */
  function seedTask(
    ownerId: string,
    overrides: { status?: 'running' | 'done' | 'failed' | 'cancelled'; session?: string | null } = {},
  ): TaskRow {
    const video = createResource(env.db, { ownerId, parentId: null, name: 'v.mp4', isDir: false });
    const task = createTask(env.db, { ownerId, resourceId: null, videoResourceId: video.id, prompt: 'p' });
    const session = overrides.session === undefined ? 'sess-1' : overrides.session;
    const status = overrides.status ?? 'running';
    updateTask(env.db, task.id, {
      agentSessionId: session,
      ...(status === 'running' ? { status } : { status }),
    });
    const row = { ...task, status, agent_session_id: session };
    return row as TaskRow;
  }

  it('running：排队投递（followup 调用带原文），不触发 resume，状态不变', async () => {
    const task = seedTask(alice.id, { status: 'running', session: 'sess-run' });
    const out = await service.followup(alice, { id: task.id, text: '再讲讲第二笔' });
    expect(out.accepted).toBe(true);
    expect(out.resumed).toBe(false);
    expect(sessions.raw.resumeTaskSession).not.toHaveBeenCalled();
    expect(sessions.raw.followup).toHaveBeenCalledTimes(1);
    const [sessionId, message] = sessions.raw.followup.mock.calls[0] as unknown as [
      string,
      { content: Array<{ text: string }> },
    ];
    expect(sessionId).toBe('sess-run');
    expect(JSON.stringify(message)).toContain('再讲讲第二笔');
    expect(out.task.status).toBe('running');
  });

  it('done → resume 后投递，任务拉回 running 并推 running 状态帧', async () => {
    const task = seedTask(alice.id, { status: 'done', session: 'sess-done' });
    const out = await service.followup(alice, { id: task.id, text: '继续' });
    expect(out.accepted).toBe(true);
    expect(out.resumed).toBe(true);
    expect(sessions.raw.resumeTaskSession).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ sessionId: 'sess-done' }),
    );
    expect(sessions.raw.followup).toHaveBeenCalledTimes(1);
    const row = env.db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
    expect(row.status).toBe('running');
    expect(
      sessions.emitted.some((f) => f.kind === 'status' && (f.payload as { status: string }).status === 'running'),
    ).toBe(true);
  });

  it('resume 失败 → 任务收敛 failed + failed 状态帧 + 调用方收到错误（不静默）', async () => {
    const task = seedTask(alice.id, { status: 'done', session: 'sess-dead' });
    sessions.raw.resumeTaskSession.mockRejectedValueOnce(new Error('内核会话日志损坏'));
    await expect(service.followup(alice, { id: task.id, text: '继续' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const row = env.db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
    expect(row.status).toBe('failed');
    expect(
      sessions.emitted.some((f) => f.kind === 'status' && (f.payload as { status: string }).status === 'failed'),
    ).toBe(true);
  });

  it('running 但会话不在册：followup 抛错 → 复活一次后重投成功', async () => {
    const task = seedTask(alice.id, { status: 'running', session: 'sess-stale' });
    sessions.raw.followup.mockImplementation((sessionId: string) => {
      if (sessionId === 'sess-stale' && sessions.raw.followup.mock.calls.length === 1) {
        throw new Error('agent session not found: sess-stale');
      }
      return undefined;
    });
    const out = await service.followup(alice, { id: task.id, text: '继续' });
    expect(out.resumed).toBe(true);
    expect(sessions.raw.resumeTaskSession).toHaveBeenCalledTimes(1);
    expect(sessions.raw.followup).toHaveBeenCalledTimes(2);
  });

  it('权限与边界：他人任务 403、未知 404、无会话 409、未挂载 BAD_REQUEST、cancelled 409、admin 豁免', async () => {
    const task = seedTask(alice.id, { status: 'running' });
    await expect(service.followup(bob, { id: task.id, text: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.followup(alice, { id: 'missing', text: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const noSession = seedTask(alice.id, { status: 'done', session: null });
    await expect(service.followup(alice, { id: noSession.id, text: 'x' })).rejects.toMatchObject({ code: 'CONFLICT' });

    const cancelled = seedTask(alice.id, { status: 'cancelled' });
    await expect(service.followup(alice, { id: cancelled.id, text: 'x' })).rejects.toMatchObject({ code: 'CONFLICT' });

    const unmounted = new TaskService({
      config: env.config,
      db: env.db,
      blobs: new BlobStore(env.config.dataRoot, env.db),
      sessions: sessions.service,
      kernelMounted: () => false,
    });
    await expect(unmounted.followup(alice, { id: task.id, text: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const out = await service.followup(root, { id: task.id, text: 'admin 续聊' });
    expect(out.accepted).toBe(true);
  });
});

describe('followup rpc 接线', () => {
  it('client.tasks.followup：未装配 501、装配后可用、未认证 401', async () => {
    const env = createServices();
    try {
      const alice = createUser(env.db, { username: 'alice', passwordHash: hashPassword('pw'), role: 'user' });
      const sessions = fakeSessions();
      const service = new TaskService({
        config: env.config,
        db: env.db,
        blobs: new BlobStore(env.config.dataRoot, env.db),
        sessions: sessions.service,
        kernelMounted: () => true,
      });
      await expect(
        clientFor(env.context({ user: alice, secret: TEST_SECRET })).tasks.followup({ id: 't1', text: 'x' }),
      ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });

      const client = clientFor(env.context({ user: alice, secret: TEST_SECRET, tasks: service }));
      const video = createResource(env.db, { ownerId: alice.id, parentId: null, name: 'v.mp4', isDir: false });
      const task = createTask(env.db, { ownerId: alice.id, resourceId: null, videoResourceId: video.id, prompt: 'p' });
      updateTask(env.db, task.id, { agentSessionId: 'sess-rpc', status: 'running' });
      const out = await client.tasks.followup({ id: task.id, text: 'rpc 续聊' });
      expect(out.accepted).toBe(true);
      await expect(
        clientFor(env.context({ secret: TEST_SECRET, tasks: service })).tasks.followup({ id: task.id, text: 'x' }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    } finally {
      env.dispose();
    }
  });
});
