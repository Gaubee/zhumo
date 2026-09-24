/**
 * 任务与会话帧状态（tasks store；mock 帧流，后续波次接 WS）。
 * 正交意图：
 *   [1] 任务列表（时间倒序）与选中任务。
 *   [2] 选中任务的帧缓存 + 订阅（/api/tasks/{id} 初始帧 + /ws/tasks/{id} 增量
 *       的 mock 同构：getTaskFrames + subscribeTaskFrames）。
 *   [3] 帧投影（frame → 转录流条目，移植 skill-creator-v2 TranscriptView 条目
 *       语法：user/assistant/tool/status/turn-end）。
 */
import { api } from "$lib/api";
import type { Frame, Task, TaskResultRefView } from "$lib/types";

export const tasks = $state({
  list: [] as Task[],
  selectedId: null as string | null,
  frames: [] as Frame[],
  /** 选中任务的导出结果列表（新→旧；右侧标签页数据源）。 */
  results: [] as TaskResultRefView[],
  sending: false,
  loading: true,
  error: null as string | null,
});

let unsubscribe: (() => void) | null = null;

export async function loadTasks(): Promise<void> {
  tasks.loading = true;
  try {
    tasks.list = await api.listTasks();
    if (tasks.selectedId === null && tasks.list[0] !== undefined) {
      await selectTask(tasks.list[0].id);
    }
  } catch (error) {
    tasks.error = error instanceof Error ? error.message : String(error);
  } finally {
    tasks.loading = false;
  }
}

export async function selectTask(taskId: string): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
  tasks.selectedId = taskId;
  // 先清结果/帧：切换瞬间不残留上一任务的标签与转录（走查 2026-09-25：
  // 用户实测「导出结果不跟着任务走」——慢网下旧任务响应晚到覆盖新任务）。
  tasks.results = [];
  const frames = await api.getTaskFrames(taskId);
  if (tasks.selectedId !== taskId) return; // 已切走：过期响应丢弃
  tasks.frames = frames;
  const results = await api.getTaskResults(taskId);
  if (tasks.selectedId !== taskId) return;
  tasks.results = results;
  const subscribe = api.subscribeTaskFrames(taskId, (frame) => {
    // 真实 user-text 帧到达 → 移除同文本的乐观帧（走查 R7：乐观显示去重）。
    if (frame.kind === "user-text") dropOptimistic(frame.text ?? "");
    if (tasks.selectedId === taskId) tasks.frames = [...tasks.frames, frame];
    // result 帧 = 新导出落地 → 刷新结果列表（详情右侧即时出新标签）。
    if (frame.kind === "result") void refreshResults(taskId);
    // 状态帧 payload.status → 行状态同步（W7 + 走查 R3：failed 帧携带的 error
    // 详情一并写行——详情头「失败原因」即时呈现，不等列表重拉）。
    const status = readFrameStatus(frame);
    if (status !== null) {
      const frameError = readFrameError(frame);
      tasks.list = tasks.list.map((t) =>
        t.id === taskId
          ? { ...t, status, ...(frameError !== null ? { error: frameError } : {}) }
          : t,
      );
    }
  });
  if (tasks.selectedId !== taskId) {
    subscribe(); // 等待期间已切走：立即退订，不留悬挂订阅
    return;
  }
  unsubscribe = subscribe;
  // 帧流可能推动任务状态变化；轻量刷新行（mock 下 replayAgentTurn 改内存对象）。
  void loadTaskRow(taskId);
}

/** 导出结果列表刷新（selectTask 初始 + result 帧到达时）。 */
async function refreshResults(taskId: string): Promise<void> {
  try {
    const results = await api.getTaskResults(taskId);
    if (tasks.selectedId === taskId) tasks.results = results;
  } catch {
    // 结果面失败不打断对话流；下次 result 帧或重选任务再试。
  }
}

/** status 帧的 payload.error 收窄（走查 R3：daemon 失败帧携带详情明文）。 */
function readFrameError(frame: Frame): string | null {
  const payload = frame.payload as { error?: unknown } | string | undefined;
  if (typeof payload === "object" && payload !== null && typeof payload.error === "string") {
    return payload.error;
  }
  return null;
}

/** status 帧的 payload.status 收窄（daemon 推 {task_id, status}）。 */
function readFrameStatus(frame: Frame): Task["status"] | null {
  const payload = frame.payload as { status?: unknown } | string | undefined;
  if (typeof payload === "object" && payload !== null && typeof payload.status === "string") {
    const status = payload.status;
    return status === "running" || status === "queued" || status === "done" || status === "failed" || status === "cancelled"
      ? status
      : null;
  }
  return null;
}

async function loadTaskRow(taskId: string): Promise<void> {
  const fresh = await api.listTasks();
  const found = fresh.find((t) => t.id === taskId);
  const current = tasks.list.find((t) => t.id === taskId);
  if (found && current && found.status !== current.status) {
    tasks.list = tasks.list.map((t) => (t.id === taskId ? found : t));
  }
}

/** 移除未落实的乐观 user 帧（真帧到达/发送失败时）。 */
function dropOptimistic(text: string): void {
  const idx = [...tasks.frames]
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.kind === "user-text" && (f.payload as { optimistic?: boolean } | undefined)?.optimistic === true && (f.text ?? "") === text)
    .pop()?.i;
  if (idx !== undefined) tasks.frames = tasks.frames.filter((_, i) => i !== idx);
}

export async function sendPrompt(prompt: string): Promise<void> {
  const taskId = tasks.selectedId;
  const trimmed = prompt.trim();
  if (taskId === null || tasks.sending || trimmed.length === 0) return;
  tasks.sending = true;
  tasks.error = null;
  // 乐观插入（走查 R7：发送即显示——不等 WS 帧回放；真帧到达后 dropOptimistic 去重）。
  const optimistic: Frame = {
    at: Date.now(),
    seq: -(Date.now()),
    kind: "user-text",
    text: trimmed,
    payload: { optimistic: true },
  };
  tasks.frames = [...tasks.frames, optimistic];
  try {
    await api.sendTaskPrompt(taskId, trimmed);
    // followup 触发 resume（done/failed 续聊）时任务即时回 running；状态帧到达前先行联动。
    tasks.list = tasks.list.map((t) =>
      t.id === taskId && t.status !== "running" ? { ...t, status: "running" as const } : t,
    );
  } catch (error) {
    dropOptimistic(trimmed);
    tasks.error = error instanceof Error ? error.message : String(error);
  } finally {
    tasks.sending = false;
  }
}

export async function createTask(
  prompt: string,
  video: File | null,
  model?: { provider: string; model: string },
): Promise<void> {
  tasks.error = null;
  try {
    const task = await api.createTask(prompt, video, model);
    tasks.list = [task, ...tasks.list];
    await selectTask(task.id);
  } catch (error) {
    tasks.error = error instanceof Error ? error.message : String(error);
  }
}

// ---- 帧投影（TranscriptView 条目语法） ----

export type TranscriptItem =
  | { kind: "user"; seq: number; text: string }
  | { kind: "assistant"; seq: number; text: string; streaming: boolean }
  | { kind: "reasoning"; seq: number; text: string; streaming: boolean }
  | { kind: "tool"; seq: number; toolName: string; argsText: string; result: string | null }
  | { kind: "status"; seq: number; text: string }
  | { kind: "error"; seq: number; text: string }
  | { kind: "turn-end"; seq: number; elapsedMs?: number; usage?: TurnUsagePill };

/**
 * turn-end 用量药丸数据（daemon turn/end 帧 payload.usage 透传，2026-09-22）：
 * - in = 未缓存输入 tokens（dsh-llm TokenUsage.inputTokens）；
 * - cacheRead/cacheWrite 仅在 SDK 样本上报该桶时存在（↑ 口径 = 三者之和）；
 * - 历史帧无 usage 时整个字段缺省（药丸只显时长）。
 */
export interface TurnUsagePill {
  in: number;
  out: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 帧 payload.usage 最小结构收窄（畸形/缺失 → undefined，优雅缺省）。 */
function usageOfFramePayload(payload: unknown): TurnUsagePill | undefined {
  const usage = (payload as { usage?: unknown } | undefined)?.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const { in: input, out } = usage as { in?: unknown; out?: unknown };
  if (typeof input !== "number" || typeof out !== "number") return undefined;
  const cacheRead = (usage as { cache_read?: unknown }).cache_read;
  const cacheWrite = (usage as { cache_write?: unknown }).cache_write;
  return {
    in: input,
    out,
    ...(typeof cacheRead === "number" ? { cacheRead } : {}),
    ...(typeof cacheWrite === "number" ? { cacheWrite } : {}),
  };
}

/**
 * 帧 → 转录条目（走查 R7 对齐 skill-creator-v2 投影语义）：
 * - assistant-delta/reasoning-delta 流式增量：并轨合并为 streaming 条目（终帧
 *   assistant-text/reasoning 落定替换）；
 * - assistant-reasoning → thinking 折叠行（流式自动展开、定稿收起）；
 * - turn-start 记时间，turn-end 投影 elapsed 药丸（payload.usage 存在时
 *   追加 ↑/↓ tokens 用量，历史帧缺省只显时长）；
 * - error 双源（turn-end error / failed status 详情）相邻去重。
 */
export function projectFrames(frames: Frame[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let turnStartAt: number | null = null;
  for (const frame of frames) {
    switch (frame.kind) {
      case "user-text":
        if ((frame.payload as { optimistic?: boolean } | undefined)?.optimistic === true) break;
        items.push({ kind: "user", seq: frame.seq, text: frame.text ?? "" });
        break;
      case "assistant-delta": {
        // 并轨：上一条 streaming assistant 延续；否则新开。
        const last = items[items.length - 1];
        if (last !== undefined && last.kind === "assistant" && last.streaming) {
          items[items.length - 1] = { ...last, text: last.text + (frame.text ?? "") };
        } else {
          items.push({ kind: "assistant", seq: frame.seq, text: frame.text ?? "", streaming: true });
        }
        break;
      }
      case "assistant-text": {
        // 终帧替换本轮流式草稿（内容以终帧为准）。
        const last = items[items.length - 1];
        if (last !== undefined && last.kind === "assistant" && last.streaming) {
          items[items.length - 1] = { kind: "assistant", seq: frame.seq, text: frame.text ?? "", streaming: false };
        } else {
          items.push({ kind: "assistant", seq: frame.seq, text: frame.text ?? "", streaming: false });
        }
        break;
      }
      case "assistant-reasoning-delta": {
        const last = items[items.length - 1];
        if (last !== undefined && last.kind === "reasoning" && last.streaming) {
          items[items.length - 1] = { ...last, text: last.text + (frame.text ?? "") };
        } else {
          items.push({ kind: "reasoning", seq: frame.seq, text: frame.text ?? "", streaming: true });
        }
        break;
      }
      case "assistant-reasoning": {
        const last = items[items.length - 1];
        if (last !== undefined && last.kind === "reasoning" && last.streaming) {
          items[items.length - 1] = { kind: "reasoning", seq: frame.seq, text: frame.text ?? "", streaming: false };
        } else {
          items.push({ kind: "reasoning", seq: frame.seq, text: frame.text ?? "", streaming: false });
        }
        break;
      }
      case "tool-call":
        items.push({
          kind: "tool",
          seq: frame.seq,
          toolName: frame.toolName ?? "tool",
          argsText: frame.text ?? "",
          result: null,
        });
        break;
      case "tool-result": {
        const call = [...items]
          .reverse()
          .find((item) => item.kind === "tool" && item.toolName === frame.toolName);
        if (call && call.kind === "tool" && call.result === null) call.result = frame.text ?? "";
        break;
      }
      case "turn-start":
        turnStartAt = frame.at;
        break;
      case "status":
      case "step": {
        const payload = frame.payload as { status?: string; error?: string } | string | undefined;
        const statusText =
          typeof payload === "object" && payload !== null && typeof payload.status === "string"
            ? `任务状态 → ${payload.status}`
            : null;
        if (
          typeof payload === "object" &&
          payload !== null &&
          payload.status === "failed" &&
          typeof payload.error === "string" &&
          payload.error.length > 0
        ) {
          items.push({ kind: "error", seq: frame.seq, text: payload.error });
          break;
        }
        items.push({ kind: "status", seq: frame.seq, text: frame.text ?? statusText ?? frame.kind });
        break;
      }
      case "turn-end": {
        const reason = (
          frame.payload as {
            reason?: { kind?: string; error?: { message?: string; code?: string } };
          } | undefined
        )?.reason;
        if (reason?.kind === "error") {
          const message = reason.error?.message ?? "未知错误";
          const code = reason.error?.code;
          const text = code !== undefined ? `${message}（${code}）` : message;
          const last = items[items.length - 1];
          if (last !== undefined && last.kind === "error") items[items.length - 1] = { kind: "error", seq: frame.seq, text };
          else items.push({ kind: "error", seq: frame.seq, text });
          turnStartAt = null;
          break;
        }
        const elapsedMs = turnStartAt !== null ? Math.max(0, frame.at - turnStartAt) : undefined;
        const usage = usageOfFramePayload(frame.payload);
        items.push({
          kind: "turn-end",
          seq: frame.seq,
          ...(elapsedMs !== undefined ? { elapsedMs } : {}),
          ...(usage !== undefined ? { usage } : {}),
        });
        turnStartAt = null;
        break;
      }
    }
  }
  return items;
}

/** 选中任务（组件内以 $derived 调用；模块层不做导出派生）。 */
export function getSelectedTask(): Task | null {
  return tasks.list.find((t) => t.id === tasks.selectedId) ?? null;
}
