/**
 * 帧投影测试（W4）：mock firehose 事件 → Frame 断言。
 * 原始需求 2026-09-23：Zod safeParse 守门（畸形丢弃）、120ms delta 合并、
 * tool/result 按 callId 回填工具名、审批 request/answer、环形 retention、
 * 订阅推送与 afterSeq 读取、cancel 语义。
 * 正交意图：
 *   [1] 投影正确性（各事件类型 → Frame kind/字段/seq 单调）。
 *   [2] 会话生命周期（create 首发提示词 / cancel / answer / stream / subscribe）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskSessions } from '../src/kernel/sessions.js';
import { FrameStore } from '../src/kernel/frame-store.js';
import { asKernelHandle, FakeAgent, FakeKernel } from './helpers-task.js';

describe('kernel sessions 帧投影', () => {
  let kernel: FakeKernel;
  let framesFile: string;
  let root: string;
  let sessions: ReturnType<typeof createTaskSessions>;

  beforeEach(() => {
    kernel = new FakeKernel();
    root = mkdtempSync(path.join(tmpdir(), 'shufa-frames-'));
    framesFile = path.join(root, '.shufa', 'frames.jsonl');
    sessions = createTaskSessions({
      kernel: () => asKernelHandle(kernel),
      modelSelection: async () => ({ provider: 'zhipu', model: 'glm-5.3-flash' }),
      retention: 50,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function createSession(): Promise<string> {
    const created = await sessions.createTaskSession('task-1', {
      cwd: root,
      framesFile,
      prompt: '分析这段视频',
    });
    return created.sessionId;
  }

  it('create 走 agents.create（preset/cwd/model）并 followup 首条提示词', async () => {
    const sessionId = await createSession();
    expect(sessionId).toMatch(/^task-/);
    const agent = kernel.created[0] as FakeAgent;
    expect(agent.session.id).toBe(sessionId);
    expect(agent.prompts).toHaveLength(1);
    expect(agent.prompts[0]?.text).toContain('分析这段视频');
    expect(JSON.parse(agent.prompts[0]?.text ?? '{}')).toMatchObject({
      source: { kind: 'user' },
    });
  });

  it('assistant/chunk text-delta 合并为单帧（非 chunk 事件触发冲刷）', async () => {
    const sessionId = await createSession();
    kernel.emitSessionEvent(sessionId, { seq: 1, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '你好' } } });
    kernel.emitSessionEvent(sessionId, { seq: 2, type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '，世界' } } });
    kernel.emitSessionEvent(sessionId, { seq: 3, type: 'turn/end', data: { reason: { kind: 'end_turn' } } });
    const { frames } = sessions.stream(sessionId, framesFile, 0);
    const delta = frames.find((f) => f.kind === 'assistant-delta');
    expect(delta?.text).toBe('你好，世界');
    const turnEnd = frames.find((f) => f.kind === 'turn-end');
    expect(turnEnd?.text).toBe('end_turn');
    // seq 单调递增
    const seqs = frames.map((f) => f.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('tool/call + tool/result：toolName 按 callId 回填', async () => {
    const sessionId = await createSession();
    kernel.emitSessionEvent(sessionId, {
      seq: 1,
      type: 'tool/call',
      data: { callId: 'c1', name: 'shufa_probe', arguments: '{"video":"/x.mp4"}' },
    });
    kernel.emitSessionEvent(sessionId, {
      seq: 2,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: 'tool', callId: 'c1' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '{"step":"probe"}' }] }],
        },
      },
    });
    const { frames } = sessions.stream(sessionId, framesFile, 0);
    const call = frames.find((f) => f.kind === 'tool-call');
    expect(call?.toolName).toBe('shufa_probe');
    expect((call?.payload as { call_id: string }).call_id).toBe('c1');
    expect((call?.payload as { arguments: unknown }).arguments).toEqual({ video: '/x.mp4' });
    const result = frames.find((f) => f.kind === 'tool-result');
    expect(result?.toolName).toBe('shufa_probe');
    expect(result?.text).toBe('{"step":"probe"}');
  });

  it('assistant/message：reasoning 帧先于 text 帧', async () => {
    const sessionId = await createSession();
    kernel.emitSessionEvent(sessionId, {
      seq: 1,
      type: 'assistant/message',
      data: {
        message: {
          source: { kind: 'model' },
          content: [
            { type: 'reasoning', text: '思考中' },
            { type: 'text', text: '结论' },
          ],
        },
      },
    });
    const { frames } = sessions.stream(sessionId, framesFile, 0);
    const reasoningIdx = frames.findIndex((f) => f.kind === 'assistant-reasoning');
    const textIdx = frames.findIndex((f) => f.kind === 'assistant-text');
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(textIdx).toBeGreaterThan(reasoningIdx);
    expect(frames[reasoningIdx]?.text).toBe('思考中');
    expect(frames[textIdx]?.text).toBe('结论');
  });

  it('user/message：仅 user source 产 user-text 帧', async () => {
    const sessionId = await createSession();
    kernel.emitSessionEvent(sessionId, {
      seq: 1,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] },
    });
    kernel.emitSessionEvent(sessionId, {
      seq: 2,
      type: 'user/message',
      data: { content: [{ type: 'text', text: '内核注入不算用户输入' }] },
    });
    const { frames } = sessions.stream(sessionId, framesFile, 0);
    const userTexts = frames.filter((f) => f.kind === 'user-text');
    expect(userTexts).toHaveLength(1);
    expect(userTexts[0]?.text).toBe('继续');
  });

  it('todo/write 投影 todo-snapshot；agent/status 投影 status', async () => {
    const sessionId = await createSession();
    kernel.emitSessionEvent(sessionId, {
      seq: 1,
      type: 'todo/write',
      data: { todos: [{ content: 'probe', status: 'completed' }, { content: 'sample', status: 'weird' }] },
    });
    kernel.emitSessionEvent(sessionId, { seq: 2, type: 'agent/status', data: { state: 'running' } });
    const { frames } = sessions.stream(sessionId, framesFile, 0);
    const todos = frames.find((f) => f.kind === 'todo-snapshot');
    expect((todos?.payload as { todos: Array<{ status: string }> }).todos[1]?.status).toBe('pending');
    expect(frames.find((f) => f.kind === 'status')).toBeDefined();
  });

  it('畸形事件整条丢弃（不产帧不崩溃）', async () => {
    const sessionId = await createSession();
    kernel.emitSessionEvent(sessionId, { seq: 1, type: 'assistant/chunk', data: { nonsense: true } });
    kernel.emitSessionEvent(sessionId, { seq: 2, type: 'tool/call', data: { callId: '', name: 'x', arguments: '{}' } });
    const { frames } = sessions.stream(sessionId, framesFile, 0);
    expect(frames.filter((f) => f.kind !== 'user-text')).toHaveLength(0);
  });

  it('turn/end usage：assistant/message 顶层 + assistant/attempt 流末样本聚合投影', async () => {
    const sessionId = await createSession();
    kernel.emitSessionEvent(sessionId, { seq: 1, type: 'turn/start', data: { turn: 1 } });
    // 失败重试尝试：usage 只嵌在流末 usage chunk（对齐 dsh 流记录形状）。
    kernel.emitSessionEvent(sessionId, {
      seq: 2,
      type: 'assistant/attempt',
      data: {
        turn: 1,
        step: 1,
        stream: [
          { type: 'chunk', chunk: { type: 'text-delta', text: '半途' } },
          { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } } },
        ],
      },
    });
    // 成功尝试：usage 挂在事件 data 顶层（{message} 信封之外）。
    kernel.emitSessionEvent(sessionId, {
      seq: 3,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: { source: { kind: 'model' }, content: [{ type: 'text', text: '结论' }] },
        usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 500, cacheWriteTokens: 20 },
      },
    });
    kernel.emitSessionEvent(sessionId, { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'end_turn' } } });
    const { frames } = sessions.stream(sessionId, framesFile, 0);
    const turnEnd = frames.find((f) => f.kind === 'turn-end');
    // 与既有 payload 字段共存（turn/reason 保留）。
    expect(turnEnd?.payload).toMatchObject({
      turn: 1,
      reason: { kind: 'end_turn' },
      usage: { in: 107, out: 43, cache_read: 500, cache_write: 20 },
    });
  });

  it('turn/end usage：无样本轮 payload 不含 usage 键；新轮 turn/start 清零', async () => {
    const sessionId = await createSession();
    // 第一轮带 usage。
    kernel.emitSessionEvent(sessionId, { seq: 1, type: 'turn/start', data: { turn: 1 } });
    kernel.emitSessionEvent(sessionId, {
      seq: 2,
      type: 'assistant/message',
      data: {
        message: { source: { kind: 'model' }, content: [{ type: 'text', text: '一' }] },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    });
    kernel.emitSessionEvent(sessionId, { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'end_turn' } } });
    // 第二轮无 usage 样本（历史帧优雅缺省：药丸只显时长）。
    kernel.emitSessionEvent(sessionId, { seq: 4, type: 'turn/start', data: { turn: 2 } });
    kernel.emitSessionEvent(sessionId, {
      seq: 5,
      type: 'assistant/message',
      data: { message: { source: { kind: 'model' }, content: [{ type: 'text', text: '二' }] } },
    });
    kernel.emitSessionEvent(sessionId, { seq: 6, type: 'turn/end', data: { turn: 2, reason: { kind: 'end_turn' } } });
    const { frames } = sessions.stream(sessionId, framesFile, 0);
    const ends = frames.filter((f) => f.kind === 'turn-end');
    expect(ends).toHaveLength(2);
    expect((ends[0]?.payload as { usage?: unknown }).usage).toEqual({ in: 10, out: 5 });
    expect('usage' in (ends[1]?.payload as Record<string, unknown>)).toBe(false);
  });

  it('turn/end usage：畸形 usage 样本静默跳过（不产诊断不崩帧链）', async () => {
    const sessionId = await createSession();
    kernel.emitSessionEvent(sessionId, { seq: 1, type: 'turn/start', data: { turn: 1 } });
    // usage 计数非法（负数）→ 样本丢弃。
    kernel.emitSessionEvent(sessionId, {
      seq: 2,
      type: 'assistant/message',
      data: {
        message: { source: { kind: 'model' }, content: [{ type: 'text', text: 'x' }] },
        usage: { inputTokens: -3, outputTokens: 4 },
      },
    });
    // assistant/attempt 流里 usage chunk 形状非法 → 样本丢弃。
    kernel.emitSessionEvent(sessionId, {
      seq: 3,
      type: 'assistant/attempt',
      data: { turn: 1, step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 'x' } } }] },
    });
    kernel.emitSessionEvent(sessionId, { seq: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'end_turn' } } });
    const { frames } = sessions.stream(sessionId, framesFile, 0);
    const turnEnd = frames.find((f) => f.kind === 'turn-end');
    expect(turnEnd?.text).toBe('end_turn');
    expect('usage' in (turnEnd?.payload as Record<string, unknown>)).toBe(false);
  });

  it('环形 retention：超出上限的旧帧被裁剪', async () => {
    const sessionId = await createSession();
    for (let i = 0; i < 60; i += 1) {
      kernel.emitSessionEvent(sessionId, { seq: i + 1, type: 'turn/start', data: {} });
    }
    const { frames } = sessions.stream(sessionId, framesFile, 0);
    expect(frames.length).toBeLessThanOrEqual(50);
    // jsonl 是完整历史（裁剪只作用于内存环）。
    expect(new FrameStore(framesFile).readAfter(0).length).toBe(60);
  });

  it('审批：request 挂起 approval-request 帧，answer 回填 resolved', async () => {
    const sessionId = await createSession();
    const agent = kernel.created[0] as FakeAgent;
    const pending = (agent.answerer as NonNullable<FakeAgent['answerer']>)({ questions: [{ id: 'q1', header: '继续?' }] }, async () => ({}));
    const before = sessions.stream(sessionId, framesFile, 0).frames;
    const request = before.find((f) => f.kind === 'approval-request');
    expect(request).toBeDefined();
    expect(sessions.answer(sessionId, (request?.seq ?? 0), [{ id: 'q1', selected: ['yes'] }])).toBe(true);
    expect(await pending).toEqual({ answers: [{ id: 'q1', selected: ['yes'] }] });
    const after = sessions.stream(sessionId, framesFile, 0).frames;
    expect(after.find((f) => f.kind === 'approval-resolved')).toBeDefined();
    expect(sessions.answer(sessionId, request?.seq ?? 0, [])).toBe(false);
  });

  it('cancel 转发 agent.cancel("user")；emit 注入产品帧；订阅推送', async () => {
    const sessionId = await createSession();
    const received: string[] = [];
    const off = sessions.subscribe(sessionId, (frame) => received.push(frame.kind));
    sessions.emit(sessionId, { kind: 'status', payload: { task_id: 'task-1', status: 'running' } });
    expect(received).toEqual(['status']);
    off();
    sessions.emit(sessionId, { kind: 'status', payload: { task_id: 'task-1', status: 'done' } });
    expect(received).toEqual(['status']);

    sessions.cancel(sessionId);
    const agent = kernel.created[0] as FakeAgent;
    expect(agent.cancellations[0]?.cause).toBe('user');
    expect(agent.cancellations[0]?.options).toEqual({ keepInbox: true });
  });

  it('resume：内核 agents.resume 复活 + jsonl 帧回填 ring', async () => {
    const first = await createSession();
    // 预置持久帧（模拟重启前历史）。
    const store = new FrameStore(framesFile);
    store.append({ at: 1, seq: 1, kind: 'user-text', text: '历史' });
    store.append({ at: 2, seq: 2, kind: 'assistant-text', text: '回复' });
    await sessions.resumeTaskSession('task-1', { sessionId: first, framesFile });
    expect(kernel.resumed).toEqual([first]);
    const { frames } = sessions.stream(first, framesFile, 0);
    expect(frames.map((f) => f.text)).toContain('历史');
    // 复活后新帧序号接续历史。
    const lastSeq = frames.at(-1)?.seq ?? 0;
    sessions.emit(first, { kind: 'status', payload: {} });
    expect(sessions.stream(first, framesFile, 0).frames.at(-1)?.seq).toBe(lastSeq + 1);
  });
});
