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
  // 帧流可能推动任务状态变化；轻量刷新行（mock 下 replayAgentTurn 改内存对象）。
  void loadTaskRow(taskId);
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
  /** 失败明文卡片（走查 R3：turn-end error / failed status 帧的详情）。 */
  | { kind: "error"; seq: number; text: string }
  | { kind: "turn-end"; seq: number };

/** 帧 → 转录条目（tool-result 并回前序 tool-call 行；error 双源投影——走查 R3：
 * turn-end 的 error payload 与 failed status 的详情此前被丢弃，用户「任务失败
 * 看不到任何异常」，现在都渲染为 error 条目）。 */
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
        const payload = frame.payload as { status?: string; error?: string } | string | undefined;
        const statusText =
          typeof payload === "object" && payload !== null && typeof payload.status === "string"
            ? `任务状态 → ${payload.status}`
            : null;
        // failed 且带详情 → 错误条目（错误卡自含状态语义，不再重复 status 行）。
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
        // turn 以 error 终止（内核帧 payload.reason.kind === "error"）→ 错误卡片明文。
        const reason = (
          frame.payload as {
            reason?: { kind?: string; error?: { message?: string; code?: string } };
          } | undefined
        )?.reason;
        if (reason?.kind === "error") {
          const message = reason.error?.message ?? "未知错误";
          const code = reason.error?.code;
          const text = code !== undefined ? `${message}（${code}）` : message;
          // 去重：紧邻的 status failed 帧已产错误卡（daemon 双发），turn-end 版本
          // 携带 code 更全——原位替换而不是再叠一张。
          const last = items[items.length - 1];
          if (last !== undefined && last.kind === "error") items[items.length - 1] = { kind: "error", seq: frame.seq, text };
          else items.push({ kind: "error", seq: frame.seq, text });
          break;
        }
        items.push({ kind: "turn-end", seq: frame.seq });
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
