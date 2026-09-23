<!--
  极简确认对话框（skill-creator-v2 ConfirmDialog 的交互语义：bind:open +
  busy 态防抖 + 遮罩点击关闭）。纯 Svelte 无 bits-ui 依赖——设置面删除路由等
  破坏性操作的统一确认入口。
-->
<script lang="ts">
  import { Button } from "$lib/components/ui/button";

  let {
    open = $bindable(false),
    title,
    description,
    confirmText = "确认删除",
    busy = false,
    onconfirm,
  }: {
    open?: boolean;
    title: string;
    description: string;
    confirmText?: string;
    busy?: boolean;
    onconfirm: () => void;
  } = $props();
</script>

{#if open}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="presentation"
    onclick={() => {
      if (!busy) open = false;
    }}
    onkeydown={(event) => {
      if (event.key === "Escape" && !busy) open = false;
    }}
  >
    <div
      class="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
    >
      <h3 class="text-sm font-medium">{title}</h3>
      <p class="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
      <div class="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={busy} onclick={() => (open = false)}>
          取消
        </Button>
        <Button size="sm" variant="destructive" disabled={busy} onclick={onconfirm}>
          {busy ? "处理中…" : confirmText}
        </Button>
      </div>
    </div>
  </div>
{/if}
