/**
 * W10b 队列面板测试：真实 createTaskSessions × FakeAgent inbox——验证
 * queueView/freeze/unfreeze/setMode 对内核 inbox 的读写语义（Owner 设计
 * 2026-09-27：编辑冻结=该条及其后暂离队列；确认/取消按原序放回；模式可改
 * 注入或引导）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createTaskSessions } from '../src/kernel/sessions.js';
import { asKernelHandle, FakeAgent, FakeKernel } from './helpers-task.js';

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
    expect(view.items.map((i) => [i.mode, i.text])).toEqual([
      ['queue', '一'],
      ['queue', '二'],
      ['steer', '引导一下'],
    ]);
    expect(view.editing).toBeNull();
    // 每条 messageId 均可寻址（inbox 消息 id 稳定）。
    for (const item of view.items) expect(item.messageId.length).toBeGreaterThan(0);
    void agent;
  });

  it('queueFreeze：该条及其后暂离 next-turn（队首保留）；再次编辑被拒', async () => {
    const { sessionId } = await seedQueue(['一', '二', '三']);
    const before = sessions.queueView(sessionId);
    const secondId = before.items[1]!.messageId;
    const text = sessions.queueFreeze(sessionId, secondId);
    expect(text).toBe('二');
    // 冻结段（二、三）暂离；只剩「一」；editing 指向被编辑条。
    const view = sessions.queueView(sessionId);
    expect(view.items.map((i) => i.text)).toEqual(['一']);
    expect(view.editing).toBe(secondId);
    expect(() => sessions.queueFreeze(sessionId, before.items[0]!.messageId)).toThrow('编辑');
  });

  it('queueUnfreeze（取消）：冻结段按原序原样放回', async () => {
    const { sessionId } = await seedQueue(['一', '二', '三']);
    const secondId = sessions.queueView(sessionId).items[1]!.messageId;
    sessions.queueFreeze(sessionId, secondId);
    sessions.queueUnfreeze(sessionId, null);
    const view = sessions.queueView(sessionId);
    expect(view.items.map((i) => i.text)).toEqual(['一', '二', '三']);
    expect(view.editing).toBeNull();
  });

  it('queueUnfreeze（确认）：首条换新文本，整段原序放回', async () => {
    const { sessionId } = await seedQueue(['一', '二', '三']);
    const secondId = sessions.queueView(sessionId).items[1]!.messageId;
    sessions.queueFreeze(sessionId, secondId);
    sessions.queueUnfreeze(sessionId, '二（改）');
    const view = sessions.queueView(sessionId);
    expect(view.items.map((i) => i.text)).toEqual(['一', '二（改）', '三']);
    expect(view.editing).toBeNull();
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

  it('不在册：队列操作抛错（调用方引导重开对话）', async () => {
    expect(() => sessions.queueView('nope')).toThrow('not found');
    expect(() => sessions.queueFreeze('nope', 'x')).toThrow('not found');
  });
});
