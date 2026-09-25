<script lang="ts">
  /**
   * 队列面板（W10b，Owner 设计 2026-09-27）：对话框上方的投递队列视图——
   * 内核 inbox 的产品面。每行一条排队/挂起消息，行尾三动作：编辑（文本回
   * 输入框，该条及其后冻结暂离队列）、修改模式（排队⇄引导/注入）、删除。
   * 冻结段由后端暂离 inbox——编辑期间本面板自然只显示冻结边界之前的条目。
   */
  import IconPencil from "@lucide/svelte/icons/pencil";
  import IconTrash from "@lucide/svelte/icons/trash";
  import IconRepeat from "@lucide/svelte/icons/repeat";
  import * as Popover from "$lib/components/ui/popover";
  import type { TaskQueueItem, TaskQueueMode } from "@zhumo/contracts";

  let {
    items,
    editing = null,
    onedit,
    oncancel,
    onremove,
    onsetmode,
  }: {
    items: TaskQueueItem[];
    editing?: string | null;
    onedit: (messageId: string) => void;
    oncancel: () => void;
    onremove: (messageId: string) => void;
    onsetmode: (messageId: string, mode: TaskQueueMode) => void;
  } = $props();

  const MODE_LABEL: Record<TaskQueueMode, string> = {
    queue: "排队",
    steer: "引导",
    inject: "注入",
  };
  /** 模式菜单选项（Owner：可改成注入或引导；排队项可回切） */
  const MODE_CYCLE: TaskQueueMode[] = ["queue", "steer", "inject"];

  /** 行内模式菜单开合（一次一行） */
  let modeOpenId = $state<string | null>(null);
</script>

{#if items.length > 0 || editing !== null}
  <div class="mb-1.5 rounded-lg border border-border bg-muted/40 px-2 py-1.5">
    <div class="flex items-center gap-1.5 px-0.5 pb-1 text-[11px] font-medium text-muted-foreground">
      <span>投递队列</span>
      <span class="text-muted-foreground/70">（逐条生效）</span>
      <span class="flex-1"></span>
      {#if editing !== null}
        <button
          type="button"
          class="rounded px-1.5 py-0.5 text-[11px] text-amber-600 hover:bg-amber-500/10"
          onclick={oncancel}
          title="取消编辑，冻结段按原样放回队列"
        >
          编辑中 · 取消
        </button>
      {/if}
    </div>
    <ul class="flex flex-col gap-1">
      {#each items as item (item.message_id)}
        <li
          class="flex items-center gap-2 rounded border border-border/60 bg-card px-2 py-1 text-[12px]"
        >
          <span
            class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] {item.mode === 'queue'
              ? 'bg-primary/10 text-primary'
              : item.mode === 'steer'
                ? 'bg-amber-500/15 text-amber-600'
                : 'bg-violet-500/15 text-violet-600'}"
            title={item.mode === 'queue' ? '本轮结束后自动开轮' : item.mode === 'steer' ? '下一 step 边界影响当前轮' : '注入上下文（不作为对话轮）'}
          >
            {MODE_LABEL[item.mode]}
          </span>
          <span class="min-w-0 flex-1 truncate" title={item.text}>{item.text}</span>
          <!-- 编辑仅对排队条目（引导/注入是 step 边界挂起项，无冻结语义） -->
          {#if item.mode === "queue"}
            <button
              type="button"
              class="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              title="编辑（该条及其后的消息冻结，确认后放回）"
              aria-label="编辑该消息"
              disabled={editing !== null}
              onclick={() => onedit(item.message_id)}
            >
              <IconPencil class="h-3 w-3" />
            </button>
          {/if}
          <Popover.Root open={modeOpenId === item.message_id} onOpenChange={(open) => (modeOpenId = open ? item.message_id : null)}>
            <Popover.Trigger>
              {#snippet child({ props })}
                <button
                  type="button"
                  {...props}
                  class="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  title="修改模式（排队 / 引导 / 注入）"
                  aria-label="修改投递模式"
                  disabled={editing !== null}
                >
                  <IconRepeat class="h-3 w-3" />
                </button>
              {/snippet}
            </Popover.Trigger>
            <Popover.Content side="top" align="end" class="w-36 p-1">
              {#each MODE_CYCLE as mode (mode)}
                <button
                  type="button"
                  class="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted {mode === item.mode ? 'font-medium text-primary' : ''}"
                  onclick={() => {
                    if (mode !== item.mode) onsetmode(item.message_id, mode);
                    modeOpenId = null;
                  }}
                >
                  <span>{MODE_LABEL[mode]}</span>
                  {#if mode === item.mode}
                    <span class="text-[10px] text-muted-foreground">当前</span>
                  {/if}
                </button>
              {/each}
            </Popover.Content>
          </Popover.Root>
          <button
            type="button"
            class="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="从队列删除"
            aria-label="删除该消息"
            onclick={() => onremove(item.message_id)}
          >
            <IconTrash class="h-3 w-3" />
          </button>
        </li>
      {/each}
    </ul>
  </div>
{/if}
