/**
 * 模型路由图标与命名助手（移植自 skill-creator-v2 webui
 * src/lib/components/settings/{route-icon.ts,route-naming.ts,model-fields.ts}，
 * 剔除目录画廊依赖，保留字母头像回退 + 可读名派生）。
 * 正交意图：
 *   [1] 字母头像：routeLetter/iconColor（provider 名哈希取暖色底 + 首字母）。
 *   [2] 可读名：readableModelName（id 分段标题化）+ routeDisplayLabel。
 */
import type { DshModelRoute, RouteApi, RouteModel } from "$lib/types";

/** wire 协议运行时枚举（contracts ROUTE_APIS 的 webui 侧镜像，Select option 源）。 */
export const ROUTE_APIS: readonly RouteApi[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
];

/** 模型 id 补全候选（目录模型的 browser-safe 投影，含富预填字段）。 */
export interface ModelCandidate {
  id: string;
  name?: string;
  contextWindow?: number;
  inputTypes?: RouteModel["inputTypes"];
  efforts?: string[];
}

/**
 * 补全池派生（skill-creator-v2 catalogModelCandidates 简化移植）：当前路由
 * provider（编号 slug 归一 base）命中目录时其模型置顶（含命名空间 id），其余
 * provider 剔除命名空间 id；并入已建路由的模型并集。手输仍允许任意 id。
 */
export function modelIdCandidates(
  presets: Array<{
    provider: string;
    models: Array<{
      id: string;
      name?: string;
      contextWindow?: number;
      inputTypes?: RouteModel["inputTypes"];
      efforts?: string[];
    }>;
  }>,
  routeProvider: string,
  routeModels: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    inputTypes?: RouteModel["inputTypes"];
    efforts?: string[];
  }>,
): ModelCandidate[] {
  const base = slugBase(routeProvider);
  const own = presets.find((p) => p.provider === base)?.models ?? [];
  const others = presets
    .filter((p) => p.provider !== base)
    .flatMap((p) => p.models)
    .filter((m) => !isNamespaceModelId(m.id));
  const seen = new Set<string>();
  const out: ModelCandidate[] = [];
  for (const m of [...own, ...others, ...routeModels]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      name: "name" in m ? m.name : undefined,
      contextWindow: "contextWindow" in m ? m.contextWindow : undefined,
      inputTypes: "inputTypes" in m ? m.inputTypes : undefined,
      efforts: "efforts" in m ? m.efforts : undefined,
    });
  }
  return out;
}

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

/** 路由展示名：provider 首段首字母（图标缺失时的字母头像）。 */
export function routeLetter(route: Pick<DshModelRoute, "provider">): string {
  const first = route.provider.split(/[-_.]/)[0] ?? route.provider;
  return first.slice(0, 1).toUpperCase();
}

const PALETTE = ["#c0392b", "#8d6e63", "#2f6f4f", "#3f5b8f", "#8f5b3f", "#5f4b8b"];

/** provider 名 → 稳定暖调底色（与纸墨色系协调）。 */
export function routeAvatarColor(route: Pick<DshModelRoute, "provider">): string {
  let hash = 0;
  for (const ch of route.provider) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length] ?? "#8d6e63";
}

/** 路由显示标签：provider 原名（自定义路由即用户键入名）。 */
export function routeDisplayLabel(route: Pick<DshModelRoute, "provider">): string {
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

/**
 * token 简写解析（skill-creator-v2 parseTokenShorthand 移植）：`128k`/`0.5M`/
 * `131072` → 字节数（k=1024、M=1024²，二进制语义）；非法输入返回 null。
 */
export function parseTokenShorthand(text: string): number | null {
  const matched = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(text.trim());
  if (matched === null) return null;
  const base = Number.parseFloat(matched[1] ?? "0");
  const unit = matched[2]?.toLowerCase();
  const value =
    unit === "k" ? base * 1024 : unit === "m" ? base * 1024 * 1024 : base;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) && rounded > 0 ? rounded : null;
}

/** 新增模型的默认 effort 三档（skill-creator-v2 用户裁定：Low/High/Max）。 */
export const DEFAULT_MODEL_EFFORTS: readonly string[] = ["low", "high", "max"];

/**
 * 已建路由的下一个可用 provider slug（skill-creator-v2 nextRouteSlug 移植）：
 * 同名已存在时编号续尾（zai → zai-2 → zai-3），凭据/身份各自独立。
 */
export function nextRouteSlug(base: string, existing: string[]): string {
  if (!existing.includes(base)) return base;
  let suffix = 2;
  while (existing.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** 编号 slug 的 base 段（`zai-2` → `zai`；非编号原样）。 */
export function slugBase(provider: string): string {
  const matched = /^(.*)-(\d+)$/.exec(provider);
  return matched?.[1] ?? provider;
}

/** 命名空间 id（含 `/` 或 `@`）只在其宿主 provider 上有效，跨路由候选剔除。 */
export function isNamespaceModelId(id: string): boolean {
  return id.includes("/") || id.includes("@");
}
