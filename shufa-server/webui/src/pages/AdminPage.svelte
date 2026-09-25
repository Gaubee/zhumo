<!--
  /admin 后台三页（PRODUCT_DESIGN §2：账号管理 / 资源管理 / 设置）。
  原始需求 [2026-09-23]：账号（列表+创建+改密+匿名开关）；资源（W5 实装：
  面包屑资源管理器 + 右键/双击 + 上传 + admin 用户切换）；设置（准备步骤
  手风琴与 Models 配置复用同一套组件 + 管理员改密 + 站点域名）。
  后台改版 + 走查修复 [2026-09-23]：R1——tab 条改 shadcn 惯例侧栏布局
  （aside+nav 手搓，不引新依赖）；BUG4 根因之一是无角色守卫：匿名会话也能
  打开 /admin，全部 RPC 403 而 UI 只剩死按钮——现非 admin 会话直接渲染
  「需要管理员权限」守卫页；R3——设置页站点域名下方展示局域网访问链接
  （admin.settings.lan()，失败静默隐藏）。
  正交意图：
  1. tab 路由（#/admin/accounts|resources|settings）+ 侧栏导航（激活高亮）。
  2. admin 角色守卫（非 admin 渲染权限提示页，可去登录/回前台）。
  3. 账号管理：列表 + 创建 Dialog + 改密 Dialog + 匿名开关。
  4. 资源管理：ResourceManager 组件 + admin 用户根切换下拉。
  5. 设置：PrepStepsAccordion / ModelsConfig / 改密表单 / 站点域名 + 局域网访问。
  朱墨前端改造 [2026-09-24]：
  1. BUG5 账号行操作：禁用/启用（update 直调）+ 删除（ConfirmDialog，文案声明
     数据级联清理且不可恢复）；__anonymous__ 系统账户行隐藏全部入口；禁用行徽章。
  2. BUG1 设置页步骤运行中每 1s 轮询刷新（真后端无推送；结束/卸载即停）。
-->
<script lang="ts">
  import { tick } from "svelte";
  import IconFolder from "@lucide/svelte/icons/folder";
  import IconBookOpen from "@lucide/svelte/icons/book-open";
  import IconLogIn from "@lucide/svelte/icons/log-in";
  import IconSettings from "@lucide/svelte/icons/settings";
  import IconUsers from "@lucide/svelte/icons/users";
  import IconListChecks from "@lucide/svelte/icons/list-checks";
  import IconBrain from "@lucide/svelte/icons/brain";
  import IconShield from "@lucide/svelte/icons/shield";
  import IconMenu from "@lucide/svelte/icons/menu";
  import IconX from "@lucide/svelte/icons/x";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Select from "$lib/components/ui/select";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Switch } from "$lib/components/ui/switch";
  import GithubMark from "$lib/components/brand/GithubMark.svelte";
  import KnowledgeManager from "$lib/components/kb/KnowledgeManager.svelte";
  import ModelsConfig from "$lib/components/models/ModelsConfig.svelte";
  import PrepStepsAccordion from "$lib/components/wizard/PrepStepsAccordion.svelte";
  import ResourceManager from "$lib/components/resources/ResourceManager.svelte";
  import { api } from "$lib/api";
  import { auth } from "$lib/stores/auth.svelte";
  import { navigate, stashReturnTo, type Route } from "$lib/router.svelte";
  import type { AdminSettings, UserInfo, WizardRunParams, WizardStep } from "$lib/types";

  let { tab }: { tab: Route & { name: "admin" } } = $props();

  // ---- 账号管理 ----
  let users = $state<UserInfo[]>([]);
  let createOpen = $state(false);
  let newUsername = $state("");
  let newPassword = $state("");
  let createError = $state<string | null>(null);
  let passwordTarget = $state<UserInfo | null>(null);
  let nextPassword = $state("");
  /** BUG5：待删除账号（ConfirmDialog 目标）。 */
  let deleteTarget = $state<UserInfo | null>(null);
  /** 账号行操作（禁用/删除）的行内错误反馈。 */
  let accountMessage = $state<string | null>(null);
  let busy = $state(false);

  // ---- 资源管理（admin 可切换查看任意用户的根） ----
  let resOwner = $state(auth.session?.username ?? "");

  // ---- 设置 ----
  let settings = $state<AdminSettings | null>(null);
  let wizardSteps = $state<WizardStep[]>([]);
  let runningStep = $state<string | null>(null);
  /** 本地发起且未收尾的运行（轮询期间保持乐观运行态，防止自停）。 */
  let localRun = $state<string | null>(null);
  let oldPassword = $state("");
  let adminNewPassword = $state("");
  let passwordMessage = $state<string | null>(null);
  /** 局域网访问链接（R3/BUG3）：null=加载失败或无链接 → 整块隐藏。 */
  let lanUrls = $state<string[] | null>(null);
  let loadError = $state<string | null>(null);

  const navItems = [
    { id: "accounts", label: "账号管理", icon: IconUsers },
    { id: "resources", label: "资源管理", icon: IconFolder },
    { id: "kb", label: "知识库", icon: IconBookOpen },
    { id: "settings", label: "设置", icon: IconSettings },
  ] as const;

  // ---- 设置页二级导航（Owner 2026-09-25：三个 details 折叠分区改为
  // list-detail——桌面左侧分区导航 + 右侧内容；移动顶部横滑 pill 条。
  // 默认落 models（原「版面让给高频的模型配置」语义由导航默认项承接）。
  // 纯视图状态不进路由，与 details 默认折叠的刷新语义一致） ----
  const settingSections = [
    { id: "models", label: "大模型服务", icon: IconBrain },
    { id: "prep", label: "准备步骤", icon: IconListChecks },
    { id: "site", label: "站点与安全", icon: IconShield },
  ] as const;
  let section = $state<(typeof settingSections)[number]["id"]>("models");

  // ---- 一级导航移动适配（Owner 2026-09-25：aside 固定 w-44 在窄屏挤占内容。
  // 前台 ListDetailPage 同款：桌面常驻侧栏，移动收进左侧 Sheet 抽屉——
  // 顶栏汉堡唤起，选中即收）。 ----
  let desktop = $state(true);
  $effect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => (desktop = mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  });
  let navOpen = $state(false);

  /** 一级导航项点击：路由跳转 + 移动抽屉收起。 */
  function goto(item: (typeof navItems)[number]): void {
    navigate(`#/admin/${item.id}`);
    if (!desktop) navOpen = false;
  }

  const isAdmin = $derived(auth.session?.role === "admin");

  $effect(() => {
    if (isAdmin) void refreshData();
  });

  async function refreshData(): Promise<void> {
    loadError = null;
    try {
      [users, settings, wizardSteps] = await Promise.all([
        api.listUsers(),
        api.updateAdminSettings({}),
        api.getWizardSteps(),
      ]);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
      return;
    }
    // LAN 链接（BUG3）：加载失败静默隐藏该块，不与主数据互相拖垮。
    try {
      lanUrls = await api.getLanUrls();
    } catch {
      lanUrls = null;
    }
  }

  async function createUser(): Promise<void> {
    createError = null;
    if (newUsername.trim().length < 2) {
      createError = "用户名至少 2 个字符";
      return;
    }
    if (newPassword.length < 8) {
      createError = "密码至少 8 位";
      return;
    }
    busy = true;
    try {
      await api.createUser(newUsername.trim(), newPassword, "user");
      users = await api.listUsers();
      createOpen = false;
      newUsername = "";
      newPassword = "";
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function changePassword(): Promise<void> {
    if (passwordTarget === null) return;
    if (nextPassword.length < 8) {
      passwordMessage = "新密码至少 8 位";
      return;
    }
    busy = true;
    try {
      await api.changeUserPassword(passwordTarget.id, nextPassword);
      passwordMessage = null;
      passwordTarget = null;
      nextPassword = "";
    } finally {
      busy = false;
    }
  }

  /** BUG5：禁用/启用（可登录可读、禁止新建任务；daemon 侧同样拦截）。 */
  async function toggleDisabled(user: UserInfo): Promise<void> {
    busy = true;
    accountMessage = null;
    try {
      await api.setUserDisabled(user.id, !user.disabled);
      users = await api.listUsers();
    } catch (e) {
      accountMessage = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /** BUG5：删除账号（数据级联清理：任务、资源与结果页一并移除，不可恢复）。 */
  async function deleteAccount(): Promise<void> {
    if (deleteTarget === null) return;
    busy = true;
    accountMessage = null;
    try {
      await api.deleteUser(deleteTarget.id);
      deleteTarget = null;
      users = await api.listUsers();
    } catch (e) {
      accountMessage = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function toggleAnonymous(allow: boolean): Promise<void> {
    if (settings === null) return;
    settings.allowAnonymous = allow;
    await api.updateAdminSettings({ allowAnonymous: allow });
  }

  async function runStep(id: string, force: boolean, params?: WizardRunParams): Promise<void> {
    runningStep = id;
    localRun = id;
    try {
      await api.runWizardStep(id, force, params);
    } finally {
      // 设置页无步骤推送订阅：轮询 + 收尾主动刷新；localRun 先清再刷新，
      // 运行态交还远端判定（完成 → 轮询自动停表）。finally 保证失败也解锁按钮。
      localRun = null;
      await refreshWizardSteps();
    }
  }

  /** 取消运行中的步骤（走查 2026-09-24）：与 SetupPage.cancelStep 同型。 */
  async function cancelStep(id: string): Promise<void> {
    try {
      await api.cancelWizardStep(id);
    } catch {
      /* 已结束/竞态静默：轮询与 runStep 收尾会把状态带正 */
    } finally {
      await refreshWizardSteps();
    }
  }

  /** BUG1：真后端无推送——运行期间每 1s 轮询；runningStep 清空即停；卸载回收定时器。 */
  async function refreshWizardSteps(): Promise<void> {
    try {
      wizardSteps = await api.getWizardSteps();
    } catch {
      if (localRun === null) runningStep = null;
      return;
    }
    const remote = wizardSteps.find((s) => s.status === "running")?.id ?? null;
    runningStep = localRun ?? remote;
  }

  $effect(() => {
    if (runningStep === null) return;
    const timer = setInterval(() => void refreshWizardSteps(), 1000);
    return () => clearInterval(timer);
  });

  async function saveAdminPassword(): Promise<void> {
    if (adminNewPassword.length < 8) {
      passwordMessage = "新密码至少 8 位";
      return;
    }
    busy = true;
    try {
      await api.changeUserPassword("u-admin", adminNewPassword);
      passwordMessage = null;
      adminNewPassword = "";
      oldPassword = "";
      await tick();
      passwordMessage = "密码已更新";
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex h-screen flex-col bg-paper">
{#snippet primaryNavButtons()}
  {#each navItems as item (item.id)}
    {@const Icon = item.icon}
    {@const active = tab.tab === item.id}
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      class="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors {active
        ? 'bg-accent-soft text-accent-foreground'
        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
      onclick={() => goto(item)}
    >
      <Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
      {item.label}
    </button>
  {/each}
{/snippet}

<header class="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3 md:gap-3 md:px-4">
  {#if !desktop}
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label="打开后台导航"
      onclick={() => (navOpen = true)}
    >
      <IconMenu class="size-4" aria-hidden="true" />
    </Button>
  {/if}
  <img src="/icon.svg" alt="朱墨" class="size-6 shrink-0 rounded-[4px]" />
    <span class="text-sm font-semibold">后台管理</span>
    <span class="flex-1"></span>
    <a
      href="https://github.com/Gaubee/zhumo"
      target="_blank"
      rel="noreferrer"
      class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      title="GitHub 仓库"
      aria-label="GitHub 仓库"
    >
      <GithubMark />
    </a>
    <Button size="sm" variant="outline" onclick={() => navigate("#/")}>返回前台</Button>
  </header>

  {#if !isAdmin}
    <!-- BUG4 根因修复：admin 面板不再对匿名/普通会话裸奔（全部 403 + 死按钮）。 -->
    <div class="flex min-h-0 flex-1 items-center justify-center p-6">
      <div class="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-amber-500/50 bg-card p-6 text-center">
        <p class="text-sm font-medium">需要管理员权限</p>
        <p class="text-xs leading-snug text-muted-foreground">
          当前会话无权访问后台管理。请使用管理员账号登录后再试。
        </p>
        <div class="mt-1 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onclick={() => {
              stashReturnTo();
              navigate("#/login");
            }}
          >
            <IconLogIn data-icon="inline-start" />
            去登录
          </Button>
          <Button size="sm" variant="ghost" onclick={() => navigate("#/")}>返回前台</Button>
        </div>
      </div>
    </div>
  {:else}
    <div class="flex min-h-0 flex-1">
      <!-- R1 侧栏导航（shadcn dashboard 惯例：aside+nav 手搓，激活态 accent 高亮；
           ≥md 常驻，移动收进左侧 Sheet 抽屉（顶栏汉堡唤起，选中即收）。 -->
      <aside class="hidden w-44 shrink-0 flex-col gap-1 border-r border-border bg-card p-2 md:flex">
        <nav class="flex flex-col gap-1" aria-label="后台导航">
          {@render primaryNavButtons()}
        </nav>
      </aside>

      <!-- min-w-0：flex item 默认 min-width:auto 会放行内容固有宽（nowrap
           truncate 的整行文本 min-content）——准备步骤列表在 375px 曾把
           main 撑到 507px（Windows 实测定位）。 -->
      <main class="min-h-0 min-w-0 flex-1">
        {#if loadError !== null}
          <div class="p-4">
            <div class="mx-auto max-w-2xl rounded-md border border-destructive/40 bg-destructive/5 p-4 text-xs text-destructive" role="alert">
              后台数据加载失败：{loadError}
            </div>
          </div>
        {:else if tab.tab === "accounts"}
          <!-- 账号管理 -->
          <div class="h-full overflow-y-auto p-4">
            <div class="mx-auto max-w-2xl space-y-3">
              <div class="flex items-center justify-between">
                <h2 class="text-sm font-medium">账号管理</h2>
                <Button size="sm" onclick={() => (createOpen = true)}>+ 创建用户</Button>
              </div>
              <div class="overflow-hidden rounded-lg border bg-card">
                <!-- 桌面表格 / 移动卡片（Owner 2026-09-25：四列表格固有宽 ~460px，
                     375px 视口必溢出——<md 换卡片列表，字段语义不变）。 -->
                <table class="hidden w-full text-xs md:table">
                  <thead class="border-b bg-muted/40 text-left text-muted-foreground">
                    <tr>
                      <th class="px-3 py-2 font-medium">用户名</th>
                      <th class="px-3 py-2 font-medium">角色</th>
                      <th class="px-3 py-2 font-medium">状态</th>
                      <th class="px-3 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each users as user (user.id)}
                      {@const isSystem = user.role === "anonymous"}
                      <tr class="border-b last:border-b-0">
                        <td class="px-3 py-2">
                          <span class="flex items-center gap-1.5">
                            <span class="font-mono">{user.username}</span>
                            {#if isSystem}
                              <!-- BUG5：内置匿名行——仅标注，不给任何操作入口。 -->
                              <Badge variant="outline" class="shrink-0 text-[10px]">系统账户</Badge>
                            {/if}
                          </span>
                        </td>
                        <td class="px-3 py-2">
                          <Badge variant="secondary" class="text-[10px]">{user.role}</Badge>
                        </td>
                        <td class="px-3 py-2">
                          {#if user.disabled}
                            <Badge variant="destructive" class="text-[10px]">已禁用</Badge>
                          {:else}
                            正常
                          {/if}
                        </td>
                        <td class="px-3 py-2 text-right">
                          {#if isSystem}
                            <span class="text-[11px] text-muted-foreground">—</span>
                          {:else}
                            <span class="inline-flex justify-end gap-1">
                              <Button
                                size="xs"
                                variant="ghost"
                                onclick={() => {
                                  passwordTarget = user;
                                  nextPassword = "";
                                }}
                              >
                                改密
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={busy}
                                onclick={() => void toggleDisabled(user)}
                              >
                                {user.disabled ? "启用" : "禁用"}
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                class="text-destructive"
                                disabled={busy}
                                onclick={() => (deleteTarget = user)}
                              >
                                删除
                              </Button>
                            </span>
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
                <div class="flex flex-col divide-y md:hidden">
                  {#each users as user (user.id)}
                    {@const isSystem = user.role === "anonymous"}
                    <div class="flex flex-col gap-2 p-3">
                      <div class="flex items-center gap-1.5">
                        <span class="min-w-0 flex-1 truncate font-mono text-xs">{user.username}</span>
                        {#if isSystem}
                          <Badge variant="outline" class="shrink-0 text-[10px]">系统账户</Badge>
                        {/if}
                        <Badge variant="secondary" class="shrink-0 text-[10px]">{user.role}</Badge>
                        {#if user.disabled}
                          <Badge variant="destructive" class="shrink-0 text-[10px]">已禁用</Badge>
                        {/if}
                      </div>
                      {#if isSystem}
                        <span class="text-[11px] text-muted-foreground">—</span>
                      {:else}
                        <div class="flex flex-wrap justify-end gap-1">
                          <Button
                            size="xs"
                            variant="ghost"
                            onclick={() => {
                              passwordTarget = user;
                              nextPassword = "";
                            }}
                          >
                            改密
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onclick={() => void toggleDisabled(user)}
                          >
                            {user.disabled ? "启用" : "禁用"}
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            class="text-destructive"
                            disabled={busy}
                            onclick={() => (deleteTarget = user)}
                          >
                            删除
                          </Button>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
              {#if accountMessage}
                <p class="text-xs text-destructive" role="alert">{accountMessage}</p>
              {/if}
              <div class="flex items-center justify-between rounded-lg border bg-card p-3">
                <div>
                  <p class="text-xs font-medium">允许匿名访问</p>
                  <p class="text-[11px] text-muted-foreground">
                    开启后前台自动以内置匿名账号签发 JWT。
                  </p>
                </div>
                <Switch
                  checked={settings?.allowAnonymous ?? false}
                  onCheckedChange={(value) => void toggleAnonymous(value)}
                  aria-label="匿名访问开关"
                />
              </div>
            </div>
          </div>
        {:else if tab.tab === "resources"}
          <!-- 资源管理 -->
          <div class="flex h-full flex-col gap-3 p-4">
            <div class="mx-auto flex w-full max-w-4xl shrink-0 items-center justify-between">
              <h2 class="text-sm font-medium">资源管理</h2>
              {#if auth.session?.role === "admin"}
                <label class="flex items-center gap-2 text-xs text-muted-foreground">
                  查看用户
                  <Select.Root type="single" bind:value={resOwner}>
                    <Select.Trigger class="h-8 w-40 text-xs" aria-label="切换查看的用户">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content class="max-h-64 text-xs">
                      {#each users.filter((user) => !user.disabled && user.role !== "anonymous") as user (user.id)}
                        <Select.Item value={user.username}>{user.username}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </label>
              {/if}
            </div>
            <div class="mx-auto min-h-0 w-full max-w-4xl flex-1">
              <ResourceManager
                owner={resOwner === (auth.session?.username ?? "") ? undefined : resOwner}
              />
            </div>
          </div>
        {:else if tab.tab === "kb"}
          <!-- 知识库（Owner 2026-09-22：两级结构 + git 修订历史 + 5s 轮询实时回填） -->
          <KnowledgeManager />
        {:else}
          <!-- 设置（Owner 2026-09-25：三个 details 折叠分区 → 二级导航 list-detail。
               桌面左分区导航右内容（一级 nav 同款样式）；移动顶部横滑 pill 条。
               滚动所有权按分区分型：models 满高链组件内滚（ModelsConfig 设计语义
               不变），prep/site 页面级滚动。 -->
          <div class="flex h-full min-h-0 flex-col p-4">
            <div class="mx-auto flex min-h-0 w-full max-w-4xl flex-1 gap-4">
              <!-- 桌面：左侧分区导航（与一级 aside nav 同款视觉） -->
              <nav
                class="hidden w-40 shrink-0 flex-col gap-1 self-start rounded-lg border bg-card/60 p-1.5 md:flex"
                aria-label="设置分区"
              >
                {#each settingSections as item (item.id)}
                  {@const Icon = item.icon}
                  {@const active = section === item.id}
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    class="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors {active
                      ? 'bg-accent-soft text-accent-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
                    onclick={() => (section = item.id)}
                  >
                    <Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
                    {item.label}
                  </button>
                {/each}
              </nav>
              <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                <!-- 移动：顶部横滑分区条（窄屏三个分区并列会挤，横滑最稳） -->
                <div class="mb-3 flex gap-1 overflow-x-auto pb-0.5 md:hidden">
                  {#each settingSections as item (item.id)}
                    {@const active = section === item.id}
                    {@const Icon = item.icon}
                    <button
                      type="button"
                      aria-current={active ? "true" : undefined}
                      class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors {active
                        ? 'border-transparent bg-accent-soft text-accent-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
                      onclick={() => (section = item.id)}
                    >
                      <Icon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {item.label}
                    </button>
                  {/each}
                </div>
                {#if section === "models"}
                  <!-- models：满高链交 ModelsConfig 内滚（滚动所有权在其 tab 内容容器） -->
                  <section class="min-h-0 flex-1 rounded-lg border bg-card p-4">
                    <ModelsConfig />
                  </section>
                {:else if section === "prep"}
                  <!-- prep：页面级滚动；PrepStepsAccordion 内部自带步骤 list-detail -->
                  <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
                    <section class="rounded-lg border bg-card p-4">
                      <h2 class="mb-3 text-sm font-medium">准备步骤重跑</h2>
                      <PrepStepsAccordion
                        steps={wizardSteps}
                        running={runningStep}
                        onrun={runStep}
                        oncancel={cancelStep}
                      />
                    </section>
                  </div>
                {:else}
                  <!-- site：页面级滚动 -->
                  <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
                    <section class="rounded-lg border bg-card p-4">
                      <h2 class="mb-3 text-sm font-medium">站点与安全</h2>
                      <div class="space-y-3">
                        <label class="flex flex-col gap-1 text-xs">
                          <span class="text-muted-foreground">站点域名（对外链接拼接基址）</span>
                          <Input
                            class="h-8 max-w-sm font-mono text-xs"
                            value={settings?.siteBaseUrl ?? ""}
                            onchange={(event) => {
                              if (settings) settings.siteBaseUrl = event.currentTarget.value;
                              void api.updateAdminSettings({ siteBaseUrl: event.currentTarget.value });
                            }}
                          />
                        </label>
                        {#if lanUrls !== null && lanUrls.length > 0}
                          <!-- R3/BUG3：局域网访问链接（加载失败时整块隐藏，不报错弹脸） -->
                          <div class="flex max-w-sm flex-col gap-1.5 border-t border-border pt-3">
                            <span class="text-xs font-medium">局域网访问</span>
                            <p class="text-[11px] leading-snug text-muted-foreground">
                              同一局域网内的设备可通过以下地址访问本站；防火墙放行后生效。
                            </p>
                            <div class="flex flex-col gap-0.5">
                              {#each lanUrls as url (url)}
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noreferrer"
                                  class="w-fit font-mono text-xs text-primary underline-offset-2 hover:underline"
                                >
                                  {url}
                                </a>
                              {/each}
                            </div>
                          </div>
                        {/if}
                        <div class="flex max-w-sm flex-col gap-2 border-t border-border pt-3">
                          <span class="text-xs font-medium">管理员改密</span>
                          <Input
                            bind:value={oldPassword}
                            type="password"
                            placeholder="原密码"
                            class="h-8 text-xs"
                          />
                          <Input
                            bind:value={adminNewPassword}
                            type="password"
                            placeholder="新密码（≥8 位）"
                            class="h-8 text-xs"
                          />
                          <div class="flex items-center gap-3">
                            <Button size="sm" disabled={busy} onclick={() => void saveAdminPassword()}>
                              更新密码
                            </Button>
                            {#if passwordMessage}
                              <span class="text-[11px] text-muted-foreground">{passwordMessage}</span>
                            {/if}
                          </div>
                        </div>
                      </div>
                    </section>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </main>
    </div>

    <!-- 移动一级导航抽屉（与前台任务列表同款：左抽屉 + 标题行内关闭）。 -->
    <Sheet.Root bind:open={navOpen}>
      <Sheet.Content side="left" class="w-60 gap-0 p-0" hideClose>
        <Sheet.Header class="flex-row items-center justify-between border-b px-3 py-2">
          <Sheet.Title class="text-xs font-medium text-muted-foreground">后台导航</Sheet.Title>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="关闭导航"
            onclick={() => (navOpen = false)}
          >
            <IconX class="size-4" aria-hidden="true" />
          </Button>
        </Sheet.Header>
        <nav class="flex flex-col gap-1 p-2" aria-label="后台导航（移动）">
          {@render primaryNavButtons()}
        </nav>
      </Sheet.Content>
    </Sheet.Root>
  {/if}
</div>

<!-- 创建用户 / 改密 Dialog -->
<Dialog.Root bind:open={createOpen}>
  <Dialog.Content class="max-w-sm p-5">
    <Dialog.Title class="text-sm font-medium">创建用户</Dialog.Title>
    <Dialog.Description class="mt-1 text-[11px] text-muted-foreground">
      本站不开放注册，仅管理员创建。
    </Dialog.Description>
    <div class="mt-3 flex flex-col gap-2">
      <Input bind:value={newUsername} placeholder="用户名" class="h-8 text-xs" />
      <Input bind:value={newPassword} type="password" placeholder="密码（≥8 位）" class="h-8 text-xs" />
      {#if createError}
        <p class="text-xs text-destructive">{createError}</p>
      {/if}
    </div>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (createOpen = false)}>取消</Button>
      <Button size="sm" disabled={busy} onclick={() => void createUser()}>创建</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={passwordTarget !== null}
  onOpenChange={(open) => {
    if (!open) passwordTarget = null;
  }}
>
  <Dialog.Content class="max-w-sm p-5">
    <Dialog.Title class="text-sm font-medium">修改密码 · {passwordTarget?.username ?? ""}</Dialog.Title>
    <div class="mt-3 flex flex-col gap-2">
      <Input bind:value={nextPassword} type="password" placeholder="新密码（≥8 位）" class="h-8 text-xs" />
    </div>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (passwordTarget = null)}>取消</Button>
      <Button size="sm" disabled={busy} onclick={() => void changePassword()}>确认</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- BUG5：删除账号确认（数据级联清理警示，不可恢复）。 -->
<Dialog.Root
  open={deleteTarget !== null}
  onOpenChange={(open) => {
    if (!open) deleteTarget = null;
  }}
>
  <Dialog.Content class="max-w-sm p-5">
    <Dialog.Title class="text-sm font-medium">删除账号 · {deleteTarget?.username ?? ""}</Dialog.Title>
    <Dialog.Description class="mt-1 text-[11px] leading-snug text-destructive">
      删除将清理该账号的全部数据（任务、资源与结果页）且不可恢复。
    </Dialog.Description>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (deleteTarget = null)}>取消</Button>
      <Button variant="destructive" size="sm" disabled={busy} onclick={() => void deleteAccount()}>
        确认删除
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
