<!--
  应用根：bootstrap 门控 + hash 路由出口。
  原始需求 [2026-09-23]：朱墨 W3——needs_setup 强制进 /setup；匿名开时前台
  自动匿名 JWT；路由 /setup /login / /admin /r/{publicId}。
  正交意图：
  1. 启动序列（startRouter + initAuth）与全屏加载/错误态。
  2. 安装门控（bootstrap.needsSetup → 强制 /setup，除 /setup 本身）。
  3. 路由分发到五个页面。
-->
<script lang="ts">
  import Toaster from "$lib/components/ui/toast/Toaster.svelte";
  import { onMount } from "svelte";
  import AdminPage from "$pages/AdminPage.svelte";
  import ListDetailPage from "$pages/ListDetailPage.svelte";
  import LoginPage from "$pages/LoginPage.svelte";
  import ResultPage from "$pages/ResultPage.svelte";
  import SetupPage from "$pages/SetupPage.svelte";
  import { auth, initAuth } from "$lib/stores/auth.svelte";
  import { router, startRouter } from "$lib/router.svelte";

  onMount(() => {
    startRouter();
    void initAuth();
  });

  // 安装门控：needsSetup 且不在 /setup → 强制跳转（PRODUCT_DESIGN §1）；
  // 反向：安装已完成（setup_completed，非 needs_setup——后者建管理员即翻 false）
  // 再进 /setup 属残废向导（无会话凭证步 2 必败）→ 弹去登录。
  $effect(() => {
    if (auth.loading) return;
    const name = router.route.name;
    if (auth.bootstrap?.needsSetup && name !== "setup") {
      location.hash = "#/setup";
    } else if (auth.bootstrap?.setupCompleted && name === "setup") {
      location.hash = "#/login";
    }
  });
</script>

{#if auth.loading}
  <div class="flex min-h-screen items-center justify-center bg-paper">
    <p class="text-xs text-muted-foreground">正在启动朱墨…</p>
  </div>
{:else if auth.error}
  <div class="flex min-h-screen items-center justify-center bg-paper">
    <p class="text-xs text-destructive" role="alert">启动失败：{auth.error}</p>
  </div>
{:else}
  {#snippet routeView()}
    {#if router.route.name === "setup"}
      <SetupPage />
    {:else if router.route.name === "login"}
      <LoginPage />
    {:else if router.route.name === "admin"}
      <AdminPage tab={router.route} />
    {:else if router.route.name === "result"}
      <ResultPage publicId={router.route.publicId} />
    {:else}
      <ListDetailPage />
    {/if}
  {/snippet}
  {@render routeView()}
{/if}
<Toaster />
