<!--
  reasoning 行（2026-09-25 三轮：按需展开——从 TranscriptView 抽出组件化）：
  - 流式中：折叠摘要行扫光 + 自动展开全文（限高内滚）；
  - 定稿后短文（JS 测量不超限）→ 直接全文，无折叠行无展开交互；
  - 定稿后长文 → 折叠摘要行 + 手动展开/收起（溢出滚动才有展开的必要）。
  测量模式与 UserBubble/AgentToolRow 同源。
-->
<script lang="ts">
  import IconSparkles from "@lucide/svelte/icons/sparkles";
  import DisclosureRow from "./DisclosureRow.svelte";

  let {
    text,
    streaming = false,
    open = false,
    onToggle,
  }: {
    text: string;
    streaming?: boolean;
    open?: boolean;
    onToggle?: () => void;
  } = $props();

  let measureEl = $state<HTMLDivElement | null>(null);
  let overflowing = $state(false);

  /** 直接显示的高度上限（约 5 行 11px）。 */
  const INLINE_MAX = 84;

  const summary = $derived.by(() => {
    const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? "";
    return streaming ? `${firstLine.slice(0, 60)}…` : firstLine.slice(0, 60);
  });

  $effect(() => {
    void text;
    if (streaming) return;
    const el = measureEl;
    if (el === null) return;
    overflowing = el.scrollHeight > INLINE_MAX + 4;
  });

  /** 折叠行只在流式中或定稿溢出时出现。 */
  const collapsed = $derived(streaming || overflowing);
</script>

<div class="flow-item">
  {#if collapsed}
    <DisclosureRow
      icon={IconSparkles}
      title="思考中"
      {summary}
      open={streaming ? true : open}
      running={streaming}
      onToggle={() => onToggle?.()}
    />
    {#if streaming || open}
      <div
        class="mt-1 max-h-48 overflow-y-auto rounded-md px-2 pb-1 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
      >
        {text}
      </div>
    {/if}
  {:else}
    <!-- 定稿短文：全文直显（sparkles 小标），无展开交互。 -->
    <div class="px-1">
      <span class="flex h-5 items-center gap-1 text-[11px] text-muted-foreground">
        <IconSparkles class="h-3 w-3" aria-hidden="true" />
        思考
      </span>
      <div
        bind:this={measureEl}
        class="rounded-md px-2 pb-1 text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
      >
        {text}
      </div>
    </div>
  {/if}
</div>
