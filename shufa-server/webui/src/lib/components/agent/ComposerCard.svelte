<!--
  指令输入卡（走查 R6 按 skill-creator-v2 ComposerCard 重写）：附件行（素材
  视频 chip）→ 自动长高 textarea（Enter 发送 / Shift+Enter 换行）→ 工具行
  （右簇：模型 chip + 发送按钮）。
  模型 chip（抄 skill-creator-v2 model chip 语义）：
  - Popover 菜单按路由分组列模型（图标/字母头像组头 + 模型名 + 上下文窗口 +
    视觉标记 + 当前项打勾）；
  - 任务级覆盖（currentModel）当前项打勾；无覆盖回落后台默认；
  - 任务 running 时整菜单禁用（title「本轮结束后再切换」——服务端同款拒绝）；
  - 选中走 onsetmodel（父级调 setTaskModel 热切会话）。
-->
<script lang="ts">
  import IconFile from "@lucide/svelte/icons/file";
  import IconSend from "@lucide/svelte/icons/send";
  import IconChevronDown from "@lucide/svelte/icons/chevron-down";
  import IconCheck from "@lucide/svelte/icons/check";
  import IconImage from "@lucide/svelte/icons/image";
  import IconX from "@lucide/svelte/icons/x";
  import IconLoader from "@lucide/svelte/icons/loader-circle";
  import { Button } from "$lib/components/ui/button";
  import * as Popover from "$lib/components/ui/popover";
  import { routeAvatarColor, routeLetter } from "$lib/components/models/route-meta";
  import { api } from "$lib/api";
  import type { Attachment } from "$lib/types";
  import { formatTokenCount } from "$lib/components/models/route-meta";
  import type { AvailableModel } from "$lib/types";

  let {
    onsend,
    disabled = false,
    sending = false,
    videoName = null,
    placeholder = "描述分析需求，例如：分析起笔角度与收笔…",
    /** 可用模型清单（null/空 = 无已配路由，chip 隐藏）。 */
    models = null,
    defaultModel = null,
    /** 任务级模型覆盖（null = 跟随后台默认）。 */
    currentModel = null,
    /** 任务运行中：菜单禁用（本轮结束后再切换）。 */
    running = false,
    onsetmodel,
  }: {
    onsend: (text: string) => void;
    disabled?: boolean;
    sending?: boolean;
    videoName?: string | null;
    placeholder?: string;
    models?: AvailableModel[] | null;
    defaultModel?: { provider: string; model: string } | null;
    currentModel?: { provider: string; model: string } | null;
    running?: boolean;
    onsetmodel?: (provider: string, model: string) => void;
  } = $props();

  let text = $state("");
  let menuOpen = $state(false);
  /** 附件（走查 R7：图片 ≤4MiB/张；上传后 chip 缩略预览，发送时注入路径）。 */
  let attachments = $state<Attachment[]>([]);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

  async function onFilesPicked(files: FileList | null): Promise<void> {
    if (files === null) return;
    uploading = true;
    try {
      for (const file of [...files]) {
        if (file.size > MAX_ATTACHMENT_BYTES) continue;
        if (attachments.some((a) => a.name === file.name && a.size === file.size)) continue;
        const dataBase64 = await fileToBase64(file);
        const uploaded = await api.uploadAttachment({ name: file.name, dataBase64 });
        attachments = [...attachments, uploaded];
      }
    } catch (e) {
      (window as unknown as { __attachError?: string }).__attachError =
        e instanceof Error ? e.message : String(e);
    } finally {
      uploading = false;
      if (fileInput !== null) fileInput.value = "";
    }
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  function removeAttachment(name: string): void {
    attachments = attachments.filter((a) => a.name !== name);
  }

  interface ModelGroup {
    provider: string;
    iconUrl?: string;
    models: AvailableModel[];
  }

  const groups = $derived.by(() => {
    const byProvider = new Map<string, ModelGroup>();
    for (const item of models ?? []) {
      let group = byProvider.get(item.provider);
      if (group === undefined) {
        group = { provider: item.provider, models: [] };
        if (item.iconUrl !== undefined) group.iconUrl = item.iconUrl;
        byProvider.set(item.provider, group);
      }
      group.models.push(item);
    }
    return [...byProvider.values()];
  });

  const activeModel = $derived(
    currentModel ?? (defaultModel !== null && groups.length > 0 ? defaultModel : null),
  );

  /** chip 标签：活动模型名；同 id 跨路由时加 provider 前缀区分。 */
  const chipLabel = $derived.by(() => {
    if (activeModel === null) return "默认";
    const sameIdProviders = groups
      .filter((g) => g.models.some((m) => m.model === activeModel.model))
      .map((g) => g.provider);
    const prefix = sameIdProviders.length > 1 ? `${activeModel.provider}/` : "";
    return `${prefix}${activeModel.model}`;
  });

  function isActive(provider: string, model: string): boolean {
    return activeModel !== null && activeModel.provider === provider && activeModel.model === model;
  }

  function submit(): void {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending || disabled) return;
    // 附件路径注入（走查 R7：agent 经工具按路径读取图片）。
    const attachLines = attachments
      .map((a) => `[图片附件 ${a.name}]：${a.path}`)
      .join("\n");
    onsend(attachLines.length > 0 ? `${trimmed}\n${attachLines}` : trimmed);
    text = "";
    attachments = [];
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  /** 自动长高（1 行 → 4 行封顶内滚）。 */
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  $effect(() => {
    void text;
    const el = textareaEl;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  });
</script>

<div class="rounded-xl border border-border bg-card p-2 shadow-sm">
  {#if videoName !== null}
    <div class="mb-1.5 flex flex-wrap gap-1">
      <span
        class="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px]"
      >
        <IconFile class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="max-w-40 truncate">{videoName}</span>
      </span>
    </div>
  {/if}
  {#if attachments.length > 0 || uploading}
    <div class="mb-1.5 flex flex-wrap gap-1">
      {#each attachments as att (att.resourceId)}
        <span class="group/att relative flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-0.5 pl-0.5 pr-1.5">
          <img src={att.rawUrl(96)} alt={att.name} class="h-8 w-8 rounded object-cover" />
          <span class="max-w-28 truncate text-[10px]">{att.name}</span>
          <button
            type="button"
            class="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label="移除附件 {att.name}"
            onclick={() => removeAttachment(att.name)}
          >
            <IconX class="h-2.5 w-2.5" />
          </button>
        </span>
      {/each}
      {#if uploading}
        <span class="flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[10px] text-muted-foreground">
          <IconLoader class="h-3 w-3 animate-spin" aria-hidden="true" />
          上传中…
        </span>
      {/if}
    </div>
  {/if}
  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    multiple
    class="hidden"
    onchange={(event) => void onFilesPicked(event.currentTarget.files)}
  />
  <textarea
    bind:this={textareaEl}
    bind:value={text}
    {onkeydown}
    {placeholder}
    rows="1"
    class="block w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-6 outline-none placeholder:text-muted-foreground/70"
  ></textarea>
  <div class="mt-1 flex items-center gap-2 px-1">
    <div class="flex-1"></div>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      title="附加图片（≤4MiB/张）"
      aria-label="附加图片"
      disabled={uploading || disabled || sending}
      onclick={() => fileInput?.click()}
    >
      <IconImage class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
    {#if groups.length > 0}
      <Popover.Root open={menuOpen} onOpenChange={(open) => (menuOpen = open)}>
        <Popover.Trigger>
          {#snippet child({ props })}
            <button
              type="button"
              {...props}
              class="flex h-7 max-w-[220px] items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={running ? "本轮结束后再切换" : "切换本任务使用的模型"}
              aria-label="切换模型"
              disabled={running || disabled}
            >
              <span class="truncate">{chipLabel}</span>
              <IconChevronDown class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
            </button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Content class="w-64 p-0">
          <div class="max-h-72 overflow-y-auto p-1">
            {#each groups as group (group.provider)}
              <div class="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-muted-foreground">
                {#if group.iconUrl}
                  <img
                    src={group.iconUrl}
                    alt=""
                    class="h-3.5 w-3.5 rounded object-contain dark:invert"
                    onerror={(event) => ((event.currentTarget as HTMLImageElement).style.display = "none")}
                  />
                {:else}
                  <span
                    class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[8px] font-semibold text-white"
                    style="background: {routeAvatarColor({ provider: group.provider })}"
                    aria-hidden="true">{routeLetter({ provider: group.provider })}</span
                  >
                {/if}
                <span class="truncate">{group.provider}</span>
              </div>
              {#each group.models as item (item.provider + "::" + item.model)}
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 {isActive(item.provider, item.model)
                    ? "bg-accent-soft"
                    : ""}"
                  onclick={() => {
                    menuOpen = false;
                    onsetmodel?.(item.provider, item.model);
                  }}
                >
                  <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {#if isActive(item.provider, item.model)}
                      <IconCheck class="h-3 w-3" aria-hidden="true" />
                    {/if}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{item.name}</span>
                    {#if item.contextWindow !== undefined}
                      <span class="block truncate text-[10px] text-muted-foreground">
                        {formatTokenCount(item.contextWindow)} 上下文
                      </span>
                    {/if}
                  </span>
                  {#if (item.inputTypes ?? ["text"]).includes("image")}
                    <IconImage class="h-3 w-3 shrink-0 text-muted-foreground" aria-label="支持图片输入" />
                  {/if}
                </button>
              {/each}
            {/each}
            {#if defaultModel !== null}
              <div class="border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground">
                后台默认：{defaultModel.provider} / {defaultModel.model}
              </div>
            {/if}
          </div>
        </Popover.Content>
      </Popover.Root>
    {/if}
    <Button
      size="sm"
      class="h-8 w-8 rounded-full p-0"
      disabled={sending || disabled || text.trim().length === 0}
      onclick={submit}
      aria-label="发送"
    >
      <IconSend class="h-4 w-4" />
    </Button>
  </div>
</div>
