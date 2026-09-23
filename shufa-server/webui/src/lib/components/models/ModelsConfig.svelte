<!--
  Models 配置（移植自 skill-creator-v2 webui settings/*：ModelSettingsSection
  tab 条语法 + RouteTabContent 编辑面 + model-fields 数据模型；剔除目录画廊/
  IconPicker，图标统一字母头像）。
  原始需求 [2026-09-23]：DshModelRoute（provider/api/baseURL/apiKey/models[]/icon
  + 活动模型选择）；安装向导第 3 步与后台设置页共用。
  走查修复 [2026-09-23]：BUG4——加载失败不再只是红字+死按钮（+ 新路由在
  settings 未就绪时直接不渲染，错误态给重试）；头部展示生效路由（R4）。
  朱墨前端改造 [2026-09-24]：BUG4 预设选择器——「从预设添加」Popover（本地
  provider/name 搜索；点选新建路由并预填 provider/baseURL/api/models 前若干个，
  仍可改）；列表底部「从 models.dev 刷新预设」+ fetched_at 展示；加载失败给
  非阻断提示。
  正交意图：
  1. tab 条：每路由一 tab（字母头像 + key 缺失 amber 点 + active badge），
     横滚；+ New 追加路由。
  2. 路由编辑面：provider/api/baseURL/apiKey + models 列表（id/展示名/上下文
     窗口/efforts 增删改）+ 删除路由（ConfirmDialog 语法）。
  3. 活动模型选择：active = {provider, model}（路由内模型单选）。
  4. 持久化经 api.getModels/saveModels（mock→真 API 同签名），保存即生效；
     保存成功/失败均有可见反馈，成功后刷新生效路由展示。
  5. 预设目录（api.getModelsCatalog/refreshModelsCatalog）→ 预填新建路由。
-->
<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Badge } from "$lib/components/ui/badge";
  import * as Select from "$lib/components/ui/select";
  import * as Popover from "$lib/components/ui/popover";
  import { api } from "$lib/api";
  import type {
    DshModelRoute,
    ModelRouteInfo,
    ModelsCatalog,
    ModelsCatalogPreset,
    ModelsSettings,
    RouteModel,
  } from "$lib/types";
  import { formatTokenCount, readableModelName, routeAvatarColor, routeLetter } from "./route-meta";

  let { onsaved }: { onsaved?: () => void } = $props();

  let settings = $state<ModelsSettings | null>(null);
  let selected = $state<string | null>(null);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let savedFlash = $state(false);
  /** 生效路由（R4）：bootstrap.model_route 投影；保存后刷新。 */
  let routeInfo = $state<ModelRouteInfo | null>(null);
  let routeInfoError = $state(false);

  // ---- BUG4：预设选择器状态 ----
  let catalogOpen = $state(false);
  let catalog = $state<ModelsCatalog | null>(null);
  let catalogLoading = $state(false);
  let catalogError = $state<string | null>(null);
  let catalogQuery = $state("");
  let refreshing = $state(false);

  const routes = $derived(settings?.routes ?? []);
  const selectedRoute = $derived(routes.find((route) => route.provider === selected));

  /** 预设列表本地过滤（provider/名称，大小写不敏感）。 */
  const filteredPresets = $derived.by(() => {
    const presets = catalog?.presets ?? [];
    const query = catalogQuery.trim().toLowerCase();
    if (query.length === 0) return presets;
    return presets.filter(
      (preset) =>
        preset.provider.toLowerCase().includes(query) || preset.name.toLowerCase().includes(query),
    );
  });

  /** fetched_at 展示文案；null=从未拉取 models.dev。 */
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

  /** Popover 开关：首次打开惰性拉目录（失败非阻断，面板内红字提示）。 */
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

  /** 点选预设 → 新建路由并预填 provider/baseURL/api/models（前 8 个），用户仍可改。 */
  function addRouteFromPreset(preset: ModelsCatalogPreset): void {
    if (settings === null) return;
    let provider = preset.provider;
    let suffix = 2;
    while (settings.routes.some((route) => route.provider === provider)) {
      provider = `${preset.provider}-${suffix}`;
      suffix += 1;
    }
    const models: RouteModel[] = preset.models.slice(0, 8).map((model) => ({
      id: model.id,
      name: model.name,
      efforts: ["low", "high", "max"],
    }));
    settings.routes.push({
      provider,
      api: preset.api ?? "openai-completions",
      baseURL: preset.baseURL ?? "",
      apiKey: "",
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
      // 生效路由展示失败不阻断配置编辑，头部退化为「未知」。
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
    await loadRouteInfo();
  }

  async function save(): Promise<void> {
    if (settings === null) return;
    saving = true;
    error = null;
    try {
      await api.saveModels($state.snapshot(settings) as ModelsSettings);
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
      apiKey: "",
      models: [{ id: "model-a", efforts: ["low", "high", "max"] }],
    });
    selected = provider;
  }

  function removeRoute(provider: string): void {
    if (settings === null) return;
    settings.routes = settings.routes.filter((route) => route.provider !== provider);
    if (settings.active.provider === provider) {
      const first = settings.routes[0];
      settings.active = { provider: first?.provider ?? "", model: first?.models[0]?.id ?? "" };
    }
  }

  function addModel(route: DshModelRoute): void {
    route.models.push({ id: `model-${route.models.length + 1}`, efforts: ["low", "high", "max"] });
  }

  function displayName(model: RouteModel): string {
    return model.name ?? readableModelName(model.id);
  }

  function parseToken(text: string): number | undefined {
    const matched = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(text.trim());
    if (matched === null) return undefined;
    const base = Number.parseFloat(matched[1] ?? "0");
    const unit = matched[2]?.toLowerCase();
    if (unit === "k") return Math.round(base * 1024);
    if (unit === "m") return Math.round(base * 1024 * 1024);
    return Math.round(base);
  }
</script>

<div class="flex h-full min-h-0 flex-col gap-3">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <h3 class="text-sm font-medium">大模型服务</h3>
      <p class="mt-0.5 text-[11px] text-muted-foreground">
        配置模型路由与 API Key，保存后立即对新的分析会话生效。
      </p>
      <!-- R4 生效路由：透明展示当前 agent 实际使用的 provider/model 与来源。 -->
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
        <!-- BUG4：从预设添加（Popover 搜索列表；点选预填新路由）。 -->
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
                <!-- 非阻断提示：预设失败不影响手动配置。 -->
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
    <!-- tab 条 -->
    <div class="flex items-stretch gap-1 overflow-x-auto border-b border-border pb-px">
      {#each routes as route (route.provider)}
        {@const ownsActive = settings?.active.provider === route.provider}
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
          <span
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[8px] font-semibold text-white"
            style="background: {routeAvatarColor(route)}"
            aria-hidden="true">{routeLetter(route)}</span
          >
          <span class="max-w-[120px] truncate">{route.provider}</span>
          {#if route.apiKey === undefined || route.apiKey.length === 0}
            <span class="h-1 w-1 rounded-full bg-amber-500" title="缺少 API Key"></span>
          {/if}
          {#if ownsActive}
            <span
              class="rounded bg-primary/10 px-1 py-px text-[9px] font-medium leading-tight text-primary"
              >活动</span
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
                <Select.Item value="anthropic-messages">anthropic-messages</Select.Item>
                <Select.Item value="openai-completions">openai-completions</Select.Item>
              </Select.Content>
            </Select.Root>
          </label>
          <label class="flex flex-col gap-1 text-xs">
            <span class="text-muted-foreground">Base URL</span>
            <Input bind:value={route.baseURL} class="h-8 font-mono text-xs" />
          </label>
          <label class="flex flex-col gap-1 text-xs">
            <span class="text-muted-foreground">API Key {route.apiKey ? "（已配置）" : "（缺失）"}</span>
            <Input
              bind:value={route.apiKey}
              type="password"
              class="h-8 font-mono text-xs"
              placeholder="sk-..."
            />
          </label>
        </div>

        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium">模型列表</span>
            <Button size="xs" variant="ghost" onclick={() => addModel(route)}>+ 加模型</Button>
          </div>
          {#each route.models as model, index (index)}
            <div
              class="rounded-md border bg-muted/20 p-2 {settings?.active.provider === route.provider &&
              settings?.active.model === model.id
                ? 'border-primary/50'
                : ''}"
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
                    class="h-7 w-24 font-mono text-xs"
                    value={model.contextWindow === undefined
                      ? ""
                      : formatTokenCount(model.contextWindow)}
                    oninput={(event) => {
                      const parsed = parseToken(event.currentTarget.value);
                      if (parsed === undefined || parsed > 0) model.contextWindow = parsed;
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
              <div class="mt-1.5 flex items-center gap-2">
                <span class="text-[11px] text-muted-foreground">
                  显示名：{displayName(model)}{model.contextWindow !== undefined
                    ? ` · ${formatTokenCount(model.contextWindow)}`
                    : ""}
                </span>
                {#if settings?.active.provider === route.provider && settings?.active.model === model.id}
                  <Badge class="text-[9px]" variant="secondary">活动模型</Badge>
                {:else}
                  <Button
                    size="xs"
                    variant="outline"
                    onclick={() => {
                      if (settings) settings.active = { provider: route.provider, model: model.id };
                    }}
                  >
                    设为活动模型
                  </Button>
                {/if}
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
            {#if savedFlash}
              <span class="text-xs text-primary">已保存</span>
            {/if}
            <Button size="sm" disabled={saving} onclick={() => void save()}>
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
    <!-- BUG4 修复：加载失败不再只有一行红字+死按钮，给出显式错误卡与重试。 -->
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
