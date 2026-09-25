<script lang="ts">
  /**
   * 队列抽屉（W10c，Owner 设计 2026-09-27 二轮）：输入面板上方紧贴长出的
   * 手风琴——收起=一行预览（条数 + 下一条文本），展开=完整队列列表。
   * 行布局：status（三态锁，Owner 设计 2026-09-27）+ 单行文本（含模式微标）
   * + actions（立刻发送/编辑/改模式/删除）。锁三态：解锁 / 主动锁定（点击
   * 上锁）/ 被动锁定（生效序中位于主动锁之后的条目因互斥连带锁定，点击=
   * 把主动锁上移到该行）。锁定（含被动）禁操作不可拖、重排固定原位。
   * 整行可拖动排序（HTML5 DnD）：拖动开始即全面板锁定（actions 禁用、暂停
   * 帧驱动刷新防抖动），drop 一次性提交新序。
   */
  import { slide } from "svelte/transition";
  import IconChevronDown from "@lucide/svelte/icons/chevron-down";
  import IconPencil from "@lucide/svelte/icons/pencil";
  import IconTrash from "@lucide/svelte/icons/trash";
  import IconRepeat from "@lucide/svelte/icons/repeat";
  import IconSend from "@lucide/svelte/icons/send";
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
    onsendnow,
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
    /** 立刻发送（打断当前轮 + 该条提到队头，内核收敛后自动开轮）。 */
    onsendnow: (messageId: string) => void;
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

  /**
   * 三态锁（Owner 设计）：生效序中第一把主动锁之后的全部条目被动锁定
   * （互斥连带——锁定即「从这里到队尾视为整体」）。返回每条的锁态。
   */
  const lockStateOf = $derived.by(() => {
    const states = new Map<string, "unlocked" | "locked" | "passive">();
    let frozen = false;
    for (const item of items) {
      const active = locked[item.message_id] === true;
      if (active) frozen = true;
      states.set(item.message_id, active ? "locked" : frozen ? "passive" : "unlocked");
    }
    return states;
  });
  const lockState = (id: string): "unlocked" | "locked" | "passive" =>
    lockStateOf.get(id) ?? "unlocked";
  const isLocked = (id: string): boolean => lockState(id) !== "unlocked";

  /** 两组视图（W10g 时序如实表达）：挂起组（引导/注入=当前轮下一 step 边界，
   * 时序上先于排队）在前；排队组按生效序。拖动只作用于排队组（挂起项无
   * 逐条生效序）。 */
  const queueItems = $derived.by(() => {
    if (localOrder === null) return items.filter((i) => i.mode === "queue");
    const byId = new Map(items.map((i) => [i.message_id, i]));
    return localOrder
      .map((id) => byId.get(id))
      .filter((i): i is TaskQueueItem => i !== undefined && i.mode === "queue");
  });
  const pendingItems = $derived(items.filter((i) => i.mode !== "queue"));

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
    localOrder = queueItems.map((i) => i.message_id);
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
    const original = queueItems.map((i) => i.message_id);
    dragId = null;
    localOrder = null;
    onreordering(false); // 先解锁刷新，提交后 refreshQueue 拉权威序
    if (ordered.join("\n") !== original.join("\n")) onreorder(ordered);
    else void onreorderRefreshOnly();
  }

  /** 原序拖回（取消）：无需提交，但仍要恢复一次远端视图。 */
  async function onreorderRefreshOnly(): Promise<void> {
    onreorder(queueItems.map((i) => i.message_id));
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
          {pendingItems.length > 0
            ? `即将生效：${pendingItems[0]?.text}`
            : `下一条：${queueItems[0]?.text}`}
        </span>
      {:else}
        <span class="flex-1"></span>
      {/if}
    </button>

    {#if open}
      <div class="border-t border-border/60 px-2 py-1.5" transition:slide={{ duration: 140 }}>
        <p class="px-0.5 pb-1 text-[10px] text-muted-foreground/60">
          点锁可固定一条（其后的消息连带锁定） · 拖动排序（拖动期间队列锁定）
        </p>
        {#snippet row(item: TaskQueueItem, index: number)}
          <li
            class="flex items-center gap-2 rounded border px-2 py-1 text-[12px] transition-colors {dragId === item.message_id
              ? 'border-primary/50 bg-primary/5 opacity-60'
              : 'border-border/60 bg-card'} {isLocked(item.message_id) ? 'opacity-75' : ''}"
            draggable={item.mode === "queue" && !isLocked(item.message_id) && editing === null && !reordering}
            ondragstart={(e) => onDragStart(e, item)}
            ondragover={(e) => onDragOver(e, index)}
            ondragend={onDragEnd}
            class:cursor-grab={item.mode === "queue" && !isLocked(item.message_id) && editing === null}
          >
            <!-- status：三态锁定位（主动锁点击解锁；被动锁点击=主动锁上移到该行） -->
            <button
              type="button"
              class="shrink-0 rounded p-0.5 {lockState(item.message_id) === 'locked'
                ? 'text-amber-600'
                : lockState(item.message_id) === 'passive'
                  ? 'text-amber-600/45'
                  : 'text-muted-foreground/40 hover:text-muted-foreground'}"
              title={lockState(item.message_id) === 'locked'
                ? "已主动锁定：本条及之后全部禁操作（点击解除）"
                : lockState(item.message_id) === 'passive'
                  ? "被动锁定（因本条之前有主动锁）；点击把锁定边界上移到本条"
                  : "锁定：本条及之后全部视为整体（防误操作，排序时固定）"}
              aria-label={lockState(item.message_id) === 'unlocked' ? "锁定" : "解锁"}
              onclick={() => onsetlocked(item.message_id, lockState(item.message_id) !== 'locked')}
            >
              {#if lockState(item.message_id) === 'unlocked'}
                <IconLockOpen class="h-3 w-3" />
              {:else}
                <IconLock class="h-3 w-3" />
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
            <!-- actions：立刻发送/编辑（仅排队条目）/改模式/删除；锁定或拖动中禁用 -->
            {#if item.mode === "queue"}
              <button
                type="button"
                class="shrink-0 rounded p-1 text-muted-foreground hover:bg-primary/10 hover:text-primary disabled:opacity-30"
                title="立刻发送：打断当前工作，以这条消息立即开始新一轮"
                aria-label="立刻发送该消息"
                disabled={isLocked(item.message_id) || editing !== null || reordering}
                onclick={() => onsendnow(item.message_id)}
              >
                <IconSend class="h-3 w-3" />
              </button>
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
        {/snippet}

        {#if pendingItems.length > 0}
          <p class="px-0.5 pb-1 pt-0.5 text-[10px] font-medium text-amber-600" title="当前轮的下一 step 边界立即消费——时序上先于全部排队消息">
            即将生效 · 当前轮下一步（{pendingItems.length}）
          </p>
          <ul class="mb-1.5 flex flex-col gap-1">
            {#each pendingItems as item (item.message_id)}
              {@render row(item, -1)}
            {/each}
          </ul>
        {/if}
        <p class="px-0.5 pb-1 text-[10px] font-medium text-primary" title="本轮结束后按序逐条开轮">
          排队 · 按序生效（{queueItems.length}）
        </p>
        <ul class="flex flex-col gap-1">
          {#each queueItems as item, index (item.message_id)}
            {@render row(item, index)}
          {/each}
        </ul>
      </div>
    {/if}
  </div>
{/if}
