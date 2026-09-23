<!--
  / 前台 list-detail（PRODUCT_DESIGN §3：左列任务列表时间倒序+进行中徽标；
  右列详情 = agent 对话 + 素材视频展示位；顶栏后台入口）。
  走查反馈 [2026-09-23]：新建入口从左列移入 detail 面板——左列专注列表导航；
  未选中任务时 detail 即新建面板（预设开场），详情头部提供「新建任务」切回。
  正交意图：
  1. 任务列表（倒序/状态徽标/选中态）——纯导航。
  2. 详情：选中 = 素材视频展示位 + TranscriptView + ComposerCard；
     未选中 = TaskComposer（新建分析任务）。
  3. 顶栏（站点名/身份/后台入口）。
-->
<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import ComposerCard from "$lib/components/agent/ComposerCard.svelte";
  import TaskComposer from "$lib/components/agent/TaskComposer.svelte";
  import TranscriptView from "$lib/components/agent/TranscriptView.svelte";
  import { auth } from "$lib/stores/auth.svelte";
  import {
    getSelectedTask,
    loadTasks,
    projectFrames,
    selectTask,
    sendPrompt,
    tasks,
  } from "$lib/stores/tasks.svelte";
  import { navigate } from "$lib/router.svelte";
  import { onMount } from "svelte";

  const statusLabel: Record<string, string> = {
    queued: "排队中",
    running: "进行中",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };

  onMount(() => {
    void loadTasks();
  });

  const selected = $derived(getSelectedTask());
  const items = $derived(projectFrames(tasks.frames));
  const detailRunning = $derived(selected?.status === "running" || tasks.sending);

  function timeLabel(iso: string): string {
    const date = new Date(iso);
    return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  /** 关闭当前详情，回到 detail 面板的新建态（走查：新建入口在 detail 面板）。 */
  function openComposer(): void {
    tasks.selectedId = null;
    tasks.frames = [];
  }
</script>

<div class="flex h-screen flex-col bg-paper">
  <!-- 顶栏 -->
  <header class="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
    <span class="text-sm font-semibold tracking-wide">朱墨</span>
    <span class="text-[11px] text-muted-foreground">书法视频 · agent 分析工作台</span>
    <span class="flex-1"></span>
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

  <div class="flex min-h-0 flex-1">
    <!-- 左列：任务列表（纯导航） -->
    <aside class="flex w-72 shrink-0 flex-col border-r border-border bg-card/60">
      <div class="border-b border-border px-3 py-2.5">
        <span class="text-xs font-medium text-muted-foreground">任务列表</span>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        {#each tasks.list as task (task.id)}
          <button
            type="button"
            class="mb-1 w-full rounded-lg px-2.5 py-2 text-left transition-colors {tasks.selectedId ===
            task.id
              ? 'bg-accent-soft'
              : 'hover:bg-muted/60'}"
            onclick={() => void selectTask(task.id)}
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
            还没有任务<br />在右侧创建第一个分析任务
          </p>
        {/if}
      </div>
    </aside>

    <!-- 右列：详情（选中 = 对话；未选中 = 新建分析任务） -->
    <section class="flex min-w-0 flex-1 flex-col">
      {#if selected}
        <div class="flex items-center gap-3 border-b border-border px-4 py-2">
          <h2 class="min-w-0 flex-1 truncate text-sm font-medium">{selected.title}</h2>
          <Badge variant="outline" class="text-[10px]">
            {statusLabel[selected.status] ?? selected.status}
          </Badge>
          <Button size="sm" variant="outline" onclick={openComposer}>新建任务</Button>
        </div>
        <!-- 素材视频展示位 -->
        <div class="flex items-center gap-3 border-b border-border bg-card/50 px-4 py-2">
          <div
            class="flex h-14 w-24 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-[10px] text-muted-foreground"
            aria-label="素材视频展示位"
          >
            视频
          </div>
          <div class="min-w-0 text-xs">
            <p class="truncate font-medium">{selected.videoName}</p>
            <p class="text-[11px] text-muted-foreground">
              素材视频仅作展示，agent 通过文件路径自行编排分析工具。
            </p>
          </div>
        </div>
        <TranscriptView {items} running={detailRunning} />
        <div class="border-t border-border p-3">
          <ComposerCard
            onsend={(text) => void sendPrompt(text)}
            sending={tasks.sending}
            videoName={selected.videoName}
          />
        </div>
      {:else}
        <div class="min-h-0 flex-1 overflow-y-auto">
          <TaskComposer />
        </div>
      {/if}
    </section>
  </div>
</div>
