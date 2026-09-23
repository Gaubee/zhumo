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

/** 启动：拉 bootstrap + 恢复会话；匿名允许且无会话时自动匿名（PRODUCT_DESIGN §3）。 */
export async function initAuth(): Promise<void> {
  auth.loading = true;
  auth.error = null;
  try {
    auth.bootstrap = await api.getBootstrap();
    const existing = await api.me();
    if (existing !== null) {
      auth.session = existing;
    } else if (auth.bootstrap.allowAnonymous) {
      auth.session = await api.loginAnonymous();
    }
  } catch (error) {
    auth.error = error instanceof Error ? error.message : String(error);
  } finally {
    auth.loading = false;
  }
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
