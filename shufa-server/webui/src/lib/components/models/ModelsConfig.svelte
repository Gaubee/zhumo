<!--
  大模型服务设置分区（skill-creator-v2 ModelSettingsSection 结构复刻，2026-09-24
  五轮 R2 重写）。对齐的源实现结构：
  - tab 条：每路由一个 tab（图标回退 + amber 缺 key 点 + 默认 badge），横滚
    （滚轮纵转横 + 两侧渐隐 mask），右端固定「+ 新路由」；←/→ 焦点移动，
    Delete 触发删除确认。
  - 组件路由：NewRouteTab（pick 画廊 | form 自定义）/ RouteTabContent（编辑态，
    {#key provider} 切换重挂载丢弃草稿）/ 空态 onboarding；tab 选中纯视图状态。
  - 滚动所有权：分区整体 flex 链（h-full min-h-0），滚动只发生在 tab 内容容器。
  zhumo 特有保留（skill-creator-v2 无此概念）：
  - 头部「生效路由」信息行（settings/env 来源透明度）。
  - 默认模型独立选择器（活动模型在任务对话框 chip 覆盖；后台只留默认）。
  写路径：saveRoutes 统一全量落库（api.saveModels：routes + default；apiKey
  非空=更新/缺省=保留），保存后 load() 重建读面 + onsaved 上抛。
-->
<script lang="ts">
  import { tick } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Select from "$lib/components/ui/select";
  import ConfirmDialog from "$lib/components/ui/confirm-dialog.svelte";
  import NewRouteTab from "./NewRouteTab.svelte";
  import RouteTabContent from "./RouteTabContent.svelte";
  import { api } from "$lib/api";
  import { routeAvatarColor, routeLetter } from "./route-meta";
  import type {
    BootstrapInfo,
    DshModelRoute,
    ModelsCatalog,
    ModelsSettings,
  } from "$lib/types";

  let { onsaved }: { onsaved?: () => void } = $props();

  /** 选中 tab（null = NewTab 视图或空态）；纯视图状态。 */
  let selected = $state<string | null>(null);
  let newOpen = $state(false);
  /** NewTab 挂载代次（每次打开 +1，重置草稿）。 */
  let newTabSession = $state(0);
  /** 新建成功后的粘 key 引导（RouteTabContent 消费后清除）。 */
  let pendingKeyFocus = $state<string | null>(null);
  let removeTarget = $state<string | null>(null);
  let removeOpen = $state(false);
  let removing = $state(false);

  let settings = $state<ModelsSettings | null>(null);
  let error = $state<string | null>(null);
  let routeInfo = $state<BootstrapInfo["modelRoute"]>(null);
  let routeInfoError = $state(false);

  // 预设目录（一次加载；失败由 NewTab 内呈现，可重开重试）。
  let catalog = $state<ModelsCatalog | null>(null);
  let catalogError = $state<string | null>(null);
  let catalogLoading = $state(false);

  const routes = $derived(settings?.routes ?? []);
  const selectedRoute = $derived(routes.find((route) => route.provider === selected));

  // 选中态归一：路由消失回退首 tab；NewTab 打开时不动选中。
  $effect(() => {
    if (newOpen) return;
    if (selected !== null && !routes.some((route) => route.provider === selected)) {
      selected = null;
    }
    if (selected === null && routes.length > 0) selected = routes[0]?.provider ?? null;
  });

  $effect(() => {
    void load();
  });

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

  async function loadRouteInfo(): Promise<void> {
    routeInfoError = false;
    try {
      routeInfo = (await api.getBootstrap()).modelRoute;
    } catch {
      routeInfoError = true;
    }
  }

  async function loadCatalog(): Promise<void> {
    if (catalog !== null || catalogLoading) return;
    catalogLoading = true;
    catalogError = null;
    try {
      catalog = await api.getModelsCatalog();
    } catch (e) {
      catalogError = e instanceof Error ? e.message : String(e);
    } finally {
      catalogLoading = false;
    }
  }

  /**
   * 统一写路径：全量 routes 落库（default 保留现值）→ 重建读面。
   * NewTab pick 卡即点即建 / RouteTabContent Save / 密钥旁路 / 删除路由共用。
   */
  async function saveRoutes(next: DshModelRoute[]): Promise<boolean> {
    if (settings === null) return false;
    try {
      await api.saveModels({ routes: next, default: settings.default });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    }
    error = null;
    await load();
    onsaved?.();
    return true;
  }

  function openNew(): void {
    newTabSession += 1;
    newOpen = true;
    selected = null;
    void loadCatalog();
  }

  /** NewRouteTab 成功落库：选中新 tab + 粘 key 引导 + 新 tab 滚入视野。 */
  async function onRouteAdded(provider: string): Promise<void> {
    newOpen = false;
    selected = provider;
    pendingKeyFocus = provider;
    await tick();
    tabRefs[provider]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }

  function requestRemove(provider: string | null | undefined): void {
    if (!provider) return;
    removeTarget = provider;
    removeOpen = true;
  }

  async function confirmRemove(): Promise<void> {
    const target = removeTarget;
    if (target === null) return;
    removing = true;
    const ok = await saveRoutes(routes.filter((route) => route.provider !== target));
    removing = false;
    if (ok) {
      removeOpen = false;
      removeTarget = null;
    }
  }

  // ---- tab 条横滚（滚轮纵转横；可滚时才劫持，否则交还页面滚动）。 ----
  let stripEl = $state<HTMLElement | null>(null);
  let canLeft = $state(false);
  let canRight = $state(false);
  let tabRefs = $state<Record<string, HTMLButtonElement | null>>({});

  function refreshScrollState(): void {
    const el = stripEl;
    if (!el) {
      canLeft = false;
      canRight = false;
      return;
    }
    canLeft = el.scrollLeft > 0;
    canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  }

  $effect(() => {
    const el = stripEl;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    const observer = new ResizeObserver(() => refreshScrollState());
    observer.observe(el);
    refreshScrollState();
    return () => {
      el.removeEventListener("wheel", onWheel);
      observer.disconnect();
    };
  });

  $effect(() => {
    void routes.length;
    void catalog;
    refreshScrollState();
  });

  function onTabKeydown(event: KeyboardEvent, index: number): void {
    if (routes.length === 0) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      const next = (index + delta + routes.length) % routes.length;
      tabRefs[routes[next]!.provider]?.focus();
    } else if (event.key === "Delete") {
      event.preventDefault();
      requestRemove(routes[index]?.provider);
    }
  }

  /** 默认模型行显示名。 */
  function displayName(model: { id: string; name?: string }): string {
    return model.name ?? model.id;
  }

  async function saveDefault(next: { provider: string; model: string } | null): Promise<void> {
    if (settings === null) return;
    const previous = settings.default;
    settings.default = next;
    try {
      await api.saveModels({ routes: settings.routes, default: next });
    } catch (e) {
      settings.default = previous;
      error = e instanceof Error ? e.message : String(e);
      return;
    }
    await loadRouteInfo();
    onsaved?.();
  }
</script>

<div class="flex h-full min-h-0 flex-col gap-3">
  <div class="flex shrink-0 items-start justify-between gap-2">
    <div class="min-w-0">
      <h3 class="text-sm font-medium">大模型服务</h3>
      <p class="mt-0.5 text-[11px] text-muted-foreground">
        配置模型路由与 API Key；活动模型在新建任务时选择，保存后对新会话生效。
      </p>
      <p class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        生效路由：
        {#if routeInfo !== null}
          <span class="font-mono text-foreground">{routeInfo.provider} / {routeInfo.model}</span>
          <span class="rounded bg-muted px-1 py-px text-[9px]">
            {routeInfo.source === "settings" ? "后台配置" : ".env 引导值"}
          </span>
        {:else if routeInfoError}
          <span class="text-muted-foreground/70">未知（读取失败）</span>
        {:else if routes.length > 0}
          <span class="font-medium">未设置默认（跟随首个路由）</span>
        {:else}
          <span class="font-medium text-destructive">未配置</span>
        {/if}
      </p>
    </div>
  </div>

  {#if settings !== null}
    <!-- 默认模型（zhumo 特有：后台默认；活动模型由任务对话框覆盖）。 -->
    <div class="flex shrink-0 items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
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
          if (value === undefined) return;
          const [provider, model] = value.split("::");
          void saveDefault(
            provider !== undefined && model !== undefined ? { provider, model } : null,
          );
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

    <!-- tab 条：横滚区 + 固定 + 新路由。 -->
    <div class="flex shrink-0 items-stretch gap-1 border-b border-border">
      <div class="relative min-w-0 flex-1">
        <div
          class="tab-scroll flex h-9 items-stretch overflow-x-auto"
          bind:this={stripEl}
          onscroll={refreshScrollState}
          role="tablist"
          aria-label="模型路由"
        >
          {#each routes as route, index (route.provider)}
            {@const isDefaultRoute = settings?.default?.provider === route.provider}
            <button
              type="button"
              role="tab"
              aria-selected={!newOpen && selected === route.provider}
              class="relative flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs font-medium transition-colors hover:bg-muted/50 {!newOpen && selected === route.provider
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"}"
              title="{route.provider} · {route.baseURL}"
              bind:this={tabRefs[route.provider]}
              onclick={() => {
                selected = route.provider;
                newOpen = false;
              }}
              onkeydown={(event) => onTabKeydown(event, index)}
            >
              {#if route.iconUrl}
                <img
                  src={route.iconUrl}
                  alt=""
                  class="h-4 w-4 shrink-0 rounded object-contain dark:invert"
                  onerror={(event) => ((event.currentTarget as HTMLImageElement).style.display = "none")}
                />
              {:else}
                <span class="relative inline-flex shrink-0">
                  <span
                    class="flex h-4 w-4 items-center justify-center rounded text-[8px] font-semibold text-white"
                    style="background: {routeAvatarColor(route)}"
                    aria-hidden="true">{routeLetter(route)}</span
                  >
                  {#if !route.hasKey}
                    <span
                      class="absolute -right-1 -top-0.5 h-1 w-1 rounded-full bg-amber-500"
                      title="缺少 API Key"></span>
                  {/if}
                </span>
              {/if}
              <span class="max-w-[120px] truncate">{route.provider}</span>
              {#if route.iconUrl && !route.hasKey}
                <span class="h-1 w-1 shrink-0 rounded-full bg-amber-500" title="缺少 API Key"></span>
              {/if}
              {#if isDefaultRoute}
                <span
                  class="rounded bg-primary/10 px-1 py-px text-[9px] font-medium leading-tight text-primary"
                  title="默认模型所在路由">默认</span
                >
              {/if}
            </button>
          {/each}
        </div>
        {#if canLeft}
          <span
            class="pointer-events-none absolute inset-y-0 left-0 w-2 bg-gradient-to-r from-background to-transparent"
            aria-hidden="true"></span>
        {/if}
        {#if canRight}
          <span
            class="pointer-events-none absolute inset-y-0 right-0 w-2 bg-gradient-to-l from-background to-transparent"
            aria-hidden="true"></span>
        {/if}
      </div>
      <button
        type="button"
        class="h-7 shrink-0 self-center rounded px-2 text-[11px] font-medium transition-colors {newOpen
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"}"
        onclick={openNew}
      >
        + 新路由
      </button>
    </div>

    <!-- tab 内容（滚动只发生在此容器内）。 -->
    <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
      {#if newOpen}
        {#key newTabSession}
          <NewRouteTab
            presets={catalog?.presets ?? []}
            catalogError={catalogError}
            catalogLoading={catalogLoading}
            {routes}
            {saveRoutes}
            onadded={(provider) => void onRouteAdded(provider)}
            onclose={() => (newOpen = false)}
          />
        {/key}
      {:else if selectedRoute}
        {#key selectedRoute.provider}
          <RouteTabContent
            route={selectedRoute}
            {routes}
            catalogPresets={catalog?.presets ?? []}
            autoFocusCredential={pendingKeyFocus === selectedRoute.provider}
            onCredentialFocused={() => (pendingKeyFocus = null)}
            onremove={() => requestRemove(selectedRoute?.provider)}
            {saveRoutes}
          />
        {/key}
      {:else}
        <!-- 空态 onboarding。 -->
        <div class="flex flex-col items-center gap-2.5 rounded-md border border-dashed p-6 text-center">
          <p class="text-xs font-medium">添加第一个模型路由</p>
          <p class="max-w-[320px] text-[10px] leading-snug text-muted-foreground">
            从目录（models.dev）选一个服务商连同模型一键添加，或指向任意
            OpenAI/Anthropic 兼容端点。
          </p>
          <div class="mt-1 flex gap-2">
            <Button size="sm" variant="outline" class="h-8 px-3 text-xs" onclick={openNew}>
              浏览目录
            </Button>
          </div>
        </div>
      {/if}
    </div>
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

<ConfirmDialog
  bind:open={removeOpen}
  title="删除路由"
  description="删除「{removeTarget ?? ""}」路由？其已存密钥将一并清除；若它承载默认模型，默认引用同时置空。"
  busy={removing}
  onconfirm={() => void confirmRemove()}
/>

<style>
  /* 横滚区隐藏滚动条（tab 溢出策略：横滚 + 渐隐 mask，不换行不折叠）。 */
  .tab-scroll {
    scrollbar-width: none;
  }
  .tab-scroll::-webkit-scrollbar {
    display: none;
  }
</style>
