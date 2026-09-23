<!--
  Models 配置 v2（走查五轮 2026-09-24，全面对齐 skill-creator-v2）：
  五点落法——
  1. 连接测试：逐路由「测试连接」按钮（表单密钥直传优先 → 已存密钥），
     结果 inline 回显（testing… / ok · Nms / failed · detail）。
  2. 模型图标：路由 iconUrl（models.dev logos）三级回退字母头像；预设同。
  3. 协议：三协议 select（补 openai-responses）。
  4. 活动模型出清：服务配置只管路由；头部独立「默认模型」选择器；
     任务级模型选择在前台任务对话框（TaskComposer）。
  5. 上下文窗口草稿态提交（128k/0.5M 简写；非法红边不提交且阻断保存）；
     输入模态 chips（text 锁定 + image 可切）、输出 text 锁定。
  原有语义保留：tab 条（图标 + key 缺失点 + 默认 badge）、预设 Popover
  （搜索 + models.dev 刷新）、保存即桥接生效、生效路由头部投影。
-->
<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Badge } from "$lib/components/ui/badge";
  import * as Select from "$lib/components/ui/select";
  import * as Popover from "$lib/components/ui/popover";
  import IconPlugZap from "@lucide/svelte/icons/plug-zap";
  import { api } from "$lib/api";
  import type {
    DshModelRoute,
    ModelRouteInfo,
    ModelsCatalog,
    ModelsCatalogPreset,
    ModelsSettings,
    ModelsTestResult,
    RouteApi,
    RouteModel,
  } from "$lib/types";
  import { formatTokenCount, readableModelName, routeAvatarColor, routeLetter } from "./route-meta";

  const ROUTE_APIS: RouteApi[] = ["anthropic-messages", "openai-completions", "openai-responses"];

  let { onsaved }: { onsaved?: () => void } = $props();

  let settings = $state<ModelsSettings | null>(null);
  let selected = $state<string | null>(null);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let savedFlash = $state(false);
  /** 生效路由投影（bootstrap.model_route）；保存后刷新。 */
  let routeInfo = $state<ModelRouteInfo | null>(null);
  let routeInfoError = $state(false);
  /** 连接测试状态（键=provider）。 */
  let testing = $state<Record<string, boolean>>({});
  let testResult = $state<Record<string, ModelsTestResult | undefined>>({});
  /** 上下文窗口草稿（键=`provider/modelId`）；非法时红边并阻断保存。 */
  let contextDrafts = $state<Record<string, string>>({});
  let contextInvalid = $state<Record<string, boolean>>({});
  /** 密钥草稿（provider → 输入值；空=不更新）。 */
  let keyDrafts = $state<Record<string, string>>({});

  // ---- 预设选择器 ----
  let catalogOpen = $state(false);
  let catalog = $state<ModelsCatalog | null>(null);
  let catalogLoading = $state(false);
  let catalogError = $state<string | null>(null);
  let catalogQuery = $state("");
  let refreshing = $state(false);

  const routes = $derived(settings?.routes ?? []);
  const selectedRoute = $derived(routes.find((route) => route.provider === selected));
  const hasInvalidContext = $derived(Object.values(contextInvalid).some(Boolean));

  const filteredPresets = $derived.by(() => {
    const presets = catalog?.presets ?? [];
    const query = catalogQuery.trim().toLowerCase();
    if (query.length === 0) return presets;
    return presets.filter(
      (preset) =>
        preset.provider.toLowerCase().includes(query) || preset.name.toLowerCase().includes(query),
    );
  });

  const catalogFetchedLabel = $derived.by(() => {
    const at = catalog?.fetched_at ?? null;
    if (at === null) return null;
    const date = new Date(at);
    return `models.dev 更新于 ${Number.isNaN(date.getTime()) ? at : date.toLocaleString()}`;
  });

  $effect(() => {
    void load();
  });

  // 选中态归一：路由消失回退首 tab。
  $effect(() => {
    if (selected === null && routes.length > 0) selected = routes[0]?.provider ?? null;
    if (selected !== null && !routes.some((route) => route.provider === selected)) {
      selected = routes[0]?.provider ?? null;
    }
  });

  async function openCatalog(open: boolean): Promise<void> {
    catalogOpen = open;
    if (!open || catalog !== null || catalogLoading) return;
    await loadCatalog(false);
  }

  async function loadCatalog(force: boolean): Promise<void> {
    catalogError = null;
    if (force) refreshing = true;
    else catalogLoading = true;
    try {
      catalog = force ? await api.refreshModelsCatalog() : await api.getModelsCatalog();
    } catch (e) {
      catalogError = e instanceof Error ? e.message : String(e);
    } finally {
      catalogLoading = false;
      refreshing = false;
    }
  }

  /** 点选预设 → 新建路由（预填 provider/baseURL/api/图标 + 富模型字段）。 */
  function addRouteFromPreset(preset: ModelsCatalogPreset): void {
    if (settings === null) return;
    let provider = preset.provider;
    let suffix = 2;
    while (settings.routes.some((route) => route.provider === provider)) {
      provider = `${preset.provider}-${suffix}`;
      suffix += 1;
    }
    const api0 = ROUTE_APIS.includes(preset.api as RouteApi) ? (preset.api as RouteApi) : "openai-completions";
    const models: RouteModel[] = preset.models.slice(0, 8).map((model) => ({
      id: model.id,
      name: model.name,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.inputTypes !== undefined ? { inputTypes: model.inputTypes } : {}),
      efforts: ["low", "high", "max"],
    }));
    settings.routes.push({
      provider,
      api: api0,
      baseURL: preset.baseURL ?? "",
      ...(preset.iconUrl !== undefined ? { iconUrl: preset.iconUrl } : {}),
      models,
    });
    selected = provider;
    catalogOpen = false;
    catalogQuery = "";
  }

  async function loadRouteInfo(): Promise<void> {
    routeInfoError = false;
    try {
      routeInfo = (await api.getBootstrap()).modelRoute;
    } catch {
      routeInfoError = true;
    }
  }

  async function load(): Promise<void> {
    error = null;
    try {
      settings = await api.getModels();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return;
    }
    // 密钥草稿清空（新读面重新起算）；上下文草稿按存量值初始化。
    keyDrafts = {};
    for (const route of settings.routes) {
      for (const model of route.models) {
        const key = draftKey(route.provider, model.id);
        contextDrafts[key] =
          model.contextWindow === undefined ? "" : formatTokenCount(model.contextWindow);
      }
    }
    await loadRouteInfo();
  }

  async function save(): Promise<void> {
    if (settings === null || hasInvalidContext) return;
    saving = true;
    error = null;
    try {
      // 密钥草稿并入（apiKey 非空=更新；空=保留旧值——daemon 侧语义）。
      const snapshot = $state.snapshot(settings) as ModelsSettings;
      for (const route of snapshot.routes) {
        const draft = keyDrafts[route.provider]?.trim();
        if (draft && draft.length > 0) route.apiKey = draft;
      }
      await api.saveModels(snapshot);
      savedFlash = true;
      setTimeout(() => (savedFlash = false), 1200);
      await loadRouteInfo();
      onsaved?.();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function addRoute(): void {
    if (settings === null) return;
    const provider = `custom-${settings.routes.length + 1}`;
    settings.routes.push({
      provider,
      api: "openai-completions",
      baseURL: "https://api.example.com/v1",
      models: [{ id: "model-a", efforts: ["low", "high", "max"], inputTypes: ["text"] }],
    });
    selected = provider;
  }

  function removeRoute(provider: string): void {
    if (settings === null) return;
    settings.routes = settings.routes.filter((route) => route.provider !== provider);
    if (settings.default?.provider === provider) settings.default = null;
  }

  function addModel(route: DshModelRoute): void {
    route.models.push({
      id: `model-${route.models.length + 1}`,
      efforts: ["low", "high", "max"],
      inputTypes: ["text"],
    });
  }

  function displayName(model: RouteModel): string {
    return model.name ?? readableModelName(model.id);
  }

  // ---- 上下文窗口草稿：128k/0.5M/131072；blur/Enter 提交，非法红边不提交 ----
  function draftKey(provider: string, modelId: string): string {
    return `${provider}/${modelId}`;
  }

  function commitContext(provider: string, model: RouteModel): void {
    const key = draftKey(provider, model.id);
    const text = (contextDrafts[key] ?? "").trim();
    if (text.length === 0) {
      model.contextWindow = undefined;
      contextInvalid[key] = false;
      return;
    }
    const matched = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(text);
    if (matched === null) {
      contextInvalid[key] = true; // 红边 + 阻断保存；草稿保留待改
      return;
    }
    const base = Number.parseFloat(matched[1] ?? "0");
    const unit = matched[2]?.toLowerCase();
    const value =
      unit === "k"
        ? base * 1024
        : unit === "m"
          ? base * 1024 * 1024
          : base;
    const rounded = Math.round(value);
    if (!Number.isSafeInteger(rounded) || rounded <= 0) {
      contextInvalid[key] = true;
      return;
    }
    model.contextWindow = rounded;
    contextDrafts[key] = formatTokenCount(rounded); // 规范化回显
    contextInvalid[key] = false;
  }

  // ---- 输入/输出模态：text 恒锁定 ----
  function toggleInputType(model: RouteModel, type: "image"): void {
    const set = new Set(model.inputTypes ?? ["text"]);
    if (set.has(type)) set.delete(type);
    else set.add(type);
    set.add("text");
    model.inputTypes = ["text", ...[...set].filter((t) => t !== "text")] as RouteModel["inputTypes"];
  }

  function toggleOutputType(model: RouteModel, type: "image"): void {
    const set = new Set(model.outputTypes ?? ["text"]);
    if (set.has(type)) set.delete(type);
    else set.add(type);
    set.add("text");
    model.outputTypes = ["text", ...[...set].filter((t) => t !== "text")];
  }

  // ---- 连接测试：表单密钥草稿直传优先，否则已存密钥 ----
  async function runTest(route: DshModelRoute): Promise<void> {
    testing[route.provider] = true;
    testResult[route.provider] = undefined;
    try {
      const modelId = route.models[0]?.id ?? "";
      if (modelId.length === 0) {
        testResult[route.provider] = { ok: false, detail: "路由内没有模型可测" };
        return;
      }
      const draft = keyDrafts[route.provider]?.trim();
      testResult[route.provider] = await api.testModelRoute({
        api: route.api,
        baseURL: route.baseURL,
        modelId,
        ...(draft && draft.length > 0 ? { apiKey: draft } : { provider: route.provider }),
      });
    } catch (e) {
      testResult[route.provider] = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      testing[route.provider] = false;
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col gap-3">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <h3 class="text-sm font-medium">大模型服务</h3>
      <p class="mt-0.5 text-[11px] text-muted-foreground">
        配置模型路由与 API Key；活动模型在新建任务时选择，保存后对新会话生效。
      </p>
      <p class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        生效路由：
        {#if routeInfo !== null}
          <span class="font-mono text-foreground">{routeInfo.provider} / {routeInfo.model}</span>
          <Badge variant="secondary" class="text-[9px]">
            {routeInfo.source === "settings" ? "后台配置" : ".env 引导值"}
          </Badge>
        {:else if routeInfoError}
          <span class="text-muted-foreground/70">未知（读取失败）</span>
        {:else}
          <span class="font-medium text-destructive">未配置</span>
        {/if}
      </p>
    </div>
    {#if settings !== null}
      <div class="flex shrink-0 items-center gap-2">
        <Popover.Root open={catalogOpen} onOpenChange={(open) => void openCatalog(open)}>
          <Popover.Trigger>
            {#snippet child({ props })}
              <Button size="sm" variant="outline" {...props}>从预设添加</Button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Content class="w-80 p-0">
            <div class="flex flex-col">
              <div class="border-b border-border p-2">
                <!-- svelte-ignore a11y_autofocus -->
                <Input
                  autofocus
                  bind:value={catalogQuery}
                  placeholder="搜索 provider 或名称…"
                  class="h-8 text-xs"
                />
              </div>
              <div class="max-h-64 overflow-y-auto p-1">
                {#if catalogLoading}
                  <p class="p-3 text-center text-xs text-muted-foreground">加载预设中…</p>
                {:else if filteredPresets.length === 0}
                  <p class="p-3 text-center text-xs text-muted-foreground">没有匹配的预设</p>
                {:else}
                  {#each filteredPresets as preset (preset.provider + preset.name)}
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                      onclick={() => addRouteFromPreset(preset)}
                    >
                      {#if preset.iconUrl}
                        <img
                          src={preset.iconUrl}
                          alt=""
                          class="h-5 w-5 shrink-0 object-contain dark:invert"
                          onerror={(event) => ((event.currentTarget as HTMLImageElement).style.display = "none")}
                        />
                      {:else}
                        <span
                          class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[9px] font-semibold text-white"
                          style="background: {routeAvatarColor({ provider: preset.provider })}"
                          aria-hidden="true">{preset.provider.slice(0, 1).toUpperCase()}</span
                        >
                      {/if}
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-xs font-medium">{preset.name}</span>
                        <span class="truncate font-mono text-[10px] text-muted-foreground">
                          {preset.provider} · {preset.models.length} 个模型{preset.baseURL
                            ? ` · ${preset.baseURL}`
                            : ""}
                        </span>
                      </span>
                      <Badge
                        variant={preset.source === "builtin" ? "secondary" : "outline"}
                        class="shrink-0 text-[9px]"
                      >
                        {preset.source === "builtin" ? "内置" : "models.dev"}
                      </Badge>
                    </button>
                  {/each}
                {/if}
              </div>
              <div class="flex items-center justify-between gap-2 border-t border-border p-2">
                <span class="min-w-0 truncate text-[10px] text-muted-foreground">
                  {catalogFetchedLabel ?? "尚未从 models.dev 拉取"}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={refreshing}
                  onclick={() => void loadCatalog(true)}
                >
                  {refreshing ? "刷新中…" : "从 models.dev 刷新预设"}
                </Button>
              </div>
              {#if catalogError}
                <p class="border-t border-border px-2 py-1.5 text-[11px] text-destructive" role="alert">
                  预设加载失败：{catalogError}
                </p>
              {/if}
            </div>
          </Popover.Content>
        </Popover.Root>
        <Button size="sm" variant="outline" onclick={addRoute}>+ 新路由</Button>
      </div>
    {/if}
  </div>

  {#if settings !== null}
    <!-- 默认模型（五轮 · 四：独立选择器，不掺进路由编辑） -->
    <div class="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
      <span class="shrink-0 text-xs text-muted-foreground">默认模型</span>
      <Select.Root
        type="single"
        items={routes.flatMap((route) =>
          route.models.map((model) => ({
            value: `${route.provider}::${model.id}`,
            label: `${route.provider} / ${displayName(model)}`,
          })),
        )}
        value={settings.default ? `${settings.default.provider}::${settings.default.model}` : undefined}
        onValueChange={(value) => {
          if (settings === null || !value) return;
          const [provider, model] = value.split("::");
          settings.default =
            provider !== undefined && model !== undefined ? { provider, model } : null;
        }}
      >
        <Select.Trigger class="h-8 min-w-0 flex-1 text-xs" aria-label="选择默认模型">
          <Select.Value placeholder="未设置（任务未指定时跟随首个路由）" />
        </Select.Trigger>
        <Select.Content class="max-h-64 text-xs">
          {#each routes as route (route.provider)}
            {#each route.models as model (model.id)}
              <Select.Item
                value={`${route.provider}::${model.id}`}
                label={`${route.provider} / ${displayName(model)}`}
              >
                {route.provider} / {displayName(model)}
              </Select.Item>
            {/each}
          {/each}
        </Select.Content>
      </Select.Root>
      <span class="shrink-0 text-[10px] text-muted-foreground">新建任务未选模型时使用</span>
    </div>

    <!-- tab 条 -->
    <div class="flex items-stretch gap-1 overflow-x-auto border-b border-border pb-px">
      {#each routes as route (route.provider)}
        {@const isDefaultRoute = settings?.default?.provider === route.provider}
        <button
          type="button"
          role="tab"
          aria-selected={selected === route.provider}
          class="flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs font-medium transition-colors {selected ===
          route.provider
            ? 'rounded-t-md border-b-2 border-primary text-foreground'
            : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground'}"
          onclick={() => (selected = route.provider)}
        >
          {#if route.iconUrl}
            <img
              src={route.iconUrl}
              alt=""
              class="h-4 w-4 shrink-0 object-contain dark:invert"
              onerror={(event) => ((event.currentTarget as HTMLImageElement).style.display = "none")}
            />
          {:else}
            <span
              class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[8px] font-semibold text-white"
              style="background: {routeAvatarColor(route)}"
              aria-hidden="true">{routeLetter(route)}</span
            >
          {/if}
          <span class="max-w-[120px] truncate">{route.provider}</span>
          {#if !route.hasKey && (keyDrafts[route.provider] ?? "").length === 0}
            <span class="h-1 w-1 rounded-full bg-amber-500" title="缺少 API Key"></span>
          {/if}
          {#if isDefaultRoute}
            <span
              class="rounded bg-primary/10 px-1 py-px text-[9px] font-medium leading-tight text-primary"
              >默认</span
            >
          {/if}
        </button>
      {/each}
    </div>

    <!-- 路由编辑面 -->
    {#if selectedRoute}
      {@const route = selectedRoute}
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
        <div class="grid grid-cols-2 gap-2">
          <label class="flex flex-col gap-1 text-xs">
            <span class="text-muted-foreground">路由名（provider）</span>
            <Input bind:value={route.provider} class="h-8 text-xs" />
          </label>
          <label class="flex flex-col gap-1 text-xs">
            <span class="text-muted-foreground">wire 协议（api）</span>
            <Select.Root type="single" bind:value={route.api}>
              <Select.Trigger class="h-8 text-xs" aria-label="选择 wire 协议">
                <Select.Value />
              </Select.Trigger>
              <Select.Content class="text-xs">
                {#each ROUTE_APIS as api0 (api0)}
                  <Select.Item value={api0}>{api0}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </label>
          <label class="flex flex-col gap-1 text-xs">
            <span class="text-muted-foreground">Base URL</span>
            <Input bind:value={route.baseURL} class="h-8 font-mono text-xs" />
          </label>
          <label class="flex flex-col gap-1 text-xs">
            <span class="text-muted-foreground">
              API Key {route.hasKey || (keyDrafts[route.provider] ?? "").length > 0
                ? "（已配置）"
                : "（缺失）"}
            </span>
            <Input
              bind:value={keyDrafts[route.provider]}
              type="password"
              class="h-8 font-mono text-xs"
              placeholder={route.hasKey ? "已保存（输入即更新）" : "sk-..."}
            />
          </label>
        </div>

        <!-- 连接测试（五轮 · 一） -->
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={testing[route.provider] || route.baseURL.trim().length === 0 || route.models.length === 0}
            onclick={() => void runTest(route)}
          >
            <IconPlugZap data-icon="inline-start" />
            {testing[route.provider] ? "测试中…" : "测试连接"}
          </Button>
          {#if testResult[route.provider]}
            {@const result = testResult[route.provider]!}
            {#if result.ok}
              <span class="text-xs font-medium text-primary">ok · {result.latencyMs} ms</span>
            {:else}
              <span class="text-xs text-destructive" role="alert">failed · {result.detail}</span>
            {/if}
          {/if}
          <span class="text-[10px] text-muted-foreground">
            以首个模型发最小探测请求；密钥用上方输入或已保存值
          </span>
        </div>

        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium">模型列表</span>
            <Button size="xs" variant="ghost" onclick={() => addModel(route)}>+ 加模型</Button>
          </div>
          {#each route.models as model, index (index)}
            {@const ck = draftKey(route.provider, model.id)}
            <div
              class="rounded-md border bg-muted/20 p-2 {settings?.default?.provider === route.provider &&
              settings?.default?.model === model.id
                ? "border-primary/50"
                : ""}"
            >
              <div class="flex flex-wrap items-center gap-2">
                <Input bind:value={model.id} class="h-7 w-44 font-mono text-xs" placeholder="模型 id" />
                <Input
                  bind:value={model.name}
                  class="h-7 w-36 text-xs"
                  placeholder={readableModelName(model.id)}
                />
                <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
                  上下文窗口
                  <Input
                    class="h-7 w-24 font-mono text-xs {contextInvalid[ck] ? "border-destructive" : ""}"
                    placeholder="128k / 0.5M"
                    value={contextDrafts[ck] ?? ""}
                    oninput={(event) => {
                      contextDrafts[ck] = event.currentTarget.value;
                      contextInvalid[ck] = false;
                    }}
                    onblur={() => commitContext(route.provider, model)}
                    onkeydown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </label>
                <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
                  Efforts
                  <Input
                    class="h-7 w-32 font-mono text-xs"
                    value={(model.efforts ?? []).join(",")}
                    placeholder="low,high,max"
                    oninput={(event) => {
                      const efforts = event.currentTarget.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0);
                      model.efforts = efforts.length > 0 ? efforts : undefined;
                    }}
                  />
                </label>
                <Button
                  size="xs"
                  variant="ghost"
                  class="ml-auto text-destructive"
                  onclick={() => route.models.splice(index, 1)}>移除</Button
                >
              </div>
              <!-- 输入/输出模态（五轮 · 五）：text 恒锁定 -->
              <div class="mt-1.5 flex flex-wrap items-center gap-2">
                <span class="text-[11px] text-muted-foreground">输入</span>
                <span
                  class="rounded bg-primary px-1.5 py-px text-[10px] font-medium text-primary-foreground"
                  >text</span
                >
                <button
                  type="button"
                  aria-pressed={(model.inputTypes ?? ["text"]).includes("image")}
                  class="rounded px-1.5 py-px text-[10px] font-medium transition-colors {(model.inputTypes ??
                  ["text"]).includes("image")
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:text-foreground"}"
                  onclick={() => toggleInputType(model, "image")}
                >
                  image
                </button>
                <span class="ml-2 text-[11px] text-muted-foreground">输出</span>
                <span
                  class="rounded bg-primary px-1.5 py-px text-[10px] font-medium text-primary-foreground"
                  >text</span
                >
                <button
                  type="button"
                  aria-pressed={(model.outputTypes ?? ["text"]).includes("image")}
                  class="rounded px-1.5 py-px text-[10px] font-medium transition-colors {(model.outputTypes ??
                  ["text"]).includes("image")
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:text-foreground"}"
                  onclick={() => toggleOutputType(model, "image")}
                >
                  image
                </button>
                <span class="ml-auto text-[11px] text-muted-foreground">
                  {displayName(model)}{model.contextWindow !== undefined
                    ? ` · ${formatTokenCount(model.contextWindow)}`
                    : ""}
                </span>
              </div>
            </div>
          {/each}
        </div>

        <div class="flex items-center justify-between border-t border-border pt-2">
          <Button size="sm" variant="ghost" class="text-destructive" onclick={() => removeRoute(route.provider)}>
            删除此路由
          </Button>
          <div class="flex items-center gap-2">
            {#if error}
              <span class="text-xs text-destructive" role="alert">{error}</span>
            {/if}
            {#if hasInvalidContext}
              <span class="text-xs text-destructive" role="alert">上下文窗口有非法输入（红边项）</span>
            {/if}
            {#if savedFlash}
              <span class="text-xs text-primary">已保存</span>
            {/if}
            <Button size="sm" disabled={saving || hasInvalidContext} onclick={() => void save()}>
              {saving ? "保存中…" : "保存配置"}
            </Button>
          </div>
        </div>
      </div>
    {:else}
      <div class="flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center">
        <p class="text-xs font-medium">还没有模型路由</p>
        <p class="max-w-[320px] text-[11px] leading-snug text-muted-foreground">
          添加一个 OpenAI/Anthropic 兼容端点，或配置智谱、DeepSeek 等服务商。
        </p>
        <Button size="sm" onclick={addRoute}>添加第一个路由</Button>
      </div>
    {/if}
  {:else if error}
    <div class="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4">
      <p class="text-xs font-medium text-destructive" role="alert">模型配置加载失败：{error}</p>
      <p class="text-[11px] text-muted-foreground">
        「需要管理员权限」时请先用管理员账号登录，再回到此页。
      </p>
      <Button size="sm" variant="outline" onclick={() => void load()}>重试</Button>
    </div>
  {:else}
    <div class="text-xs text-muted-foreground">加载中…</div>
  {/if}
</div>
