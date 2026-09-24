<!--
  任务详情面板（Owner 需求 2026-09-25：右侧 detail 拆分的右半——多标签页浏览器）。
  本轮改版（同日走查反馈）：
  1. 素材视频：固定比例容器 + object-contain（任意尺寸视频信箱入容器，不再
     写死高度）；自绘播放控制（播放/暂停、进度拖拽、时间、静音、全屏），
     不用原生裸控件。
  2. 结果标签页 = 纯标签（不再内嵌关闭/外链小按钮——易误触）；动作全部下沉
     到「地址栏」工具行：后退/前进/刷新（iframe history navigation）+
     网址输入框（Enter 跳转）+ 浏览器打开 + 关闭标签。
  结构：「任务详情」固定标签 + 每个导出结果一个标签（iframe 常驻挂载保活）。
  URL 口径：iframe/新窗口一律 location.origin 拼接，不依赖服务端基址。
-->
<script lang="ts">
  import IconExternalLink from "@lucide/svelte/icons/external-link";
  import IconFileVideo from "@lucide/svelte/icons/file-video";
  import IconMaximize from "@lucide/svelte/icons/maximize";
  import IconPause from "@lucide/svelte/icons/pause";
  import IconPlay from "@lucide/svelte/icons/play";
  import IconRotateCw from "@lucide/svelte/icons/rotate-cw";
  import IconVolume2 from "@lucide/svelte/icons/volume-2";
  import IconVolumeX from "@lucide/svelte/icons/volume-x";
  import IconX from "@lucide/svelte/icons/x";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Button } from "$lib/components/ui/button";
  import { api } from "$lib/api";
  import type { Snippet } from "svelte";
  import type { Task, TaskResultRefView } from "$lib/types";

  let {
    task,
    results,
    running = false,
    action,
  }: {
    task: Task;
    results: TaskResultRefView[];
    running?: boolean;
    /** 标签行 inline-end 固定动作区（不随 tabs 滚动；移动抽屉放「关闭」）。 */
    action?: Snippet;
  } = $props();

  /** 活动标签值：详情（固定）或某结果的 public_id。 */
  let active = $state("detail");
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

  /** 任务切换时回详情页；结果消失（恢复历史/重导）时活动标签回退。 */
  $effect(() => {
    if (active !== "detail" && !results.some((r) => r.publicId === active)) {
      active = "detail";
    }
  });

  // ---------------------------------------------------------------- 播放器

  let videoEl = $state<HTMLVideoElement | null>(null);
  let playerBox = $state<HTMLDivElement | null>(null);
  let playing = $state(false);
  let muted = $state(false);
  let currentTime = $state(0);
  let duration = $state(0);

  function togglePlay(): void {
    const v = videoEl;
    if (v === null) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  function toggleMute(): void {
    const v = videoEl;
    if (v === null) return;
    v.muted = !v.muted;
    muted = v.muted;
  }

  function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void playerBox?.requestFullscreen();
  }

  function fmtTime(sec: number): string {
    if (!Number.isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // ---------------------------------------------------------------- 结果地址栏

  /** 每个结果标签的 iframe 引用与当前地址（同源可读 contentWindow.location）。 */
  let frames = $state<Record<string, HTMLIFrameElement | null>>({});
  let urls = $state<Record<string, string>>({});
  let urlDraft = $state("");

  function resultUrl(publicId: string): string {
    return `${location.origin}/r/${encodeURIComponent(publicId)}`;
  }

  /** 切到结果标签时同步地址输入框。 */
  $effect(() => {
    if (active === "detail") return;
    const shown = urls[active] ?? resultUrl(active);
    if (urlDraft !== shown) urlDraft = shown;
  });

  function activeFrame(): HTMLIFrameElement | null {
    return active === "detail" ? null : (frames[active] ?? null);
  }

  function navBack(): void {
    activeFrame()?.contentWindow?.history.back();
  }

  function navForward(): void {
    activeFrame()?.contentWindow?.history.forward();
  }

  function navReload(): void {
    const f = activeFrame();
    if (f?.contentWindow) f.contentWindow.location.reload();
    else if (f) f.src = f.src;
  }

  function navGo(): void {
    const f = activeFrame();
    const input = urlDraft.trim();
    if (f === null || input.length === 0) return;
    const target = /^https?:\/\//.test(input)
      ? input
      : `${location.origin}${input.startsWith("/") ? "" : "/"}${input}`;
    f.src = target;
    urlDraft = target;
    if (active !== "detail") urls[active] = target;
  }

  function onFrameLoad(publicId: string): void {
    try {
      const href = frames[publicId]?.contentWindow?.location.href;
      if (href) {
        urls[publicId] = href;
        if (active === publicId) urlDraft = href;
      }
    } catch {
      // 跨源（用户在地址栏跳去外站）：不可读，保持已输入值。
    }
  }

  function openExternal(publicId: string): void {
    window.open(urls[publicId] ?? resultUrl(publicId), "_blank", "noopener");
  }

  function closeResultTab(): void {
    if (active !== "detail") active = "detail";
  }

  function timeLabel(iso: string): string {
    const d = new Date(iso);
    return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
</script>

<Tabs.Root bind:value={active} class="flex h-full min-h-0 flex-col bg-card/40">
  <!-- 标签行 = 可滚动 tabs（纯标签）+ 固定 action。 -->
  <div class="flex shrink-0 items-stretch border-b border-border">
    <Tabs.List
      variant="line"
      class="h-9 min-w-0 flex-1 justify-start gap-1 overflow-x-auto rounded-none border-none px-1.5"
      aria-label="任务详情与结果页"
    >
      <Tabs.Trigger value="detail" class="flex-none gap-1.5 px-2.5 text-xs">
        <IconFileVideo class="size-3.5" aria-hidden="true" />
        任务详情
      </Tabs.Trigger>
      {#each results as r, i (r.publicId)}
        <Tabs.Trigger value={r.publicId} class="flex-none px-2.5 text-xs">
          结果 {results.length - i}
        </Tabs.Trigger>
      {/each}
    </Tabs.List>
    {#if action !== undefined}
      <div class="flex shrink-0 items-center border-l border-border px-1">
        {@render action()}
      </div>
    {/if}
  </div>

  {#if active !== "detail"}
    <!-- 结果地址栏：后退/前进/刷新 + 网址 + 浏览器打开 + 关闭标签（动作不污染 tabs）。 -->
    <div class="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1.5">
      <Button size="icon-sm" variant="ghost" aria-label="后退" onclick={navBack}>
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="前进" onclick={navForward}>
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="刷新" onclick={navReload}>
        <IconRotateCw class="size-3.5" aria-hidden="true" />
      </Button>
      <input
        bind:value={urlDraft}
        class="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-[11px] outline-none focus:border-ring"
        aria-label="结果页地址"
        onkeydown={(e) => e.key === "Enter" && navGo()}
      />
      <Button size="icon-sm" variant="ghost" aria-label="在浏览器中打开" onclick={() => openExternal(active)}>
        <IconExternalLink class="size-3.5" aria-hidden="true" />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="关闭标签" onclick={closeResultTab}>
        <IconX class="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  {/if}

  <Tabs.Content value="detail" class="min-h-0 flex-1 overflow-y-auto p-3">
    <!-- 素材视频：固定比例容器 + object-contain（任意尺寸信箱入容器）+ 自绘控制。 -->
    {#if task.videoResourceId === null}
      <div class="flex aspect-video items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
        未附素材视频
      </div>
    {:else if videoUrl !== null}
      <div bind:this={playerBox} class="overflow-hidden rounded-lg border bg-black">
        <video
          bind:this={videoEl}
          src={videoUrl}
          preload="metadata"
          playsinline
          class="aspect-video w-full object-contain"
          aria-label="素材视频预览"
          ontimeupdate={(e) => (currentTime = e.currentTarget.currentTime)}
          ondurationchange={(e) => (duration = e.currentTarget.duration)}
          onplay={() => (playing = true)}
          onpause={() => (playing = false)}
          onended={() => (playing = false)}
        ></video>
        <div class="flex items-center gap-1.5 bg-card px-2 py-1.5">
          <Button size="icon-sm" variant="ghost" aria-label={playing ? "暂停" : "播放"} onclick={togglePlay}>
            {#if playing}
              <IconPause class="size-4" aria-hidden="true" />
            {:else}
              <IconPlay class="size-4" aria-hidden="true" />
            {/if}
          </Button>
          <span class="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {fmtTime(currentTime)} / {fmtTime(duration)}
          </span>
          <input
            type="range"
            min="0"
            max={duration || 0}
            step="0.1"
            value={currentTime}
            class="h-1.5 min-w-0 flex-1 accent-foreground"
            aria-label="播放进度"
            oninput={(e) => {
              if (videoEl !== null) videoEl.currentTime = Number(e.currentTarget.value);
            }}
          />
          <Button size="icon-sm" variant="ghost" aria-label={muted ? "取消静音" : "静音"} onclick={toggleMute}>
            {#if muted}
              <IconVolumeX class="size-4" aria-hidden="true" />
            {:else}
              <IconVolume2 class="size-4" aria-hidden="true" />
            {/if}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="全屏" onclick={toggleFullscreen}>
            <IconMaximize class="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    {:else if videoError !== null}
      <div class="rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-[11px] text-destructive" role="alert">
        视频加载失败：{videoError}
      </div>
    {:else}
      <div class="flex aspect-video items-center justify-center rounded-lg border text-xs text-muted-foreground">
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
            <span class="text-[10px] text-muted-foreground">（进行中）</span>
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

    <!-- 导出结果列表（同 bundle 重导已合并为一条；不同 bundle 各一条） -->
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
              onclick={() => (active = r.publicId)}
            >
              <span class="min-w-0 flex-1 truncate">结果 {results.length - i}</span>
              <span class="shrink-0 text-[10px] text-muted-foreground">{timeLabel(r.createdAt)}</span>
              <IconExternalLink class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </Tabs.Content>

  {#each results as r (r.publicId)}
    <!-- bits-ui Tabs.Content 常驻挂载（inactive 走 hidden）——切标签 iframe 不重载。 -->
    <Tabs.Content value={r.publicId} class="min-h-0 flex-1">
      <iframe
        bind:this={frames[r.publicId]}
        title="结果页预览"
        src={resultUrl(r.publicId)}
        class="h-full w-full border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-popups"
        onload={() => onFrameLoad(r.publicId)}
      ></iframe>
    </Tabs.Content>
  {/each}
</Tabs.Root>
