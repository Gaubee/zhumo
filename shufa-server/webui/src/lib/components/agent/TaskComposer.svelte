<!--
  新建分析任务面板（走查反馈 2026-09-23：新建入口从左侧列表移入 detail 面板，
  左列专注列表导航；预设开场提示词可一键填充、保持可编辑——管线工具面有限
  （转录/田字格分析/旁注提取等），预设覆盖典型意图，自由文本兜底。
  R4 [2026-09-23]：生效模型路由未配置（bootstrap.modelRoute === null）时显示
  警示条并禁用创建（视频选择不受影响）。
  朱墨前端改造 [2026-09-24]（BUG5）：会话用户已被禁用 → 同款警示条 + 禁用创建
  （禁用账号可登录可读，仅新建任务被拦；daemon 侧双重拦截）。
  Owner 2026-09-28 复用裁决：指令输入框整体复用会话 ComposerCard（模型/强度
  选择、发送语义同源），本面板不再自建 textarea/选择器；预设经 setPrompt
  实例方法注入。模型清单挂载即拉（不等点开选择器）。附件面/触发面板关（新
  建无任务资源位、prompt 为自由描述）。
  正交意图：[1] 素材视频选择；[2] 预设开场 chips；[3] 创建（输入面复用
  ComposerCard）；[4] 未配置模型路由/账号被禁用的创建阻断；[5] 任务级模型
  /强度选择（ComposerCard 同源交互）。
-->
<script lang="ts">
  import { onMount } from "svelte";
  import IconFile from "@lucide/svelte/icons/file";
  import IconTriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { Button } from "$lib/components/ui/button";
  import ComposerCard from "./ComposerCard.svelte";
  import { createTask, tasks } from "$lib/stores/tasks.svelte";
  import { auth } from "$lib/stores/auth.svelte";
  import { api } from "$lib/api";
  import type { AvailableModel } from "$lib/types";

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

  let video = $state<File | null>(null);
  let videoName = $state("");
  let videoInput = $state<HTMLInputElement | null>(null);

  // ---- 活动模型选择（任务级覆盖；null = 跟随默认）——状态面与 ComposerCard 同源 ----
  let available = $state<AvailableModel[]>([]);
  let availableDefault = $state<{ provider: string; model: string; effort?: string | null } | null>(null);
  let picked = $state<{ provider: string; model: string; effort?: string } | null>(null);
  let composer = $state<ComposerCard | null>(null);

  // 挂载即拉（Owner 2026-09-28：不等点开选择器才加载——配置应首屏可见）。
  onMount(() => {
    void (async () => {
      try {
        const out = await api.getAvailableModels();
        available = out.models;
        availableDefault = out.default;
      } catch {
        available = []; // 拉取失败：选择器空态，创建仍走默认
      }
    })();
  });

  let sending = $derived(tasks.sending);
  /** R4：bootstrap 已加载且生效路由为 null → 管理员未配置大模型服务。 */
  /** 走查演示模式（URL demoDelay 写入的 sessionStorage 标记）：模型路由未配置
   也可建任务（DemoAgent 不调真实模型）。 */
  const demoActive = (() => {
    try {
      return Number(sessionStorage.getItem("zhumo:demo-delay") ?? "0") > 0;
    } catch {
      return false;
    }
  })();
  let modelMissing = $derived(
    !demoActive && auth.bootstrap !== null && auth.bootstrap.modelRoute === null,
  );
  /** BUG5：会话用户已被禁用 → 不能新建任务（仍可查看已有任务）。 */
  let userDisabled = $derived(auth.session !== null && auth.session.disabled);

  /** ComposerCard 的模型/强度选择 → 任务级覆盖状态。默认态选强度 = 把默认
   模型显式化为覆盖 + 档（强度不能脱离模型单独落任务列）。 */
  function pickModel(provider: string, model: string): void {
    picked = { provider, model }; // 换模型：档位重置
  }
  function pickEffort(effort: string | null): void {
    const base = picked ?? (availableDefault !== null ? { provider: availableDefault.provider, model: availableDefault.model } : null);
    if (base === null) return;
    picked = { ...base, ...(effort !== null ? { effort } : {}) };
  }

  /** ComposerCard 发送（Enter/按钮同源）→ 创建任务。 */
  function submitFromComposer(text: string): void {
    if (modelMissing || userDisabled) return;
    const trimmed = text.trim();
    if (trimmed.length === 0 || video === null || sending) return;
    const file = video;
    video = null;
    videoName = "";
    const model = picked === null ? undefined : picked; // 任务级覆盖；未选=跟随默认
    picked = null;
    void createTask(trimmed, file, model);
  }
</script>

<div class="mx-auto w-full max-w-2xl px-6 py-8">
  <h2 class="text-sm font-semibold">新建分析任务</h2>
  <p class="mt-1 text-[11px] text-muted-foreground">
    选择素材视频，选一个预设开场或直接描述需求——agent 会自行编排分析工具，摘要由它亲自撰写。
  </p>

  <div class="mt-4 space-y-2">
    <div class="rounded-xl border border-border bg-card p-3 shadow-sm">
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
            onclick={() => composer?.setPrompt(preset.prompt)}
          >
            {preset.label}
          </button>
        {/each}
      </div>
    </div>

    <!-- 指令输入框整体复用会话 ComposerCard（Owner 2026-09-28）：
         模型/强度选择、发送交互与对话页同源；Enter=创建。 -->
    <ComposerCard
      bind:this={composer}
      onsend={submitFromComposer}
      models={available}
      defaultModel={availableDefault}
      currentModel={picked}
      currentEffort={picked?.effort ?? null}
      onsetmodel={pickModel}
      onseteffort={pickEffort}
      attachable={false}
      triggers={false}
      placeholder="描述分析需求…（点上方预设可快速填充，填充后仍可自由修改）"
      sending={sending}
      disabled={modelMissing || userDisabled || video === null}
    />

    {#if modelMissing}
      <div
        class="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-700"
        role="alert"
      >
        <IconTriangleAlert class="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>管理员尚未配置大模型服务，暂时无法创建任务；请联系管理员在后台「设置 → 大模型服务」完成配置。</span>
      </div>
    {/if}

    {#if userDisabled}
      <!-- BUG5：禁用账号创建阻断（与模型未配置同款警示模式）。 -->
      <div
        class="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-700"
        role="alert"
      >
        <IconTriangleAlert class="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>账号已被禁用：不能新建任务，仍可查看已有任务。</span>
      </div>
    {/if}

    {#if tasks.error}
      <p class="px-1 text-[11px] text-destructive" role="alert">{tasks.error}</p>
    {/if}
  </div>
</div>
