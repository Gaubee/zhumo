<!--
  新建分析任务面板（走查反馈 2026-09-23：新建入口从左侧列表移入 detail 面板，
  左列专注列表导航；预设开场提示词可一键填充、保持可编辑——管线工具面有限
  （转录/田字格分析/旁注提取等），预设覆盖典型意图，自由文本兜底。
  R4 [2026-09-23]：生效模型路由未配置（bootstrap.modelRoute === null）时显示
  警示条并禁用创建（视频选择不受影响）。
  正交意图：[1] 素材视频选择；[2] 预设开场 chips；[3] 提示词编辑与创建；
  [4] 未配置模型路由的创建阻断。
-->
<script lang="ts">
  import IconFile from "@lucide/svelte/icons/file";
  import IconSend from "@lucide/svelte/icons/send";
  import IconTriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { Button } from "$lib/components/ui/button";
  import { createTask, tasks } from "$lib/stores/tasks.svelte";
  import { auth } from "$lib/stores/auth.svelte";

  /** 预设开场（点选填充，仍然可编辑；措辞覆盖管线真实工具面）。 */
  const PRESETS: Array<{ label: string; prompt: string }> = [
    {
      label: "完整分析（推荐）",
      prompt:
        "请按手册全流程分析这段讲评视频：转正对齐、田字格检测、旁注批注提取、焦点回放剪辑与语音转录；把旁注与对应生字关联，最后由你阅读转录与画面产物亲自撰写摘要（教师点评要点 + 练习建议），并导出分析包。",
    },
    {
      label: "转录与讲解要点",
      prompt:
        "请侧重语音内容：完整转录这段讲评视频，按时间线整理教师的点评要点（逐字讲解、常见错误、修改建议），画面分析从简（田字格检测与焦点格即可），摘要围绕讲解内容撰写并导出分析包。",
    },
    {
      label: "字形与笔画诊断",
      prompt:
        "请侧重田字格与字形：检测全部田字格与讲解焦点格，提取旁注批注并与对应生字关联，逐字整理笔画要点与结构问题，转录内容作为佐证；摘要聚焦字形诊断与改进建议。",
    },
    {
      label: "快速出结果",
      prompt: "请直接按默认流程分析这段视频并导出分析包，摘要简洁（3 段以内）即可。",
    },
  ];

  let prompt = $state("");
  let video = $state<File | null>(null);
  let videoName = $state("");
  let videoInput = $state<HTMLInputElement | null>(null);
  let sending = $derived(tasks.sending);
  /** R4：bootstrap 已加载且生效路由为 null → 管理员未配置大模型服务。 */
  let modelMissing = $derived(auth.bootstrap !== null && auth.bootstrap.modelRoute === null);

  function applyPreset(presetPrompt: string): void {
    prompt = presetPrompt;
  }

  function submit(): void {
    if (modelMissing) return;
    const trimmed = prompt.trim();
    if (trimmed.length === 0 || video === null || sending) return;
    prompt = "";
    const file = video;
    video = null;
    videoName = "";
    void createTask(trimmed, file);
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }
</script>

<div class="mx-auto w-full max-w-2xl px-6 py-8">
  <h2 class="text-sm font-semibold">新建分析任务</h2>
  <p class="mt-1 text-[11px] text-muted-foreground">
    选择素材视频，选一个预设开场或直接描述需求——agent 会自行编排分析工具，摘要由它亲自撰写。
  </p>

  <div class="mt-4 rounded-xl border border-border bg-card p-3 shadow-sm">
    <input
      bind:this={videoInput}
      type="file"
      accept="video/*"
      class="hidden"
      onchange={(event) => {
        video = event.currentTarget.files?.[0] ?? null;
        videoName = video?.name ?? "";
      }}
    />
    <div class="flex items-center gap-2">
      <Button size="sm" variant="outline" onclick={() => videoInput?.click()}>
        <IconFile data-icon="inline-start" />
        选择素材视频…
      </Button>
      {#if videoName !== ""}
        <span class="min-w-0 truncate text-xs text-muted-foreground">{videoName}</span>
      {:else}
        <span class="text-[11px] text-muted-foreground">必选；agent 通过文件路径自行读取分析</span>
      {/if}
    </div>

    <div class="mt-3 flex flex-wrap gap-1.5">
      {#each PRESETS as preset (preset.label)}
        <button
          type="button"
          class="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-foreground/80 transition-colors hover:border-primary/50 hover:bg-accent-soft"
          onclick={() => applyPreset(preset.prompt)}
        >
          {preset.label}
        </button>
      {/each}
    </div>

    <textarea
      bind:value={prompt}
      {onkeydown}
      rows="5"
      placeholder="描述分析需求…（点上方预设可快速填充，填充后仍可自由修改）"
      class="mt-3 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-[13px] leading-5 outline-none placeholder:text-muted-foreground/70 focus:border-primary/50"
    ></textarea>

    {#if modelMissing}
      <div
        class="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-700"
        role="alert"
      >
        <IconTriangleAlert class="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>管理员尚未配置大模型服务，暂时无法创建任务；请联系管理员在后台「设置 → 大模型服务」完成配置。</span>
      </div>
    {/if}

    <div class="mt-2 flex items-center justify-between gap-2">
      <span class="text-[10px] text-muted-foreground">
        {#if tasks.error}
          <span class="text-destructive" role="alert">{tasks.error}</span>
        {:else}
          ⌘/Ctrl + Enter 创建 · 换行直接回车
        {/if}
      </span>
      <Button
        size="sm"
        disabled={sending || modelMissing || prompt.trim().length === 0 || video === null}
        onclick={submit}
      >
        <IconSend data-icon="inline-start" />
        {sending ? "创建中…" : "创建任务"}
      </Button>
    </div>
  </div>
</div>
