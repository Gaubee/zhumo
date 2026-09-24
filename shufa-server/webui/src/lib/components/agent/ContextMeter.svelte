<!--
  上下文占用表（移植自 skill-creator-v2 ContextMeter，2026-09-25 前台对齐）：
  14px SVG 环 = lastUsage.in / 活动模型 contextWindow（75%+ amber）；点击弹
  用量面板（本轮 in/out + 容量 + compact 按钮）。compact 走 oncompact 回调
  （daemon 对 "/compact" 文本做内核命令分流，不进 LLM）。
  分母解析：活动模型 contextWindow；缺省回退 131072 并标注 assumed 128k。
-->
<script lang="ts">
  import { formatTokenCount } from "$lib/components/models/route-meta";

  let {
    usage = null,
    capacity = null,
    disabled = false,
    oncompact,
  }: {
    /** 最近一轮用量（turn-end 帧 usage 投影；null = 尚无回合）。 */
    usage?: { in: number; out: number } | null;
    /** 活动模型上下文窗口（null = 回退 128k 假定值）。 */
    capacity?: number | null;
    disabled?: boolean;
    oncompact: () => void;
  } = $props();

  /** 回退上下文窗口常量（131072 = 128k；模型窗口未命中时使用并标注）。 */
  const CONTEXT_WINDOW = 131_072;

  let open = $state(false);
  let container = $state<HTMLElement | null>(null);

  const resolvedCapacity = $derived(capacity ?? CONTEXT_WINDOW);
  const fillRatio = $derived.by(() => {
    if (!usage) return 0;
    return Math.min(1, Math.max(0, usage.in / resolvedCapacity));
  });
  const percent = $derived(Math.round(fillRatio * 100));
  const warn = $derived(percent >= 75);
  /** SVG 环几何：14px 视窗，r=5，stroke 2.5；dasharray 驱动进度弧。 */
  const circumference = 2 * Math.PI * 5;
  const dash = $derived(`${(fillRatio * circumference).toFixed(2)} ${circumference.toFixed(2)}`);

  const tooltip = $derived(
    usage
      ? `上下文已用 ${percent}% · 上轮 ↑${formatTokenCount(usage.in)} / ↓${formatTokenCount(usage.out)}`
      : "上下文用量在首轮对话后出现",
  );

  function onWindowPointerDown(event: PointerEvent): void {
    if (!open) return;
    if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
      open = false;
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div bind:this={container} class="relative">
  <button
    type="button"
    class="relative flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
    aria-label="上下文用量"
    title={tooltip}
    aria-expanded={open}
    disabled={disabled}
    onclick={() => (open = !open)}
  >
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle
        cx="7"
        cy="7"
        r="5"
        fill="none"
        stroke-width="2.5"
        class="stroke-muted-foreground/40"
      ></circle>
      <circle
        cx="7"
        cy="7"
        r="5"
        fill="none"
        stroke-width="2.5"
        stroke-linecap="round"
        class={warn ? "stroke-amber-500" : "stroke-primary"}
        stroke-dasharray={dash}
        transform="rotate(-90 7 7)"
      ></circle>
    </svg>
  </button>
  {#if open}
    <div
      role="dialog"
      aria-label="上下文用量详情"
      class="absolute right-0 bottom-full z-20 mb-1.5 w-60 rounded-lg border border-border bg-popover p-2.5 text-xs shadow-md"
    >
      <div class="mb-1.5 text-[11px] font-medium text-muted-foreground">上下文</div>
      {#if usage}
        <div class="flex items-center justify-between">
          <span>已用</span>
          <span class="tabular-nums {warn ? 'text-amber-600 dark:text-amber-400' : ''}">{percent}%</span>
        </div>
        <div class="mt-0.5 flex items-center justify-between text-muted-foreground">
          <span>上一轮</span>
          <span class="tabular-nums">
            ↑ {formatTokenCount(usage.in)} · ↓ {formatTokenCount(usage.out)}
          </span>
        </div>
        <div class="mt-0.5 flex items-center justify-between text-muted-foreground">
          <span>容量</span>
          <span class="tabular-nums">
            {formatTokenCount(resolvedCapacity)}{capacity == null ? " · 假定 128k" : ""}
          </span>
        </div>
      {:else}
        <div class="text-muted-foreground">尚无对话回合。</div>
      {/if}
      <button
        type="button"
        class="mt-2 w-full rounded-md border border-border px-2 py-1 text-[11px] transition-colors hover:bg-muted disabled:opacity-50"
        title="压缩对话历史（内核 /compact）"
        disabled={disabled || !usage}
        onclick={() => {
          open = false;
          oncompact();
        }}
      >
        压缩上下文
      </button>
    </div>
  {/if}
</div>
