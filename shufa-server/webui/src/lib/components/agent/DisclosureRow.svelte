<!--
  24px 折叠行骨架（移植自 skill-creator-v2 webui DisclosureRow.svelte，原样保留
  语法：[icon 14px] 标题 [·] 摘要 [chevron]，运行态扫光）。
  正交意图：[1] thinking/tool 等可折叠行的共用行原子。
-->
<script lang="ts">
  import IconChevron from "@lucide/svelte/icons/chevron-right";
  import type { Component } from "svelte";

  let {
    icon: Icon,
    title,
    summary = "",
    open = false,
    running = false,
    error = false,
    onToggle,
  }: {
    icon: Component<{ class?: string }>;
    title: string;
    summary?: string;
    open?: boolean;
    running?: boolean;
    error?: boolean;
    onToggle: () => void;
  } = $props();
</script>

<button
  type="button"
  class="disclosure-row"
  data-open={open}
  aria-expanded={open}
  title={summary.length > 0 ? `${title} · ${summary}` : title}
  onclick={onToggle}
>
  <span class="flex items-center justify-center text-muted-foreground" aria-hidden="true">
    <Icon class="h-3.5 w-3.5" />
  </span>
  <span class="flex items-center gap-1 overflow-hidden">
    <span class="max-w-40 truncate text-left font-medium text-foreground">{title}</span>
    {#if error}
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" title="工具执行失败"></span>
    {/if}
  </span>
  <span class="text-center text-muted-foreground/70" aria-hidden="true">·</span>
  <span class="disclosure-summary {running ? 'sweep' : ''}">{summary}</span>
  <IconChevron class="disclosure-chevron h-3.5 w-3.5 shrink-0 text-muted-foreground" />
</button>
