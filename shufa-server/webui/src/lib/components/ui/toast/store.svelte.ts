/**
 * 轻量 toast（W10g，Owner 要求「已排队」类提示走 toast 而非输入框内联）：
 * 项目无 sonner 依赖——按 shadcn 交互惯例自实现（顶部居中浮层，自动消失）。
 */
export interface ToastItem {
  id: number;
  message: string;
  tone: "info" | "success" | "warn";
}

export const toasts = $state<{ items: ToastItem[] }>({ items: [] });

let nextId = 1;

export function toast(message: string, tone: ToastItem["tone"] = "info", durationMs = 3000): void {
  const id = nextId++;
  toasts.items = [...toasts.items, { id, message, tone }];
  setTimeout(() => {
    toasts.items = toasts.items.filter((t) => t.id !== id);
  }, durationMs);
}
