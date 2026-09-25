<!--
  / 前台 list-detail（PRODUCT_DESIGN §3）。
  布局改版（Owner 2026-09-25）：
  1. 桌面（≥md）：三栏 Resizable（shadcn resizable / paneforge）——任务列表 | 对话 |
     任务详情（TaskDetailPanel 标签页），两根分隔条可拖拽，autoSaveId 记忆比例。
  2. 移动（<md）：对话全宽；任务列表与任务详情收纳为 Sheet 抽屉（顶栏汉堡 +
     详情按钮唤起）。
  3. 任务列表/对话栏以 snippet 复用（桌面 Pane 与移动 Sheet 共享同一份标记，
     单实例不双挂 Composer）。
  历史注：新建入口在 detail 面板（未选中 = TaskComposer）；未登录守卫卡。
-->
<script lang="ts">
  import IconListTodo from "@lucide/svelte/icons/list-todo";
  import IconLogIn from "@lucide/svelte/icons/log-in";
  import IconPanelRight from "@lucide/svelte/icons/panel-right";
  import IconX from "@lucide/svelte/icons/x";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Pane, PaneGroup, Handle } from "$lib/components/ui/resizable";
  import GithubMark from "$lib/components/brand/GithubMark.svelte";
  import ComposerCard from "$lib/components/agent/ComposerCard.svelte";
  import TaskComposer from "$lib/components/agent/TaskComposer.svelte";
  import TaskDetailPanel from "$lib/components/agent/TaskDetailPanel.svelte";
  import TranscriptView from "$lib/components/agent/TranscriptView.svelte";
  import { auth } from "$lib/stores/auth.svelte";
  import {
    cancelQueueEdit,
    confirmQueueEdit,
    editQueueItem,
    getSelectedTask,
    lastUsage,
    loadTasks,
    projectFrames,
    queue,
    refreshQueue,
    removeQueueItem,
    reorderQueue,
    selectTask,
    sendPrompt,
    sendQueueNow,
    setQueueItemLocked,
    setQueueItemMode,
    setQueueReordering,
    stopPrompt,
    tasks,
  } from "$lib/stores/tasks.svelte";
  import QueueDrawer from "$lib/components/agent/QueueDrawer.svelte";
  import { navigate, router, stashReturnTo } from "$lib/router.svelte";
  import { onMount } from "svelte";
  import { api } from "$lib/api";
  import type { AvailableModel } from "$lib/types";

  const statusLabel: Record<string, string> = {
    queued: "排队中",
    running: "进行中",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };

  /** 桌面/移动切换（md 768px）：桌面走三栏 PaneGroup，移动走全宽 + 抽屉。 */
  let desktop = $state(true);
  $effect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => (desktop = mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  });

  /** 移动抽屉开关。 */
  let listOpen = $state(false);
  let detailOpen = $state(false);

  onMount(() => {
    // 未登录（匿名关闭）不拉任务面——守卫卡呈现，避免 401 噪音。
    if (auth.session !== null) void loadTasks();
  });

  // 可用模型（走查 R6：对话中模型 chip；拉取失败静默隐藏 chip）。
  let availableModels = $state<AvailableModel[] | null>(null);
  let availableDefault = $state<{ provider: string; model: string } | null>(null);
  onMount(async () => {
    if (auth.session === null) return;
    try {
      const out = await api.getAvailableModels();
      availableModels = out.models;
      availableDefault = out.default;
    } catch {
      availableModels = null;
    }
  });

  /** 聊天中切换模型/档位（走查 R6 + 2026-09-25 effort）：热切会话；失败内联呈现。 */
  async function setModel(provider: string, model: string, effort?: string | null): Promise<void> {
    if (selected === null) return;
    try {
      const updated = await api.setTaskModel(selected.id, provider, model, effort);
      tasks.list = tasks.list.map((t) => (t.id === updated.id ? updated : t));
    } catch (e) {
      tasks.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** 活动模型（任务覆盖 ?? 后台默认）在可用清单中的条目（efforts/窗口数据源）。 */
  const activeAvailable = $derived.by(() => {
    const current =
      selected?.modelProvider !== null && selected?.modelModel !== null && selected !== null
        ? { provider: selected.modelProvider, model: selected.modelModel }
        : availableDefault;
    if (current === null) return null;
    return (
      availableModels?.find(
        (m) => m.provider === current.provider && m.model === current.model,
      ) ?? null
    );
  });
  const lastUsageView = $derived(lastUsage());

  const selected = $derived(getSelectedTask());
  const items = $derived(projectFrames(tasks.frames));
  const detailRunning = $derived(selected?.status === "running" || tasks.sending);

  // ----------------------------- 队列面板协调（W10b，Owner 设计 2026-09-27）

  /** composer 引用：进入编辑前校验输入框无未发送内容（有则拒绝编辑模式）。 */
  let composerRef = $state<({ draftLength: () => number } | null)>(null);
  /** 进入编辑时回填的文本（null=非编辑；变化触发 ComposerCard 填充）。 */
  let editingDraft = $state<string | null>(null);

  async function beginQueueEdit(messageId: string): Promise<void> {
    if (composerRef !== null && composerRef.draftLength() > 0) {
      tasks.error = "输入框有未发送内容，清空后再编辑队列消息";
      return;
    }
    const text = await editQueueItem(messageId);
    if (text !== null) editingDraft = text;
  }

  // 选中任务变化 → 队列视图跟随（帧驱动的刷新在 store 内）。
  $effect(() => {
    if (tasks.selectedId !== null && selected !== undefined) void refreshQueue();
  });

  // URL ↔ 会话同步（2026-09-25 路由锚定）：选中由路由派生——刷新/回退/深链
  // #/t/{id} 恢复该会话；#/new = 新建态；#/ = 默认最新会话。UI 侧选择已同步
  // 写过 hash，这里只处理 mismatch（回退键、直达 URL、URL 指向已删任务）。
  $effect(() => {
    const route = router.route;
    if (route.name !== "home" || tasks.loading) return;
    if (route.composer) {
      if (tasks.selectedId !== null) {
        tasks.selectedId = null;
        tasks.frames = [];
        tasks.results = [];
      }
      return;
    }
    const wanted = route.taskId ?? tasks.list[0]?.id ?? null;
    if (wanted === null || wanted === tasks.selectedId) return;
    if (!tasks.list.some((t) => t.id === wanted)) {
      if (route.taskId !== null) navigate("#/");
      return;
    }
    void selectTask(wanted);
  });

  // 标签页标题跟随当前会话（URL 之外的第二处「我在哪个会话」提示）。
  $effect(() => {
    document.title = selected === null ? "朱墨" : `${selected.title} · 朱墨`;
  });

  function timeLabel(iso: string): string {
    const date = new Date(iso);
    return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  /** 关闭当前详情，回到 detail 面板的新建态（走查：新建入口在 detail 面板）。 */
  function openComposer(): void {
    tasks.selectedId = null;
    tasks.frames = [];
    tasks.results = [];
    navigate("#/new");
  }

  /** 选中会话并锚定 URL（#/t/{id}）：刷新/回退/分享都回到同一会话。 */
  function openTask(taskId: string): void {
    void selectTask(taskId);
    navigate(`#/t/${taskId}`);
  }

  /** 移动抽屉内选任务：选中即收抽屉。 */
  function pickTask(taskId: string): void {
    openTask(taskId);
    listOpen = false;
  }
</script>

{#snippet taskListColumn()}
  <!-- 纯列表区：标题条由桌面栏与移动抽屉各自持有（移动走查 2026-09-25：
       snippet 自带标题时抽屉里出现两个「任务列表」）。 -->
  <div class="min-h-0 flex-1 overflow-y-auto bg-card/60 p-2">
      {#each tasks.list as task (task.id)}
        <button
          type="button"
          class="mb-1 w-full rounded-lg px-2.5 py-2 text-left transition-colors {tasks.selectedId ===
          task.id
            ? 'bg-accent-soft'
            : 'hover:bg-muted/60'}"
          onclick={() => (desktop ? openTask(task.id) : pickTask(task.id))}
        >
          <span class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate text-xs font-medium">{task.title}</span>
            {#if task.status === "running" || task.status === "queued"}
              <Badge class="shrink-0 text-[9px]">进行中</Badge>
            {:else if task.status === "failed"}
              <Badge variant="destructive" class="shrink-0 text-[9px]">失败</Badge>
            {/if}
          </span>
          <span class="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span class="truncate">{task.videoName}</span>
            <span class="shrink-0">{timeLabel(task.createdAt)}</span>
          </span>
        </button>
      {/each}
      {#if tasks.list.length === 0 && !tasks.loading}
        <p class="p-4 text-center text-xs text-muted-foreground">
          还没有任务<br />创建第一个分析任务
        </p>
      {/if}
    </div>
{/snippet}

{#snippet listTitlebar(onNew: () => void)}
  <div class="flex shrink-0 items-center justify-between border-b border-border bg-card/60 px-3 py-2">
    <span class="text-xs font-medium text-muted-foreground">任务列表</span>
    <Button size="xs" variant="ghost" onclick={onNew}>+ 新建</Button>
  </div>
{/snippet}

{#snippet chatColumn()}
  <div class="flex h-full min-h-0 flex-col">
    {#if selected}
      <div class="flex items-center gap-3 border-b border-border px-4 py-2">
        <h2 class="min-w-0 flex-1 truncate text-sm font-medium">{selected.title}</h2>
        <Badge variant="outline" class="text-[10px]">
          {statusLabel[selected.status] ?? selected.status}
        </Badge>
        <Button size="sm" variant="outline" class="md:hidden" onclick={() => (detailOpen = true)}>
          <IconPanelRight data-icon="inline-start" />
          面板
        </Button>
      </div>
      {#if selected.status === "failed"}
        <!-- 失败摘要行（走查 R3：库内 error 是兜底真源）。 -->
        <div
          class="flex items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-1.5"
          role="alert"
        >
          <span class="mt-px shrink-0 text-[11px] font-medium text-destructive">失败原因</span>
          <span class="min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-all text-destructive/90">
            {selected.error ?? "未知错误（无详情记录——可在对话中重发触发重试）"}
          </span>
        </div>
      {/if}
      <TranscriptView {items} running={detailRunning} />
      <div class="border-t border-border p-3">
        <!-- W10c 队列抽屉：输入面板上方长出的手风琴（收起=预览，展开=列表+
             拖动排序）；选中任务变化或帧到达由 store 刷新（编辑/拖动期暂停）。 -->
        <QueueDrawer
          items={queue.items}
          editing={queue.editing}
          locked={queue.locked}
          reordering={queue.reordering}
          onedit={(messageId) => void beginQueueEdit(messageId)}
          oncancel={() => void cancelQueueEdit()}
          onremove={(messageId) => void removeQueueItem(messageId)}
          onsetmode={(messageId, mode) => void setQueueItemMode(messageId, mode)}
          onsetlocked={(messageId, lock) => setQueueItemLocked(messageId, lock)}
          onreorder={(orderedIds) => void reorderQueue(orderedIds)}
          onreordering={(v) => setQueueReordering(v)}
          onsendnow={(messageId) => void sendQueueNow(messageId)}
        />
        <ComposerCard
          bind:this={composerRef}
          onsend={(text) => void sendPrompt(text)}
          onstop={() => void stopPrompt()}
          editingActive={queue.editing !== null}
          editingDraft={editingDraft}
          onconfirmedit={(text) => void confirmQueueEdit(text)}
          oncanceledit={() => void cancelQueueEdit()}
          sending={tasks.sending}
          videoName={selected.videoName}
          models={availableModels}
          defaultModel={availableDefault}
          currentModel={selected.modelProvider !== null && selected.modelModel !== null
            ? { provider: selected.modelProvider, model: selected.modelModel }
            : null}
          currentEffort={selected.modelEffort}
          running={selected.status === "running" || selected.status === "queued"}
          usage={lastUsageView}
          capacity={activeAvailable?.contextWindow ?? null}
          onsetmodel={(provider, model) => void setModel(provider, model)}
          onseteffort={
            activeAvailable !== null
              ? (effort) =>
                  void setModel(
                    activeAvailable.provider,
                    activeAvailable.model,
                    effort,
                  )
              : undefined
          }
        />
      </div>
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto">
        <TaskComposer />
      </div>
    {/if}
  </div>
{/snippet}

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && detailOpen) detailOpen = false;
  }}
/>

<div class="flex h-screen flex-col bg-paper">
  <!-- 顶栏 -->
  <header class="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-3 md:px-4">
    {#if !desktop}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="打开任务列表"
        onclick={() => (listOpen = true)}
      >
        <IconListTodo class="size-4" aria-hidden="true" />
      </Button>
    {/if}
    <img src="/icon.svg" alt="朱墨" class="size-6 shrink-0 rounded-[4px]" />
    <span class="text-sm font-semibold tracking-wide">朱墨</span>
    <span class="hidden text-[11px] text-muted-foreground md:inline">书法视频 · agent 分析工作台</span>
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
    {#if auth.session}
      <span class="text-[11px] text-muted-foreground">
        {auth.session.role === "anonymous" ? "匿名用户" : auth.session.username}
      </span>
    {/if}
    {#if auth.session?.role === "admin"}
      <Button size="sm" variant="outline" onclick={() => navigate("#/admin/accounts")}>
        进入后台
      </Button>
    {/if}
  </header>

  {#if auth.session === null}
    <!-- 匿名默认关闭：未登录守卫卡（AdminPage 权限守卫同语法）。 -->
    <div class="flex min-h-0 flex-1 items-center justify-center p-6">
      <div
        class="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-amber-500/50 bg-card p-6 text-center"
      >
        <p class="text-sm font-medium">请先登录</p>
        <p class="text-xs leading-snug text-muted-foreground">
          本站未开启匿名访问，登录后即可查看与创建书法分析任务。
        </p>
        <Button
          size="sm"
          class="mt-1"
          onclick={() => {
            stashReturnTo();
            navigate("#/login");
          }}
        >
          <IconLogIn data-icon="inline-start" />
          去登录
        </Button>
      </div>
    </div>
  {:else if desktop}
    <!-- 桌面：三栏可拖拽（任务列表 | 对话 | 任务详情） -->
    <PaneGroup direction="horizontal" autoSaveId="zhumo-home-panes" class="min-h-0 flex-1">
      <Pane defaultSize={18} minSize={10} class="min-w-44">
        <div class="flex h-full min-h-0 flex-col">
          {@render listTitlebar(openComposer)}
          {@render taskListColumn()}
        </div>
      </Pane>
      <Handle />
      <Pane minSize={26}>
        {@render chatColumn()}
      </Pane>
      {#if selected}
        <Handle />
        <Pane defaultSize={32} minSize={18} class="min-w-72">
          <TaskDetailPanel task={selected} results={tasks.results} running={detailRunning} />
        </Pane>
      {/if}
    </PaneGroup>
  {:else}
    <!-- 移动：对话全宽；任务列表走 Sheet（无状态可卸载）；任务面板长驻
         （transform 滑入滑出、永不卸载——视频进度/iframe 状态跨开关保留）。 -->
    <main class="min-h-0 flex-1">
      {@render chatColumn()}
    </main>

    {#if selected}
      <div
        class="fixed inset-y-0 end-0 z-50 flex w-[92%] max-w-md flex-col border-s bg-background shadow-xl transition-transform duration-300 {detailOpen
          ? "translate-x-0"
          : "pointer-events-none translate-x-full"}"
        aria-hidden={detailOpen ? undefined : "true"}
        aria-label="任务面板"
        role="region"
      >
        <div class="min-h-0 flex-1">
          <TaskDetailPanel task={selected} results={tasks.results} running={detailRunning}>
            {#snippet action()}
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="关闭面板"
                onclick={() => (detailOpen = false)}
              >
                <IconX class="size-4" aria-hidden="true" />
              </Button>
            {/snippet}
          </TaskDetailPanel>
        </div>
      </div>
      {#if detailOpen}
        <button
          type="button"
          class="fixed inset-0 z-40 bg-black/40"
          aria-label="收起任务面板"
          onclick={() => (detailOpen = false)}
        ></button>
      {/if}
    {/if}

    <Sheet.Root bind:open={listOpen}>
      <!-- 与任务面板同款：title + actions（新建/关闭都在行内，浮动 X 隐藏）。 -->
      <Sheet.Content side="left" class="w-80 gap-0 p-0" hideClose>
        <Sheet.Header class="flex-row items-center justify-between border-b px-3 py-2">
          <Sheet.Title class="text-xs font-medium text-muted-foreground">任务列表</Sheet.Title>
          <span class="flex items-center gap-0.5">
            <Button
              size="xs"
              variant="ghost"
              onclick={() => {
                openComposer();
                listOpen = false;
              }}
            >
              + 新建
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="关闭列表"
              onclick={() => (listOpen = false)}
            >
              <IconX class="size-4" aria-hidden="true" />
            </Button>
          </span>
        </Sheet.Header>
        <div class="flex min-h-0 flex-1 flex-col">
          {@render taskListColumn()}
        </div>
      </Sheet.Content>
    </Sheet.Root>

  {/if}
</div>
