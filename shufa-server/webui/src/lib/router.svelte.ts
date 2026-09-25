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
  | { name: "home"; taskId: string | null; composer: boolean }
  | { name: "admin"; tab: "accounts" | "resources" | "settings" | "kb" }
  | { name: "result"; publicId: string };

const ADMIN_TABS = ["accounts", "resources", "settings", "kb"] as const;

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
  // 会话锚定（2026-09-25 路由优化）：#/t/{id} 打开指定会话（刷新/回退/分享
  // 可恢复），#/new = 新建态；#/ 保持原语义 = 默认进最新会话。
  if (segments[0] === "t") {
    const taskId = segments[1] ?? "";
    if (taskId.length > 0) return { name: "home", taskId, composer: false };
  }
  if (segments[0] === "new") return { name: "home", taskId: null, composer: true };
  return { name: "home", taskId: null, composer: false };
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
    case "home":
      if (route.composer) return "#/new";
      return route.taskId !== null ? `#/t/${route.taskId}` : "#/";
    default:
      return "#/";
  }
}

/** 登录回跳（2026-09-25 会话锚定配套）：守卫卡进登录前记下来处 hash。 */
export function stashReturnTo(): void {
  if (location.hash === "" || location.hash === "#/login") return;
  try {
    sessionStorage.setItem("zhumo:return-to", location.hash);
  } catch {
    // 隐私模式等存储不可用：静默降级为登录后回 #/。
  }
}

/** 登录成功后取回来处（一次性消费；无记录/无效值回默认首页）。 */
export function consumeReturnTo(): string {
  let to: string | null = null;
  try {
    to = sessionStorage.getItem("zhumo:return-to");
    sessionStorage.removeItem("zhumo:return-to");
  } catch {
    to = null;
  }
  return to !== null && to !== "" && to !== "#/login" ? to : "#/";
}
