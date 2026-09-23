<!--
  准备步骤手风琴（PRODUCT_DESIGN §1.2 / §2 settings 页共用组件）。
  原始需求 [2026-09-23]：两类步骤（命令安装/依赖下载），每项 summary 内嵌实时
  预览（命令=last-line-log 尾行，下载=进度条），显示目标目录+来源链接；嗅探
  已存在默认跳过 +「强制执行/强制下载」开关；运行/下载按钮。
  Owner 走查修订 [2026-09-24]：
  1. 状态文案按 kind 分型（命令=待执行/已安装，下载=待下载/已下载），两套不混用。
  2. done 态按钮默认 disabled，勾选强制开关才 enable，并在按钮附近给说明行。
  3. 嗅探徽章 kind-aware（已安装（嗅探）/ 已下载（嗅探））。
  4. whisper-model 步骤内嵌模型/镜像选择器，选中值随 onrun params 传出。
  走查修订 [2026-09-24 · 三轮]：
  1. 下载运行徽章带百分比：「下载中 nn.nn%」（解析精度两位小数）。
  2. title 摘要 span 补 block——inline 元素上 w-full/truncate 不生效，长行撑破布局。
  3. whisper 两个 Select 触发器 w-fit 撑破格子（选中 large-v3-turbo 与镜像源重叠）
     → w-full min-w-0 + label min-w-0。
  4. 下载开关改「覆盖下载」（force=丢弃 .download 从头下载）；按钮按残差分
     「开始下载 / 恢复下载」。
  走查修订 [2026-09-24 · 二轮]：
  1. running 徽章/按钮按 kind 分型（命令=执行中，下载=下载中），运行中按钮变
     「中断」（oncancel），不再禁用等待。
  2. title 摘要区只留命令尾行/下载 URL——进度条只在展开面板里渲染一条。
  朱墨前端改造 [2026-09-24]（BUG1+3 实时日志与进度）：
  1. 展开面板 lastLog 全量 <pre> 自动滚底（用户上滚即停，回底恢复跟随）。
  2. 下载步骤进度条 + current/total 文案（12.3MB / 148.0MB（8%））；终态保留
     100% / 失败红条，不清空。
  3. whisper 来源链接显示选中组合的预测 URL（客户端合成，选中即更新；
     持久化仍由点击下载时后端写）。
  正交意图：
  1. 手风琴呈现（shadcn Accordion）+ 状态徽章（pending/running/done/failed/skipped）。
  2. summary 实时预览分型：command → lastLog 尾行 mono；download → 进度条。
  3. 强制执行开关 + 运行按钮（Loading 锁；错误信息中文）。
-->
<script lang="ts">
  import * as Accordion from "$lib/components/ui/accordion";
  import * as Select from "$lib/components/ui/select";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import IconPlay from "@lucide/svelte/icons/play";
  import IconSquare from "@lucide/svelte/icons/square";
  import { WHISPER_MIRRORS, WHISPER_MODEL_CATALOG } from "@zhumo/contracts";
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

  // ---- BUG1：步骤日志 <pre> 自动滚底（仅当用户没往上滚时） ----

  /**
   * 每步日志 <pre> 元素与吸底标记（键=step.id；缺省吸底）。
   * 注意：手风琴收起时内容卸载，bind:this 会被置为 null——判空须含 null。
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
   * BUG3：whisper 选中模型/镜像组合的预测来源 URL（客户端合成，仅作显示，
   * 选中立即更新；真正的持久化在点击下载时由后端写）。
   */
  const whisperPredictedUrl = $derived.by(() => {
    const mirror = WHISPER_MIRRORS.find((candidate) => candidate.id === whisperMirror);
    const model = WHISPER_MODEL_CATALOG.find((candidate) => candidate.id === whisperModel);
    if (mirror === undefined || model === undefined) return "";
    // 四轮：来源 = 模型页（${mirror.base}/${repo}）；下载走 HF_ENDPOINT + HF 标准缓存。
    return `${mirror.base}/${model.repo}`;
  });

  /**
   * 状态文案按 kind 分型：命令类=待执行/执行中/已安装，下载类=待下载/下载中/
   * 已下载（走查 2026-09-24 · 二轮：running 不再统一「进行中」）。isRunning 为
   * 父组件乐观值（pending 但刚点过运行）时同样按 kind 显示运行文案。
   */
  function statusLabel(step: WizardStep, isRunning: boolean): string {
    // 三轮：下载运行中带两位小数百分比（「下载中 nn.nn%」）；无进度行时纯文案。
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
        return step.kind === "command" ? "已安装" : "已下载";
      case "failed":
        return "失败";
      case "skipped":
        return "已跳过";
    }
  }

  /** 嗅探徽章 kind-aware：命令=已安装（嗅探），下载=已下载（嗅探）。 */
  function detectedLabel(step: WizardStep): string {
    return step.kind === "command" ? "已安装（嗅探）" : "已下载（嗅探）";
  }

  /** 按钮文字（三轮）：命令=运行；下载=.download 残差存在=恢复下载，否则开始下载。 */
  function actionLabel(step: WizardStep): string {
    if (step.kind === "command") return "运行";
    return step.resumable ? "恢复下载" : "开始下载";
  }

  /** done 态且未开强制开关时按钮旁的说明行（kind-aware）。 */
  function rerunHint(step: WizardStep): string {
    return step.kind === "command"
      ? "已安装；重跑请先开启强制开关。"
      : "已下载；重新下载请先开启「覆盖下载」。";
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
</script>

<Accordion.Root type="multiple" class="gap-2">
  {#each steps as step (step.id)}
    {@const isRunning = running === step.id || step.status === "running"}
    {@const force = forceMap[step.id] ?? false}
    {@const rerunLocked = step.status === "done" && !force}
    <Accordion.Item
      value={step.id}
      class="rounded-lg border bg-card px-4 {isRunning ? 'border-primary/40' : ''}"
    >
      <!-- min-w-0：Trigger 是 Header(flex) 的 flex item，min-width:auto 会随长日志行
           撑开（三轮实证：2864px 长行把 w-full/truncate 全链顶穿，只剩祖先硬剪）。 -->
      <Accordion.Trigger class="min-w-0 gap-3 py-3 text-sm hover:no-underline">
        <span class="flex min-w-0 flex-1 flex-col items-start gap-1">
          <span class="flex w-full items-center gap-2">
            <span class="truncate font-medium">{step.title}</span>
            {#if step.detected}
              <Badge variant="secondary" class="shrink-0 text-[10px]">{detectedLabel(step)}</Badge>
            {/if}
            <Badge
              variant={step.status === "done"
                ? "secondary"
                : step.status === "failed"
                  ? "destructive"
                  : isRunning
                    ? "default"
                    : "outline"}
              class="shrink-0 text-[10px]"
            >
              {statusLabel(step, isRunning)}
            </Badge>
          </span>
          <!-- summary 内嵌预览（走查 2026-09-24 · 二轮：title 不再放进度条——展开
               面板已有唯一进度条，title 只留命令尾行/下载 URL 的 mono 摘要） -->
          <span
            class="block w-full truncate rounded bg-muted/60 px-1.5 py-0.5 text-left font-mono text-[11px] text-muted-foreground"
          >
            {step.kind === "command"
              ? (step.lastLog.length > 0 ? lastLine(step.lastLog) : (step.command ?? ""))
              : (step.url ?? "")}
          </span>
        </span>
      </Accordion.Trigger>
      <Accordion.Content>
        <div class="flex flex-col gap-3 pb-4 text-xs text-muted-foreground">
          <div class="flex flex-col gap-1">
            <span>
              目标目录：<span class="font-mono text-foreground">{step.targetDir}</span>
            </span>
            {#if step.id === "whisper-model" && whisperPredictedUrl !== ""}
              <!-- BUG3：whisper 来源=选中模型/镜像的预测 URL（选中即更新，未运行时也显示）。 -->
              <span>
                来源：<a
                  href={whisperPredictedUrl}
                  target="_blank"
                  rel="noreferrer"
                  class="text-primary underline underline-offset-2">{whisperPredictedUrl}</a
                >
                <span class="text-[10px]">（随选中即时更新；点击下载后由后端持久化）</span>
              </span>
            {:else if step.url}
              <span>
                来源：<a
                  href={step.url}
                  target="_blank"
                  rel="noreferrer"
                  class="text-primary underline underline-offset-2">{step.url}</a
                >
              </span>
            {/if}
            {#if step.command}
              <span>命令：<span class="font-mono text-foreground">{step.command}</span></span>
            {/if}
          </div>
          {#if step.kind === "download"}
            <!-- BUG1：下载进度条 + current/total 文案；终态保留（100% / 失败红条），不清空。
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
            <pre
              bind:this={logEls[step.id]}
              onscroll={() => onLogScroll(step.id)}
              class="max-h-32 overflow-y-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{step.lastLog}</pre
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
      </Accordion.Content>
    </Accordion.Item>
  {/each}
</Accordion.Root>
