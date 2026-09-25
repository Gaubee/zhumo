<script lang="ts">
  import { toasts } from "./store.svelte";
</script>

<!-- 顶部居中浮层（composer 上方不占布局；aria-live 供读屏）。 -->
<div class="pointer-events-none fixed left-1/2 top-14 z-[80] flex -translate-x-1/2 flex-col items-center gap-1.5" aria-live="polite">
  {#each toasts.items as t (t.id)}
    <div
      class="pointer-events-auto rounded-full border px-3 py-1.5 text-[12px] shadow-sm {t.tone === 'success'
        ? 'border-primary/30 bg-primary/10 text-primary'
        : t.tone === 'warn'
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-700'
          : 'border-border bg-card text-foreground'}"
    >
      {t.message}
    </div>
  {/each}
</div>
