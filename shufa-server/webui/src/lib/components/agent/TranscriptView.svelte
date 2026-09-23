<!--
  转录流渲染（移植自 skill-creator-v2 webui TranscriptView.svelte 骨架：
  flow-item 节奏 + 用户气泡/助手全宽/工具行/状态行/turn 药丸 + 贴底跟随与
  back-to-bottom FAB + Working 扫光；助手文本走 markstream-svelte 流式
  markdown 渲染（走查反馈 2026-09-23：不要纯文本直出）。
  正交意图：
  1. 帧投影条目渲染（TranscriptItem 语法）。
  2. 滚动跟随（贴底钉住 + FAB）。
-->
<script lang="ts">
  import IconArrowDown from "@lucide/svelte/icons/arrow-down";
  import IconTriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import MarkdownRender from "markstream-svelte";
  import "markstream-svelte/index.css";
  import AgentToolRow from "./AgentToolRow.svelte";
  import "./agent-flow.css";
  import type { TranscriptItem } from "$lib/stores/tasks.svelte";

  let {
    items,
    running = false,
    emptyHint = "发送第一条指令开始分析",
  }: {
    items: TranscriptItem[];
    running?: boolean;
    emptyHint?: string;
  } = $props();

  let scrollBody = $state<HTMLElement | null>(null);
  let awayFromBottom = $state(false);
  let lastContentHeight = 0;

  // 新帧到达时贴底跟随（用户上滚 >200px 时停手，FAB 浮现）。
  $effect(() => {
    void items.length;
    const body = scrollBody;
    if (!body) return;
    const follow = (): void => {
      const wasNearBottom = lastContentHeight - body.scrollTop - body.clientHeight < 160;
      lastContentHeight = body.scrollHeight;
      if (wasNearBottom || body.scrollHeight - body.scrollTop - body.clientHeight < 160) {
        body.scrollTop = body.scrollHeight;
      }
      awayFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight > 200;
    };
    follow();
    const observer = new ResizeObserver(follow);
    for (const child of body.children) observer.observe(child);
    return () => observer.disconnect();
  });

  function backToBottom(): void {
    const body = scrollBody;
    if (body) body.scrollTop = body.scrollHeight;
  }
</script>

<div class="relative min-h-0 flex-1">
  <div
    bind:this={scrollBody}
    class="h-full overflow-y-auto px-4 py-3"
    onscroll={(event) => {
      const body = event.currentTarget;
      awayFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight > 200;
    }}
  >
    {#if items.length === 0 && !running}
      <div class="flex h-full items-center justify-center">
        <p class="max-w-[280px] text-center text-xs text-muted-foreground">{emptyHint}</p>
      </div>
    {:else}
      {#each items as item (item.seq)}
        {#if item.kind === "user"}
          <!-- 用户消息：右对齐气泡；内容走 markstream（走查 R3：markdown 输入
               不再以 rawText 展示；保留 max-h 滚动防长 prompt 淹没对话）。 -->
          <div class="flow-item ml-auto max-w-[85%]">
            <div class="bubble-user max-h-64 overflow-y-auto px-3.5 py-2 text-[13px] leading-5">
              <MarkdownRender content={item.text} />
            </div>
          </div>
        {:else if item.kind === "assistant"}
          <!-- 助手消息：全宽无气泡，流式 markdown 渲染 -->
          <div class="flow-item max-w-full">
            <div class="msg-body max-w-full">
              <MarkdownRender content={item.text} />
            </div>
          </div>
        {:else if item.kind === "tool"}
          <AgentToolRow
            toolName={item.toolName}
            argsText={item.argsText}
            result={item.result}
            running={running && item.result === null}
          />
        {:else if item.kind === "status"}
          <div class="flow-item px-1 text-[11px] text-muted-foreground">{item.text}</div>
        {:else if item.kind === "error"}
          <!-- 失败明文卡片（走查 R3：failed 必须可见——协议 404/网络错误等
               直接入对话流，不再只剩一枚失败徽章）。 -->
          <div
            class="flow-item flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2"
            role="alert"
          >
            <IconTriangleAlert class="mt-px h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
            <div class="min-w-0">
              <p class="text-xs font-medium text-destructive">任务失败</p>
              <p class="mt-0.5 font-mono text-[11px] leading-relaxed break-all text-destructive/90">
                {item.text}
              </p>
            </div>
          </div>
        {:else if item.kind === "turn-end"}
          <div class="flow-item flex h-5 items-center gap-1.5">
            <span class="turn-pill">本轮完成</span>
          </div>
        {/if}
      {/each}
      {#if running}
        <div class="flow-item flex h-6 items-center" role="status">
          <span class="sweep rounded-md px-1 text-xs text-muted-foreground">分析中…</span>
        </div>
      {/if}
    {/if}
  </div>
  {#if awayFromBottom}
    <button
      type="button"
      class="absolute top-3 right-3 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-md transition-colors hover:text-foreground"
      title="回到底部"
      aria-label="回到底部"
      onclick={backToBottom}
    >
      <IconArrowDown class="h-3.5 w-3.5" />
    </button>
  {/if}
</div>
