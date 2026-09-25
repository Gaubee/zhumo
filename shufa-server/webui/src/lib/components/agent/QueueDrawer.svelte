<script lang="ts">
  /**
   * 队列抽屉（W10c，Owner 设计 2026-09-27 二轮）：输入面板上方紧贴长出的
   * 手风琴——收起=一行预览（条数 + 下一条文本），展开=完整队列列表。
   * 行布局：status（锁定，可点击主动锁）+ 单行文本（含模式微标）+ actions
   * （编辑/改模式/删除）。整行可拖动排序（HTML5 DnD）：拖动开始即全面板
   * 锁定（actions 禁用、暂停帧驱动刷新防抖动），drop 一次性提交新序；
   * 主动锁定的行固定原位（不可拖、重排时其余行绕开它滑动）。
   */
  import { slide } from "svelte/transition";
  import IconChevronDown from "@lucide/svelte/icons/chevron-down";
  import IconPencil from "@lucide/svelte/icons/pencil";
  import IconTrash from "@lucide/svelte/icons/trash";
  import IconRepeat from "@lucide/svelte/icons/repeat";
  import IconLock from "@lucide/svelte/icons/lock";
  import IconLockOpen from "@lucide/svelte/icons/lock-open";
  import * as Popover from "$lib/components/ui/popover";
  import type { TaskQueueItem, TaskQueueMode } from "@zhumo/contracts";

  let {
    items,
    editing = null,
    locked = {},
    reordering = false,
    onedit,
    oncancel,
    onremove,
    onsetmode,
    onsetlocked,
    onreorder,
    onreordering,
  }: {
    items: TaskQueueItem[];
    editing?: string | null;
    /** 主动锁定表（messageId → true；会话级 UI 态，store 持有）。 */
    locked?: Record<string, boolean>;
    /** 拖动进行中（store 置位：帧驱动刷新暂停）。 */
    reordering?: boolean;
    onedit: (messageId: string) => void;
    oncancel: () => void;
    onremove: (messageId: string) => void;
    onsetmode: (messageId: string, mode: TaskQueueMode) => void;
    onsetlocked: (messageId: string, locked: boolean) => void;
    onreorder: (orderedIds: string[]) => void;
    /** 拖动期面板锁（Svelte 5 props 不可反写——经回调置 store）。 */
    onreordering: (v: boolean) => void;
  } = $props();

  const MODE_LABEL: Record<TaskQueueMode, string> = {
    queue: "排队",
    steer: "引导",
    inject: "注入",
  };
  const MODE_CYCLE: TaskQueueMode[] = ["queue", "steer", "inject"];

  let open = $state(false);
  let modeOpenId = $state<string | null>(null);
  /** 拖动中的本地序（null=非拖动；displayItems 派生消费）。 */
  let localOrder = $state<string[] | null>(null);
  let dragId = $state<string | null>(null);

  const isLocked = (id: string): boolean => locked[id] === true;

  const displayItems = $derived.by(() => {
    if (localOrder === null) return items;
    const byId = new Map(items.map((i) => [i.message_id, i]));
    const shown = localOrder.map((id) => byId.get(id)).filter((i) => i !== undefined);
    return shown as TaskQueueItem[];
  });

  /** 非锁定行滑动、锁定行原位（挖槽回填）。 */
  function moveWithLocked(ids: string[], movingId: string, targetIndex: number): string[] {
    const lockedSet = new Set(ids.filter((id) => isLocked(id)));
    const free = ids.filter((id) => !lockedSet.has(id));
    const from = free.indexOf(movingId);
    if (from < 0) return ids;
    free.splice(from, 1);
    let insertAt = free.length;
    if (targetIndex < ids.indexOf(movingId)) {
      // 向上拖：插到第一个全局位置 ≥ 目标的 free 行之前。
      for (let i = 0; i < free.length; i++) {
        if (ids.indexOf(free[i]!) >= targetIndex) {
          insertAt = i;
          break;
        }
      }
    } else {
      // 向下拖：插到最后一个全局位置 ≤ 目标的 free 行之后。
      for (let i = free.length - 1; i >= 0; i--) {
        if (ids.indexOf(free[i]!) <= targetIndex) {
          insertAt = i + 1;
          break;
        }
      }
    }
    free.splice(insertAt, 0, movingId);
    const out = ids.slice();
    let fi = 0;
    for (let i = 0; i < out.length; i++) {
      if (!lockedSet.has(ids[i]!)) out[i] = free[fi++]!;
    }
    return out;
  }

  function onDragStart(event: DragEvent, item: TaskQueueItem): void {
    if (isLocked(item.message_id) || editing !== null) return;
    dragId = item.message_id;
    localOrder = items.map((i) => i.message_id);
    onreordering(true); // store 置位：暂停帧驱动刷新（面板锁定）
    event.dataTransfer?.setData("text/plain", item.message_id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(event: DragEvent, index: number): void {
    if (dragId === null || localOrder === null) return;
    event.preventDefault();
    const next = moveWithLocked(localOrder, dragId, index);
    if (next.join("\n") !== localOrder.join("\n")) localOrder = next;
  }

  function onDragEnd(): void {
    if (dragId === null || localOrder === null) return;
    const ordered = localOrder;
    const original = items.map((i) => i.message_id);
    dragId = null;
    localOrder = null;
    onreordering(false); // 先解锁刷新，提交后 refreshQueue 拉权威序
    if (ordered.join("\n") !== original.join("\n")) onreorder(ordered);
    else void onreorderRefreshOnly();
  }

  /** 原序拖回（取消）：无需提交，但仍要恢复一次远端视图。 */
  async function onreorderRefreshOnly(): Promise<void> {
    onreorder(items.map((i) => i.message_id));
  }
</script>

{#if items.length > 0 || editing !== null}
  <div class="mb-1.5 overflow-hidden rounded-t-lg border border-b-0 border-border bg-muted/40">
    <!-- 手风琴头：收起=预览（条数 + 下一条文本）；展开=完整列表。 -->
    <button
      type="button"
      class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70"
      onclick={() => (open = !open)}
      aria-expanded={open}
    >
      <IconChevronDown class="h-3 w-3 shrink-0 transition-transform {open ? '' : '-rotate-90'}" aria-hidden="true" />
      <span>投递队列（{items.length}）</span>
      {#if editing !== null}
        <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">编辑中（后续消息已冻结）</span>
        <span class="flex-1"></span>
        <span
          role="button"
          tabindex="0"
          class="rounded px-1.5 py-0.5 text-[10px] text-amber-600 underline underline-offset-2 hover:bg-amber-500/10"
          onclick={(e) => {
            e.stopPropagation();
            oncancel();
          }}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              oncancel();
            }
          }}
        >
          取消编辑
        </span>
      {:else if items.length > 0}
        <span class="min-w-0 flex-1 truncate text-muted-foreground/70">
          下一条：{displayItems[0]?.text ?? items[0]?.text}
        </span>
      {:else}
        <span class="flex-1"></span>
      {/if}
    </button>

    {#if open}
      <div class="border-t border-border/60 px-2 py-1.5" transition:slide={{ duration: 140 }}>
        <p class="px-0.5 pb-1 text-[10px] text-muted-foreground/60">
          逐条生效 · 拖动排序（拖动期间队列锁定）· 点锁可固定一条
        </p>
        <ul class="flex flex-col gap-1">
          {#each displayItems as item, index (item.message_id)}
            <li
              class="flex items-center gap-2 rounded border px-2 py-1 text-[12px] transition-colors {dragId === item.message_id
                ? 'border-primary/50 bg-primary/5 opacity-60'
                : 'border-border/60 bg-card'} {isLocked(item.message_id) ? 'opacity-80' : ''}"
              draggable={!isLocked(item.message_id) && editing === null && !reordering}
              ondragstart={(e) => onDragStart(e, item)}
              ondragover={(e) => onDragOver(e, index)}
              ondragend={onDragEnd}
              class:cursor-grab={!isLocked(item.message_id) && editing === null}
            >
              <!-- status：锁定位（点击主动锁定/解锁；锁定行禁操作固定原位） -->
              <button
                type="button"
                class="shrink-0 rounded p-0.5 {isLocked(item.message_id)
                  ? 'text-amber-600'
                  : 'text-muted-foreground/40 hover:text-muted-foreground'}"
                title={isLocked(item.message_id) ? "已锁定：不可编辑/删除/拖动" : "锁定该条（防误操作，排序时固定原位）"}
                aria-label={isLocked(item.message_id) ? "解锁" : "锁定"}
                onclick={() => onsetlocked(item.message_id, !isLocked(item.message_id))}
              >
                {#if isLocked(item.message_id)}
                  <IconLock class="h-3 w-3" />
                {:else}
                  <IconLockOpen class="h-3 w-3" />
                {/if}
              </button>
              <!-- 模式微标 + 单行文本 -->
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
              <!-- actions：编辑（仅排队条目）/改模式/删除；锁定或拖动中禁用 -->
              {#if item.mode === "queue"}
                <button
                  type="button"
                  class="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  title="编辑（该条及其后冻结，文本回输入框）"
                  aria-label="编辑该消息"
                  disabled={isLocked(item.message_id) || editing !== null || reordering}
                  onclick={() => onedit(item.message_id)}
                >
                  <IconPencil class="h-3 w-3" />
                </button>
              {/if}
              <Popover.Root open={modeOpenId === item.message_id} onOpenChange={(o) => (modeOpenId = o ? item.message_id : null)}>
                <Popover.Trigger>
                  {#snippet child({ props })}
                    <button
                      type="button"
                      {...props}
                      class="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                      title="修改模式（排队 / 引导 / 注入）"
                      aria-label="修改投递模式"
                      disabled={isLocked(item.message_id) || editing !== null || reordering}
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
                class="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                title="从队列删除"
                aria-label="删除该消息"
                disabled={isLocked(item.message_id) || reordering}
                onclick={() => onremove(item.message_id)}
              >
                <IconTrash class="h-3 w-3" />
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{/if}
