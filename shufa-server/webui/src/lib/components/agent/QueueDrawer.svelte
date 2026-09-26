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
  import { dndzone } from "svelte-dnd-action";
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
    lockBoundary = null,
    editingId = null,
    reordering = false,
    onedit,
    oncancel,
    onremove,
    onsetmode,
    onlock,
    onreorder,
    onreordering,
    onsendnow,
  }: {
    items: TaskQueueItem[];
    /** 锁定边界条目 id（daemon 单一事实源；null=未锁定）。 */
    lockBoundary?: string | null;
    /** 编辑目标（前端本地态；null=非编辑）。 */
    editingId?: string | null;
    /** 拖动进行中（store 置位：帧驱动刷新暂停）。 */
    reordering?: boolean;
    onedit: (messageId: string) => void;
    oncancel: () => void;
    onremove: (messageId: string) => void;
    onsetmode: (messageId: string, mode: TaskQueueMode) => void;
    /** 锁定/解锁（null=解锁放回；daemon 持久化）。 */
    onlock: (messageId: string | null) => void;
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

  /**
   * 三态锁（Owner 设计四轮重做）：held 条目=锁定段（daemon 持久化，内核不消
   * 费——可安全编辑/删除/拖动）；lockBoundary=边界条（段内其余为被动锁定）。
   */
  const lockStateOf = $derived.by(() => {
    const states = new Map<string, "unlocked" | "locked" | "passive">();
    for (const item of items) {
      // 拖动进行中：全部未锁条目进入被动锁定（Owner 设计——拖动时整队列
      // 稳定，松手恢复）；锁定段维持原态。
      if (reordering && !item.held) {
        states.set(item.message_id, "passive");
        continue;
      }
      states.set(
        item.message_id,
        item.held ? (item.message_id === lockBoundary ? "locked" : "passive") : "unlocked",
      );
    }
    return states;
  });
  const lockState = (id: string): "unlocked" | "locked" | "passive" =>
    lockStateOf.get(id) ?? "unlocked";
  const isHeld = (id: string): boolean => items.find((i) => i.message_id === id)?.held === true;

  /** 两组视图（W10g 时序如实表达）：挂起组（引导/注入=当前轮下一 step 边界，
   * 时序上先于排队）在前；排队组按生效序（含 held 锁定段）。dnd 容器只装
   * 排队组——挂起项无逐条生效序。 */
  const queueItems = $derived(items.filter((i) => i.mode === "queue"));
  const pendingItems = $derived(items.filter((i) => i.mode !== "queue"));

  /** dnd-action 容器 items（库要求可变数组带 id；拖动中库实时回写=插入预览）。
   * 与 props 同步：非拖动期以 props 为准（items 变化重灌），拖动期不动。 */
  let dndItems = $state<Array<TaskQueueItem & { id: string }>>([]);
  let syncing = false;
  $effect(() => {
    if (reordering) return;
    const next = queueItems.map((i) => ({ ...i, id: i.message_id }));
    if (JSON.stringify(next.map((n) => n.id)) !== JSON.stringify(dndItems.map((n) => n.id)) || syncing) {
      syncing = false;
      dndItems = next;
    }
  });

  function handleDndItems(newItems: Array<Record<string, unknown>>): void {
    // 库 consider 回写（拖动开始的首次 consider 也走这里）：开启拖动态——
    // 通知 daemon 暂停消费 + reordering 置位（$effect 停止回灌，预览序保得住）。
    if (!reordering) onreordering(true);
    syncing = true;
    dndItems = newItems as Array<TaskQueueItem & { id: string }>;
  }

  function onDndFinalize(newItems: Array<Record<string, unknown>>): void {
    dndItems = newItems as Array<TaskQueueItem & { id: string }>;
    onreordering(false); // 松手：恢复消费 + 帧驱动刷新
    onreorder(newItems.map((n) => String(n.id))); // 原序拖回也走它——reorderQueue finally 恢复远端视图
  }
</script>

{#if items.length > 0 || editingId !== null}
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
      {#if editingId !== null}
        <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">编辑中（锁定段内，Esc 取消不改锁）</span>
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
          点锁=该条起暂停发送进入管理态（编辑/删除安全） · 再点解锁放回 · 拖动排序（未锁定条）
        </p>
        {#snippet row(item: TaskQueueItem)}
          <li
            class="flex items-center gap-2 rounded border border-border/60 bg-card px-2 py-1 text-[12px] transition-colors {isHeld(item.message_id) ? 'opacity-75' : ''}"
          >
            <!-- status：三态锁定位（边界锁点击=解锁放回；被动锁点击=边界上移到该行；未锁点击=锁定）。
                 开/闭两个图标常驻 DOM 由 data-lock CSS 切换（不 {#if} 切换）——拖动库在起始帧
                 克隆行作为浮影，克隆体不随后续重渲染更新，双图标+CSS 才能让浮影正确呈被动锁。 -->
            <button
              type="button"
              data-lock={lockState(item.message_id)}
              class="shrink-0 rounded p-0.5 {lockState(item.message_id) === 'locked'
                ? 'text-amber-600'
                : lockState(item.message_id) === 'passive'
                  ? 'text-amber-600/45'
                  : 'text-muted-foreground/40 hover:text-muted-foreground'}"
              title={lockState(item.message_id) === 'locked'
                ? "锁定边界：本条及之后暂停发送（可编辑/删除）；点击解锁全部放回"
                : lockState(item.message_id) === 'passive'
                  ? "被动锁定（锁定段内）；点击把锁定边界上移到本条"
                  : "锁定：本条及之后暂停发送，进入稳定管理态（编辑/删除随时做）"}
              aria-label={lockState(item.message_id) === 'unlocked' ? "锁定" : "调整锁定"}
              onclick={() =>
                onlock(lockState(item.message_id) === 'locked' ? null : item.message_id)}
            >
              <IconLockOpen class="h-3 w-3 lock-ico-open" />
              <IconLock class="h-3 w-3 lock-ico-closed" />
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
                title={isHeld(item.message_id) ? "立刻发送：先解锁放回，再打断当前工作以本条开新一轮" : "立刻发送：打断当前工作，以这条消息立即开始新一轮"}
                aria-label="立刻发送该消息"
                disabled={editingId !== null || reordering}
                onclick={() => onsendnow(item.message_id)}
              >
                <IconSend class="h-3 w-3" />
              </button>
              <button
                type="button"
                class="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                title={isHeld(item.message_id) ? "编辑锁定段消息（安全：解锁前不会发送）" : "编辑（该条及其后锁定，文本回输入框）"}
                aria-label="编辑该消息"
                disabled={editingId !== null || reordering}
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
                    title={isHeld(item.message_id) ? "修改模式：改引导/注入会立即生效（脱离锁定段）" : "修改模式（排队 / 引导 / 注入）"}
                    aria-label="修改投递模式"
                    disabled={editingId !== null || reordering}
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
              title={isHeld(item.message_id) ? "从锁定段删除（安全，立即生效）" : "从队列删除"}
              aria-label="删除该消息"
              disabled={reordering}
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
              {@render row(item)}
            {/each}
          </ul>
        {/if}
        <p class="px-0.5 pb-1 text-[10px] font-medium text-primary" title="本轮结束后按序逐条开轮">
          排队 · 按序生效（{queueItems.length}）
        </p>
        <!-- dnd 容器（svelte-dnd-action）：实时插入预览（占位动画），松手落定。 -->
        <section
          class="dnd-queue flex flex-col gap-1"
          use:dndzone={{ items: dndItems, flipDurationMs: 120, dropTargetStyle: {} } as never}
          onconsider={(e) => handleDndItems(e.detail.items)}
          onfinalize={(e) => onDndFinalize(e.detail.items)}
        >
          {#each dndItems as item (item.id)}
            {@render row(item)}
          {/each}
        </section>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* 三态锁图标切换（data-lock 属性驱动；双图标常驻 DOM 的原因见上方模板注释）。
   * 图标类在 lucide 子组件的 svg 上，本组件 hash class 不落在那里——图标类
   * 一律 :global()（克隆体会原样复制这些类，规则对浮影同样生效）。 */
  button[data-lock='unlocked'] :global(.lock-ico-closed) {
    display: none;
  }
  button[data-lock='locked'] :global(.lock-ico-open),
  button[data-lock='passive'] :global(.lock-ico-open) {
    display: none;
  }

  /* 拖动浮影（svelte-dnd-action 克隆行、id=dnd-action-dragged-el、position:fixed）：
   * 克隆发生在拖动起始帧——早于 reordering=true 的重渲染，冻结在未锁态。
   * 拖动中全员被动锁定（Owner 设计），浮影同样以被动锁呈现：琥珀闭锁 +
   * 操作按钮禁用观感 + 抓取浮层阴影。 */
  :global(#dnd-action-dragged-el) {
    box-shadow: 0 10px 24px rgb(0 0 0 / 0.14);
  }
  :global(#dnd-action-dragged-el) :global(.lock-ico-open) {
    display: none;
  }
  :global(#dnd-action-dragged-el) :global(.lock-ico-closed) {
    display: block;
  }
  :global(#dnd-action-dragged-el) button[data-lock] {
    color: rgb(217 119 6 / 0.55);
  }
  :global(#dnd-action-dragged-el) button:not([data-lock]) {
    opacity: 0.3;
  }
</style>
