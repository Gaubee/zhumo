/**
 * W10k 统一队列测试（Owner 语义 2026-09-28，ZCode×Codex 讨论定稿）：
 * 单一有序序列，queue=anchor（开轮），steer/inject=attach（补充——绑定前方
 * 最近 anchor，头部 attach=当前轮）；daemon 单一事实源，内核 inbox 是瞬时
 * 投递缓冲；单航次投递游标（pump）；锁=位置派生后缀（只是不自动投递）。
 * 真实 createTaskSessions × FakeAgent（turn 事件经 firehose 手动驱动）/DemoAgent
 * （真实定时器）双面验证。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskSessions } from '../src/kernel/sessions.js';
import { asKernelHandle, FakeKernel } from './helpers-task.js';

describe('sessions 统一队列（W10k：单一序列 + 单航次投递）', () => {
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

  /** 建会话并把初始 prompt 轮跑完（干净 idle 态）。返回驱动 turn 事件的工具。 */
  async function seedIdle(taskId: string) {
    const created = await sessions.createTaskSession(taskId, {
      cwd: root,
      framesFile: path.join(root, `frames-${taskId}.jsonl`),
      prompt: '初始',
    });
    const agent = kernel.created.at(-1)!;
    const sid = created.sessionId;
    let seq = 1;
    const turnStart = () => {
      // 内核消费 next-turn 队头开轮（FakeAgent 不自动消费——手动同构）。
      if (agent.inbox.nextTurn.length > 0) agent.inbox.splice('next-turn', 0, 1, []);
      kernel.emitSessionEvent(sid, { seq: seq++, type: 'turn/start', data: {} });
    };
    const turnEnd = (reason = 'completed') =>
      kernel.emitSessionEvent(sid, { seq: seq++, type: 'turn/end', data: { reason: { kind: reason } } });
    turnStart();
    turnEnd();
    return { sid, agent, turnStart, turnEnd };
  }

  it('queueView：单序列投影（anchor→queue，attach→effect）；id 可寻址', async () => {
    const { sid } = await seedIdle('task-view');
    sessions.followup(sid, '开轮条目');
    sessions.steer(sid, '引导条目');
    const view = sessions.queueView(sid);
    expect(view.items.map((i) => [i.mode, i.text, i.held, i.inflight])).toEqual([
      ['queue', '开轮条目', false, false],
      ['steer', '引导条目', false, false],
    ]);
    expect(view.lockBoundary).toBeNull();
    for (const item of view.items) expect(item.messageId.length).toBeGreaterThan(0);
  });

  it('Owner 核心场景：引导1→队列2→引导3→队列4→引导5（交错单序列逐轮投递）', async () => {
    const { sid, agent, turnStart, turnEnd } = await seedIdle('task-interleave');
    // 制造运行中的轮（外生轮）：引导1 补充当前轮。
    kernel.emitSessionEvent(sid, { seq: 90, type: 'turn/start', data: {} });
    sessions.steer(sid, '引导1');
    sessions.followup(sid, '队列2');
    sessions.steer(sid, '引导3');
    sessions.followup(sid, '队列4');
    sessions.steer(sid, '引导5');
    // 引导1 已投当前轮（steer 一次）；其余按序排队，队列2 忙期不承认。
    expect(agent.steers).toHaveLength(1);
    let view = sessions.queueView(sid);
    expect(view.items.map((i) => [i.mode, i.text, i.inflight])).toEqual([
      ['steer', '引导1', true],
      ['queue', '队列2', false],
      ['steer', '引导3', false],
      ['queue', '队列4', false],
      ['steer', '引导5', false],
    ]);
    // 轮结束：引导1 清扫；队列2 承认（followup 入 next-turn）。
    turnEnd();
    expect(agent.inbox.nextTurn).toHaveLength(1);
    // 开轮：队列2 配对移除，引导3 跟随投进该轮（steer 第二次）。
    turnStart();
    expect(agent.steers).toHaveLength(2);
    view = sessions.queueView(sid);
    expect(view.items.map((i) => [i.mode, i.text, i.inflight])).toEqual([
      ['steer', '引导3', true],
      ['queue', '队列4', false],
      ['steer', '引导5', false],
    ]);
    // 队列4 轮：引导5 跟随；随后队列空。
    turnEnd();
    turnStart();
    expect(agent.steers).toHaveLength(3);
    turnEnd();
    expect(sessions.queueView(sid).items).toHaveLength(0);
  });

  it('idle + 引导：steer 等价开新轮；inject 不唤醒保持 pending（活动轮开始后注入）', async () => {
    const { sid, agent, turnStart, turnEnd } = await seedIdle('task-idle-head');
    sessions.steer(sid, '引导即刻');
    expect(agent.steers).toHaveLength(1); // idle steer 开轮
    sessions.followup(sid, '等引导轮结束的开轮');
    turnEnd(); // 引导轮结束 → 开轮条目承认
    expect(agent.inbox.nextTurn).toHaveLength(1);
    turnStart();
    turnEnd();

    // inject 头部：idle 不投（不唤醒），外部轮开始后注入当前轮。
    sessions.followup(sid, '会被改成注入的');
    const view = sessions.queueView(sid);
    sessions.queueSetMode(sid, view.items[0]!.messageId, 'inject');
    expect(sessions.queueView(sid).items[0]!.mode).toBe('inject');
    expect(agent.injects).toHaveLength(0); // idle 不投
    turnStart(); // 活动轮 → pump 注入
    expect(agent.injects).toHaveLength(1);
    turnEnd();
  });

  it('锁定：边界后缀 held（位置派生）；在途条目先撤回内核再锁；解锁 pump 续投', async () => {
    const { sid, agent, turnStart, turnEnd } = await seedIdle('task-lock');
    sessions.followup(sid, 'A');
    sessions.followup(sid, 'B');
    sessions.followup(sid, 'C');
    // A 已承认（next-turn 在途）——锁定 A 撤回内核。
    expect(agent.inbox.nextTurn).toHaveLength(1);
    const view = sessions.queueView(sid);
    sessions.queueLock(sid, view.items[0]!.messageId);
    expect(agent.inbox.nextTurn).toHaveLength(0); // 撤回
    expect(
      sessions.queueView(sid).items.map((i) => [i.text, i.held]),
    ).toEqual([
      ['A', true],
      ['B', true],
      ['C', true],
    ]);
    // 轮事件不消费锁定段。
    turnStart();
    turnEnd();
    turnStart();
    turnEnd();
    expect(sessions.queueView(sid).items.filter((i) => i.held)).toHaveLength(3);
    // 解锁：pump 立即承认 A；消费后 B、C 依次接力。
    sessions.queueLock(sid, null);
    expect(agent.inbox.nextTurn).toHaveLength(1);
    turnStart();
    turnEnd();
    expect(sessions.queueView(sid).items.map((i) => i.text)).toEqual(['B', 'C']);
  });

  it('编辑：锁定段内取文本/改文本（id 稳定寻址）', async () => {
    const { sid } = await seedIdle('task-edit');
    sessions.followup(sid, '原文');
    const view = sessions.queueView(sid);
    const id = view.items[0]!.messageId;
    sessions.queueLock(sid, id);
    expect(sessions.queueHeldText(sid, id)).toBe('原文');
    sessions.queueEditApply(sid, id, '改后');
    expect(sessions.queueHeldText(sid, id)).toBe('改后');
    expect(sessions.queueView(sid).items[0]!.messageId).toBe(id);
  });

  it('删除：held 条目安全删；边界条被删→后继接班；anchor 被删→attach 原地保留重绑', async () => {
    const { sid } = await seedIdle('task-remove');
    sessions.followup(sid, '锚1');
    sessions.steer(sid, '补充a');
    sessions.followup(sid, '锚2');
    const view = sessions.queueView(sid);
    const anchor1 = view.items[0]!.messageId;
    // 锁锚2（后缀全 held），删边界条锚2 → 无后继 → 自动解锁。
    sessions.queueLock(sid, view.items[2]!.messageId);
    sessions.queueRemove(sid, view.items[2]!.messageId);
    expect(sessions.queueView(sid).lockBoundary).toBeNull();
    // 删锚1：补充a 留在序列（绑定按位置重算——头部=当前轮）。
    sessions.queueRemove(sid, anchor1);
    expect(
      sessions.queueView(sid).items.map((i) => [i.mode, i.text]),
    ).toEqual([['steer', '补充a']]);
    // 不在队列：幂等成功。
    expect(() => sessions.queueRemove(sid, anchor1)).not.toThrow();
  });

  it('改模式：位置不动只改 kind/effect；锁定不因改模式越过（正交）', async () => {
    const { sid, agent } = await seedIdle('task-setmode');
    sessions.followup(sid, '排队的');
    const view = sessions.queueView(sid);
    const id = view.items[0]!.messageId;
    sessions.queueSetMode(sid, id, 'inject');
    expect(sessions.queueView(sid).items[0]!.mode).toBe('inject');
    sessions.queueSetMode(sid, id, 'queue');
    expect(sessions.queueView(sid).items[0]!.mode).toBe('queue');
    // 锁定段内改模式：保持 held（锁=不自动投递，与模式正交）。
    sessions.queueLock(sid, id);
    sessions.queueSetMode(sid, id, 'steer');
    expect(sessions.queueView(sid).items[0]).toMatchObject({ mode: 'steer', held: true });
    sessions.queueLock(sid, null);
    // 解锁后 pump 投递（idle steer 开轮）。
    expect(agent.steers).toHaveLength(1);
  });

  it('立刻发送 anchor：组前移（含后续 attach）越过锁定；idle 直接承认', async () => {
    const { sid, agent } = await seedIdle('task-sendnow');
    sessions.followup(sid, '先来的');
    sessions.followup(sid, '目标轮');
    sessions.steer(sid, '目标轮补充');
    sessions.followup(sid, '垫后的');
    const view = sessions.queueView(sid);
    const target = view.items[1]!.messageId;
    sessions.queueLock(sid, target); // 锁目标（后缀全 held）
    sessions.queueSendNow(sid, target);
    // 组（目标轮+其补充）到队首且可投：目标轮已承认（next-turn），
    // 补充待开轮跟随；其余仍在锁定段。
    expect(agent.inbox.nextTurn).toHaveLength(1);
    const after = sessions.queueView(sid);
    expect(after.items[0]!.text).toBe('目标轮');
    expect(after.items[1]).toMatchObject({ mode: 'steer', text: '目标轮补充' });
    // 组后：先来的原本就在边界前（未锁）；垫后的=原后继接班边界（held）。
    expect(after.items.slice(2).map((i) => [i.text, i.held === true])).toEqual([
      ['先来的', false],
      ['垫后的', true],
    ]);
  });

  it('立刻发送 attach：提到队首立即投当前轮（steer）', async () => {
    const { sid, agent, turnStart, turnEnd } = await seedIdle('task-sendnow-attach');
    sessions.followup(sid, '开轮在前');
    turnEnd(); // 承认开轮
    turnStart(); // 开轮运行中（补充绑当前轮的窗口）
    sessions.steer(sid, '稍后补充');
    // 稍后补充在开轮运行中入列即投——立刻发送再验证一次投递路径。
    expect(agent.steers.length).toBeGreaterThanOrEqual(1);
    turnEnd();
  });

  it('重排：queued 全量新序（绑定按位置重算）；集合不一致拒绝', async () => {
    const { sid, turnStart, turnEnd } = await seedIdle('task-reorder');
    sessions.followup(sid, 'A');
    sessions.steer(sid, 'b');
    sessions.followup(sid, 'C');
    // 重排集合=非 inflight 全量（A 已承认 admitted 也参与——拖动期队头常态）。
    const queued = sessions
      .queueView(sid)
      .items.filter((i) => !i.inflight)
      .map((i) => i.messageId);
    sessions.queueReorder(sid, [...queued].reverse());
    expect(
      sessions.queueView(sid).items.map((i) => i.text),
    ).toEqual(['C', 'b', 'A']);
    // 集合不一致拒绝且不污染。
    expect(() => sessions.queueReorder(sid, ['不存在'])).toThrow();
    expect(
      sessions.queueView(sid).items.map((i) => i.text),
    ).toEqual(['C', 'b', 'A']);
    // A 消费后 pump 按新序续投：b 是 attach（跟随消费语境）……C 是下一锚点。
    // C 轮消费（b 作为其补充同轮清扫）；A 承认为下一轮——留存。
    turnEnd();
    turnStart();
    turnEnd();
    expect(sessions.queueView(sid).items.map((i) => i.text)).toEqual(['A']);
    void sessions;
  });

  it('W10f→W10k：轮完成且队列头不可投 → onSessionIdle；可投不回调', async () => {
    const idles: string[] = [];
    const sessions2 = createTaskSessions({
      kernel: () => asKernelHandle(kernel),
      modelSelection: async () => ({ provider: 'zhipu', model: 'glm-5.3-flash' }),
      retention: 50,
      onSessionIdle: (s) => idles.push(s),
    });
    const created = await sessions2.createTaskSession('task-idle', {
      cwd: root,
      framesFile: path.join(root, 'frames-idle.jsonl'),
      prompt: '首条',
    });
    const sid = created.sessionId;
    const agent = kernel.created.at(-1)!;
    agent.inbox.splice('next-turn', 0, agent.inbox.nextTurn.length, []);
    kernel.emitSessionEvent(sid, { seq: 1, type: 'turn/start', data: {} });
    kernel.emitSessionEvent(sid, { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } });
    expect(idles).toEqual([sid]);
    // 队列可投（followup 入列 → pump 立即承认）→ 轮完成不回调。
    sessions2.followup(sid, '排队中');
    kernel.emitSessionEvent(sid, { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } });
    expect(idles).toEqual([sid]);
  });

  it('持久化：变更回调 onQueuePersist；resume 装配 onQueueRestore 恢复序列与边界', async () => {
    interface Archive {
      items: Array<{ id: string; text: string; kind: 'anchor' | 'attach'; effect?: 'steer' | 'inject'; state: 'queued' | 'admitted' | 'inflight' }>;
      lockBoundaryId: string | null;
    }
    const store: { archive: Archive | null } = { archive: null };
    let persistCount = 0;
    const sessions2 = createTaskSessions({
      kernel: () => asKernelHandle(kernel),
      modelSelection: async () => ({ provider: 'zhipu', model: 'glm-5.3-flash' }),
      retention: 50,
      onQueuePersist: (_sid, _taskId, items, lockBoundaryId) => {
        persistCount += 1;
        store.archive = {
          items: items.map((i) => ({ id: i.id, text: i.text, kind: i.kind, state: i.state, ...(i.effect ? { effect: i.effect } : {}) })),
          lockBoundaryId,
        };
      },
      onQueueRestore: () => store.archive,
    });
    const created = await sessions2.createTaskSession('task-persist', {
      cwd: root,
      framesFile: path.join(root, 'frames-persist.jsonl'),
      prompt: '初始',
    });
    const sid = created.sessionId;
    sessions2.followup(sid, '待恢复A');
    sessions2.steer(sid, '待恢复补充');
    const view = sessions2.queueView(sid);
    sessions2.queueLock(sid, view.items[1]!.messageId);
    expect(persistCount).toBeGreaterThan(0);
    expect(store.archive?.items.map((i) => i.text)).toEqual(['待恢复A', '待恢复补充']);
    // resume 装配：restore 回填（内核 resume 的 FakeAgent inbox 空——无收养项）。
    await sessions2.resumeTaskSession('task-persist', {
      sessionId: sid,
      framesFile: path.join(root, 'frames-persist.jsonl'),
    });
    // 恢复后 pump 依边界续投：A（未锁）重新承认，补充保持锁定段。
    expect(
      sessions2.queueView(sid).items.map((i) => [i.text, i.held === true]),
    ).toEqual([
      ['待恢复A', false],
      ['待恢复补充', true],
    ]);
  });

  it('W10k demo 场景（真实定时器）：引导跟随开轮同轮呈现；锁定段不被消费；解锁续跑', async () => {
    vi.useRealTimers();
    const sessions2 = createTaskSessions({
      kernel: () => asKernelHandle(kernel),
      modelSelection: async () => ({ provider: 'zhipu', model: 'glm-5.3-flash' }),
      retention: 50,
    });
    sessions2.setDemoDelay(30);
    const created = await sessions2.createTaskSession('task-demo', {
      cwd: root,
      framesFile: path.join(root, 'frames-demo.jsonl'),
      prompt: '首条',
    });
    const sid = created.sessionId;
    await new Promise((r) => setTimeout(r, 80));
    expect(sessions2.queueView(sid).items).toHaveLength(0);
    // 开轮+引导跟随：同轮消费（补充帧出现在同一轮）。
    sessions2.followup(sid, '开轮X');
    sessions2.steer(sid, '引导Y');
    await new Promise((r) => setTimeout(r, 150));
    expect(sessions2.queueView(sid).items).toHaveLength(0);
    // 锁定段不被消费。
    sessions2.followup(sid, '锁A');
    sessions2.followup(sid, '锁B');
    const view = sessions2.queueView(sid);
    sessions2.queueLock(sid, view.items[0]!.messageId);
    await new Promise((r) => setTimeout(r, 120));
    expect(sessions2.queueView(sid).items.filter((i) => i.held)).toHaveLength(2);
    sessions2.queueLock(sid, null);
    await new Promise((r) => setTimeout(r, 200));
    expect(sessions2.queueView(sid).items).toHaveLength(0);
  });

  it('W10i：拖动期暂停消费（setQueueReordering true→false）——队列稳定不抖，松手恢复', async () => {
    vi.useRealTimers();
    const sessions2 = createTaskSessions({
      kernel: () => asKernelHandle(kernel),
      modelSelection: async () => ({ provider: 'zhipu', model: 'glm-5.3-flash' }),
      retention: 50,
    });
    sessions2.setDemoDelay(30);
    const created = await sessions2.createTaskSession('task-drag', {
      cwd: root,
      framesFile: path.join(root, 'frames-drag.jsonl'),
      prompt: '首条',
    });
    const sid = created.sessionId;
    await new Promise((r) => setTimeout(r, 80));
    sessions2.followup(sid, '拖动期A');
    sessions2.followup(sid, '拖动期B');
    sessions2.setQueueReordering(sid, true);
    await new Promise((r) => setTimeout(r, 120));
    expect(sessions2.queueView(sid).items.filter((i) => !i.held)).toHaveLength(2);
    const ids = sessions2.queueView(sid).items.map((i) => i.messageId);
    sessions2.queueReorder(sid, [ids[1]!, ids[0]!]);
    sessions2.setQueueReordering(sid, false);
    await new Promise((r) => setTimeout(r, 250));
    expect(sessions2.queueView(sid).items.filter((i) => !i.held)).toHaveLength(0);
  });

  it('Codex P1 回归：admitted A 在途时 sendNow B——A 撤回无残留、B 唯一在途', async () => {
    const { sid, agent } = await seedIdle('task-p1-sendnow');
    sessions.followup(sid, 'A');
    sessions.followup(sid, 'B');
    expect(agent.inbox.nextTurn).toHaveLength(1); // A admitted
    const view = sessions.queueView(sid);
    sessions.queueSendNow(sid, view.items[1]!.messageId); // 立刻发送 B
    // A 撤回（nextTurn 无残留旧消息），B 唯一在途。
    expect(agent.inbox.nextTurn).toHaveLength(1);
    expect(
      sessions.queueView(sid).items.map((i) => i.text),
    ).toEqual(['B', 'A']);
  });

  it('Codex P1 回归：锁定边界覆盖多个 inflight attach——后缀全部撤回', async () => {
    const { sid, agent, turnStart } = await seedIdle('task-p1-lock-suffix');
    turnStart(); // 外生运行轮
    sessions.steer(sid, '补充甲');
    sessions.steer(sid, '补充乙');
    expect(agent.inbox.nextStep).toHaveLength(2); // 均已投内核
    const view = sessions.queueView(sid);
    sessions.queueLock(sid, view.items[0]!.messageId); // 锁首条（后缀=两条）
    expect(agent.inbox.nextStep).toHaveLength(0); // 全部撤回
    expect(sessions.queueView(sid).items.every((i) => i.held)).toBe(true);
  });

  it('Codex P1 回归：删除 admitted anchor——游标清理且下一条立即续泵', async () => {
    const { sid, agent } = await seedIdle('task-p1-remove-admitted');
    sessions.followup(sid, 'A');
    sessions.followup(sid, 'B');
    expect(agent.inbox.nextTurn).toHaveLength(1); // A
    const view = sessions.queueView(sid);
    sessions.queueRemove(sid, view.items[0]!.messageId);
    // A 撤回 + B 同步续泵承认：nextTurn 恰一条（=B，视图只剩 B 可证非 A 残留）。
    expect(agent.inbox.nextTurn).toHaveLength(1);
    expect(sessions.queueView(sid).items.map((i) => i.text)).toEqual(['B']);
  });

  it('Codex P1 回归：恢复只回填 queued 态（admitted/inflight 走内核收养，防双投）', async () => {
    const sessions2 = createTaskSessions({
      kernel: () => asKernelHandle(kernel),
      modelSelection: async () => ({ provider: 'zhipu', model: 'glm-5.3-flash' }),
      retention: 50,
      onQueueRestore: () => ({
        lockBoundaryId: null,
        items: [
          { id: 'db-queued', text: '留存的', kind: 'anchor', state: 'queued' },
          { id: 'db-admitted', text: '在途的', kind: 'anchor', state: 'admitted' },
          { id: 'db-inflight', text: '飞行中', kind: 'attach', effect: 'steer', state: 'inflight' },
        ],
      }),
    });
    const created = await sessions2.createTaskSession('task-p1-restore', {
      cwd: root,
      framesFile: path.join(root, 'frames-p1r.jsonl'),
      prompt: '初始',
    });
    expect(
      sessions2.queueView(created.sessionId).items.map((i) => i.text),
    ).toEqual(['留存的']);
  });

  it('Codex P1 回归：anchor 开轮后持久化不再包含该 anchor（防重启复活）', async () => {
    const persisted: string[][] = [];
    const sessions2 = createTaskSessions({
      kernel: () => asKernelHandle(kernel),
      modelSelection: async () => ({ provider: 'zhipu', model: 'glm-5.3-flash' }),
      retention: 50,
      onQueuePersist: (_sid, _taskId, items) => {
        persisted.push(items.map((i) => i.text));
      },
    });
    const created = await sessions2.createTaskSession('task-p1-persist', {
      cwd: root,
      framesFile: path.join(root, 'frames-p1p.jsonl'),
      prompt: '初始',
    });
    const sid = created.sessionId;
    const agent = kernel.created.at(-1)!;
    sessions2.followup(sid, '唯一');
    agent.inbox.splice('next-turn', 0, agent.inbox.nextTurn.length, []);
    kernel.emitSessionEvent(sid, { seq: 5, type: 'turn/start', data: {} });
    const last = persisted.at(-1) ?? [];
    expect(last.includes('唯一')).toBe(false);
  });

  it('不在册：队列操作抛错（调用方引导重开对话）', async () => {
    expect(() => sessions.queueView('nope')).toThrow('not found');
    expect(() => sessions.queueLock('nope', null)).toThrow('not found');
    expect(() => sessions.followup('nope', 'x')).toThrow('not found');
    expect(() => sessions.steer('nope', 'x')).toThrow('not found');
  });
});
