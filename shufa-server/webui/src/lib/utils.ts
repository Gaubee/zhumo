/**
 * shadcn 类名合并与组件 props 结构类型助手（CLI 生成组件的依赖；
 * WithElementRef 等类型与 shadcn-svelte 生成器约定一致）。
 * 正交意图：
 *   [1] clsx + tailwind-merge 组合；[2] props 组合结构类型。
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** 合并条件 class，并消解 Tailwind utility 冲突。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** 从组件 props 中移除单一 child。 */
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, "child"> : T;
/** 从组件 props 中移除 children。 */
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, "children"> : T;
/** 从组件 props 中同时移除 child 与 children。 */
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
/** 为组件 props 附加可选 DOM element ref。 */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & { ref?: U | null };
