/**
 * 会话状态（auth store）。
 * 正交意图：[1] 当前会话的加载/持有/登出；[2] 匿名自动登录的判定入口。
 */
import { api } from "$lib/api";
import type { BootstrapInfo, SessionInfo } from "$lib/types";

export const auth = $state({
  session: null as SessionInfo | null,
  bootstrap: null as BootstrapInfo | null,
  loading: true,
  error: null as string | null,
});

/**
 * 启动：拉 bootstrap + 恢复会话；匿名允许且无会话时自动匿名（PRODUCT_DESIGN §3）。
 * quiet（后台刷新）：不翻 loading——实证 2026-09-24：SetupPage createAdmin 后
 * 调本函数，loading=true 令 App 整树卸载重挂，向导表单被重置回步 0（冒泡为
 * 「创建成功但 UI 永远停在管理员账号步」）；仅首次启动用响亮模式。
 */
export async function initAuth(opts: { quiet?: boolean } = {}): Promise<void> {
  if (!opts.quiet) auth.loading = true;
  auth.error = null;
  // W10l：启动自愈——daemon 重启/短暂不在（部署窗口）不再直接死成「启动失败」
  // 死屏（Owner 痛点：daemon 一重启页面就废），退避重试三轮后才报错。
  const attempts = opts.quiet ? 1 : 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      auth.bootstrap = await api.getBootstrap();
      const existing = await api.me();
      if (existing !== null) {
        auth.session = existing;
      } else if (auth.bootstrap.allowAnonymous) {
        auth.session = await api.loginAnonymous();
      }
      break;
    } catch (error) {
      if (attempt === attempts) {
        auth.error = error instanceof Error ? error.message : String(error);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  auth.loading = false;
}

export async function login(username: string, password: string): Promise<boolean> {
  auth.error = null;
  try {
    auth.session = await api.login(username, password);
    return true;
  } catch (error) {
    auth.error = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function loginWithDialog(username: string, password: string): Promise<boolean> {
  return login(username, password);
}

export async function logout(): Promise<void> {
  await api.logout();
  auth.session = null;
  if (auth.bootstrap?.allowAnonymous) auth.session = await api.loginAnonymous();
}
