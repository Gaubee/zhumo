/**
 * hash 路由（自研轻路由；选型：纯 Vite SPA + hash——daemon 静态托管零配置、
 * 无 SvelteKit adapter 复杂度，/r/{publicId} 深链由 hash 承载）。
 * 原始需求 [2026-09-23]：朱墨 W3 路由选型自定并说明理由。
 * 正交意图：
 *   [1] 解析 location.hash → Route 判别联合（setup/login/home/admin/result）。
 *   [2] navigate() + hashchange 订阅（Svelte 5 $state 单例）。
 */
export type Route =
  | { name: "setup" }
  | { name: "login" }
  | { name: "home" }
  | { name: "admin"; tab: "accounts" | "resources" | "settings" }
  | { name: "result"; publicId: string };

const ADMIN_TABS = ["accounts", "resources", "settings"] as const;

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "/";
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments[0] === "setup") return { name: "setup" };
  if (segments[0] === "login") return { name: "login" };
  if (segments[0] === "r") {
    const publicId = segments[1] ?? "";
    if (publicId.length > 0) return { name: "result", publicId };
  }
  if (segments[0] === "admin") {
    const tab = segments[1];
    if (tab !== undefined && (ADMIN_TABS as readonly string[]).includes(tab)) {
      return { name: "admin", tab: tab as (typeof ADMIN_TABS)[number] };
    }
    return { name: "admin", tab: "accounts" };
  }
  return { name: "home" };
}

/** 结果页深链（§3 /r/{public_id} 独立分享）：daemon SPA 回退使任意 path 都落到
 * index.html；hash 为空且 pathname 形如 /r/{id} 时按结果路由解析。 */
function parseResultPath(): Route | null {
  const match = /^\/r\/([^/]+)\/?$/.exec(location.pathname);
  if (!match) return null;
  const publicId = decodeURIComponent(match[1] ?? "");
  if (publicId.length === 0) return null;
  return { name: "result", publicId };
}

function currentRoute(): Route {
  const route = parseHash(location.hash);
  if (route.name === "home") {
    return parseResultPath() ?? route;
  }
  return route;
}

/** 当前路由（响应式单例）。 */
export const router = $state<{ route: Route }>({ route: currentRoute() });

/** 编程导航（hash 变更驱动重渲染）。 */
export function navigate(to: string): void {
  location.hash = to;
}

let listening = false;

export function startRouter(): void {
  if (listening) return;
  listening = true;
  const sync = (): void => {
    router.route = currentRoute();
  };
  window.addEventListener("hashchange", sync);
  window.addEventListener("popstate", sync);
  sync();
}

/** Route → 推荐分享/回跳 hash。 */
export function routeHash(route: Route): string {
  switch (route.name) {
    case "setup":
      return "#/setup";
    case "login":
      return "#/login";
    case "admin":
      return `#/admin/${route.tab}`;
    case "result":
      return `#/r/${route.publicId}`;
    default:
      return "#/";
  }
}
