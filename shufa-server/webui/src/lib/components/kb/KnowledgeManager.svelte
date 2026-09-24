<!--
  知识库管理（Owner 2026-09-22：书法领域知识面——两级结构 分组→键值，git 修订历史）。
  设计要点：
  1. 左：分组列表（说明 + 条目数；新建/改名/删除）；右：选中分组的条目编辑器
     （key + value 文本域；新增/改名/保存/删除）。操作直落 daemon（每次写 = 一个
     git commit），返回的全量 groups 即时回填。
  2. 历史：右滑面板（git log 列表 → 修订详情：变更文件 + 快照 → 恢复到此版）。
     available=false（目标设备缺 git）时提示安装，读写不受影响。
  3. 实时性：agent 会话可能并行写库——本组件挂载期间每 5s 轮询刷新（编辑中的
     文本域不覆盖，只在内容未修改时回填）。
-->
<script lang="ts">
  import IconHistory from "@lucide/svelte/icons/history";
  import IconPencil from "@lucide/svelte/icons/pencil";
  import IconPlus from "@lucide/svelte/icons/plus";
  import IconTrash2 from "@lucide/svelte/icons/trash-2";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { api } from "$lib/api";
  import type { KbGroupView, KbRevisionDetailView, KbRevisionView } from "$lib/types";

  let groups = $state<KbGroupView[]>([]);
  let selected = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let busy = $state(false);
  /** 编辑中的条目草稿：group/key → value。仅未手动修改过的草稿会被轮询回填覆盖。 */
  let drafts = $state<Record<string, string>>({});
  let draftTouched = $state<Record<string, boolean>>({});

  // ---- 分组操作 ----
  let newGroupName = $state("");
  let renameTarget = $state<KbGroupView | null>(null);
  let renameValue = $state("");
  let deleteGroupTarget = $state<KbGroupView | null>(null);

  // ---- 条目操作 ----
  let newEntryKey = $state("");
  let deleteEntryTarget = $state<string | null>(null);

  // ---- 历史 ----
  let historyOpen = $state(false);
  let historyAvailable = $state(true);
  let revisions = $state<KbRevisionView[]>([]);
  let revisionDetail = $state<KbRevisionDetailView | null>(null);
  let restoreTarget = $state<KbRevisionView | null>(null);

  $effect(() => {
    void refresh();
  });

  /** 5s 轮询：agent 并行写入实时可见（编辑中草稿不覆盖）。 */
  $effect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, 5000);
    return () => clearInterval(timer);
  });

  const current = $derived(groups.find((g) => g.name === selected) ?? null);

  async function refresh(silent = false): Promise<void> {
    try {
      groups = await api.listKb();
      if (selected === null || !groups.some((g) => g.name === selected)) {
        selected = groups[0]?.name ?? null;
      }
      if (!silent) loadError = null;
    } catch (e) {
      if (!silent) loadError = e instanceof Error ? e.message : String(e);
    }
  }

  function draftOf(group: string, key: string, fallback: string): string {
    const id = `${group}/${key}`;
    if (drafts[id] === undefined) {
      drafts[id] = fallback;
      draftTouched[id] = false;
    }
    return drafts[id]!;
  }

  async function run(action: () => Promise<KbGroupView[]>): Promise<void> {
    busy = true;
    try {
      groups = await action();
      loadError = null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function createGroup(): Promise<void> {
    const name = newGroupName.trim();
    if (!name) return;
    await run(() => api.saveKbGroup({ name }));
    selected = name;
    newGroupName = "";
  }

  async function renameGroup(): Promise<void> {
    if (renameTarget === null) return;
    const newName = renameValue.trim();
    if (!newName || newName === renameTarget.name) {
      renameTarget = null;
      return;
    }
    const old = renameTarget.name;
    await run(() => api.saveKbGroup({ name: old, newName }));
    if (selected === old) selected = newName;
    renameTarget = null;
  }

  async function removeGroup(): Promise<void> {
    const target = deleteGroupTarget;
    if (target === null) return;
    await run(() => api.deleteKbGroup(target.name));
    if (selected === target.name) selected = groups[0]?.name ?? null;
    deleteGroupTarget = null;
  }

  async function createEntry(): Promise<void> {
    if (current === null) return;
    const key = newEntryKey.trim();
    if (!key) return;
    await run(() => api.saveKbEntry({ group: current.name, key, value: "（待填写）" }));
    newEntryKey = "";
  }

  async function saveEntry(key: string, newKey?: string): Promise<void> {
    if (current === null) return;
    const id = `${current.name}/${key}`;
    await run(() =>
      api.saveKbEntry({ group: current.name, key, value: drafts[id] ?? "", newKey }),
    );
    if (newKey) {
      drafts[`${current.name}/${newKey}`] = drafts[id] ?? "";
      delete drafts[id];
    }
    draftTouched[id] = false;
  }

  async function removeEntry(): Promise<void> {
    const target = deleteEntryTarget;
    if (current === null || target === null) return;
    await run(() => api.deleteKbEntry(current.name, target));
    delete drafts[`${current.name}/${target}`];
    delete draftTouched[`${current.name}/${target}`];
    deleteEntryTarget = null;
  }

  async function openHistory(): Promise<void> {
    historyOpen = true;
    revisionDetail = null;
    try {
      const out = await api.listKbRevisions();
      historyAvailable = out.available;
      revisions = out.revisions;
    } catch (e) {
      historyAvailable = false;
      revisions = [];
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  async function viewRevision(id: string): Promise<void> {
    try {
      revisionDetail = await api.getKbRevision(id);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  async function doRestore(): Promise<void> {
    if (restoreTarget === null) return;
    busy = true;
    try {
      await api.restoreKb(restoreTarget.id);
      await refresh();
      await openHistory();
      restoreTarget = null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function fmtTime(iso: string): string {
    return iso.replace("T", " ").slice(0, 16);
  }

  function statusText(s: string): string {
    return s === "added" ? "新增" : s === "deleted" ? "删除" : "修改";
  }
</script>

<div class="flex h-full min-h-0 flex-col gap-3 p-4">
  <div class="mx-auto flex w-full max-w-4xl shrink-0 items-center justify-between">
    <div>
      <h2 class="text-sm font-medium">知识库</h2>
      <p class="text-[11px] text-muted-foreground">
        书法领域知识与总结模式（分组 → 条目）。每次变更记入 git 历史，agent 写总结前经 MCP 读取。
      </p>
    </div>
    <Button size="sm" variant="outline" onclick={() => void openHistory()}>
      <IconHistory data-icon="inline-start" />
      修订历史
    </Button>
  </div>

  {#if loadError}
    <div class="mx-auto w-full max-w-4xl">
      <p class="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
        {loadError}
      </p>
    </div>
  {/if}

  <div class="mx-auto flex min-h-0 w-full max-w-4xl flex-1 gap-3">
    <!-- 左：分组 -->
    <aside class="flex w-52 shrink-0 flex-col gap-2 rounded-lg border bg-card p-2">
      <div class="flex items-center gap-1">
        <Input
          bind:value={newGroupName}
          placeholder="新分组名"
          class="h-7 text-xs"
          onkeydown={(e) => e.key === "Enter" && void createGroup()}
        />
        <Button size="xs" variant="ghost" disabled={busy || !newGroupName.trim()} onclick={() => void createGroup()} aria-label="创建分组">
          <IconPlus class="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {#each groups as group (group.name)}
          <button
            type="button"
            aria-current={selected === group.name ? "true" : undefined}
            class="group flex flex-col rounded-md px-2.5 py-2 text-left transition-colors {selected === group.name
              ? 'bg-accent-soft text-accent-foreground'
              : 'hover:bg-muted/60'}"
            onclick={() => (selected = group.name)}
          >
            <span class="flex w-full items-center justify-between gap-1">
              <span class="truncate text-xs font-medium">{group.name}</span>
              <span class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <span
                  role="button"
                  tabindex="0"
                  class="rounded p-0.5 hover:bg-muted"
                  aria-label="重命名分组"
                  onclick={(e) => {
                    e.stopPropagation();
                    renameTarget = group;
                    renameValue = group.name;
                  }}
                  onkeydown={(e) => e.key === "Enter" && ((e.stopPropagation(), (renameTarget = group), (renameValue = group.name)))}
                >
                  <IconPencil class="h-3 w-3" aria-hidden="true" />
                </span>
                <span
                  role="button"
                  tabindex="0"
                  class="rounded p-0.5 text-destructive hover:bg-muted"
                  aria-label="删除分组"
                  onclick={(e) => {
                    e.stopPropagation();
                    deleteGroupTarget = group;
                  }}
                  onkeydown={(e) => e.key === "Enter" && ((e.stopPropagation(), (deleteGroupTarget = group)))}
                >
                  <IconTrash2 class="h-3 w-3" aria-hidden="true" />
                </span>
              </span>
            </span>
            <span class="text-[10px] text-muted-foreground">{group.entries.length} 条</span>
          </button>
        {/each}
      </div>
    </aside>

    <!-- 右：条目编辑器 -->
    <section class="flex min-h-0 flex-1 flex-col rounded-lg border bg-card">
      {#if current === null}
        <div class="flex flex-1 items-center justify-center text-xs text-muted-foreground">尚无分组——左侧创建一个</div>
      {:else}
        <div class="shrink-0 border-b px-3 py-2">
          <p class="text-xs font-medium">{current.name}</p>
          <p class="mt-0.5 text-[11px] leading-snug text-muted-foreground">{current.note}</p>
        </div>
        <div class="flex shrink-0 items-center gap-1 border-b px-3 py-2">
          <Input
            bind:value={newEntryKey}
            placeholder="新条目名"
            class="h-7 max-w-56 text-xs"
            onkeydown={(e) => e.key === "Enter" && void createEntry()}
          />
          <Button size="xs" variant="ghost" disabled={busy || !newEntryKey.trim()} onclick={() => void createEntry()} aria-label="新增条目">
            <IconPlus class="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          {#each current.entries as entry (entry.key)}
            {@const id = `${current.name}/${entry.key}`}
            <div class="rounded-md border p-2">
              <div class="mb-1 flex items-center justify-between gap-2">
                <Input
                  class=" h-7 max-w-64 text-xs font-medium"
                  value={entry.key}
                  aria-label="条目名"
                  onchange={(e) => {
                    const next = e.currentTarget.value.trim();
                    if (next && next !== entry.key) void saveEntry(entry.key, next);
                    else e.currentTarget.value = entry.key;
                  }}
                />
                <span class="flex items-center gap-1">
                  <Button size="xs" disabled={busy || !draftTouched[id]} onclick={() => void saveEntry(entry.key)}>保存</Button>
                  <Button size="xs" variant="ghost" class="text-destructive" disabled={busy} onclick={() => (deleteEntryTarget = entry.key)}>
                    删除
                  </Button>
                </span>
              </div>
              <textarea
                rows="5"
                class="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs leading-relaxed"
                value={draftOf(current.name, entry.key, entry.value)}
                oninput={(e) => {
                  drafts[id] = e.currentTarget.value;
                  draftTouched[id] = e.currentTarget.value !== entry.value;
                }}
                aria-label="条目内容"
              ></textarea>
            </div>
          {/each}
          {#if current.entries.length === 0}
            <p class="py-6 text-center text-xs text-muted-foreground">本分组暂无条目</p>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</div>

<!-- 历史面板 -->
<Dialog.Root bind:open={historyOpen}>
  <Dialog.Content class="max-w-2xl p-5">
    <Dialog.Title class="flex items-center gap-2 text-sm font-medium">
      <IconHistory class="h-4 w-4" aria-hidden="true" />
      修订历史（git）
    </Dialog.Title>
    <Dialog.Description class="mt-1 text-[11px] text-muted-foreground">
      {#if historyAvailable}
        每次变更（后台/agent/系统）各一个提交；恢复操作生成新提交，历史不丢。
      {:else}
        当前设备未检测到 git——知识库可正常读写，但无历史记录。安装 git 后自动启用。
      {/if}
    </Dialog.Description>
    <div class="mt-3 max-h-96 overflow-y-auto">
      {#if !historyAvailable}
        <p class="py-6 text-center text-xs text-muted-foreground">无历史可显示</p>
      {:else if revisionDetail !== null}
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <Button size="xs" variant="ghost" onclick={() => (revisionDetail = null)}>← 返回列表</Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onclick={() => {
                const r = revisionDetail;
                if (r !== null) restoreTarget = r.revision;
              }}
            >
              恢复到此版本
            </Button>
          </div>
          <p class="text-xs font-medium">
            {revisionDetail.revision.summary}
          </p>
          <p class="text-[11px] text-muted-foreground">
            {fmtTime(revisionDetail.revision.at)} · {revisionDetail.revision.actor} · {revisionDetail.revision.id}
          </p>
          <div class="rounded-md border">
            {#each revisionDetail.changes as change (change.path)}
              <div class="flex items-center justify-between border-b px-3 py-1.5 text-[11px] last:border-b-0">
                <span class="font-mono">{change.path}</span>
                <Badge variant={change.status === "deleted" ? "destructive" : "secondary"} class="text-[10px]">
                  {statusText(change.status)}
                </Badge>
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <div class="rounded-md border">
          {#each revisions as revision (revision.id)}
            <button
              type="button"
              class="flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left text-[11px] last:border-b-0 hover:bg-muted/50"
              onclick={() => void viewRevision(revision.id)}
            >
              <span class="min-w-0 flex-1">
                <span class="block truncate">{revision.summary}</span>
                <span class="text-muted-foreground">{fmtTime(revision.at)} · {revision.actor}</span>
              </span>
              <span class="shrink-0 font-mono text-[10px] text-muted-foreground">{revision.id}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>

<!-- 分组改名 -->
<Dialog.Root
  open={renameTarget !== null}
  onOpenChange={(open) => {
    if (!open) renameTarget = null;
  }}
>
  <Dialog.Content class="max-w-sm p-5">
    <Dialog.Title class="text-sm font-medium">重命名分组 · {renameTarget?.name ?? ""}</Dialog.Title>
    <div class="mt-3">
      <Input bind:value={renameValue} class="h-8 text-xs" aria-label="新分组名" />
    </div>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (renameTarget = null)}>取消</Button>
      <Button size="sm" disabled={busy} onclick={() => void renameGroup()}>确认</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 删组确认 -->
<Dialog.Root
  open={deleteGroupTarget !== null}
  onOpenChange={(open) => {
    if (!open) deleteGroupTarget = null;
  }}
>
  <Dialog.Content class="max-w-sm p-5">
    <Dialog.Title class="text-sm font-medium">删除分组 · {deleteGroupTarget?.name ?? ""}</Dialog.Title>
    <Dialog.Description class="mt-1 text-[11px] leading-snug text-destructive">
      将删除该分组及全部 {deleteGroupTarget?.entries.length ?? 0} 条条目（git 历史可恢复）。
    </Dialog.Description>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (deleteGroupTarget = null)}>取消</Button>
      <Button variant="destructive" size="sm" disabled={busy} onclick={() => void removeGroup()}>确认删除</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 删条目确认 -->
<Dialog.Root
  open={deleteEntryTarget !== null}
  onOpenChange={(open) => {
    if (!open) deleteEntryTarget = null;
  }}
>
  <Dialog.Content class="max-w-sm p-5">
    <Dialog.Title class="text-sm font-medium">删除条目 · {deleteEntryTarget ?? ""}</Dialog.Title>
    <Dialog.Description class="mt-1 text-[11px] leading-snug text-destructive">
      将从分组「{current?.name ?? ""}」删除该条目（git 历史可恢复）。
    </Dialog.Description>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (deleteEntryTarget = null)}>取消</Button>
      <Button variant="destructive" size="sm" disabled={busy} onclick={() => void removeEntry()}>确认删除</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 恢复确认 -->
<Dialog.Root
  open={restoreTarget !== null}
  onOpenChange={(open) => {
    if (!open) restoreTarget = null;
  }}
>
  <Dialog.Content class="max-w-sm p-5">
    <Dialog.Title class="text-sm font-medium">恢复到修订 {restoreTarget?.id ?? ""}</Dialog.Title>
    <Dialog.Description class="mt-1 text-[11px] leading-snug text-muted-foreground">
      {restoreTarget?.summary ?? ""}——恢复会生成新的修订提交，当前版本仍保留在历史中。
    </Dialog.Description>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (restoreTarget = null)}>取消</Button>
      <Button size="sm" disabled={busy} onclick={() => void doRestore()}>确认恢复</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
