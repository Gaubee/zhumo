/**
 * W4 测试装配：mock 内核（firehose 可注入）+ mock 会话服务。
 * 原始需求 2026-09-23（W4 测试纪律：真实 LLM 端到端留 W7）。
 * 正交意图：
 *   [1] FakeKernel：session/event firehose 捕获 + agents.create/resume 假句柄。
 *   [2] FakeAgent：followup/cancel/ctx.on（user-questions/request）记录面。
 */
import { EventEmitter } from 'node:events';

export interface RecordedPrompt {
  text: string;
}

export class FakeAgent {
  id: string;
  status = 'idle';
  session: { id: string; header: { cwd?: string } };
  prompts: RecordedPrompt[] = [];
  cancellations: Array<{ cause: unknown; options: unknown }> = [];
  /** user-questions/request 监听器（审批应答面）。 */
  answerer: ((request: { questions?: unknown }, next: () => Promise<unknown>) => Promise<unknown>) | null = null;
  ctx = {
    on: (event: string, listener: never): (() => void) => {
      if (event === 'user-questions/request') {
        this.answerer = listener as unknown as FakeAgent['answerer'];
      }
      return () => {};
    },
  };

  constructor(sessionId: string) {
    this.id = sessionId;
    this.session = { id: sessionId, header: { cwd: '/tmp' } };
  }

  followup(message: unknown): void {
    this.prompts.push({ text: JSON.stringify(message) });
  }

  cancel(cause: unknown, options?: unknown): void {
    this.cancellations.push({ cause, options });
  }
}

/** FakeKernel 以 unknown 面注入（cordis Context 无公开构造面；测试收窄为最小结构）。 */
export class FakeKernel extends EventEmitter {
  ctx: Record<string, unknown>;
  record = { entries: [{ id: 'x', name: 'fake' }], activationOrder: ['fake'] };
  agents: {
    create: (options: { sessionId: string; meta?: { cwd?: string; agentPreset?: string } }) => Promise<{ agent: FakeAgent; dispose: () => Promise<void> }>;
    resume: (options: { resumeSessionId: string }) => Promise<{ agent: FakeAgent; dispose: () => Promise<void> }>;
  };
  readonly created: FakeAgent[] = [];
  readonly resumed: string[] = [];

  constructor() {
    super();
    const kernel = this;
    const make = (sessionId: string): { agent: FakeAgent; dispose: () => Promise<void> } => {
      const agent = new FakeAgent(sessionId);
      kernel.created.push(agent);
      return { agent, dispose: async () => {} };
    };
    this.agents = {
      create: async (options) => make(options.sessionId),
      resume: async (options) => {
        kernel.resumed.push(options.resumeSessionId);
        return make(options.resumeSessionId);
      },
    };
    this.ctx = {
      agents: this.agents,
      on: (...args: unknown[]) => EventEmitter.prototype.on.apply(this, args as never),
    };
  }

  globalToolNames(): string[] {
    return ['ask_user_question', 'todo_write', 'bash'];
  }

  /** 注入一条 firehose 事件（session/event）。 */
  emitSessionEvent(sessionId: string, event: { seq: number; type: string; data: unknown }): void {
    this.emit('session/event', { id: sessionId }, event);
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/** 注入 sessions 时的最小结构收窄（ShufaKernelHandle 的 cordis Context 不可假造）。 */
export function asKernelHandle(kernel: FakeKernel): import('../src/kernel/boot.js').ShufaKernelHandle {
  return kernel as unknown as import('../src/kernel/boot.js').ShufaKernelHandle;
}
