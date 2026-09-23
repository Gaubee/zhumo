/**
 * 模型路由图标与命名助手（移植自 skill-creator-v2 webui
 * src/lib/components/settings/{route-icon.ts,route-naming.ts,model-fields.ts}，
 * 剔除目录画廊依赖，保留字母头像回退 + 可读名派生）。
 * 正交意图：
 *   [1] 字母头像：routeLetter/iconColor（provider 名哈希取暖色底 + 首字母）。
 *   [2] 可读名：readableModelName（id 分段标题化）+ routeDisplayLabel。
 */
import type { DshModelRoute } from "$lib/types";

/** model id → 展示名：`-`/`_` 分段；纯字母 ≤3 字符段全大写，其余首字母大写。 */
export function readableModelName(id: string): string {
  return id
    .split(/[-_]+/)
    .filter((token) => token.length > 0)
    .map((token) =>
      /^[a-z]{1,3}$/.test(token)
        ? token.toUpperCase()
        : token.slice(0, 1).toUpperCase() + token.slice(1),
    )
    .join(" ");
}

/** 路由展示名：优先 iconLetter，否则 provider 首段首字母。 */
export function routeLetter(route: DshModelRoute): string {
  if (route.iconLetter !== undefined && route.iconLetter.length > 0) return route.iconLetter;
  const first = route.provider.split(/[-_.]/)[0] ?? route.provider;
  return first.slice(0, 1).toUpperCase();
}

const PALETTE = ["#c0392b", "#8d6e63", "#2f6f4f", "#3f5b8f", "#8f5b3f", "#5f4b8b"];

/** provider 名 → 稳定暖调底色（与纸墨色系协调）。 */
export function routeAvatarColor(route: DshModelRoute): string {
  if (route.iconColor !== undefined) return route.iconColor;
  let hash = 0;
  for (const ch of route.provider) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? "#8d6e63";
}

/** 路由显示标签：provider 原名（自定义路由即用户键入名）。 */
export function routeDisplayLabel(route: DshModelRoute): string {
  return route.provider;
}

/** token 数规范显示（k/M 简写，model-fields.ts 逆变换移植）。 */
export function formatTokenCount(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) return String(value);
  if (value % (1024 * 1024) === 0) return `${value / (1024 * 1024)}M`;
  if (value >= 1024) {
    const k = value / 1024;
    return `${Number.isInteger(k) ? k.toString() : k.toFixed(1)}k`;
  }
  return String(value);
}
