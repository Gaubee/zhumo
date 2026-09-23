<!--
  /setup 安装向导（PRODUCT_DESIGN §1：仅未配置态可达；三步——管理员账号 /
  准备步骤手风琴 / Models 配置 → 完成跳转）。
  原始需求 [2026-09-23]：步 2 手风琴组两类（命令安装/依赖下载）、嗅探跳过 +
  强制开关、summary 内嵌实时预览；步 3 Models 配置移植组件。
  正交意图：
  1. 三步步进状态机（可回退；完成写标记跳登录/前台）。
  2. 步 1 管理员账号表单（校验中文错误）。
  3. 步 2 PrepStepsAccordion（api.subscribeWizardSteps 驱动实时预览）。
  4. 步 3 ModelsConfig（共用组件）。
-->
<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import ModelsConfig from "$lib/components/models/ModelsConfig.svelte";
  import PrepStepsAccordion from "$lib/components/wizard/PrepStepsAccordion.svelte";
  import { api } from "$lib/api";
  import { initAuth } from "$lib/stores/auth.svelte";
  import type { WizardRunParams, WizardStep } from "$lib/types";
  import { navigate } from "$lib/router.svelte";

  const stepTitles = ["管理员账号", "准备步骤", "大模型服务"] as const;

  // dev 直达（冒烟用）：?step=N 从第 N 步打开。
  let step = $state(Number(new URLSearchParams(location.search).get("step") ?? "0") || 0);
  let username = $state("");
  let password = $state("");
  let password2 = $state("");
  let error = $state<string | null>(null);
  let busy = $state(false);

  let steps = $state<WizardStep[]>([]);
  let runningStep = $state<string | null>(null);

  $effect(() => {
    void refreshSteps();
    const off = api.subscribeWizardSteps(() => void refreshSteps());
    return off;
  });

  async function refreshSteps(): Promise<void> {
    steps = await api.getWizardSteps();
    const running = steps.find((s) => s.status === "running");
    runningStep = running?.id ?? null;
  }

  function validateAdmin(): boolean {
    if (username.trim().length < 2) {
      error = "用户名至少 2 个字符";
      return false;
    }
    if (password.length < 8) {
      error = "密码至少 8 位";
      return false;
    }
    if (password !== password2) {
      error = "两次输入的密码不一致";
      return false;
    }
    return true;
  }

  async function next(): Promise<void> {
    error = null;
    if (step === 0) {
      if (!validateAdmin()) return;
      busy = true;
      try {
        await api.createAdmin(username.trim(), password);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        busy = false;
        return;
      }
      busy = false;
    }
    step += 1;
  }

  async function runStep(id: string, force: boolean, params?: WizardRunParams): Promise<void> {
    runningStep = id;
    try {
      await api.runWizardStep(id, force, params);
    } finally {
      // 真后端无向导推送面：执行完主动刷新（mock 下订阅面也会推一次，双保险）。
      await refreshSteps();
      runningStep = null;
    }
  }

  async function finish(): Promise<void> {
    busy = true;
    try {
      await api.completeSetup();
      // 刷新 bootstrap（needs_setup 已翻转），否则门控会把页面弹回 /setup。
      await initAuth();
      navigate("#/login");
    } finally {
      busy = false;
    }
  }
</script>

<div class="mx-auto flex min-h-screen w-full max-w-2xl flex-col px-4 py-8">
  <header class="mb-6">
    <h1 class="text-xl font-semibold tracking-wide">朱墨 · 安装向导</h1>
    <p class="mt-1 text-xs text-muted-foreground">
      首次部署配置：管理员账号 → 运行环境准备 → 大模型服务。
    </p>
  </header>

  <!-- 步骤指示 -->
  <ol class="mb-6 flex items-center gap-2 text-xs">
    {#each stepTitles as title, index (title)}
      <li class="flex items-center gap-2">
        <span
          class="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-medium {index ===
          step
            ? 'bg-primary text-primary-foreground'
            : index < step
              ? 'bg-primary/15 text-primary'
              : 'bg-muted text-muted-foreground'}"
        >
          {index < step ? "✓" : index + 1}
        </span>
        <span class="{index === step ? 'font-medium text-foreground' : 'text-muted-foreground'}">
          {title}
        </span>
        {#if index < stepTitles.length - 1}
          <span class="mx-1 h-px w-8 bg-border"></span>
        {/if}
      </li>
    {/each}
  </ol>

  <main class="flex-1 rounded-xl border border-border bg-card p-5">
    {#if step === 0}
      <div class="mx-auto flex max-w-sm flex-col gap-3">
        <h2 class="text-sm font-medium">创建管理员账号</h2>
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">用户名</span>
          <Input bind:value={username} placeholder="admin" />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">密码（≥8 位）</span>
          <Input bind:value={password} type="password" />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">确认密码</span>
          <Input bind:value={password2} type="password" />
        </label>
      </div>
    {:else if step === 1}
      <div class="space-y-3">
        <h2 class="text-sm font-medium">准备运行环境</h2>
        <p class="text-xs text-muted-foreground">
          嗅探到已安装的命令与已下载的文件会默认跳过；可展开单项强制重跑。
        </p>
        <PrepStepsAccordion {steps} running={runningStep} onrun={runStep} />
      </div>
    {:else}
      <div class="h-[420px]">
        <ModelsConfig />
      </div>
    {/if}

    {#if error}
      <p class="mt-4 text-xs text-destructive" role="alert">{error}</p>
    {/if}
  </main>

  <footer class="mt-4 flex items-center justify-between">
    <Button variant="ghost" disabled={step === 0 || busy} onclick={() => (step -= 1)}>
      上一步
    </Button>
    {#if step < 2}
      <Button disabled={busy} onclick={() => void next()}>下一步</Button>
    {:else}
      <Button disabled={busy} onclick={() => void finish()}>完成安装</Button>
    {/if}
  </footer>
</div>
