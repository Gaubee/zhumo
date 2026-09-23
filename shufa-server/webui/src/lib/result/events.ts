/**
 * 跨栏事件总线（自 shufa-tool web/src/events.ts 逐字移植，BUG5 结果页复刻）。
 * 静态总结列的旁注时间链接与播放器分属两列/两个模块，用 window 上的
 * "shufa:seek" CustomEvent 解耦：链接端 dispatchSeek(t)，player.ts onSeek
 * 执行跳转（保持播放状态，仅更新进度与进度条游标/填充）。
 */

/** 事件名与载荷 */
export const SEEK_EVENT = "shufa:seek";

export interface SeekDetail {
  /** 目标时刻（秒，播放器内部会钳制到 [0, duration]） */
  t: number;
}

/** 派发跳转请求（静态总结旁注时间链接 → 播放器） */
export function dispatchSeek(t: number): void {
  window.dispatchEvent(new CustomEvent<SeekDetail>(SEEK_EVENT, { detail: { t } }));
}

/** 订阅跳转请求；返回取消订阅函数（player.destroy 用） */
export function onSeek(handler: (t: number) => void): () => void {
  const h = (e: Event): void => {
    const ce = e as CustomEvent<SeekDetail>;
    const t = ce.detail?.t;
    if (typeof t === "number" && Number.isFinite(t)) handler(t);
  };
  window.addEventListener(SEEK_EVENT, h);
  return () => window.removeEventListener(SEEK_EVENT, h);
}
