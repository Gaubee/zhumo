<!--
  单模型条目卡（skill-creator-v2 ModelListItem 结构复刻，2026-09-24 五轮 R2）：
  折叠行（dirty 点 + 名称 + 测试结果摘要 + test/edit/remove 三个 44px 命中区
  icon-button）；展开 = 全表单（id 补全 + name + efforts + 上下文窗口简写 +
  输入/输出模态 chips + 模型级连接测试）。
  语义对齐源实现：
  1. 预填钩子：id 命中目录候选时预填 name/contextWindow/inputTypes（手触字段
     不被覆盖；换 id 时手触位复位重预填）。
  2. token 简写：失焦 parseTokenShorthand——合法解析回显规范化格式，非法红边
     不提交（onvalidity 上抛阻断父级 Save）。
  3. 连接测试：routeKey（NewRouteTab 表单级草稿）> 已存凭据（provider 注入）>
     条目级 test-only 输入（用完即弃不落盘）。
  4. chips：text 恒选中不可去（视觉锁定），image 可切换。
-->
<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import IconPencil from "@lucide/svelte/icons/pencil";
  import IconPlugZap from "@lucide/svelte/icons/plug-zap";
  import IconTrash from "@lucide/svelte/icons/trash-2";
  import { api } from "$lib/api";
  import type { RouteModel } from "$lib/types";
  import {
    DEFAULT_MODEL_EFFORTS,
    formatTokenCount,
    parseTokenShorthand,
    readableModelName,
    type ModelCandidate,
  } from "./route-meta";

  let {
    model,
    candidates,
    api: wireApi,
    baseURL,
    provider = "",
    /** 该路由已存密钥（false = 展开态显示 test-only key 输入后可测）。 */
    hasKey = false,
    /** 表单级 key 草稿（NewRouteTab form 态；非空时视为已可测）。 */
    routeKey = "",
    disabled = false,
    /** 有未保存改动（父级对照已存路由逐条计算；折叠行小圆点）。 */
    dirty = false,
    /** 挂载即展开（+ 加模型的新空条目）。 */
    initialExpanded = false,
    onchange,
    onremove,
    onvalidity,
  }: {
    model: RouteModel;
    candidates: ModelCandidate[];
    api: string;
    baseURL: string;
    provider?: string;
    hasKey?: boolean;
    routeKey?: string;
    disabled?: boolean;
    dirty?: boolean;
    initialExpanded?: boolean;
    onchange: (next: RouteModel) => void;
    onremove: () => void;
    onvalidity: (valid: boolean) => void;
  } = $props();

  let expanded = $state(initialExpanded);
  // 本地草稿（挂载初始化一次；父级 Save 前不回写，避免输入打架）。
  // svelte-ignore state_referenced_locally
  let idText = $state(model.id);
  // svelte-ignore state_referenced_locally
  let nameText = $state(model.name ?? readableModelName(model.id));
  // svelte-ignore state_referenced_locally
  let contextText = $state(
    model.contextWindow !== undefined ? formatTokenCount(model.contextWindow) : "",
  );
  // svelte-ignore state_referenced_locally
  let effortsText = $state((model.efforts ?? []).join(","));
  let nameTouched = $state(false);
  let contextTouched = $state(false);
  let inputsTouched = $state(false);
  let effortsTouched = $state(false);
  let contextInvalid = $state(false);
  let testing = $state(false);
  let testResult = $state<{ ok: boolean; latencyMs?: number; detail?: string } | null>(null);
  let testOnlyKey = $state("");

  const hasRouteKey = $derived(routeKey.trim().length > 0);
  const idValid = $derived(idText.trim().length > 0);
  const testDisabled = $derived(testing || !idValid || (!hasRouteKey && !hasKey && testOnlyKey.trim().length === 0));
  const headerName = $derived(nameText.trim().length > 0 ? nameText.trim() : readableModelName(idText.trim() || model.id));
  const currentInputTypes = $derived(new Set(model.inputTypes ?? ["text"]));
  const currentOutputTypes = $derived(new Set(model.outputTypes ?? ["text"]));
  /** datalist id 实例化（多条目并存不串档）。走查 R5：randomUUID 仅 secure
   * context（HTTPS/localhost）存在——局域网 IP 直访（http://192.168.x.x）下为
   * undefined，条目挂载即抛异常、整个模型列表渲染崩溃（本地 localhost 走查
   * 全绿、真机全炸的根因）；Math.random 全上下文可用。 */
  const listId = `model-id-candidates-${Math.random().toString(36).slice(2, 10)}`;

  function emit(patch: Partial<RouteModel>): void {
    onchange({ ...model, ...patch });
  }

  /** id 每次输入都回传（走查 R4 实证修复：此前只在命中目录候选时 emit，
   * 自定义端点新建路由的模型 id 恒为空串 → 服务端 zod 400「Too small」，
   * 创建路由 100% 失败）；命中候选时叠加富预填（手触位不覆盖）。 */
  function onIdInput(value: string): void {
    idText = value;
    emit({ id: value.trim() });
    const hit = candidates.find((entry) => entry.id === value.trim());
    if (hit === undefined) return;
    if (!nameTouched && hit.name !== undefined) nameText = hit.name;
    if (!contextTouched && hit.contextWindow !== undefined) {
      contextText = formatTokenCount(hit.contextWindow);
    }
    if (!inputsTouched && hit.inputTypes !== undefined) emit({ inputTypes: hit.inputTypes });
    // 目录档位（zcode 策展 reasoningLevel）覆盖新建默认三档；手触位不覆盖。
    if (!effortsTouched && hit.efforts !== undefined && hit.efforts.length > 0) {
      effortsText = hit.efforts.join(",");
      emit({ efforts: [...hit.efforts] });
    }
  }

  function onNameInput(value: string): void {
    nameText = value;
    nameTouched = true;
  }

  function onEffortsInput(value: string): void {
    effortsText = value;
    effortsTouched = true;
    const efforts = value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    emit({ efforts: efforts.length > 0 ? efforts : undefined });
  }

  /** token 简写失焦：空=清除；合法=解析回显规范化；非法=红边不提交。 */
  function commitContext(): void {
    const trimmed = contextText.trim();
    contextTouched = true;
    if (trimmed.length === 0) {
      contextInvalid = false;
      contextText = "";
      emit({ contextWindow: undefined });
      return;
    }
    const parsed = parseTokenShorthand(trimmed);
    if (parsed === null) {
      contextInvalid = true;
      return;
    }
    contextInvalid = false;
    contextText = formatTokenCount(parsed);
    emit({ contextWindow: parsed });
  }

  function toggleInputType(kind: "image"): void {
    inputsTouched = true;
    const next = new Set(currentInputTypes);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    next.add("text");
    emit({ inputTypes: ["text", ...[...next].filter((t) => t !== "text")] as RouteModel["inputTypes"] });
  }

  function toggleOutputType(kind: "image"): void {
    const next = new Set(currentOutputTypes);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    next.add("text");
    emit({ outputTypes: ["text", ...[...next].filter((t) => t !== "text")] as RouteModel["outputTypes"] });
  }

  async function runTest(): Promise<void> {
    if (testDisabled) return;
    const directKey = hasRouteKey ? routeKey.trim() : hasKey ? null : testOnlyKey.trim();
    testing = true;
    testResult = null;
    try {
      testResult = await api.testModelRoute({
        api: wireApi,
        baseURL,
        modelId: idText.trim(),
        ...(directKey === null
          ? provider.length > 0
            ? { provider }
            : {}
          : { apiKey: directKey }),
      });
    } catch (e) {
      testResult = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      testing = false;
    }
  }

  // 条目合法性：id 非空且 token 字段合法 → 父级 Save 门。
  $effect(() => {
    onvalidity(idValid && !contextInvalid);
  });

  // 挂载即展开的新空条目：聚焦 id 输入。
  let idInput = $state<HTMLInputElement | null>(null);
  $effect(() => {
    // svelte-ignore state_referenced_locally
    if (initialExpanded) idInput?.focus();
  });
</script>

<div class="space-y-1.5 rounded-md border border-border p-2" aria-label="模型 {model.id}">
  <!-- 折叠 header 行：dirty 点 + 名称 + 测试摘要 + test/edit/remove（44px 命中区）。 -->
  <div class="flex items-center justify-between gap-2">
    <div class="flex min-w-0 flex-1 items-center gap-1.5">
      {#if dirty}
        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
          title="有未保存改动"
          aria-label="有未保存改动"></span>
      {/if}
      <span class="min-w-0 truncate text-xs font-medium" title={model.id}>{headerName}</span>
      {#if !expanded && (testing || testResult !== null)}
        <span
          class="min-w-0 shrink-0 truncate text-[10px] {testResult?.ok
            ? 'text-primary'
            : testResult && !testResult.ok
              ? 'text-destructive'
              : 'text-muted-foreground'}"
        >
          {#if testing}
            测试中…
          {:else if testResult?.ok}
            ok · {testResult.latencyMs} ms
          {:else if testResult}
            failed · {testResult.detail}
          {/if}
        </span>
      {/if}
    </div>
    <div class="flex shrink-0 items-center">
      <button
        type="button"
        class="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        aria-label="测试连接 {model.id || '新模型'}"
        title={hasRouteKey
          ? "以表单密钥发最小探测请求"
          : hasKey
            ? "发最小探测请求"
            : "展开并填写 test-only 密钥后可测（不落盘）"}
        disabled={testDisabled}
        onclick={() => void runTest()}
      >
        <IconPlugZap class="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        aria-label="编辑模型 {model.id || '新模型'}"
        title={expanded ? "收起表单" : "编辑模型字段"}
        {disabled}
        onclick={() => (expanded = !expanded)}
      >
        <IconPencil class="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
        aria-label="移除模型 {model.id}"
        title="移除模型"
        {disabled}
        onclick={() => onremove()}
      >
        <IconTrash class="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  </div>

  {#if expanded}
    <div class="grid grid-cols-2 gap-1.5">
      <label class="min-w-0 space-y-0.5">
        <span class="text-[10px] text-muted-foreground">模型 id</span>
        <Input
          class="h-8 font-mono text-xs"
          aria-label="模型 id"
          placeholder="模型 id，如 glm-5.3-flash"
          list={listId}
          bind:ref={idInput}
          bind:value={idText}
          {disabled}
          oninput={(event) => onIdInput(event.currentTarget.value)}
        />
        <datalist id={listId}>
          {#each candidates.slice(0, 200) as candidate (candidate.id)}
            <option value={candidate.id}>{candidate.name ?? ""}</option>
          {/each}
        </datalist>
      </label>
      <label class="min-w-0 space-y-0.5">
        <span class="text-[10px] text-muted-foreground">名称</span>
        <Input
          class="h-8 text-xs"
          aria-label="模型名称"
          placeholder={readableModelName(idText.trim() || model.id)}
          bind:value={nameText}
          {disabled}
          oninput={(event) => onNameInput(event.currentTarget.value)}
          onblur={() => emit(nameText.trim().length > 0 ? { name: nameText.trim() } : { name: undefined })}
        />
      </label>
      <label class="min-w-0 space-y-0.5">
        <span class="text-[10px] text-muted-foreground">上下文窗口（128k / 0.5M）</span>
        <Input
          class="h-8 font-mono text-xs {contextInvalid ? 'border-destructive' : ''}"
          aria-label="上下文窗口"
          placeholder="128k / 0.5M"
          bind:value={contextText}
          {disabled}
          oninput={() => (contextInvalid = false)}
          onblur={commitContext}
          onkeydown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
      <label class="min-w-0 space-y-0.5">
        <span class="text-[10px] text-muted-foreground">Efforts（逗号分隔）</span>
        <Input
          class="h-8 font-mono text-xs"
          aria-label="Efforts"
          placeholder={DEFAULT_MODEL_EFFORTS.join(",")}
          bind:value={effortsText}
          {disabled}
          oninput={(event) => onEffortsInput(event.currentTarget.value)}
        />
      </label>
    </div>

    <!-- 输入/输出模态 chips：text 恒锁定。 -->
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-[10px] text-muted-foreground">输入</span>
      <span class="rounded bg-primary px-1.5 py-px text-[10px] font-medium text-primary-foreground">text</span>
      <button
        type="button"
        aria-pressed={currentInputTypes.has("image")}
        class="rounded px-1.5 py-px text-[10px] font-medium transition-colors {currentInputTypes.has('image')
          ? 'bg-primary text-primary-foreground'
          : 'border border-border text-muted-foreground hover:text-foreground'}"
        {disabled}
        onclick={() => toggleInputType("image")}
      >
        image
      </button>
      <span class="ml-2 text-[10px] text-muted-foreground">输出</span>
      <span class="rounded bg-primary px-1.5 py-px text-[10px] font-medium text-primary-foreground">text</span>
      <button
        type="button"
        aria-pressed={currentOutputTypes.has("image")}
        class="rounded px-1.5 py-px text-[10px] font-medium transition-colors {currentOutputTypes.has('image')
          ? 'bg-primary text-primary-foreground'
          : 'border border-border text-muted-foreground hover:text-foreground'}"
        {disabled}
        onclick={() => toggleOutputType("image")}
      >
        image
      </button>
      <span class="ml-auto text-[10px] text-muted-foreground">
        {headerName}{model.contextWindow !== undefined ? ` · ${formatTokenCount(model.contextWindow)}` : ""}
      </span>
    </div>

    {#if !hasKey && !hasRouteKey}
      <!-- test-only 密钥（无已存凭据时探活用完即弃，不落盘）。 -->
      <div class="space-y-0.5">
        <span class="text-[10px] text-muted-foreground">test-only 密钥（仅测试，不保存）</span>
        <Input
          class="h-8 font-mono text-xs"
          type="password"
          aria-label="test-only 密钥"
          placeholder="sk-..."
          bind:value={testOnlyKey}
          {disabled}
        />
      </div>
    {/if}

    {#if testResult !== null}
      <p
        class="text-[11px] {testResult.ok ? 'text-primary' : 'text-destructive'}"
        role={testResult.ok ? undefined : "alert"}
      >
        {testResult.ok ? `ok · ${testResult.latencyMs} ms` : `failed · ${testResult.detail}`}
      </p>
    {/if}
  {/if}
</div>
