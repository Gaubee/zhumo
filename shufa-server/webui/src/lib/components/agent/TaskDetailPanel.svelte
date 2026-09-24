<!--
  任务详情面板（Owner 需求 2026-09-25：右侧 detail 拆分的右半——多标签页浏览器）。
  结构：
  1. 标签条：「任务详情」（固定）+ 每个导出结果一个标签（可关闭、可新窗口打开）。
     一次对话多次导出 = 多个结果标签（results 新→旧；标签名取导出序号）。
  2. 详情标签：素材视频预览播放（resRawUrl，Range 流）+ 元数据 + 导出结果列表
     （点击开标签）。
  3. 结果标签：iframe 内嵌 /r/{publicId} 结果页（同源静态面，独立滚动不受外层
     布局影响；result-live 的 body 滚动锁只作用于 iframe 文档）。
  URL 口径：iframe/新窗口一律用 location.origin 拼接——不依赖服务端基址
  （0.0.0.0 修复只作用于 agent 转述的 result_url 文本）。
-->
<script lang="ts">
  import IconExternalLink from "@lucide/svelte/icons/external-link";
  import IconFileVideo from "@lucide/svelte/icons/file-video";
  import IconX from "@lucide/svelte/icons/x";
  import { Badge } from "$lib/components/ui/badge";
  import { api } from "$lib/api";
  import type { Task, TaskResultRefView } from "$lib/types";

  let {
    task,
    results,
    running = false,
  }: { task: Task; results: TaskResultRefView[]; running?: boolean } = $props();

  /** 活动标签：详情（固定标签）或某结果的 public_id。 */
  let active = $state<"detail" | string>("detail");
  /** 素材视频 raw 地址（resRawUrl 异步取 token）。 */
  let videoUrl = $state<string | null>(null);
  let videoError = $state<string | null>(null);

  const statusLabel: Record<string, string> = {
    queued: "排队中",
    running: "进行中",
    done: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };

  $effect(() => {
    const id = task.videoResourceId;
    videoUrl = null;
    videoError = null;
    if (id === null) return;
    void api
      .resRawUrl(id)
      .then((url) => {
        videoUrl = url;
      })
      .catch((e: unknown) => {
        videoError = e instanceof Error ? e.message : String(e);
      });
  });

  /** 任务切换时回到详情标签；被删结果的活动标签也回退。 */
  $effect(() => {
    if (active !== "detail" && !results.some((r) => r.publicId === active)) {
      active = "detail";
    }
  });

  const openTabs = $derived(results.filter((r) => r.publicId !== "detail"));

  function tabLabel(r: TaskResultRefView, index: number): string {
    void r;
    return `结果 ${openTabs.length - index}`;
  }

  function resultUrl(publicId: string): string {
    return `${location.origin}/r/${encodeURIComponent(publicId)}`;
  }

  function openResult(publicId: string): void {
    active = publicId;
  }

  function closeTab(publicId: string): void {
    if (active === publicId) active = "detail";
  }

  function timeLabel(iso: string): string {
    const d = new Date(iso);
    return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-card/40">
  <!-- 标签条 -->
  <div
    class="flex h-9 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border px-1.5"
    role="tablist"
    aria-label="任务详情与结果页"
  >
    <button
      type="button"
      role="tab"
      aria-selected={active === "detail"}
      class="flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-xs transition-colors {active === "detail"
        ? "border-primary text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground"}"
      onclick={() => (active = "detail")}
    >
      <IconFileVideo class="h-3.5 w-3.5" aria-hidden="true" />
      任务详情
    </button>
    {#each openTabs as r, i (r.publicId)}
      <button
        type="button"
        role="tab"
        aria-selected={active === r.publicId}
        class="group flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-xs transition-colors {active === r.publicId
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'}"
        onclick={() => (active = r.publicId)}
      >
        <span>{tabLabel(r, i)}</span>
        <span
          role="button"
          tabindex="0"
          aria-label="新窗口打开结果页"
          class="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
          onclick={(e) => {
            e.stopPropagation();
            window.open(resultUrl(r.publicId), "_blank", "noopener");
          }}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              window.open(resultUrl(r.publicId), "_blank", "noopener");
            }
          }}
        >
          <IconExternalLink class="h-3 w-3" aria-hidden="true" />
        </span>
        <span
          role="button"
          tabindex="0"
          aria-label="关闭结果标签"
          class="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100"
          onclick={(e) => {
            e.stopPropagation();
            closeTab(r.publicId);
          }}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              closeTab(r.publicId);
            }
          }}
        >
          <IconX class="h-3 w-3" aria-hidden="true" />
        </span>
      </button>
    {/each}
  </div>

  <!-- 内容区 -->
  {#if active === "detail"}
    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <!-- 素材视频播放 -->
      {#if task.videoResourceId === null}
        <div class="flex h-28 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
          未附素材视频
        </div>
      {:else if videoUrl !== null}
        <video
          controls
          preload="metadata"
          src={videoUrl}
          class="max-h-56 w-full rounded-lg border bg-black"
          aria-label="素材视频预览"
        ></video>
      {:else if videoError !== null}
        <div class="rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-[11px] text-destructive" role="alert">
          视频加载失败：{videoError}
        </div>
      {:else}
        <div class="flex h-28 items-center justify-center rounded-lg border text-xs text-muted-foreground">
          视频加载中…
        </div>
      {/if}

      <!-- 元数据 -->
      <dl class="mt-3 space-y-1.5 rounded-lg border bg-card p-3 text-xs">
        <div class="flex justify-between gap-3">
          <dt class="shrink-0 text-muted-foreground">视频文件</dt>
          <dd class="min-w-0 truncate text-right" title={task.videoName}>{task.videoName}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="shrink-0 text-muted-foreground">状态</dt>
          <dd class="flex items-center gap-1.5">
            {statusLabel[task.status] ?? task.status}
            {#if running}
              <Badge class="text-[9px]">进行中</Badge>
            {/if}
          </dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="shrink-0 text-muted-foreground">创建时间</dt>
          <dd>{timeLabel(task.createdAt)}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="shrink-0 text-muted-foreground">模型</dt>
          <dd class="min-w-0 truncate text-right font-mono text-[11px]">
            {#if task.modelProvider !== null}
              {task.modelProvider} / {task.modelModel}
            {:else}
              <span class="text-muted-foreground">后台默认</span>
            {/if}
          </dd>
        </div>
      </dl>

      <!-- 导出结果列表（一次对话可多次导出） -->
      <div class="mt-3 rounded-lg border bg-card p-3">
        <p class="mb-2 text-xs font-medium">
          导出结果
          <span class="ml-1 text-[11px] font-normal text-muted-foreground">{results.length} 个</span>
        </p>
        {#if results.length === 0}
          <p class="py-3 text-center text-[11px] text-muted-foreground">
            {running ? "分析进行中，导出完成后出现在这里" : "尚无导出——对话中让 agent 导出分析包"}
          </p>
        {:else}
          <div class="space-y-1">
            {#each results as r, i (r.publicId)}
              <button
                type="button"
                class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 {active ===
                r.publicId
                  ? 'bg-accent-soft'
                  : ''}"
                onclick={() => openResult(r.publicId)}
              >
                <span class="min-w-0 flex-1 truncate">结果 {results.length - i}</span>
                <span class="shrink-0 text-[10px] text-muted-foreground">{timeLabel(r.createdAt)}</span>
                <IconExternalLink class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <iframe
      title="结果页预览"
      src={resultUrl(active)}
      class="min-h-0 w-full flex-1 border-0 bg-white"
      sandbox="allow-scripts allow-same-origin allow-popups"
    ></iframe>
  {/if}
</div>
