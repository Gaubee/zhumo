<!--
  资源管理器（PRODUCT_DESIGN §2 /admin/resources；W5 实装）。
  原始需求：面包屑导航 + 文件列表（图标区分 文件夹/.shufa 任务/视频/图片/其他；
  列：名称/大小/修改时间）+ 右键菜单（打开/重命名/下载/删除）+ 双击（进目录/
  任务详情占位/媒体预览）+ 上传（进度/结果提示）；admin 经 owner 查看任意用户。
  导航形态：面包屑（含根）；不采用侧栏树。
  正交意图：
  1. 数据装载与面包屑导航（res.tree；owner 变更重置到根）。
  2. 列表呈现与右键/双击行为分发（kindOf）。
  3. 变更操作（新建文件夹/重命名/删除级联确认/上传）与结果、错误整卡提示。
  4. 预览 Dialog（视频 <video controls> / 图片 / 音频）与 .shufa 任务详情占位。
-->
<script lang="ts">
  import { untrack } from "svelte";
  import * as ContextMenu from "$lib/components/ui/context-menu";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import IconDownload from "@lucide/svelte/icons/download";
  import IconFile from "@lucide/svelte/icons/file";
  import IconFilm from "@lucide/svelte/icons/film";
  import IconFolder from "@lucide/svelte/icons/folder";
  import IconFolderPlus from "@lucide/svelte/icons/folder-plus";
  import IconImage from "@lucide/svelte/icons/image";
  import IconMusic from "@lucide/svelte/icons/music";
  import IconPencil from "@lucide/svelte/icons/pencil";
  import IconTrash2 from "@lucide/svelte/icons/trash-2";
  import IconUpload from "@lucide/svelte/icons/upload";
  import { api } from "$lib/api";
  import { navigate } from "$lib/router.svelte";
  import { formatDateTime, formatSize, kindOf, type ResourceKind } from "$lib/components/resources/kind";
  import type { ResTreeOutput, ResourceItem } from "$lib/types";

  let { owner = undefined }: { owner?: string } = $props();

  let tree = $state<ResTreeOutput | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let success = $state<string | null>(null);

  let mkdirOpen = $state(false);
  let mkdirName = $state("");
  let renaming = $state<ResourceItem | null>(null);
  let renameName = $state("");
  let deleteTarget = $state<ResourceItem | null>(null);
  let preview = $state<{ item: ResourceItem; url: string; kind: ResourceKind } | null>(null);
  let shufaInfo = $state<ResourceItem | null>(null);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  const kindIcon: Record<ResourceKind, typeof IconFile> = {
    dir: IconFolder,
    shufa: IconFolder,
    video: IconFilm,
    image: IconImage,
    audio: IconMusic,
    other: IconFile,
  };

  function kindLabel(kind?: ResourceKind): string {
    switch (kind) {
      case "video":
        return "视频";
      case "image":
        return "图片";
      case "audio":
        return "音频";
      default:
        return "文件";
    }
  }

  $effect(() => {
    // 只跟踪 owner；装载过程会读写 tree，须 untrack（否则同步读 currentId 形成
    // 「effect 读 tree → refresh 写 tree」死循环，页面假死）。owner 切换时清提示。
    void owner;
    untrack(() => {
      tree = null;
      error = null;
      success = null;
      void refresh();
    });
  });

  async function refresh(parentId?: string): Promise<void> {
    loading = true;
    try {
      const current = parentId ?? currentId();
      tree = await api.resTree(owner, current);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function path(): ResourceItem[] {
    return tree?.path ?? [];
  }

  function currentId(): string | undefined {
    return path().at(-1)?.id;
  }

  async function enter(item: ResourceItem): Promise<void> {
    if (item.id === currentId()) return;
    await refresh(item.id);
  }

  async function openItem(item: ResourceItem): Promise<void> {
    const kind = kindOf(item);
    if (kind === "dir") {
      await enter(item);
      return;
    }
    if (kind === "shufa") {
      shufaInfo = item;
      return;
    }
    if (kind === "video" || kind === "image" || kind === "audio") {
      const url = await api.resRawUrl(item.id);
      if (url === null) {
        error = `「${item.name}」没有可预览的实体内容`;
        return;
      }
      preview = { item, url, kind };
      return;
    }
    error = `「${item.name}」类型暂不支持预览（可右键下载）`;
  }

  async function downloadItem(item: ResourceItem): Promise<void> {
    const url = await api.resRawUrl(item.id);
    if (url === null) {
      error = `「${item.name}」没有可下载的实体内容`;
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = item.name;
    anchor.click();
  }

  async function createFolder(): Promise<void> {
    const parent = currentId();
    if (!parent || mkdirName.trim().length === 0) return;
    try {
      const item = await api.resMkdir(parent, mkdirName.trim());
      mkdirOpen = false;
      mkdirName = "";
      success = `已创建文件夹「${item.name}」`;
      await refresh(parent);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function submitRename(): Promise<void> {
    if (!renaming || renameName.trim().length === 0) return;
    try {
      const item = await api.resRename(renaming.id, renameName.trim());
      success = `已重命名为「${item.name}」`;
      renaming = null;
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  async function submitDelete(): Promise<void> {
    if (!deleteTarget) return;
    try {
      const outcome = await api.resDelete(deleteTarget.id);
      success = `已删除 ${outcome.deleted} 项${outcome.blobs_released > 0 ? `，回收 ${outcome.blobs_released} 个文件实体` : ""}`;
      deleteTarget = null;
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      deleteTarget = null;
    }
  }

  async function uploadFiles(files: FileList | null): Promise<void> {
    const parent = currentId();
    if (!parent || !files || files.length === 0) return;
    uploading = true;
    error = null;
    try {
      let deduped = 0;
      const names: string[] = [];
      for (const file of Array.from(files)) {
        const outcome = await api.resUpload(parent, file);
        deduped += outcome.deduped ? 1 : 0;
        names.push(outcome.item.name);
      }
      success = `已上传 ${names.length} 个文件${deduped > 0 ? `（${deduped} 个内容去重命中）` : ""}：${names.join("、")}`;
      await refresh(parent);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = "";
    }
  }
</script>

{#snippet rowIcon(item: ResourceItem)}
  {@const kind = kindOf(item)}
  {@const Icon = kindIcon[kind]}
  <Icon class="size-4 shrink-0 {kind === 'shufa' ? 'text-primary' : 'text-muted-foreground'}" />
{/snippet}

<div class="flex min-h-0 flex-1 flex-col gap-3">
  {#if owner}
    <p class="text-[11px] text-muted-foreground">
      正在查看用户 <span class="font-medium text-foreground">{owner}</span> 的资源根。
    </p>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <nav class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto text-xs" aria-label="面包屑">
      {#each path() as crumb, index (crumb.id)}
        {#if index > 0}
          <span class="text-muted-foreground">/</span>
        {/if}
        <button
          type="button"
          class="truncate rounded px-1 py-0.5 hover:bg-muted {index === path().length - 1
            ? 'font-medium'
            : 'text-muted-foreground'}"
          onclick={() => void enter(crumb)}
        >
          {#if index === 0}根目录{:else}{crumb.name}{/if}
        </button>
      {/each}
    </nav>
    <Button size="sm" variant="outline" onclick={() => (mkdirOpen = true)}>
      <IconFolderPlus class="size-3.5" /> 新建文件夹
    </Button>
    <Button size="sm" disabled={uploading} onclick={() => fileInput?.click()}>
      <IconUpload class="size-3.5" /> {uploading ? "上传中…" : "上传"}
    </Button>
    <input
      bind:this={fileInput}
      type="file"
      multiple
      class="hidden"
      onchange={(event) => void uploadFiles(event.currentTarget.files)}
    />
  </div>

  {#if error}
    <div class="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive" role="alert">
      {error}
    </div>
  {:else if success}
    <div class="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">{success}</div>
  {/if}

  <div class="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-card">
    <div class="grid grid-cols-[minmax(0,1fr)_92px_136px] items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[11px] font-medium text-muted-foreground">
      <span>名称</span>
      <span class="text-right">大小</span>
      <span class="text-right">修改时间</span>
    </div>
    {#if loading && !tree}
      <p class="px-3 py-6 text-center text-xs text-muted-foreground">正在加载资源…</p>
    {:else if (tree?.items.length ?? 0) === 0}
      <p class="px-3 py-6 text-center text-xs text-muted-foreground">此文件夹为空；可上传视频 / 图片 / 音频。</p>
    {:else}
      {#each tree?.items ?? [] as item (item.id)}
        <ContextMenu.Root>
          <ContextMenu.Trigger
            class="grid grid-cols-[minmax(0,1fr)_92px_136px] items-center gap-2 border-b px-3 py-2 text-xs last:border-b-0 hover:bg-muted/60"
            ondblclick={() => void openItem(item)}
          >
            <span class="flex min-w-0 items-center gap-2">
              {@render rowIcon(item)}
              <span class="truncate {item.is_dir ? 'font-medium' : ''}">{item.name}</span>
              {#if kindOf(item) === "shufa"}
                <Badge variant="secondary" class="shrink-0 text-[10px]">
                  任务 · {item.meta?.task_status ?? "未知"}
                </Badge>
              {/if}
            </span>
            <span class="text-right text-muted-foreground">{item.is_dir ? "—" : formatSize(item.size)}</span>
            <span class="text-right text-muted-foreground">{formatDateTime(item.updated_at)}</span>
          </ContextMenu.Trigger>
          <ContextMenu.Content class="w-44 text-xs">
            <ContextMenu.Item onclick={() => void openItem(item)}>
              打开
            </ContextMenu.Item>
            <ContextMenu.Item onclick={() => { renaming = item; renameName = item.name; }}>
              <IconPencil class="size-3.5" /> 重命名
            </ContextMenu.Item>
            <ContextMenu.Item onclick={() => void downloadItem(item)}>
              <IconDownload class="size-3.5" /> 下载
            </ContextMenu.Item>
            <ContextMenu.Separator />
            <ContextMenu.Item
              class="text-destructive data-[highlighted]:text-destructive"
              onclick={() => (deleteTarget = item)}
            >
              <IconTrash2 class="size-3.5" /> 删除
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Root>
      {/each}
    {/if}
  </div>
</div>

<!-- 新建文件夹 -->
<Dialog.Root bind:open={mkdirOpen}>
  <Dialog.Content class="max-w-sm p-5">
    <Dialog.Title class="text-sm font-medium">新建文件夹</Dialog.Title>
    <div class="mt-3 flex flex-col gap-2">
      <Input bind:value={mkdirName} placeholder="文件夹名称" class="h-8 text-xs" />
    </div>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (mkdirOpen = false)}>取消</Button>
      <Button size="sm" disabled={mkdirName.trim().length === 0} onclick={() => void createFolder()}>
        创建
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 重命名 -->
<Dialog.Root
  open={renaming !== null}
  onOpenChange={(open) => {
    if (!open) renaming = null;
  }}
>
  <Dialog.Content class="max-w-sm p-5">
    <Dialog.Title class="text-sm font-medium">重命名 · {renaming?.name ?? ""}</Dialog.Title>
    <div class="mt-3 flex flex-col gap-2">
      <Input bind:value={renameName} class="h-8 text-xs" />
    </div>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (renaming = null)}>取消</Button>
      <Button size="sm" onclick={() => void submitRename()}>确认</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 删除确认（文件夹级联整卡提示） -->
<Dialog.Root
  open={deleteTarget !== null}
  onOpenChange={(open) => {
    if (!open) deleteTarget = null;
  }}
>
  <Dialog.Content class="max-w-sm p-5">
    <Dialog.Title class="text-sm font-medium">删除 · {deleteTarget?.name ?? ""}</Dialog.Title>
    <div class="mt-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
      {#if deleteTarget?.is_dir}
        将级联删除该文件夹内全部内容（含子文件夹与文件），文件实体在引用归零后回收。
      {:else}
        删除后该文件的存储实体在引用归零时回收，不可恢复。
      {/if}
    </div>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (deleteTarget = null)}>取消</Button>
      <Button variant="destructive" size="sm" onclick={() => void submitDelete()}>确认删除</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 媒体预览 -->
<Dialog.Root
  open={preview !== null}
  onOpenChange={(open) => {
    if (!open) preview = null;
  }}
>
  <Dialog.Content class="max-w-2xl p-4">
    <Dialog.Title class="text-sm font-medium">{preview?.item.name ?? ""}</Dialog.Title>
    <Dialog.Description class="mt-1 text-[11px] text-muted-foreground">
      {formatSize(preview?.item.size ?? 0)} · {kindLabel(preview?.kind)}
    </Dialog.Description>
    <div class="mt-3 overflow-hidden rounded-lg border bg-black/90">
      {#if preview?.kind === "video"}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={preview.url} controls class="max-h-[65vh] w-full" aria-label="视频预览"></video>
      {:else if preview?.kind === "image"}
        <img src={preview.url} alt={preview.item.name} class="max-h-[65vh] w-full object-contain" />
      {:else if preview?.kind === "audio"}
        <div class="p-6">
          <audio src={preview.url} controls class="w-full" aria-label="音频预览"></audio>
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>

<!-- .shufa 任务详情占位 -->
<Dialog.Root
  open={shufaInfo !== null}
  onOpenChange={(open) => {
    if (!open) shufaInfo = null;
  }}
>
  <Dialog.Content class="max-w-md p-5">
    <Dialog.Title class="flex items-center gap-2 text-sm font-medium">
      任务详情 · {shufaInfo?.name ?? ""}
      <Badge variant="secondary" class="text-[10px]">{shufaInfo?.meta?.task_status ?? "未知"}</Badge>
    </Dialog.Title>
    <Dialog.Description class="mt-1 text-[11px] text-muted-foreground">
      任务对话详情将在任务页查看（此处为资源侧占位）；任务资产受保护，不可改名 / 移动 / 删除。
    </Dialog.Description>
    <dl class="mt-3 space-y-2 rounded-lg border bg-muted/30 p-3 text-xs">
      <div class="flex gap-2">
        <dt class="w-24 shrink-0 text-muted-foreground">任务 ID</dt>
        <dd class="truncate font-mono">{shufaInfo?.meta?.task_id ?? "—"}</dd>
      </div>
      <div class="flex gap-2">
        <dt class="w-24 shrink-0 text-muted-foreground">agent 会话</dt>
        <dd class="truncate font-mono">{shufaInfo?.meta?.agent_session_id ?? "—"}</dd>
      </div>
      <div class="flex gap-2">
        <dt class="w-24 shrink-0 text-muted-foreground">结果 ID</dt>
        <dd class="truncate font-mono">{shufaInfo?.meta?.result_id ?? "尚未生成"}</dd>
      </div>
    </dl>
    {#if shufaInfo?.meta?.result_id}
      <Dialog.Footer class="mt-4">
        <Button
          size="sm"
          onclick={() => {
            navigate(`#/r/${shufaInfo?.meta?.result_id}`);
            shufaInfo = null;
          }}
        >
          打开结果页
        </Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
