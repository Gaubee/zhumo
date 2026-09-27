<script lang="ts">
  /**
   * 队列抽屉（W10c→W10k→W10m 重做）：输入面板上方紧贴长出的手风琴——
   * 收起=一行预览（待发/生效中计数 + 下一条），展开=完整投递序列。
   * W10k 单一有序序列：queue=开轮锚点，steer/inject=补充（绑定前方最近
   * 锚点，头部=当前轮）；分组由顺序派生，拖动重排即重新绑定。
   * W10m（Codex 体验评审落地）：①暂停显式化——行首「⏸ 暂停/▶ 恢复」
   * 文字钮（后缀只显示「已暂停」，不承担隐含点击）；②模式文案按运行态
   * （steer/inject 在 idle 与运行中生效时点不同，如实标注）；③行级 pending
   * 防重复点击；④删行内「立刻发送」主图标（高频路径收敛为发送/停止，
   * sendNow RPC 保留）；⑤拖动抓手 + 触屏命中区扩张。
   */
  import { dndzone } from "svelte-dnd-action";
  import IconChevronDown from "@lucide/svelte/icons/chevron-down";
  import IconPencil from "@lucide/svelte/icons/pencil";
  import IconTrash from "@lucide/svelte/icons/trash";
  import IconRepeat from "@lucide/svelte/icons/repeat";
  import IconGripVertical from "@lucide/svelte/icons/grip-vertical";
  import IconPause from "@lucide/svelte/icons/pause";
  import IconPlay from "@lucide/svelte/icons/play";
  import * as Popover from "$lib/components/ui/popover";
  import type { TaskQueueItem, TaskQueueMode } from "@zhumo/contracts";

  let {
    items,
    lockBoundary = null,
    editingId = null,
    reordering = false,
    pendingId = null,
    running = false,
    onedit,
    oncancel,
    onremove,
    onsetmode,
    onlock,
    onreorder,
    onreordering,
  }: {
    items: TaskQueueItem[];
    /** 锁定边界条目 id（daemon 单一事实源；null=未锁定）。 */
    lockBoundary?: string | null;
    /** 编辑目标（前端本地态；null=非编辑）。 */
    editingId?: string | null;
    /** 拖动进行中（store 置位：帧驱动刷新暂停）。 */
    reordering?: boolean;
    /** 行级请求中（W10m：该条 RPC 未落定前行按钮禁用）。 */
    pendingId?: string | null;
    /** 任务运行中（模式文案按运行态切换）。 */
    running?: boolean;
    onedit: (messageId: string) => void;
    oncancel: () => void;
    onremove: (messageId: string) => void;
    onsetmode: (messageId: string, mode: TaskQueueMode) => void;
    /** 暂停/恢复（null=恢复放回；daemon 持久化）。 */
    onlock: (messageId: string | null) => void;
    onreorder: (orderedIds: string[]) => void;
    /** 拖动期面板锁（Svelte 5 props 不可反写——经回调置 store）。 */
    onreordering: (v: boolean) => void;
  } = $props();

  const MODE_CYCLE: TaskQueueMode[] = ["queue", "steer", "inject"];

  /** 模式文案（W10m/Codex P2：按运行态如实标注生效时点——idle 时 steer
   * 等价开新轮、inject 不唤醒；写死「本轮」与实际投递不一致）。 */
  function modeLabel(mode: TaskQueueMode, isRunning: boolean): string {
    if (mode === "queue") return "下一轮";
    if (mode === "steer") return isRunning ? "本轮补充" : "新开一轮";
    return isRunning ? "本轮注入" : "待活动轮";
  }

  let open = $state(false);
  let modeOpenId = $state<string | null>(null);
  /** 队列从空到非空即自动展开（W10m/Codex P2：队列存在时直接可见，少一次
   * 点击）；用户手动收起后保持，直到队列清空再来新一轮。 */
  let hadItems = false;
  $effect(() => {
    const has = items.length > 0;
    if (has && !hadItems) open = true;
    hadItems = has;
  });

  /**
   * 三态（Owner 设计四轮+W10m 显式化）：held 条目=暂停段（daemon 持久化，
   * 内核不消费——可安全编辑/删除/拖动）；lockBoundary=边界条（段内其余为
   * 被动暂停）。只有边界条「▶ 恢复」可点；后缀「已暂停」纯展示（不承担
   * 隐含点击——要上移边界先恢复再在新行暂停）。
   */
  const lockStateOf = $derived.by(() => {
    const states = new Map<string, "unlocked" | "locked" | "passive">();
    for (const item of items) {
      // 拖动进行中：全部未停条目进入被动暂停观感（拖动时队列稳定）；暂停段维持原态。
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

  /** W10k 单一序列：queue=anchor（开轮锚点），steer/inject=attach（补充，
   * 绑定前方最近 anchor；头部 attach=当前轮）。inflight 只读不参与操作。 */
  const listItems = $derived(items.filter((i) => i.inflight !== true));
  const inflightCount = $derived(items.length - listItems.length);
  /** 收起态预览：队头下一条要生效的内容（文案按运行态——与模式徽标同口径，
   * Codex P2：idle 的 steer 写「即将生效」与实际「开新一轮」不符）。 */
  const previewText = $derived.by(() => {
    const first = listItems[0];
    if (first === undefined) return null;
    if (first.mode === 'queue') return `下一条（新开一轮）：${first.text}`;
    if (first.mode === 'steer') return running ? `即将生效（本轮下一步补充）：${first.text}` : `下一条（新开一轮）：${first.text}`;
    return running ? `即将注入（本轮上下文）：${first.text}` : `待活动轮注入：${first.text}`;
  });

  /** dnd-action 容器 items（库要求可变数组带 id；拖动中库实时回写=插入预览）。
   * 拖动外不承担渲染职责（Codex UX P1：只比 id 回灌会漏同 id 的文本/模式
   * 变更——「编辑后队列还是旧的」根因）：非拖动期渲染走 rowItems（props 直
   * 派生），dndItems 仅拖动预览用，松手即被 items 重灌。 */
  let dndItems = $state<Array<TaskQueueItem & { id: string }>>([]);
  $effect(() => {
    if (reordering) return;
    dndItems = listItems.map((i) => ({ ...i, id: i.message_id }));
  });
  /** 非拖动期渲染源（props 直派生——内容变更即时反映）。 */
  const rowItems = $derived(reordering ? null : listItems);

  /** 行绑定（anchor/当前轮）——与 dndRows 同规则的单条版本。 */
  function boundOf(item: TaskQueueItem): "current" | "anchor" {
    if (item.mode === "queue") return "anchor";
    const idx = listItems.indexOf(item);
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (listItems[i]!.mode === "queue") return "anchor";
    }
    return "current";
  }

  /** 行分组派生（dnd 容器版，与 boundOf 同规则）。 */
  const dndRows = $derived.by(() => {
    const rows: Array<{ item: TaskQueueItem & { id: string }; bound: 'current' | 'anchor' }> = [];
    let seenAnchor = false;
    for (const item of dndItems) {
      if (item.mode === 'queue') {
        seenAnchor = true;
        rows.push({ item, bound: 'anchor' });
      } else {
        rows.push({ item, bound: seenAnchor ? 'anchor' : 'current' });
      }
    }
    return rows;
  });

  /** 行按钮禁用态（W10n：编辑/拖动全局态 + 行级 pending——只禁本行，不再
   * 全队列锁死；Codex P2：全局 pending 锁误伤并行操作）。 */
  const rowBusy = (id: string): boolean =>
    editingId !== null || reordering || pendingId === id;

  function handleDndItems(newItems: Array<Record<string, unknown>>): void {
    // 库 consider 回写（拖动开始的首次 consider 也走这里）：开启拖动态——
    // 通知 daemon 暂停消费 + reordering 置位（$effect 停止回灌，预览序保得住）。
    if (!reordering) onreordering(true);
    dndItems = newItems as Array<TaskQueueItem & { id: string }>;
  }

  function onDndFinalize(newItems: Array<Record<string, unknown>>): void {
    dndItems = newItems as Array<TaskQueueItem & { id: string }>;
    // 松手：daemon 恢复消费与 reordering 生命周期都由 reorderQueue 接管
    // （Codex 三轮 P2：reordering 保持到重排 RPC 落定，行按钮不在新序
    // 未提交窗口恢复；原序拖回也走它——finally 恢复权威视图）。
    onreorder(newItems.map((n) => String(n.id)));
  }
</script>

{#if items.length > 0 || editingId !== null}
  <div class="mb-1.5 overflow-hidden rounded-t-lg border border-b-0 border-border bg-muted/40">
    <!-- 手风琴头：收起=计数（待发/生效中拆分）+ 下一条预览；展开=完整列表。 -->
    <button
      type="button"
      class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70"
      onclick={() => (open = !open)}
      aria-expanded={open}
    >
      <IconChevronDown class="h-3 w-3 shrink-0 transition-transform {open ? '' : '-rotate-90'}" aria-hidden="true" />
      <span>队列 · 待发 {listItems.length}{inflightCount > 0 ? ` · 生效中 ${inflightCount}` : ''}</span>
      {#if editingId !== null}
        <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">编辑中（暂停段内，Esc 取消）</span>
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
          {previewText ?? ''}
        </span>
      {:else}
        <span class="flex-1"></span>
      {/if}
    </button>

    {#if open}
      <!-- 无过渡动画（W10k）：svelte slide 的 JS 过渡在标签页隐藏/动画节流时会冻结
           在 0 高+0 透明态——内容与输入框重叠、拖拽失效（实测两次）。开合即时。 -->
      <div class="border-t border-border/60 px-2 py-1.5">
        <p class="px-0.5 pb-1 text-[10px] text-muted-foreground/60">
          拖动排序 · ⏸ 从这里暂停 · 点模式徽标改投递方式
        </p>
        {#snippet row(r: { item: TaskQueueItem; bound: 'current' | 'anchor' })}
          {@const item = r.item}
          {@const ls = lockState(item.message_id)}
          {@const busy = rowBusy(item.message_id)}
          {@const selfPending = pendingId === item.message_id}
          <li
            class="flex items-center gap-1.5 rounded border border-border/60 bg-card px-2 py-1 text-[12px] transition-colors {r.bound === 'anchor' && item.mode !== 'queue'
              ? 'ml-4 border-l-2 border-l-primary/30'
              : ''} {isHeld(item.message_id) ? 'opacity-75' : ''} {selfPending ? 'opacity-60' : ''}"
            aria-busy={selfPending}
          >
            <!-- 拖动抓手（W10m/触屏专项：抓手显式化——整行可拖但抓手示意拖动起点）。 -->
            <IconGripVertical class="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/35" aria-hidden="true" />
            <!-- 暂停（W10m 显式化）：未停=「⏸ 暂停」（点击=该条及之后暂停）；
                 边界=「▶ 恢复」（点击=全段放回）；后缀=「已暂停」纯展示。 -->
            {#if ls === 'locked'}
              <button
                type="button"
                class="q-hit q-pause shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 hover:bg-amber-500/25 disabled:opacity-40"
                title="恢复发送：该条及之后按原序继续"
                aria-label="恢复发送"
                disabled={busy}
                onclick={() => onlock(null)}
              >
                <IconPlay class="h-3 w-3" />
                恢复
              </button>
            {:else if ls === 'passive'}
              <!-- 暂停段内：可点「移到这里」原子挪边界（daemon 侧释放前缀即泵，
                   Codex P1-4：恢复→再暂停的两步竞态会丢目标条目）。 -->
              <button
                type="button"
                class="q-hit q-pause shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600/70 hover:bg-amber-500/20 hover:text-amber-600 disabled:opacity-40"
                title="已暂停（该条在暂停段内）；点击把暂停边界移到这里（之前的条目恢复发送）"
                aria-label="把暂停边界移到这里"
                disabled={busy}
                onclick={() => onlock(item.message_id)}
              >
                <IconPause class="h-3 w-3" />
                已暂停
              </button>
            {:else}
              <button
                type="button"
                class="q-hit q-pause shrink-0 rounded-full px-2 py-0.5 text-[10px] text-muted-foreground/70 hover:bg-muted hover:text-foreground disabled:opacity-40"
                title="从这里暂停：本条及之后不再自动发送，可安全编辑"
                aria-label="从这里暂停"
                disabled={busy}
                onclick={() => onlock(item.message_id)}
              >
                <IconPause class="h-3 w-3" />
                暂停
              </button>
            {/if}
            <!-- 模式徽标（文案按运行态）+ 单行文本：下一轮=主色锚点；补充·当前轮=琥珀。 -->
            {#if r.bound === 'current' && item.mode !== 'queue'}
              <span
                class="shrink-0 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600"
                title="补充当前轮：下一 step 边界生效（idle 时引导会开新轮）"
              >
                本轮
              </span>
            {/if}
            <span
              class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] {item.mode === 'queue'
                ? 'bg-primary/10 text-primary'
                : item.mode === 'steer'
                  ? 'bg-amber-500/15 text-amber-600'
                  : 'bg-violet-500/15 text-violet-600'}"
              title={item.mode === 'queue' ? '下一轮：新起一轮逐条发送' : item.mode === 'steer' ? (running ? '引导：本轮下一 step 边界生效' : '引导：idle 时等价开新轮') : '注入：作为上下文补充，不唤醒（等下一次活动轮）'}
            >
              {modeLabel(item.mode, running)}
            </span>
            <span class="min-w-0 flex-1 truncate" title={item.text}>{item.text}</span>
            <!-- actions：编辑/改模式/删除（W10m：删「立刻发送」主图标——低频高险，
                 语义由模式+自然投递覆盖；触屏命中区经 .q-hit 扩张）。 -->
            <button
              type="button"
              class="q-hit shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              title={isHeld(item.message_id) ? '编辑暂停段消息（安全：恢复前不会发送）' : '编辑（该条及其后暂停，文本回输入框）'}
              aria-label="编辑该消息"
              disabled={busy}
              onclick={() => onedit(item.message_id)}
            >
              <IconPencil class="h-3.5 w-3.5" />
            </button>
            <Popover.Root open={modeOpenId === item.message_id} onOpenChange={(o) => (modeOpenId = o ? item.message_id : null)}>
              <Popover.Trigger>
                {#snippet child({ props })}
                  <button
                    type="button"
                    {...props}
                    class="q-hit shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                    title={isHeld(item.message_id) ? "修改模式：改引导/注入会立即生效（脱离暂停段）" : "修改投递方式"}
                    aria-label="修改投递方式"
                    disabled={busy}
                  >
                    <IconRepeat class="h-3.5 w-3.5" />
                  </button>
                {/snippet}
              </Popover.Trigger>
              <Popover.Content side="top" align="end" class="w-44 p-1">
                {#each MODE_CYCLE as mode (mode)}
                  <button
                    type="button"
                    class="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] hover:bg-muted {mode === item.mode ? 'font-medium text-primary' : ''}"
                    onclick={() => {
                      if (mode !== item.mode) onsetmode(item.message_id, mode);
                      modeOpenId = null;
                    }}
                  >
                    <span>{modeLabel(mode, running)}</span>
                    {#if mode === item.mode}
                      <span class="text-[10px] text-muted-foreground">当前</span>
                    {/if}
                  </button>
                {/each}
              </Popover.Content>
            </Popover.Root>
            <button
              type="button"
              class="q-hit shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
              title={isHeld(item.message_id) ? "从暂停段删除（安全，立即生效）" : "从队列删除"}
              aria-label="删除该消息"
              disabled={busy}
              onclick={() => onremove(item.message_id)}
            >
              <IconTrash class="h-3.5 w-3.5" />
            </button>
          </li>
        {/snippet}

        <p class="px-0.5 pb-1 text-[10px] font-medium text-primary" title="单一序列：下一轮条目之间逐轮发送，引导/注入跟随各自的开轮条目">
          投递序列（{listItems.length}）
        </p>
        <!-- dnd 容器（svelte-dnd-action）：整条序列一个容器——实时插入预览（占位
             动画），松手落定；补充条目拖过开轮条目即重新绑定。 -->
        <section
          class="dnd-queue flex flex-col gap-1"
          use:dndzone={{ items: dndItems, flipDurationMs: 120, delayTouchStart: 120 } as never}
          onconsider={(e) => handleDndItems(e.detail.items)}
          onfinalize={(e) => onDndFinalize(e.detail.items)}
        >
          {#if rowItems !== null}
            {#each rowItems as item (item.message_id)}
              {@render row({ item, bound: boundOf(item) })}
            {/each}
          {:else}
            {#each dndRows as r (r.item.id)}
              {@render row(r)}
            {/each}
          {/if}
        </section>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* 触屏命中区扩张（W10m/Codex 触屏专项）：图标视觉保持 14px，命中区经
   * ::after 外扩 ~14px（合计 ≥30px），行高不膨胀。 */
  .q-hit {
    position: relative;
  }
  .q-hit::after {
    content: "";
    position: absolute;
    inset: -7px;
  }
  /* 文字钮（暂停/恢复）同样外扩，但小于其胶囊自身时不生效也无害。 */
  .q-pause::after {
    inset: -5px;
  }

  /* 拖动浮影（svelte-dnd-action 克隆行、id=dnd-action-dragged-el、position:fixed）：
   * 克隆发生在拖动起始帧——冻结在起始状态。拖动中全员进入「已暂停」观感，
   * 操作按钮禁用 + 抓取浮层阴影。 */
  :global(#dnd-action-dragged-el) {
    box-shadow: 0 10px 24px rgb(0 0 0 / 0.14);
  }
  :global(#dnd-action-dragged-el) button {
    opacity: 0.35;
    pointer-events: none;
  }
</style>
