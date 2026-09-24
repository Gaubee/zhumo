<!--
  用户消息气泡（走查 R7：替换溢出滚动——滚动破坏阅读连续性）：
  - 折叠态 line-clamp 收起 + 底部渐变遮罩 + bottom-center「展开」按钮；
  - 展开态完整内容 + bottom-center「收起」按钮；
  - 内容未溢出时不显示任何按钮（scrollHeight 检测）。
-->
<script lang="ts">
  import IconChevronDown from "@lucide/svelte/icons/chevron-down";
  import IconChevronUp from "@lucide/svelte/icons/chevron-up";
  import MarkdownRender from "markstream-svelte";

  let { text }: { text: string } = $props();

  let expanded = $state(false);
  let bodyEl = $state<HTMLDivElement | null>(null);
  let overflowing = $state(false);

  $effect(() => {
    void text;
    void expanded;
    const el = bodyEl;
    if (el === null) return;
    overflowing = !expanded && el.scrollHeight - el.clientHeight > 4;
  });
</script>

<div class="relative">
  <div
    bind:this={bodyEl}
    class="bubble-user px-3.5 py-2 text-[13px] leading-5 {expanded ? '' : 'max-h-[7.5rem] overflow-hidden'}"
  >
    <MarkdownRender content={text} />
  </div>
  {#if expanded}
    <div class="mt-1 flex justify-center">
      <button
        type="button"
        class="flex h-6 items-center gap-1 rounded-full border border-border bg-popover px-2.5 text-[10px] text-muted-foreground shadow-sm transition-colors hover:text-foreground"
        aria-label="收起消息"
        onclick={() => (expanded = false)}
      >
        收起
        <IconChevronUp class="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  {:else if overflowing}
    <!-- 渐变遮罩盖住截断行，按钮压在 bottom-center。 -->
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent"
      aria-hidden="true"
    ></div>
    <div class="absolute inset-x-0 bottom-1.5 flex justify-center">
      <button
        type="button"
        class="flex h-6 items-center gap-1 rounded-full border border-border bg-popover px-2.5 text-[10px] text-muted-foreground shadow-md transition-colors hover:text-foreground"
        aria-label="展开完整消息"
        aria-expanded={expanded}
        onclick={() => (expanded = true)}
      >
        展开全文
        <IconChevronDown class="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  {/if}
</div>
