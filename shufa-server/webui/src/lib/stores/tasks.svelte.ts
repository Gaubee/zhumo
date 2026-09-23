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
import type { Frame, Task } from "$lib/types";

export const tasks = $state({
  list: [] as Task[],
  selectedId: null as string | null,
  frames: [] as Frame[],
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
  tasks.frames = await api.getTaskFrames(taskId);
  unsubscribe = api.subscribeTaskFrames(taskId, (frame) => {
    if (tasks.selectedId === taskId) tasks.frames = [...tasks.frames, frame];
    // 状态帧 payload.status → 行状态同步（W7：失败/完成态即时呈现，不悬挂）。
    const status = readFrameStatus(frame);
    if (status !== null) {
      tasks.list = tasks.list.map((t) => (t.id === taskId ? { ...t, status } : t));
    }
  });
  // 帧流可能推动任务状态变化；轻量刷新行（mock 下 replayAgentTurn 改内存对象）。
  void loadTaskRow(taskId);
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

export async function sendPrompt(prompt: string): Promise<void> {
  const taskId = tasks.selectedId;
  if (taskId === null || tasks.sending || prompt.trim().length === 0) return;
  tasks.sending = true;
  tasks.error = null;
  try {
    await api.sendTaskPrompt(taskId, prompt.trim());
    // followup 触发 resume（done/failed 续聊）时任务即时回 running；状态帧到达前先行联动。
    tasks.list = tasks.list.map((t) =>
      t.id === taskId && t.status !== "running" ? { ...t, status: "running" as const } : t,
    );
  } catch (error) {
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
  | { kind: "assistant"; seq: number; text: string }
  | { kind: "tool"; seq: number; toolName: string; argsText: string; result: string | null }
  | { kind: "status"; seq: number; text: string }
  | { kind: "turn-end"; seq: number };

/** 帧 → 转录条目（tool-result 并回前序 tool-call 行）。 */
export function projectFrames(frames: Frame[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const frame of frames) {
    switch (frame.kind) {
      case "user-text":
        items.push({ kind: "user", seq: frame.seq, text: frame.text ?? "" });
        break;
      case "assistant-text":
        items.push({ kind: "assistant", seq: frame.seq, text: frame.text ?? "" });
        break;
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
      case "status":
      case "step": {
        const payload = frame.payload as { status?: string } | string | undefined;
        const statusText =
          typeof payload === "object" && payload !== null && typeof payload.status === "string"
            ? `任务状态 → ${payload.status}`
            : null;
        items.push({ kind: "status", seq: frame.seq, text: frame.text ?? statusText ?? frame.kind });
        break;
      }
      case "turn-end":
        items.push({ kind: "turn-end", seq: frame.seq });
        break;
    }
  }
  return items;
}

/** 选中任务（组件内以 $derived 调用；模块层不做导出派生）。 */
export function getSelectedTask(): Task | null {
  return tasks.list.find((t) => t.id === tasks.selectedId) ?? null;
}
