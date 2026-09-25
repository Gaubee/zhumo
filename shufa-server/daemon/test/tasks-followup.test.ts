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
import { createResource, createTask, getTaskById, updateTask, type TaskRow } from '../src/db/tasks.js';
import { BlobStore } from '../src/db/blobs.js';
import { KbStore } from '../src/kb/store.js';
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
    steer: vi.fn(),
    cancel: vi.fn(),
    emit: vi.fn((_sessionId: string, frame: Omit<Frame, 'at' | 'seq'>) => {
      emitted.push({ ...frame, at: Date.now(), seq: emitted.length + 1 } as Frame);
    }),
    stream: vi.fn(() => ({ frames: [], status: 'persisted' as const })),
    subscribe: vi.fn(() => () => {}),
    isLive: vi.fn(() => false),
    isDemoActive: vi.fn(() => false),
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
      kb: new KbStore(env.config.dataRoot + "/knowledge-test"),
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
      kb: new KbStore(env.config.dataRoot + "/knowledge-test"),
    });
    await expect(unmounted.followup(alice, { id: task.id, text: 'x' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const out = await service.followup(root, { id: task.id, text: 'admin 续聊' });
    expect(out.accepted).toBe(true);
  });
  it('W10 stop：打断当前轮=live cancel(keepInbox)+任务回 done（可续聊）；cancelled 任务拒绝', async () => {
    const mk = (ownerId: string, session: string, status: string): string => {
      const video = createResource(env.db, { ownerId, parentId: null, name: 'v.mp4', isDir: false });
      const task = createTask(env.db, { ownerId, resourceId: null, videoResourceId: video.id, prompt: 'p' });
      updateTask(env.db, task.id, { agentSessionId: session, status: status as never });
      return task.id;
    };
    const taskId = mk(alice.id, 'sess-stop', 'running');
    sessions.raw.isLive = vi.fn(() => true);
    const stopped = await service.stop(alice, taskId);
    // 内核 cancel 以 user cause 调用（keepInbox 语义在 sessions 层）。
    expect(sessions.raw.cancel).toHaveBeenCalledWith('sess-stop');
    expect(stopped.status).toBe('done');
    // 打断后可续聊（followup 正常投递——区别于终态 cancel）。
    const followed = await service.followup(alice, { id: taskId, text: '打断后继续' });
    expect(followed.accepted).toBe(true);
    // 终态取消的任务不可 stop。
    // stop 是同步方法：作为 expect 参数求值时同步抛出，用 toThrow 断言。
    expect(() => service.stop(bob, mk(bob.id, 'sess-c', 'cancelled'))).toThrow('已取消的任务不可操作');
  });

  it('W10f markSessionIdle：running → done + status 帧；done 幂等不覆盖', async () => {
    const video = createResource(env.db, { ownerId: alice.id, parentId: null, name: 'v.mp4', isDir: false });
    const task = createTask(env.db, { ownerId: alice.id, resourceId: null, videoResourceId: video.id, prompt: 'p' });
    updateTask(env.db, task.id, { agentSessionId: 'sess-idle', status: 'running' });
    sessions.raw.emit.mockClear?.();
    service.markSessionIdle('sess-idle');
    const row = getTaskById(env.db, task.id)!;
    expect(row?.status).toBe('done');
    // 幂等：已 done 不再 emit。
    const emitCount = sessions.raw.emit.mock.calls.length;
    service.markSessionIdle('sess-idle');
    expect(sessions.raw.emit.mock.calls.length).toBe(emitCount);
  });

  it('W10 followup mode=steer：改走 sessions.steer 通道', async () => {
    const video = createResource(env.db, { ownerId: alice.id, parentId: null, name: 'v.mp4', isDir: false });
    const task = createTask(env.db, { ownerId: alice.id, resourceId: null, videoResourceId: video.id, prompt: 'p' });
    updateTask(env.db, task.id, { agentSessionId: 'sess-steer', status: 'running' });
    const out = await service.followup(alice, { id: task.id, text: '引导一下', mode: 'steer' });
    expect(out.accepted).toBe(true);
    expect(sessions.raw.steer).toHaveBeenCalledWith('sess-steer', '引导一下');
    expect(sessions.raw.followup).not.toHaveBeenCalledWith('sess-steer', '引导一下');
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
        kb: new KbStore(env.config.dataRoot + "/knowledge-test"),
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
