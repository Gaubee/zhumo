<!--
  转录流渲染（走查 R7 对齐 skill-creator-v2 TranscriptView 全量语义）：
  - 用户消息：UserBubble（溢出省略 + bottom-center 展开/收起，不再滚动）；
  - assistant：全宽无气泡 markstream 流式渲染 + hover copy 脚标；
  - reasoning：DisclosureRow 折叠行（流式自动展开 + 扫光摘要；定稿收起）；
  - turn-end：时长/↑↓用量药丸（payload.usage 透传：↑=输入含缓存、↓=输出；
    历史帧无 usage 时只显时长；明细进 title）；
  - error：失败明文卡片（走查 R3）；
  - 贴底跟随 + back-to-bottom FAB；Working 扫光 + 15s 起计时。
-->
<script lang="ts">
  import IconArrowDown from "@lucide/svelte/icons/arrow-down";
  import IconTriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import IconCheck from "@lucide/svelte/icons/check";
  import IconCopy from "@lucide/svelte/icons/copy";
  import MarkdownRender from "markstream-svelte";
  import "markstream-svelte/index.css";
  import AgentToolRow from "./AgentToolRow.svelte";
  import ReasoningRow from "./ReasoningRow.svelte";
  import UserBubble from "./UserBubble.svelte";
  import "./agent-flow.css";
  import type { TranscriptItem, TurnUsagePill } from "$lib/stores/tasks.svelte";

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
  /** reasoning 折叠态（seq → open；流式自动展开，定稿收起）。 */
  let openItems = $state<Record<number, boolean>>({});
  let copiedSeq = $state<number | null>(null);
  let runningSince = $state<number | null>(null);
  let workingSeconds = $state(0);

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

  // Working 计时（15s 起显示，1s tick）。
  $effect(() => {
    if (!running) {
      runningSince = null;
      workingSeconds = 0;
      return;
    }
    runningSince = Date.now();
    const timer = setInterval(() => {
      if (runningSince !== null) workingSeconds = (Date.now() - runningSince) / 1000;
    }, 1000);
    return () => clearInterval(timer);
  });

  function backToBottom(): void {
    const body = scrollBody;
    if (body) body.scrollTop = body.scrollHeight;
  }

  function formatElapsed(ms: number): string {
    return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
  }

  /** 千位以上缩写（1.2k / 12k / 1.2M；千位以下原样）。 */
  function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
    if (tokens >= 1_000) return `${Math.round(tokens / 100) / 10}k`;
    return String(tokens);
  }

  /** 药丸 ↑ 口径：全部提示词输入（未命中 + 缓存读 + 缓存写）。 */
  function turnInputTokens(usage: TurnUsagePill): number {
    return usage.in + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  }

  /** 药丸悬停明细（输入/输出 + 缓存桶拆解 + 用时）。 */
  function turnEndTitle(item: { elapsedMs?: number; usage?: TurnUsagePill }): string {
    const parts: string[] = [];
    if (item.usage !== undefined) {
      parts.push(`输入 ${formatTokens(turnInputTokens(item.usage))} · 输出 ${formatTokens(item.usage.out)} tokens`);
      const cache = [
        item.usage.cacheRead !== undefined ? `缓存命中 ${formatTokens(item.usage.cacheRead)}` : null,
        item.usage.cacheWrite !== undefined ? `缓存写入 ${formatTokens(item.usage.cacheWrite)}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ");
      if (cache.length > 0) parts.push(cache);
    }
    if (item.elapsedMs !== undefined) parts.push(`用时 ${formatElapsed(item.elapsedMs)}`);
    return parts.length > 0 ? parts.join(" · ") : "本轮完成";
  }

  async function copyText(text: string, seq: number): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copiedSeq = seq;
      setTimeout(() => (copiedSeq = null), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文）静默——局域网 IP 直访下常见。
    }
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
          <div class="flow-item ml-auto max-w-[85%]">
            <UserBubble text={item.text} />
          </div>
        {:else if item.kind === "reasoning"}
          <ReasoningRow
            text={item.text}
            streaming={item.streaming}
            open={openItems[item.seq] ?? false}
            onToggle={() => (openItems = { ...openItems, [item.seq]: !(openItems[item.seq] ?? false) })}
          />
        {:else if item.kind === "assistant"}
          <div class="flow-item group/msg max-w-full">
            <div class="msg-body max-w-full [&_a]:text-primary">
              <MarkdownRender content={item.text} final={!item.streaming} />
            </div>
            {#if !item.streaming && item.text.trim().length > 0}
              <div
                class="mt-0.5 flex h-5 gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100"
                role="toolbar"
                aria-label="消息操作"
              >
                <button
                  type="button"
                  class="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="复制"
                  aria-label="复制消息"
                  onclick={() => void copyText(item.text, item.seq)}
                >
                  {#if copiedSeq === item.seq}
                    <IconCheck class="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  {:else}
                    <IconCopy class="h-3.5 w-3.5" aria-hidden="true" />
                  {/if}
                </button>
              </div>
            {/if}
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
            <span class="turn-pill" title={turnEndTitle(item)}>
              本轮完成{item.elapsedMs !== undefined ? ` · ${formatElapsed(item.elapsedMs)}` : ""}{item.usage !== undefined
                ? ` · ↑${formatTokens(turnInputTokens(item.usage))} ↓${formatTokens(item.usage.out)}`
                : ""}
            </span>
          </div>
        {/if}
      {/each}
      {#if running}
        <div class="flow-item flex h-6 items-center" role="status">
          <span class="sweep rounded-md px-1 text-xs text-muted-foreground">
            分析中{workingSeconds >= 15 ? ` · ${Math.floor(workingSeconds)}s` : ""}…
          </span>
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
      <IconArrowDown class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  {/if}
</div>
