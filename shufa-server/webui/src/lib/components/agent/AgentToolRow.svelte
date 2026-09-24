<!--
  工具调用行（2026-09-25 三轮重写：按需展开——Owner 裁决「溢出滚动才有必要」）：
  - 内容不超限（JS 测量 scrollHeight ≤ 阈值）→ 直接显示全文（无折叠行、无展开
    交互）；超限 → DisclosureRow 折叠摘要行 + 展开卡（限高内滚，溢出滚动才有
    展开的必要）。
  - running（等待结果）→ 折叠行扫光（无可测内容）。
  测量模式与 UserBubble 同源：渲染后 effect 测量，状态一帧内收敛。
-->
<script lang="ts">
  import IconWrench from "@lucide/svelte/icons/wrench";
  import DisclosureRow from "./DisclosureRow.svelte";

  let {
    toolName,
    argsText = "",
    result = null,
    running = false,
  }: {
    toolName: string;
    argsText?: string;
    result?: string | null;
    running?: boolean;
  } = $props();

  let open = $state(false);
  let measureEl = $state<HTMLDivElement | null>(null);
  let overflowing = $state(false);

  /** 直接显示的高度上限（约 5 行 mono 11px）。 */
  const INLINE_MAX = 84;

  const summary = $derived(result ?? argsText ?? "");
  /** 折叠行只在「运行中（无可测内容）」或「内容溢出」时出现。 */
  const collapsed = $derived(running || overflowing);

  $effect(() => {
    void argsText;
    void result;
    const el = measureEl;
    if (el === null) return;
    overflowing = el.scrollHeight > INLINE_MAX + 4;
  });
</script>

<div class="flow-item">
  {#if collapsed}
    <DisclosureRow
      icon={IconWrench}
      title={toolName}
      {summary}
      open={running ? false : open}
      {running}
      onToggle={() => (open = !open)}
    />
    {#if open && !running}
      <div class="tool-card mt-1 max-h-64 space-y-1 overflow-y-auto p-2">
        {#if argsText.length > 0}
          <div>
            <span class="text-muted-foreground">调用参数：</span>
            <span class="whitespace-pre-wrap">{argsText}</span>
          </div>
        {/if}
        {#if result !== null}
          <div>
            <span class="text-muted-foreground">结果：</span>
            <span class="whitespace-pre-wrap">{result}</span>
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <!-- 不溢出：全文直显（工具名 inline 小标 + 内容），无展开交互。 -->
    <div class="px-1">
      <span class="text-[11px] font-medium text-muted-foreground">{toolName}</span>
      <div bind:this={measureEl} class="tool-card mt-0.5 px-2 py-1.5">
        {#if result !== null}
          <span class="whitespace-pre-wrap">{result}</span>
        {:else if argsText.length > 0}
          <span class="whitespace-pre-wrap">{argsText}</span>
        {:else}
          <span class="text-muted-foreground">（无输出）</span>
        {/if}
      </div>
    </div>
  {/if}
</div>
