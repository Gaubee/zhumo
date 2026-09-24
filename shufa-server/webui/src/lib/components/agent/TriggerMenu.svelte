<!--
  Composer 触发面板（移植自 skill-creator-v2 TriggerMenu，2026-09-25 前台对齐；
  精简：去 claim/forcedOpen，保留 分组/键盘先占/自定义 matcher/pinned 行）。
  浮现语法：稿文以触发符开头且光标在首行 → composer 上方锚定列表；↑↓ 循环、
  Enter 选中、Esc 驳回（稿文再变化重新浮现）；候选 value 前缀匹配自然收起。
  键盘留 textarea（handleKeydown 先占，返回 true = composer 跳过后续处理）。
-->
<script module lang="ts">
  /** 补全候选条目：value = 完整 token（含触发符前缀，如 `/compact`）。 */
  export interface MenuEntry {
    value: string;
    description?: string;
    /** 分组标题（组切换处渲染组头）。 */
    group?: string;
    /** 渲染键（跨组同名行需唯一键；缺省 = value）。 */
    key?: string;
  }

  /** 结构性置顶行（@ 面板的 `..` 上级目录）：不受过滤约束、恒在首位。 */
  export interface PinnedMenuRow {
    value: string;
    label: string;
  }
</script>

<script lang="ts">
  let {
    trigger,
    entries,
    text,
    caretOnFirstLine,
    menuLabel,
    dataSlot,
    emptyMessage,
    sourceLabel,
    suppress = false,
    pinned,
    matcher,
    onSelect,
  }: {
    trigger: string;
    entries: readonly MenuEntry[];
    /** 当前草稿全文（查询 = 首行，多行草稿只以首行为查询）。 */
    text: string;
    /** 光标是否在首行（锚定条件）。 */
    caretOnFirstLine: boolean;
    menuLabel: string;
    /** data-slot 语义/测试锚（slash-menu / kb-menu / resource-menu）。 */
    dataSlot: string;
    /** entries 为空时的占位文案（undefined = 无候选即隐藏菜单）。 */
    emptyMessage?: string;
    /** 数据源副标题（如知识库分组数）。 */
    sourceLabel?: string;
    suppress?: boolean;
    pinned?: PinnedMenuRow;
    /** 自定义匹配器（$ 面板模糊检索）；缺省 = 大小写不敏感 startsWith。 */
    matcher?: (query: string, entry: MenuEntry) => boolean;
    onSelect: (value: string, entry?: MenuEntry) => void;
  } = $props();

  /** Esc 驳回的稿文快照：稿文再变化即重新浮现。 */
  let dismissedText = $state<string | null>(null);
  let selectedIndex = $state(0);

  const query = $derived(text.startsWith(trigger) ? (text.split("\n", 1)[0] ?? "") : "");
  const matches = $derived.by(() => {
    if (query.length === 0) return [];
    if (matcher !== undefined) return entries.filter((entry) => matcher(query, entry));
    const needle = query.toLowerCase();
    return entries.filter((entry) => entry.value.toLowerCase().startsWith(needle));
  });
  /** 空注册表占位（如知识库未建任何条目）：菜单保留但无可选项。 */
  const showEmpty = $derived(entries.length === 0 && emptyMessage !== undefined);
  const open = $derived(
    !suppress &&
      caretOnFirstLine &&
      dismissedText !== text &&
      query.length > 0 &&
      (matches.length > 0 || showEmpty || (pinned !== undefined && query.includes("/"))),
  );
  const rowCount = $derived(matches.length + (pinned !== undefined ? 1 : 0));
  const selected = $derived(Math.min(selectedIndex, Math.max(0, rowCount - 1)));
  /** 分组投序：按 entries 声明序渲染组头（组切换处落组头行）。 */
  const grouped = $derived(
    matches.map((entry, index) => ({
      entry,
      index,
      header: entry.group !== undefined && entry.group !== matches[index - 1]?.group,
    })),
  );

  function consume(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  /** 键盘先占（composer textarea 的 onkeydown 最先调用）。 */
  export function handleKeydown(event: KeyboardEvent): boolean {
    if (!open) return false;
    if (event.key === "Escape") {
      consume(event);
      dismissedText = text;
      return true;
    }
    if (rowCount === 0) {
      if (event.key === "Enter") {
        consume(event);
        return true;
      }
      return false;
    }
    if (event.key === "ArrowDown") {
      consume(event);
      selectedIndex = (selected + 1) % rowCount;
      return true;
    }
    if (event.key === "ArrowUp") {
      consume(event);
      selectedIndex = (selected - 1 + rowCount) % rowCount;
      return true;
    }
    if (event.key === "Enter") {
      consume(event);
      if (pinned !== undefined && selected === 0) {
        onSelect(pinned.value);
      } else {
        const entry = matches[selected - (pinned !== undefined ? 1 : 0)];
        if (entry) onSelect(entry.value, entry);
      }
      return true;
    }
    return false;
  }
</script>

{#if open}
  <ul
    data-slot={dataSlot}
    class="absolute bottom-full left-3 z-20 mb-1.5 max-h-64 w-80 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-md"
    aria-label={menuLabel}
  >
    {#if sourceLabel}
      <div class="px-2.5 pt-1 text-[10px] text-muted-foreground" data-menu-source="true">
        {sourceLabel}
      </div>
    {/if}
    {#if matches.length === 0 && pinned === undefined}
      <li class="cursor-default px-2.5 py-1.5 text-[11px] text-muted-foreground">
        {emptyMessage}
      </li>
    {:else}
      {#if pinned}
        <li>
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[11px] {selected ===
            0
              ? 'bg-primary/15 text-foreground'
              : 'text-muted-foreground'} hover:bg-accent/50"
            aria-current={selected === 0 ? "true" : undefined}
            data-menu-pinned="true"
            onclick={() => onSelect(pinned.value)}
          >
            <span class="shrink-0 font-medium">{pinned.label}</span>
          </button>
        </li>
      {/if}
      {#each grouped as item (item.entry.key ?? item.entry.value)}
        {#if item.header && item.entry.group}
          <li
            class="px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            data-menu-group={item.entry.group}
          >
            {item.entry.group}
          </li>
        {/if}
        <li>
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[11px] {item.index +
              (pinned !== undefined ? 1 : 0) ===
            selected
              ? 'bg-primary/15 text-foreground'
              : 'text-foreground'} hover:bg-accent/50"
            aria-current={item.index + (pinned !== undefined ? 1 : 0) === selected ? "true" : undefined}
            onclick={() => onSelect(item.entry.value, item.entry)}
          >
            <span class="shrink-0 font-medium">{item.entry.value}</span>
            {#if item.entry.description}
              <span class="truncate text-muted-foreground">{item.entry.description}</span>
            {/if}
          </button>
        </li>
      {/each}
    {/if}
  </ul>
{/if}
