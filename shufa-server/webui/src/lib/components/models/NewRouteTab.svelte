<!--
  统一建路由体验（skill-creator-v2 NewRouteTab 结构复刻，2026-09-24 五轮 R2）。
  对齐的源实现语义：
  - pick 态 = 顶部 inputFilter + 全量目录卡片网格（两列，min-[520px] 断点），
    卡片点击 = **立即建路由落库**（不再是「选中→再保存」两段式）；已添加的
    provider 卡显示 Added ✓ ×N，可继续添加（编号 slug：zai → zai-2）。
  - form 态（自定义端点）= 与编辑面同字段集：名称/Base URL/协议 select/
    API key（创建即随路由落库）/Models 草稿（ModelListItem）。
  - 目录卡富预填：top-4 image 优先模型（name/contextWindow/inputTypes 随目录）。
-->
<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import IconEye from "@lucide/svelte/icons/eye";
  import IconEyeOff from "@lucide/svelte/icons/eye-off";
  import ModelListItem from "./ModelListItem.svelte";
  import { DEFAULT_MODEL_EFFORTS, ROUTE_APIS } from "./route-meta";
  import { modelIdCandidates, nextRouteSlug, routeAvatarColor, slugBase } from "./route-meta";
  import type { DshModelRoute, ModelsCatalogPreset, RouteApi, RouteModel } from "$lib/types";

  let {
    presets,
    catalogError,
    catalogLoading,
    routes,
    saveRoutes,
    lastSaveError,
    onadded,
    onclose,
  }: {
    presets: ModelsCatalogPreset[];
    catalogError: string | null;
    catalogLoading: boolean;
    routes: DshModelRoute[];
    saveRoutes: (next: DshModelRoute[]) => Promise<boolean>;
    /** 父级最近一次保存失败原因（服务端 zod/网络错误明文，走查 R4 透传）。 */
    lastSaveError: () => string | null;
    onadded: (provider: string) => void;
    /** 零路由时 pick 态的返回口（有路由时点任意 tab 即退出，由父级处理）。 */
    onclose?: () => void;
  } = $props();

  const DEFAULT_API: RouteApi = "openai-completions";

  let mode = $state<"pick" | "form">("pick");
  let filter = $state("");
  let searchInput = $state<HTMLInputElement | null>(null);
  let creating = $state(false);
  let rejection = $state<string | null>(null);

  // form 草稿。
  let draftProvider = $state("");
  let draftBaseURL = $state("");
  let draftApi = $state<RouteApi>(DEFAULT_API);
  let draftKey = $state("");
  let keyVisible = $state(false);
  let draftModels = $state<RouteModel[]>([]);
  let draftModelsValid = $state<boolean[]>([]);
  let urlTouched = $state(false);
  let nameTouched = $state(false);

  const providerName = $derived(draftProvider.trim());
  const duplicate = $derived(providerName.length > 0 && routes.some((route) => route.provider === providerName));
  const urlValid = $derived(/^https?:\/\//.test(draftBaseURL.trim()));
  const modelsAllValid = $derived(
    draftModelsValid.length === draftModels.length && draftModelsValid.every((flag) => flag),
  );
  const canSubmit = $derived(
    providerName.length > 0 && !duplicate && urlValid && draftModels.length > 0 && modelsAllValid && !creating,
  );
  const candidates = $derived(modelIdCandidates(presets, providerName, routes.flatMap((r) => r.models)));

  const filteredPresets = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return presets;
    return presets.filter(
      (preset) =>
        preset.name.toLowerCase().includes(needle) ||
        preset.provider.toLowerCase().includes(needle) ||
        (preset.baseURL ?? "").toLowerCase().includes(needle),
    );
  });

  /** 该目录 provider 的已建副本数（含编号 slug：zai-2 归一到 zai；Added ✓ ×N 徽标）。 */
  function copyCount(provider: string): number {
    return routes.filter((route) => slugBase(route.provider) === provider).length;
  }

  $effect(() => {
    if (mode === "pick") searchInput?.focus();
  });

  function startFromScratch(): void {
    draftProvider = "";
    draftBaseURL = "";
    draftApi = DEFAULT_API;
    draftKey = "";
    draftModels = [];
    draftModelsValid = [];
    mode = "form";
    urlTouched = false;
    nameTouched = false;
    rejection = null;
  }

  /** 目录卡点击 = 立即建路由：编号 slug + baseURL/api/iconUrl + top-4 image 优先富预填。 */
  async function createFromPreset(preset: ModelsCatalogPreset): Promise<void> {
    if (creating) return;
    creating = true;
    rejection = null;
    const models: RouteModel[] = [...preset.models]
      .sort((a, b) => Number((b.inputTypes ?? []).includes("image")) - Number((a.inputTypes ?? []).includes("image")))
      .slice(0, 4)
      .map((model) => ({
        id: model.id,
        ...(model.name !== undefined ? { name: model.name } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.inputTypes !== undefined ? { inputTypes: model.inputTypes } : {}),
        // 目录带档位（zcode 策展的 reasoningLevel）优先；缺省回退三档默认。
        efforts:
          model.efforts !== undefined && model.efforts.length > 0
            ? [...model.efforts]
            : [...DEFAULT_MODEL_EFFORTS],
      }));
    const route: DshModelRoute = {
      provider: nextRouteSlug(preset.provider, routes.map((r) => r.provider)),
      api: ROUTE_APIS.includes(preset.api as RouteApi) ? (preset.api as RouteApi) : DEFAULT_API,
      baseURL: preset.baseURL ?? "",
      ...(preset.iconUrl !== undefined ? { iconUrl: preset.iconUrl } : {}),
      models,
    };
    const ok = await saveRoutes([...routes, route]);
    creating = false;
    if (!ok) {
      // saveRoutes 已把服务端错误写父级 error；此处给面板内联同样明文
      //（走查 R4：此前只报「创建失败，请重试」吞掉 zod 详情）。
      rejection = lastSaveError() ?? "创建失败，请重试。";
      return;
    }
    onadded(route.provider);
  }

  function setModelAt(index: number, next: RouteModel): void {
    draftModels = draftModels.map((entry, i) => (i === index ? next : entry));
  }

  function setModelValidity(index: number, valid: boolean): void {
    if (draftModelsValid[index] === valid) return;
    draftModelsValid = draftModelsValid.map((flag, i) => (i === index ? valid : flag));
  }

  function removeModel(index: number): void {
    draftModels = draftModels.filter((_, i) => i !== index);
    draftModelsValid = draftModelsValid.filter((_, i) => i !== index);
  }

  function addModel(): void {
    draftModels = [...draftModels, { id: "", efforts: [...DEFAULT_MODEL_EFFORTS], inputTypes: ["text"] }];
    draftModelsValid = [...draftModelsValid, false];
  }

  async function createRoute(): Promise<void> {
    if (!canSubmit) return;
    creating = true;
    rejection = null;
    const route: DshModelRoute = {
      provider: providerName,
      api: draftApi,
      baseURL: draftBaseURL.trim(),
      models: draftModels.map((entry) => ({ ...entry })),
      ...(draftKey.trim().length > 0 ? { apiKey: draftKey.trim() } : {}),
    };
    const ok = await saveRoutes([...routes, route]);
    creating = false;
    if (!ok) {
      rejection = lastSaveError() ?? "创建失败，请重试。";
      return;
    }
    onadded(route.provider);
  }
</script>

{#if mode === "pick"}
  <div class="space-y-2">
    <div class="flex items-center gap-2">
      <Input
        class="h-8 flex-1 text-xs"
        aria-label="搜索 provider"
        placeholder="搜索 provider 或名称…"
        bind:ref={searchInput}
        bind:value={filter}
      />
      {#if routes.length === 0 && onclose}
        <Button size="sm" variant="ghost" class="h-8 shrink-0 px-2 text-[11px]" onclick={() => onclose?.()}>
          返回
        </Button>
      {/if}
      <Button
        size="sm"
        variant="ghost"
        class="h-8 shrink-0 px-2 text-[11px]"
        onclick={startFromScratch}
      >
        自定义端点 →
      </Button>
    </div>

    {#if rejection}
      <p class="text-xs text-destructive" role="alert">{rejection}</p>
    {/if}

    {#if catalogError}
      <p class="text-[10px] text-destructive" role="alert">{catalogError}</p>
    {:else if presets.length === 0}
      <p class="py-3 text-center text-[10px] text-muted-foreground">
        {catalogLoading ? "目录加载中…" : "目录不可用。"}
      </p>
    {:else}
      <!-- 画廊自然流式：滚动只属于父级 tab 内容容器。 -->
      <div class="space-y-2">
        <div class="space-y-1">
          <span class="text-[10px] font-medium text-muted-foreground">
            目录（{presets.length} 个 provider，含 zcode + 内置 + models.dev）
          </span>
          <div class="grid grid-cols-1 gap-1.5 min-[520px]:grid-cols-2">
            {#each filteredPresets as preset (preset.provider + preset.name)}
              {@const copies = copyCount(preset.provider)}
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-md border border-border p-2 text-left transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:opacity-60"
                title="{preset.baseURL ?? ''} · {preset.api}{copies > 0 ? ` · 已添加 ${copies} 份——点击再加一份` : ''}"
                disabled={creating}
                onclick={() => void createFromPreset(preset)}
              >
                {#if preset.iconUrl}
                  <img
                    src={preset.iconUrl}
                    alt=""
                    class="h-7 w-7 shrink-0 rounded-md bg-background object-contain p-0.5 dark:invert"
                    onerror={(event) => ((event.currentTarget as HTMLImageElement).style.display = "none")}
                  />
                {:else}
                  <span
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white"
                    style="background: {routeAvatarColor({ provider: preset.provider })}"
                    aria-hidden="true"
                  >
                    {preset.provider.slice(0, 1).toUpperCase()}
                  </span>
                {/if}
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs font-medium">{preset.name}</span>
                  <span class="block truncate text-[10px] text-muted-foreground">
                    {(preset.baseURL ?? "").replace(/^https?:\/\//, "")}
                  </span>
                </span>
                <span class="mr-0.5 flex shrink-0 items-center gap-1">
                  {#if preset.source === "zcode"}
                    <span
                      class="rounded bg-primary/10 px-1 text-[9px] font-medium text-primary"
                      title="ZCode Registry 策展提取（coding plan 端点 + reasoning 档位）"
                    >
                      ZCode
                    </span>
                  {/if}
                  {#if copies > 0}
                    <span
                      class="rounded bg-primary/10 px-1 text-[9px] text-primary"
                      title="已添加 {copies} 份，可继续添加"
                    >
                      Added ✓{copies > 1 ? ` ×${copies}` : ""}
                    </span>
                  {/if}
                  <span
                    class="rounded bg-muted px-1 text-[9px] text-muted-foreground"
                    title="目录模型数"
                  >
                    {preset.models.length}
                  </span>
                </span>
              </button>
            {/each}
            {#if filteredPresets.length === 0}
              <p class="col-span-full py-3 text-center text-[10px] text-muted-foreground">
                没有匹配「{filter}」的 provider。
              </p>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
{:else}
  <div class="space-y-3">
    <!-- 1 · 名称。 -->
    <label class="block space-y-0.5">
      <span class="text-[10px] text-muted-foreground">路由名（provider）</span>
      <Input
        class="h-8 text-xs"
        aria-label="路由名"
        placeholder="my-provider"
        bind:value={draftProvider}
        disabled={creating}
        onblur={() => (nameTouched = true)}
      />
    </label>
    {#if duplicate}
      <p class="text-[10px] text-amber-700" role="alert">路由「{providerName}」已存在。</p>
    {:else if nameTouched && providerName.length === 0}
      <p class="text-[10px] text-amber-700" role="alert">自定义路由需要一个名称。</p>
    {/if}

    <!-- 2 · Endpoint。 -->
    <label class="block space-y-0.5">
      <span class="text-[10px] text-muted-foreground">Base URL</span>
      <Input
        class="h-8 font-mono text-xs"
        aria-label="Base URL"
        placeholder="https://api.example.com/v1"
        bind:value={draftBaseURL}
        disabled={creating}
        onblur={() => (urlTouched = true)}
      />
    </label>
    {#if urlTouched && !urlValid}
      <p class="text-[10px] text-amber-700" role="alert">Base URL 需为 http(s) 地址。</p>
    {/if}
    <label class="block space-y-0.5">
      <span class="text-[10px] text-muted-foreground">wire 协议</span>
      <select
        class="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
        aria-label="wire 协议"
        bind:value={draftApi}
        disabled={creating}
      >
        {#each ROUTE_APIS as protocol (protocol)}
          <option value={protocol}>{protocol}</option>
        {/each}
      </select>
    </label>

    <!-- 3 · API key（创建即随路由落库）。 -->
    <div class="block space-y-0.5">
      <span class="text-[10px] text-muted-foreground">API Key</span>
      <div class="relative">
        <Input
          class="h-8 pr-9 font-mono text-xs"
          type={keyVisible ? "text" : "password"}
          autocomplete="off"
          aria-label="API Key"
          placeholder="sk-..."
          bind:value={draftKey}
          disabled={creating}
        />
        <button
          type="button"
          class="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          aria-label={keyVisible ? "隐藏 API Key" : "显示 API Key"}
          aria-pressed={keyVisible}
          disabled={creating}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => (keyVisible = !keyVisible)}
        >
          {#if keyVisible}
            <IconEyeOff class="h-3.5 w-3.5" aria-hidden="true" />
          {:else}
            <IconEye class="h-3.5 w-3.5" aria-hidden="true" />
          {/if}
        </button>
      </div>
    </div>

    <!-- 4 · Models 草稿。 -->
    <div class="space-y-1.5">
      <div class="flex items-center justify-between">
        <span class="text-[10px] font-medium text-muted-foreground">模型</span>
        <Button size="sm" variant="ghost" class="h-6 px-2 text-[11px]" disabled={creating} onclick={addModel}>
          + 加模型
        </Button>
      </div>
      {#if draftModels.length === 0}
        <p class="rounded-md border border-dashed p-2 text-center text-[10px] text-muted-foreground">
          还没有模型——至少添加一个才能创建路由。
        </p>
      {/if}
      <div class="space-y-1.5">
        {#each draftModels as entry, index (index)}
          <ModelListItem
            model={entry}
            candidates={candidates}
            api={draftApi}
            baseURL={draftBaseURL.trim()}
            provider={providerName}
            hasKey={false}
            routeKey={draftKey}
            disabled={creating}
            initialExpanded={entry.id === ""}
            onchange={(next) => setModelAt(index, next)}
            onremove={() => removeModel(index)}
            onvalidity={(valid) => setModelValidity(index, valid)}
          />
        {/each}
      </div>
    </div>

    {#if rejection}
      <p class="text-xs text-destructive" role="alert">{rejection}</p>
    {/if}

    <!-- 5 · 底部动作。 -->
    <div class="flex items-center justify-between border-t border-border pt-2">
      <Button size="sm" variant="ghost" class="h-7 px-2 text-xs" disabled={creating} onclick={() => (mode = "pick")}>
        返回
      </Button>
      <Button
        size="sm"
        class="h-7 px-2.5 text-xs"
        disabled={!canSubmit}
        onclick={() => void createRoute()}
      >
        {creating ? "创建中…" : "创建路由"}
      </Button>
    </div>
  </div>
{/if}
