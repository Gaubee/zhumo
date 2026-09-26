<!--
  用户消息气泡（走查 R7：替换溢出滚动——滚动破坏阅读连续性）：
  - 折叠态 line-clamp 收起 + 底部渐变遮罩 + bottom-center「展开」按钮；
  - 展开态完整内容 + bottom-center「收起」按钮；
  - 内容未溢出时不显示任何按钮（scrollHeight 检测）。
-->
<script lang="ts">
  import IconChevronDown from "@lucide/svelte/icons/chevron-down";
  import IconChevronUp from "@lucide/svelte/icons/chevron-up";
  import MarkdownRender from "markstream-svelte";

  let { text }: { text: string } = $props();

  let expanded = $state(false);
  let bodyEl = $state<HTMLDivElement | null>(null);
  let overflowing = $state(false);

  // 溢出检测抗异步渲染（Owner 2026-09-28 二轮：markstream 内容可能晚于
  // 首帧落定）：初始测一次 + ResizeObserver 盯容器与内容根，内容尺寸变化
  // 即复测——「展开全文」只在真被 7rem 截断时出现。
  $effect(() => {
    void text;
    void expanded;
    const el = bodyEl;
    if (el === null) return;
    const measure = (): void => {
      overflowing = !expanded && el.scrollHeight - el.clientHeight > 4;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild !== null) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  });
</script>

<div class="relative">
  <div
    bind:this={bodyEl}
    class="bubble-user px-3.5 py-2 text-[12px] leading-[19px] {expanded ? '' : 'max-h-[7rem] overflow-hidden'}"
  >
    <!-- 静态文本不走打字机/渐显动画路径（Owner 2026-09-28：typewriter 挂载
         的过渡链在气泡里留下幻影高度——内容 19px 根却 600px，「展开全文」\         误常驻；final 标记终稿语义）。 -->
    <MarkdownRender content={text} final={true} typewriter={false} fade={false} viewportPriority={false} />
  </div>
  {#if expanded}
    <div class="mt-1 flex justify-center">
      <button
        type="button"
        class="flex h-6 items-center gap-1 rounded-full border border-border bg-popover px-2.5 text-[10px] text-muted-foreground shadow-sm transition-colors hover:text-foreground"
        aria-label="收起消息"
        onclick={() => (expanded = false)}
      >
        收起
        <IconChevronUp class="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  {:else if overflowing}
    <!-- 渐变遮罩盖住截断行，按钮压在 bottom-center。 -->
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent"
      aria-hidden="true"
    ></div>
    <div class="absolute inset-x-0 bottom-1.5 flex justify-center">
      <button
        type="button"
        class="flex h-6 items-center gap-1 rounded-full border border-border bg-popover px-2.5 text-[10px] text-muted-foreground shadow-md transition-colors hover:text-foreground"
        aria-label="展开完整消息"
        aria-expanded={expanded}
        onclick={() => (expanded = true)}
      >
        展开全文
        <IconChevronDown class="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  {/if}
</div>
