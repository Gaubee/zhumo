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

  // 安装门控：needsSetup 且不在 /setup → 强制跳转（PRODUCT_DESIGN §1）。
  $effect(() => {
    if (auth.loading) return;
    if (auth.bootstrap?.needsSetup && router.route.name !== "setup") {
      location.hash = "#/setup";
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
