<!--
  工具调用行（移植自 skill-creator-v2 webui AgentToolRow.svelte 骨架：24px
  DisclosureRow + 展开卡显示调用参数与结果；剔除审批/分型细节，真实帧流由
  后续波次接）。
  正交意图：[1] tool-call/result 行渲染（折叠摘要 + mono 展开卡）。
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

  const summary = $derived(result ?? argsText ?? "");
</script>

<div class="flow-item">
  <DisclosureRow
    icon={IconWrench}
    title={toolName}
    {summary}
    {open}
    {running}
    onToggle={() => (open = !open)}
  />
  {#if open}
    <div class="tool-card mt-1 space-y-1 p-2">
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
      {:else}
        <div class="text-muted-foreground">等待结果…</div>
      {/if}
    </div>
  {/if}
</div>
