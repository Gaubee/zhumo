<!--
  指令输入卡（移植自 skill-creator-v2 webui ComposerCard.svelte 骨架：附件行
  + textarea + 发送按钮；菜单/芯片等富交互由后续波次接真实帧流时补）。
  正交意图：[1] 提示词输入与发送（Loading 锁）；[2] 素材视频附件 chip 展示。
-->
<script lang="ts">
  import IconFile from "@lucide/svelte/icons/file";
  import IconSend from "@lucide/svelte/icons/send";
  import { Button } from "$lib/components/ui/button";

  let {
    onsend,
    disabled = false,
    sending = false,
    videoName = null,
    placeholder = "描述分析需求，例如：分析起笔角度与收笔…",
  }: {
    onsend: (text: string) => void;
    disabled?: boolean;
    sending?: boolean;
    /** 当前任务绑定的素材视频（chip 展示）。 */
    videoName?: string | null;
    placeholder?: string;
  } = $props();

  let text = $state("");

  function submit(): void {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending || disabled) return;
    onsend(trimmed);
    text = "";
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }
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
  <textarea
    bind:value={text}
    {onkeydown}
    {placeholder}
    rows="2"
    class="w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-5 outline-none placeholder:text-muted-foreground/70"
  ></textarea>
  <div class="flex items-center justify-end gap-2">
    <span class="text-[10px] text-muted-foreground">Enter 发送 · Shift+Enter 换行</span>
    <Button size="sm" disabled={disabled || sending || text.trim().length === 0} onclick={submit}>
      <IconSend data-icon="inline-start" />
      {sending ? "发送中…" : "发送"}
    </Button>
  </div>
</div>
