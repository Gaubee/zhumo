<!--
  准备步骤面板（PRODUCT_DESIGN §1.2 / §2 settings 页共用组件）。
  原始需求 [2026-09-23]：两类步骤（命令安装/依赖下载），每项内嵌实时预览
  （命令=last-line-log 尾行，下载=进度条），显示目标目录+来源链接；嗅探
  已存在默认跳过 +「强制执行/强制下载」开关；运行/下载按钮。
  布局改版（Owner 2026-09-25）：手风琴 → list-detail——
  1. 桌面（≥md）：左列表（紧凑行：标题+状态徽章+尾行预览）右详情（选中步骤
     的完整面板）。手风琴时代长日志把后续区块顶穿的问题就此收口：详情面板
     自身限高内滚，页面布局不再随日志膨胀。
  2. 移动（<md）：列表全宽，点行从右侧 Sheet 抽屉展开详情（与前台 ListDetailPage
     的移动适配同一模式）；snippet 复用标记，桌面/移动共享单份结构。
  3. 组件名保留 Accordion 后缀（两页导入零改动），内部已无手风琴。
  历史走查（逻辑全部保留，仅呈现层重排）：
  1. 状态文案按 kind 分型（命令=待执行/已安装，下载=待下载/已下载）。
  2. done 态按钮默认 disabled，勾选强制开关才 enable，按钮附近给说明行。
  3. 下载徽章带百分比（两位小数）；下载步骤开关=「覆盖下载」；残差分
     「开始下载 / 恢复下载」。
  4. 展开面板 lastLog 全量 <pre> 自动滚底（用户上滚即停，回底恢复跟随）；
     下载进度条 + current/total 文案，终态保留不清空。
  5. whisper-model 步骤内嵌模型/镜像选择器，选中值随 onrun params 传出；
     来源链接显示选中组合的预测 URL（客户端合成，选中即更新）。
-->
<script lang="ts">
  import * as Select from "$lib/components/ui/select";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import IconPlay from "@lucide/svelte/icons/play";
  import IconSquare from "@lucide/svelte/icons/square";
  import IconX from "@lucide/svelte/icons/x";
  import { WHISPER_MIRRORS, WHISPER_MODEL_CATALOG, whisperModelIdFromRepo, whisperRepoFor } from "@zhumo/contracts";
  import type { WhisperMirrorId, WhisperModelOption, WizardRunParams, WizardStep } from "$lib/types";

  let {
    steps,
    running = null,
    onrun,
    oncancel,
  }: {
    steps: WizardStep[];
    /** 运行中的步骤 id（父组件持有，跨组件复用时状态上收）。 */
    running?: string | null;
    /** params 仅 whisper-model 步骤携带（model/mirror），其余步骤不传。 */
    onrun: (id: string, force: boolean, params?: WizardRunParams) => void;
    /** 取消运行中的步骤（走查 2026-09-24）；未提供时中断按钮隐藏、退回禁用态。 */
    oncancel?: (id: string) => void;
  } = $props();

  /** 每步独立的强制开关（纯视图状态，不落库）。 */
  let forceMap = $state<Record<string, boolean>>({});

  /** whisper-model 步骤的模型/镜像选择（默认 large-v3-turbo + official，与种子一致）。 */
  let whisperModel = $state("whisper-large-v3-turbo");
  let whisperMirror = $state<WhisperMirrorId>("official");

  // 选型回填（2026-09-25 Windows 实测教训）：行 url 是后端持久化的事实源——
  // 组件卸载重建（分区切换/刷新）后视图默认值不得越过它，否则下次点下载会把
  // 回退后的默认组合（turbo + 官方源）意外持久化。仅在 url 出现/变化时回填；
  // 用户手改选型不触碰 url，不会被覆盖。
  $effect(() => {
    const url = steps.find((s) => s.id === "whisper-model")?.url;
    if (!url) return;
    try {
      const parsed = new URL(url);
      const mirror = WHISPER_MIRRORS.find((m) => parsed.origin === m.base)?.id;
      const model = whisperModelIdFromRepo(parsed.pathname.replace(/^\//, ""));
      if (mirror) whisperMirror = mirror;
      if (model) whisperModel = model;
    } catch {
      /* 非 URL 形态（null/残缺）保持现值 */
    }
  });

  /** 选中的步骤 id（list-detail 主从选择；缺省首步——空列表时 null）。 */
  let selectedId = $state<string | null>(null);
  const selected = $derived(
    steps.find((s) => s.id === (selectedId ?? steps[0]?.id)) ?? steps[0] ?? null,
  );

  /** 桌面/移动切换（md 768px）：桌面双栏，移动列表 + 右抽屉（前台同款）。 */
  let desktop = $state(true);
  $effect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const sync = () => (desktop = mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  });

  /** 移动详情抽屉开关。 */
  let detailOpen = $state(false);

  /** 列表行点击：桌面=切换选中；移动=选中并开抽屉。 */
  function pickStep(stepId: string): void {
    selectedId = stepId;
    if (!desktop) detailOpen = true;
  }

  // ---- 步骤日志 <pre> 自动滚底（仅当用户没往上滚时） ----

  /**
   * 每步日志 <pre> 元素与吸底标记（键=step.id；缺省吸底）。
   * 注意：详情同一时刻只挂载一份（桌面面板 / 移动抽屉互斥），但切换选中或
   * 关抽屉会卸载元素——bind:this 会被置 null，判空须含 null。
   */
  let logEls = $state<Record<string, HTMLPreElement | null | undefined>>({});
  let logStick = $state<Record<string, boolean>>({});

  /** 用户滚动时更新吸底标记：接近底部=跟随，往上滚=暂停自动滚动。 */
  function onLogScroll(stepId: string): void {
    const el = logEls[stepId];
    if (el === null || el === undefined) return;
    logStick[stepId] = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
  }

  // lastLog 变化 → 吸底的步骤滚到底部（简单实现：scrollTop=scrollHeight）。
  $effect(() => {
    for (const step of steps) {
      void step.lastLog.length;
      const el = logEls[step.id];
      if (el !== null && el !== undefined && (logStick[step.id] ?? true)) {
        el.scrollTop = el.scrollHeight;
      }
    }
  });

  /**
   * 当前站点的 whisper 引擎族（W9：mac=mlx-community、win/linux=Systran）——
   * 从行上种子 url 反推（url 由 daemon 按平台落库，是站点事实），不猜 UA。
   */
  const whisperEngine = $derived.by(() => {
    const row = steps.find((s) => s.id === "whisper-model");
    return row?.url?.includes("/Systran/") ? "faster" : "mlx";
  });

  /**
   * whisper 选中模型/镜像组合的预测来源 URL（客户端合成，仅作显示，
   * 选中立即更新；真正的持久化在点击下载时由后端写）。repo 按引擎族映射
   * （whisperRepoFor，与 daemon resolveWhisperUrl 同一规则）。
   */
  const whisperPredictedUrl = $derived.by(() => {
    const mirror = WHISPER_MIRRORS.find((candidate) => candidate.id === whisperMirror);
    const repo = whisperRepoFor(whisperModel, whisperEngine);
    if (mirror === undefined || repo === undefined) return "";
    // 四轮：来源 = 模型页（${mirror.base}/${repo}）；下载走 HF_ENDPOINT + HF 标准缓存。
    return `${mirror.base}/${repo}`;
  });

  /**
   * 状态文案按 kind 分型：命令类=待执行/执行中/已安装，下载类=待下载/下载中/
   * 已下载。isRunning 为父组件乐观值（pending 但刚点过运行）时同样按 kind
   * 显示运行文案。done 且嗅探来源 → 「已就绪（嗅探）」单 badge 完整表达。
   */
  function statusLabel(step: WizardStep, isRunning: boolean): string {
    const runningLabel =
      step.kind === "command"
        ? "执行中"
        : step.progress > 0
          ? `下载中 ${step.progress.toFixed(2)}%`
          : "下载中";
    if (isRunning) return runningLabel;
    switch (step.status) {
      case "pending":
        return step.kind === "command" ? "待执行" : "待下载";
      case "running":
        return runningLabel;
      case "done":
        if (step.detected) return "已就绪（嗅探）";
        return step.kind === "command" ? "已安装" : "已下载";
      case "failed":
        return "失败";
      case "skipped":
        return "已跳过";
    }
  }

  /** 按钮文字：命令=运行；下载=.download 残差存在=恢复下载，否则开始下载。 */
  function actionLabel(step: WizardStep): string {
    if (step.kind === "command") return "运行";
    return step.resumable ? "恢复下载" : "开始下载";
  }

  /** done 态且未开强制开关时按钮旁的说明行。 */
  function rerunHint(step: WizardStep): string {
    return step.kind === "command" ? "重跑请先开启强制开关。" : "重新下载请先开启「覆盖下载」。";
  }

  /** 体积展示：≥1024MB 折算 GB 一位小数，否则整 MB。 */
  function formatSize(sizeMb: number): string {
    return sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(1)}GB` : `${sizeMb}MB`;
  }

  /** 模型选项组合 label：`base · 148MB · 约 0.6GB 内存 · 默认推荐`。 */
  function modelOptionLabel(model: WhisperModelOption): string {
    return `${model.id} · ${formatSize(model.sizeMb)} · ${model.memoryHint}`;
  }

  /** Select.Root 的 items 形状（触发器在内容挂载前也能解析出展示 label）。 */
  const whisperModelItems = WHISPER_MODEL_CATALOG.map((model) => ({
    value: model.id,
    label: modelOptionLabel(model),
  }));
  const whisperMirrorItems = WHISPER_MIRRORS.map((mirror) => ({ value: mirror.id, label: mirror.label }));

  /** 点击运行/下载：whisper-model 步骤随发选中的模型与镜像，其余不传 params。 */
  function runStep(step: WizardStep, force: boolean): void {
    if (step.id === "whisper-model") {
      onrun(step.id, force, { model: whisperModel, mirror: whisperMirror });
    } else {
      onrun(step.id, force);
    }
  }

  function lastLine(log: string): string {
    const lines = log.split("\n").filter((line) => line.trim().length > 0);
    return lines[lines.length - 1] ?? "";
  }

  /** 状态徽章 variant（列表行与详情头共用一份口径）。 */
  function badgeVariant(step: WizardStep, isRunning: boolean): "secondary" | "destructive" | "default" | "outline" {
    if (step.status === "done") return "secondary";
    if (step.status === "failed") return "destructive";
    if (isRunning) return "default";
    return "outline";
  }
</script>

{#snippet stepRow(step: WizardStep)}
  {@const isRunning = running === step.id || step.status === "running"}
  {@const active = selected?.id === step.id}
  <button
    type="button"
    class="flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors {active
      ? "bg-accent-soft"
      : "hover:bg-muted/60"} {isRunning ? "ring-1 ring-primary/40" : ""}"
    aria-current={active ? "true" : undefined}
    onclick={() => pickStep(step.id)}
  >
    <span class="flex w-full items-center gap-2">
      <!-- min-w-0/truncate：长标题在窄列里截断（三轮实证：长行会把 flex 链顶穿）。 -->
      <span class="min-w-0 flex-1 truncate text-xs font-medium">{step.title}</span>
      <Badge variant={badgeVariant(step, isRunning)} class="shrink-0 text-[10px]">
        {statusLabel(step, isRunning)}
      </Badge>
    </span>
    <span
      class="block w-full truncate rounded bg-muted/60 px-1.5 py-0.5 text-left font-mono text-[11px] text-muted-foreground"
    >
      {step.kind === "command"
        ? (step.lastLog.length > 0 ? lastLine(step.lastLog) : (step.command ?? ""))
        : (step.url ?? "")}
    </span>
  </button>
{/snippet}

{#snippet detailBody(step: WizardStep)}
  {@const isRunning = running === step.id || step.status === "running"}
  {@const force = forceMap[step.id] ?? false}
  {@const rerunLocked = step.status === "done" && !force}
  <div class="flex min-w-0 flex-col gap-3 text-xs text-muted-foreground">
    <div class="flex flex-col gap-1">
      <span class="break-all">
        目标目录：<span class="font-mono text-foreground">{step.targetDir}</span>
      </span>
      {#if step.id === "whisper-model" && whisperPredictedUrl !== ""}
        <span class="break-all">
          来源：<a
            href={whisperPredictedUrl}
            target="_blank"
            rel="noreferrer"
            class="text-primary underline underline-offset-2">{whisperPredictedUrl}</a
          >
          <span class="text-[10px]">（随选中即时更新；点击下载后由后端持久化）</span>
        </span>
      {:else if step.url}
        <span class="break-all">
          来源：<a
            href={step.url}
            target="_blank"
            rel="noreferrer"
            class="text-primary underline underline-offset-2">{step.url}</a
          >
        </span>
      {/if}
      {#if step.command}
        <span class="break-all">命令：<span class="font-mono text-foreground">{step.command}</span></span>
      {/if}
    </div>
    {#if step.kind === "download"}
      <!-- 下载进度条 + current/total 文案；终态保留（100% / 失败红条），不清空。
           未开始（无进度文案）显示占位，保持面板结构稳定。 -->
      <div class="flex flex-col gap-1">
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono text-foreground">{step.progressText ?? "未开始下载"}</span>
          {#if step.status === "failed"}
            <span class="text-destructive">下载失败</span>
          {/if}
        </div>
        <span class="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <span
            class="h-full rounded-full transition-all duration-300 {step.status === 'failed'
              ? 'bg-destructive'
              : 'bg-primary'}"
            style="width: {step.progress}%"
          ></span>
        </span>
      </div>
    {/if}
    {#if step.lastLog.length > 0}
      <!-- 详情面板限高内滚（改版动机：长日志不再把手风琴后续区块顶穿）；
           滚底跟随逻辑保留——用户上滚即停，回底恢复。overflow-wrap:anywhere：
           日志里的长 URL/路径（无空格 token）在窄屏必须可断，否则把整条 flex
           链横向顶穿（Windows 实测 ffmpeg 下载 URL 撑到 440px+）。 -->
      <pre
        bind:this={logEls[step.id]}
        onscroll={() => onLogScroll(step.id)}
        class="max-h-48 min-w-0 overflow-y-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{step.lastLog}</pre
      >
    {/if}
    <!-- whisper-model 专属：模型 + 镜像源选择（选中值随下载动作传出） -->
    {#if step.id === "whisper-model"}
      <div class="grid gap-2 sm:grid-cols-2">
        <label class="flex min-w-0 flex-col gap-1">
          <span class="text-muted-foreground">模型</span>
          <Select.Root type="single" items={whisperModelItems} bind:value={whisperModel}>
            <Select.Trigger class="h-8 w-full min-w-0 text-xs" aria-label="选择 whisper 模型">
              <Select.Value />
            </Select.Trigger>
            <Select.Content class="max-h-64 text-xs">
              {#each WHISPER_MODEL_CATALOG as model (model.id)}
                <Select.Item value={model.id} label={modelOptionLabel(model)}>
                  {modelOptionLabel(model)}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </label>
        <label class="flex min-w-0 flex-col gap-1">
          <span class="text-muted-foreground">镜像源</span>
          <Select.Root type="single" items={whisperMirrorItems} bind:value={whisperMirror}>
            <Select.Trigger class="h-8 w-full min-w-0 text-xs" aria-label="选择下载镜像源">
              <Select.Value />
            </Select.Trigger>
            <Select.Content class="max-h-64 text-xs">
              {#each WHISPER_MIRRORS as mirror (mirror.id)}
                <Select.Item value={mirror.id} label={mirror.label}>{mirror.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </label>
      </div>
    {/if}
    <div class="flex items-center justify-between gap-3">
      <label class="flex items-center gap-2">
        <Switch
          checked={force}
          onCheckedChange={(value) => (forceMap[step.id] = value)}
          disabled={isRunning}
          aria-label="强制执行"
        />
        <span>{step.kind === "command" ? "强制执行（嗅探已装也重跑）" : "覆盖下载"}</span>
      </label>
      {#if isRunning}
        {#if oncancel}
          <Button
            size="sm"
            variant="outline"
            class="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onclick={() => oncancel(step.id)}
          >
            <IconSquare class="size-3 fill-current" />
            中断
          </Button>
        {:else}
          <Button size="sm" disabled>
            {step.kind === "command" ? "执行中…" : "下载中…"}
          </Button>
        {/if}
      {:else}
        <Button size="sm" disabled={rerunLocked} onclick={() => runStep(step, force)}>
          <IconPlay />
          {actionLabel(step)}
        </Button>
      {/if}
    </div>
    {#if rerunLocked && !isRunning}
      <p class="text-right text-[11px] text-muted-foreground">{rerunHint(step)}</p>
    {/if}
  </div>
{/snippet}

{#if desktop}
  <!-- 桌面：左列表右详情（list-detail）。列表限高内滚；详情日志自身限高，
       页面布局不随日志长度膨胀（手风琴时代的布局问题就此收口）。 -->
  <div class="grid gap-3 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
    <div class="flex max-h-80 flex-col gap-1 overflow-y-auto rounded-lg border bg-card/60 p-1.5">
      {#each steps as step (step.id)}
        {@render stepRow(step)}
      {/each}
    </div>
    <div class="rounded-lg border bg-card px-4 py-3">
      {#if selected}
        <div class="mb-3 flex items-center gap-2 border-b border-border pb-2.5">
          <h4 class="min-w-0 flex-1 truncate text-sm font-medium">{selected.title}</h4>
          <Badge variant={badgeVariant(selected, running === selected.id || selected.status === "running")} class="shrink-0 text-[10px]">
            {statusLabel(selected, running === selected.id || selected.status === "running")}
          </Badge>
        </div>
        {@render detailBody(selected)}
      {:else}
        <p class="py-8 text-center text-xs text-muted-foreground">暂无步骤</p>
      {/if}
    </div>
  </div>
{:else}
  <!-- 移动：列表全宽；点行从右侧 Sheet 抽屉展开详情（前台 ListDetailPage 同款）。 -->
  <div class="flex w-full min-w-0 flex-col gap-1 rounded-lg border bg-card/60 p-1.5">
    {#each steps as step (step.id)}
      {@render stepRow(step)}
    {/each}
  </div>

  <Sheet.Root bind:open={detailOpen}>
    <Sheet.Content side="right" class="gap-0 p-0 sm:max-w-md" hideClose>
      {#if selected}
        <Sheet.Header class="flex-row items-center justify-between gap-2 border-b px-3 py-2">
          <Sheet.Title class="min-w-0 flex-1 truncate text-sm font-medium">{selected.title}</Sheet.Title>
          <Badge
            variant={badgeVariant(selected, running === selected.id || selected.status === "running")}
            class="shrink-0 text-[10px]"
          >
            {statusLabel(selected, running === selected.id || selected.status === "running")}
          </Badge>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="关闭详情"
            onclick={() => (detailOpen = false)}
          >
            <IconX class="size-4" aria-hidden="true" />
          </Button>
        </Sheet.Header>
        <div class="min-h-0 flex-1 overflow-y-auto p-4">
          {@render detailBody(selected)}
        </div>
      {/if}
    </Sheet.Content>
  </Sheet.Root>
{/if}
