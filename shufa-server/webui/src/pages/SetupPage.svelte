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
  朱墨前端改造 [2026-09-24]：
  1. BUG2 有状态向导：bootstrap.setup_progress 推导初始步（挂载一次 + bootstrap
     变化时重推）；localStorage(zhumo.setupStep) 记住手动所在步（服务端推导优先）。
  2. BUG2 步 1 增「允许匿名访问」开关（默认关，随 createAdmin 提交）。
  3. BUG1 步骤运行中每 1s 轮询 getWizardSteps 刷新（真后端无推送；结束/卸载即停）。
-->
<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Switch } from "$lib/components/ui/switch";
  import ModelsConfig from "$lib/components/models/ModelsConfig.svelte";
  import PrepStepsAccordion from "$lib/components/wizard/PrepStepsAccordion.svelte";
  import { api } from "$lib/api";
  import { auth, initAuth } from "$lib/stores/auth.svelte";
  import type { SetupProgress, WizardRunParams, WizardStep } from "$lib/types";
  import { navigate } from "$lib/router.svelte";

  const stepTitles = ["管理员账号", "准备步骤", "大模型服务"] as const;

  /** BUG2：手动所在步记忆键（浏览器内体验优化；服务端推导优先）。 */
  const SETUP_STEP_KEY = "zhumo.setupStep";

  // dev 直达（冒烟用）：?step=N 从第 N 步打开（优先于服务端推导）。
  const devStepParam = new URLSearchParams(location.search).get("step");
  let step = $state(Number(devStepParam ?? "0") || 0);
  let username = $state("");
  let password = $state("");
  let password2 = $state("");
  /** BUG2：「允许匿名访问」开关（默认关——关闭后访问需要登录）。 */
  let allowAnonymous = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);

  let steps = $state<WizardStep[]>([]);
  /** 展示用运行态：本地乐观值优先，远端 running 兜底（页面打开即有运行中步骤）。 */
  let runningStep = $state<string | null>(null);
  /** 本地发起且未收尾的运行（避免轮询把刚提交、远端尚未标 running 的步骤清空）。 */
  let localRun = $state<string | null>(null);

  /**
   * BUG2 服务端推导：!admin_created → 0（管理员账号）；
   * admin_created && steps_done < steps_total → 1（准备步骤）；
   * 步骤齐 → 2（大模型服务；全部就绪也停在此显示完成态）。
   */
  function deriveServerStep(progress: SetupProgress | null): number | null {
    if (progress === null) return null;
    if (!progress.admin_created) return 0;
    if (progress.steps_done < progress.steps_total) return 1;
    return 2;
  }

  /** 挂载时 + bootstrap 变化时重推步位置。服务端硬门槛：管理员未建一律步 0；
   *  已建则沿用手动记忆（localStorage），无记忆才落服务端推导（记忆即「用户手动
   *  所在步」的恢复，服务端推导优先于无记忆默认）。 */
  function applySetupProgress(): void {
    if (devStepParam !== null) return; // 冒烟直达优先
    const progress = auth.bootstrap?.setupProgress ?? null;
    if (progress === null) return; // 旧 daemon 未带字段 → 保持自由步进
    if (!progress.admin_created) {
      gotoStep(0);
      return;
    }
    const raw = localStorage.getItem(SETUP_STEP_KEY);
    const stored = raw === null ? Number.NaN : Number(raw); // Number(null)=0，须显式排除缺键。
    const remembered = Number.isInteger(stored) && stored >= 0 && stored <= 2 ? stored : null;
    if (remembered !== null) {
      step = remembered;
      return;
    }
    step = deriveServerStep(progress) ?? step;
  }

  applySetupProgress();

  // createAdmin / completeSetup 后 initAuth 刷新 bootstrap → 此处重推步位置。
  $effect(() => {
    void auth.bootstrap?.setupProgress;
    applySetupProgress();
  });

  /** 手动步进（上一步/下一步）统一入口：写 localStorage 记忆。 */
  function gotoStep(next: number): void {
    step = next;
    if (devStepParam === null) localStorage.setItem(SETUP_STEP_KEY, String(next));
  }

  async function refreshSteps(): Promise<void> {
    let fresh: WizardStep[];
    try {
      fresh = await api.getWizardSteps();
    } catch {
      // 未登录/无权限（建管理员前无 token 属正常态）不打断向导；本地无运行则解锁。
      if (localRun === null) runningStep = null;
      return;
    }
    steps = fresh;
    const remote = steps.find((s) => s.status === "running")?.id ?? null;
    runningStep = localRun ?? remote;
  }

  $effect(() => {
    void refreshSteps();
    const off = api.subscribeWizardSteps(() => void refreshSteps());
    return off;
  });

  // BUG1：真后端无推送——运行期间每 1s 轮询刷新；runningStep 清空（步骤完成）
  // 即自动停表；组件卸载由 effect 清理函数回收定时器。
  $effect(() => {
    if (runningStep === null) return;
    const timer = setInterval(() => void refreshSteps(), 1000);
    return () => clearInterval(timer);
  });

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
    const from = step; // createAdmin 后推导 effect 会改写 step，目标步以进入时为准。
    if (from === 0) {
      if (!validateAdmin()) return;
      busy = true;
      try {
        await api.createAdmin(username.trim(), password, allowAnonymous);
        // 刷新 bootstrap（setup_progress.admin_created 翻转）→ 推导 effect 落到步 1。
        await initAuth();
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        busy = false;
        return;
      }
      busy = false;
    }
    gotoStep(from + 1);
  }

  async function runStep(id: string, force: boolean, params?: WizardRunParams): Promise<void> {
    runningStep = id;
    localRun = id;
    try {
      await api.runWizardStep(id, force, params);
    } finally {
      // 真后端无向导推送面：收尾主动刷新（mock 下订阅面也会推，双保险）；
      // localRun 先清再刷新，运行态交还远端判定（完成 → 轮询自动停表）。
      localRun = null;
      await refreshSteps();
    }
  }

  async function finish(): Promise<void> {
    busy = true;
    try {
      await api.completeSetup();
      localStorage.removeItem(SETUP_STEP_KEY); // 向导走完，清除手动步记忆。
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
        <!-- BUG2：允许匿名访问（默认关=安全默认；随 createAdmin 提交）。 -->
        <label class="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
          <span class="flex flex-col gap-0.5">
            <span class="text-xs font-medium">允许匿名访问</span>
            <span class="text-[11px] text-muted-foreground">关闭后访问需要登录</span>
          </span>
          <Switch bind:checked={allowAnonymous} aria-label="允许匿名访问" />
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
    <Button variant="ghost" disabled={step === 0 || busy} onclick={() => gotoStep(step - 1)}>
      上一步
    </Button>
    {#if step < 2}
      <Button disabled={busy} onclick={() => void next()}>
        {busy ? (step === 0 ? "创建中…" : "处理中…") : "下一步"}
      </Button>
    {:else}
      <Button disabled={busy} onclick={() => void finish()}>完成安装</Button>
    {/if}
  </footer>
</div>
