/**
 * W10b 队列面板测试：真实 createTaskSessions × FakeAgent inbox——验证
 * queueView/freeze/unfreeze/setMode 对内核 inbox 的读写语义（Owner 设计
 * 2026-09-27：编辑冻结=该条及其后暂离队列；确认/取消按原序放回；模式可改
 * 注入或引导）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createTaskSessions } from '../src/kernel/sessions.js';
import { FrameStore } from '../src/kernel/frame-store.js';
import { asKernelHandle, FakeAgent, FakeKernel } from './helpers-task.js';

function inboxText(m: unknown): string {
  return (m as { content?: Array<{ type?: string; text?: string }> }).content
    ?.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n') ?? '';
}

function messageText(m: { content?: Array<{ type?: string; text?: string }> }): string {
  return (m.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

describe('sessions 队列面板（W10b，内核 inbox）', () => {
  let kernel: FakeKernel;
  let root: string;
  let sessions: ReturnType<typeof createTaskSessions>;

  beforeEach(() => {
    kernel = new FakeKernel();
    root = mkdtempSync(path.join(tmpdir(), 'shufa-queue-'));
    sessions = createTaskSessions({
      kernel: () => asKernelHandle(kernel),
      modelSelection: async () => ({ provider: 'zhipu', model: 'glm-5.3-flash' }),
      retention: 50,
    });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** 建会话（首条 prompt 经 createTaskSession 投递）+ 追加排队（模拟 running
   * 中的连续 followup）。返回时 next-turn 桶 = texts 原序。 */
  async function seedQueue(texts: string[]): Promise<{ sessionId: string; agent: FakeAgent }> {
    const [first, ...rest] = texts;
    const created = await sessions.createTaskSession('task-q', {
      cwd: root,
      framesFile: path.join(root, 'frames.jsonl'),
      prompt: first ?? '种子',
    });
    const agent = kernel.created.at(-1)!;
    for (const text of rest) {
      agent.followup(
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
      );
    }
    return { sessionId: created.sessionId, agent };
  }

  it('queueView：next-turn 逐条序 + next-step 按记录辨 steer/inject；steer 投递自动记模式', async () => {
    const { sessionId, agent } = await seedQueue(['一', '二']);
    sessions.steer(sessionId, '引导一下');
    const view = sessions.queueView(sessionId);
    expect(view.items.map((i) => [i.mode, i.text, i.held])).toEqual([
      ['queue', '一', false],
      ['queue', '二', false],
      ['steer', '引导一下', false],
    ]);
    expect(view.lockBoundary).toBeNull();
    // 每条 messageId 均可寻址（inbox 消息 id 稳定）。
    for (const item of view.items) expect(item.messageId.length).toBeGreaterThan(0);
    void agent;
  });

  it('queueLock（Owner 四轮）：边界条及其后暂离内核 inbox（内核不消费）但仍按排队序展示（held）', async () => {
    const { sessionId, agent } = await seedQueue(['一', '二', '三']);
    const secondId = sessions.queueView(sessionId).items[1]!.messageId;
    sessions.queueLock(sessionId, secondId);
    // 视图仍全量显示（锁定段标 held），但 inbox 只剩「一」——内核只可能消费未锁条。
    const view = sessions.queueView(sessionId);
    expect(view.items.map((i) => [i.text, i.held])).toEqual([
      ['一', false],
      ['二', true],
      ['三', true],
    ]);
    expect(view.lockBoundary).toBe(secondId);
    expect(agent.inbox.nextTurn.map((m: unknown) => inboxText(m))).toEqual(['一']);
  });

  it('queueLock 解锁：锁定段按原序放回 inbox（继续跑）；边界上移=纳入更多条', async () => {
    const { sessionId, agent } = await seedQueue(['一', '二', '三']);
    const ids = sessions.queueView(sessionId).items.map((i) => i.messageId);
    sessions.queueLock(sessionId, ids[1]!);
    // 边界上移到第一条：全部锁定。
    sessions.queueLock(sessionId, ids[0]!);
    expect(agent.inbox.nextTurn).toHaveLength(0);
    // 解锁放回。
    sessions.queueLock(sessionId, null);
    expect(agent.inbox.nextTurn.map((m: unknown) => inboxText(m))).toEqual(['一', '二', '三']);
    expect(sessions.queueView(sessionId).lockBoundary).toBeNull();
  });

  it('queueHeldText/queueEditApply：锁定段内取文本与替换（保持锁定，解锁才生效）', async () => {
    const { sessionId, agent } = await seedQueue(['一', '二', '三']);
    const ids = sessions.queueView(sessionId).items.map((i) => i.messageId);
    sessions.queueLock(sessionId, ids[1]!);
    expect(sessions.queueHeldText(sessionId, ids[1]!)).toBe('二');
    sessions.queueEditApply(sessionId, ids[1]!, '二（改）');
    // 仍锁定：inbox 不变；视图文本已换。
    expect(agent.inbox.nextTurn.map((m: unknown) => inboxText(m))).toEqual(['一']);
    expect(sessions.queueView(sessionId).items[1]!.text).toBe('二（改）');
    // 解锁放回的是改后文本。
    sessions.queueLock(sessionId, null);
    expect(agent.inbox.nextTurn.map((m: unknown) => inboxText(m))).toEqual(['一', '二（改）', '三']);
    // 非锁定段条目取文本被拒。
    expect(() => sessions.queueHeldText(sessionId, ids[0]!)).toThrow('不在锁定段');
  });

  it('queueRemove（锁定段）：安全删除；边界条被删→边界移到剩余首条；删空自动解锁', async () => {
    const { sessionId } = await seedQueue(['一', '二', '三']);
    const ids = sessions.queueView(sessionId).items.map((i) => i.messageId);
    sessions.queueLock(sessionId, ids[1]!);
    // 删边界条「二」：边界移到「三」，锁定段剩「三」。
    sessions.queueRemove(sessionId, ids[1]!);
    let view = sessions.queueView(sessionId);
    expect(view.items.map((i) => [i.text, i.held])).toEqual([['一', false], ['三', true]]);
    expect(view.lockBoundary).toBe(ids[2]);
    // 再删「三」：锁定段空=自动解锁。
    sessions.queueRemove(sessionId, ids[2]!);
    view = sessions.queueView(sessionId);
    expect(view.items.map((i) => [i.text, i.held])).toEqual([['一', false]]);
    expect(view.lockBoundary).toBeNull();
  });

  it('W10h 开放锁定段：改引导=脱离锁定段立即投递（发送意图优先于锁定）；改排队=留在段内', async () => {
    const { sessionId, agent } = await seedQueue(['一', '二', '三']);
    const ids = sessions.queueView(sessionId).items.map((i) => i.messageId);
    sessions.queueLock(sessionId, ids[1]!);
    // 段内「二」改引导：脱离锁定段 → steer 投递；边界收敛到「三」。
    sessions.queueSetMode(sessionId, ids[1]!, 'steer');
    let view = sessions.queueView(sessionId);
    expect(agent.steers).toHaveLength(1);
    // 「二」脱离锁定段进挂起组（held=false）；锁定段剩「三」。
    expect(view.items.map((i) => [i.text, i.held])).toEqual([
      ['一', false],
      ['三', true],
      ['二', false],
    ]);
    expect(view.lockBoundary).toBe(ids[2]);
    // 段内「三」改回排队：无操作（继续冻结）。
    sessions.queueSetMode(sessionId, ids[2]!, 'queue');
    view = sessions.queueView(sessionId);
    // 「三」保持锁定（改回排队在段内=继续冻结）；「二」仍在挂起组（steer）。
    expect(view.items.map((i) => [i.text, i.held])).toEqual([
      ['一', false],
      ['三', true],
      ['二', false],
    ]);
  });

  it('W10h 开放锁定段：立刻发送=先解锁放回再提队头打断', async () => {
    const { sessionId, agent } = await seedQueue(['一', '二', '三']);
    agent.status = 'running';
    const ids = sessions.queueView(sessionId).items.map((i) => i.messageId);
    sessions.queueLock(sessionId, ids[2]!);
    // 锁定段内立刻发送「三」：解锁放回 → 提队头 → cancel。
    sessions.queueSendNow(sessionId, ids[2]!);
    expect(agent.cancellations).toHaveLength(1);
    expect(sessions.queueView(sessionId).items.map((i) => i.text)).toEqual(['三', '一', '二']);
  });

  it('queueRemove：按 id 删除（next-turn 与 next-step 皆可）', async () => {
    const { sessionId } = await seedQueue(['一', '二']);
    sessions.steer(sessionId, '引导');
    const view = sessions.queueView(sessionId);
    sessions.queueRemove(sessionId, view.items[0]!.messageId);
    sessions.queueRemove(sessionId, view.items[2]!.messageId);
    expect(sessions.queueView(sessionId).items.map((i) => i.text)).toEqual(['二']);
  });

  it('queueSetMode：queue→steer/inject 走对应内核方法并入 next-step 桶；新条目可辨模式', async () => {
    const { sessionId, agent } = await seedQueue(['一', '二']);
    const firstId = sessions.queueView(sessionId).items[0]!.messageId;
    sessions.queueSetMode(sessionId, firstId, 'inject');
    // 视图序 = 生效序：next-turn（排队）在前、next-step（挂起）在后。
    let view = sessions.queueView(sessionId);
    expect(view.items.map((i) => [i.mode, i.text])).toEqual([
      ['queue', '二'],
      ['inject', '一'],
    ]);
    expect(agent.injects).toHaveLength(1);
    expect(messageText(agent.injects[0] as never)).toBe('一');
    // 再改成 steer：原 inject 条目移除、新条目入桶并可辨 steer。
    const injectId = view.items[1]!.messageId;
    sessions.queueSetMode(sessionId, injectId, 'steer');
    view = sessions.queueView(sessionId);
    expect(view.items.map((i) => [i.mode, i.text])).toEqual([
      ['queue', '二'],
      ['steer', '一'],
    ]);
    expect(agent.steers).toHaveLength(1);
  });

  it('queueReorder：按 messageId 全量新序重排；集合不一致拒绝且不污染', async () => {
    const { sessionId } = await seedQueue(['一', '二', '三']);
    const ids = sessions.queueView(sessionId).items.map((i) => i.messageId);
    sessions.queueReorder(sessionId, [ids[2]!, ids[0]!, ids[1]!]);
    expect(sessions.queueView(sessionId).items.map((i) => i.text)).toEqual(['三', '一', '二']);
    // 队列已变化（缺 id / 多 id / 重复）一律拒绝且不污染。
    expect(() => sessions.queueReorder(sessionId, [ids[0]!, ids[1]!])).toThrow('队列已变化');
    expect(() => sessions.queueReorder(sessionId, [ids[0]!, ids[0]!, ids[1]!])).toThrow('队列已变化');
    expect(sessions.queueView(sessionId).items.map((i) => i.text)).toEqual(['三', '一', '二']);
  });

  it('queueSendNow：目标提到队头 + cancel{user}+keepInbox（内核收敛后自动消费队头）', async () => {
    const { sessionId, agent } = await seedQueue(['一', '二', '三']);
    agent.status = 'running';
    const ids = sessions.queueView(sessionId).items.map((i) => i.messageId);
    sessions.queueSendNow(sessionId, ids[2]!);
    // 队头 = 目标条目；其余原序。
    expect(sessions.queueView(sessionId).items.map((i) => i.text)).toEqual(['三', '一', '二']);
    expect(agent.cancellations).toHaveLength(1);
    expect(agent.cancellations[0]).toEqual({ cause: { kind: 'user' }, options: { keepInbox: true } });
    // 不在 next-turn（如已消费）抛错。
    sessions.queueRemove(sessionId, ids[2]!);
    expect(() => sessions.queueSendNow(sessionId, ids[2]!)).toThrow('队列中没有该排队条目');
  });

  it('W10f：turn/end completed 且队列空 → onSessionIdle；队列非空 → 不回调', async () => {
    const idles: string[] = [];
    const sessions2 = createTaskSessions({
      kernel: () => asKernelHandle(kernel),
      modelSelection: async () => ({ provider: 'zhipu', model: 'glm-5.3-flash' }),
      retention: 50,
      onSessionIdle: (sessionId) => idles.push(sessionId),
    });
    const created = await sessions2.createTaskSession('task-idle', {
      cwd: root,
      framesFile: path.join(root, 'frames-idle.jsonl'),
      prompt: '首条',
    });
    const sessionId = created.sessionId;
    const agent = kernel.created.at(-1)!;
    // 清掉建会话首条 prompt（模拟已消费完的空闲态）。
    agent.inbox.splice('next-turn', 0, agent.inbox.nextTurn.length, []);
    // 队列空：completed → 回调。
    kernel.emitSessionEvent(sessionId, { seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } });
    expect(idles).toEqual([sessionId]);
    // 队列非空（排队续跑中）：completed → 不回调。
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '排队中' }] }));
    kernel.emitSessionEvent(sessionId, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } });
    expect(idles).toEqual([sessionId]);
    void sessions;
  });

  it('W10h demo 场景：锁定段不被消费；解锁放回后 DemoAgent 定时自动续跑（真实定时器）', async () => {
    vi.useRealTimers();
    const sessions2 = createTaskSessions({
      kernel: () => asKernelHandle(kernel),
      modelSelection: async () => ({ provider: 'zhipu', model: 'glm-5.3-flash' }),
      retention: 50,
    });
    sessions2.setDemoDelay(30);
    const framesFile = path.join(root, 'frames-demo.jsonl');
    const created = await sessions2.createTaskSession('task-demo', {
      cwd: root,
      framesFile,
      prompt: '首条',
    });
    const sid = created.sessionId;
    // 首条 30ms 后被消费。
    await new Promise((r) => setTimeout(r, 80));
    let view = sessions2.queueView(sid);
    expect(view.items).toHaveLength(0);
    // 排两条，锁第一条（连同其后全部）→ 等待远超消费周期，一条都不消费。
    sessions2.followup(sid, '锁定段A');
    sessions2.followup(sid, '锁定段B');
    view = sessions2.queueView(sid);
    sessions2.queueLock(sid, view.items[0]!.messageId);
    await new Promise((r) => setTimeout(r, 120));
    view = sessions2.queueView(sid);
    expect(view.items.map((i) => [i.text, i.held])).toEqual([
      ['锁定段A', true],
      ['锁定段B', true],
    ]);
    // 解锁放回：30ms 周期自动逐条消费。
    sessions2.queueLock(sid, null);
    await new Promise((r) => setTimeout(r, 200));
    expect(sessions2.queueView(sid).items).toHaveLength(0);
    void sessions;
  });

  it('不在册：队列操作抛错（调用方引导重开对话）', async () => {
    expect(() => sessions.queueView('nope')).toThrow('not found');
    expect(() => sessions.queueLock('nope', 'x')).toThrow('not found');
  });
});
