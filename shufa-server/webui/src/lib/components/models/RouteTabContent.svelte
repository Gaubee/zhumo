<!--
  单路由完整编辑面（skill-creator-v2 RouteTabContent 结构复刻，2026-09-24 五轮 R2）。
  对齐的用户裁决（源实现注释 R12-A/R14-A）：
  - 「一共只提供一个 save 按钮，save 和 remove 都放到右上角」——本组件标题行
    右端 [Remove icon][Save]，与 title/meta 同一水平线；标题行在滚动容器外，
    内容再长按钮恒可见。
  - 「key 直接通过一个 input-password 显示出来，提供 eye-toggle 即可」——
    Credential 常驻 password 输入，blur/Enter 保存（输入即更新，空 = 不动）。
  块序：Identity 标题行 / Endpoint（baseURL + api select）/ Credential /
  Models（ModelListItem 列表 + 加模型）。
  写路径：全局 Save 把 endpoint + models 草稿合并经父级 saveRoutes 全量落库；
  密钥旁路单独保存（基于已存 route 态，不掺未保存草稿）；tab 切换经父级 {#key}
  重挂载自然丢弃草稿。
-->
<script lang="ts">
  import { tick } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import IconEye from "@lucide/svelte/icons/eye";
  import IconEyeOff from "@lucide/svelte/icons/eye-off";
  import IconTrash from "@lucide/svelte/icons/trash-2";
  import ModelListItem from "./ModelListItem.svelte";
  import {
    DEFAULT_MODEL_EFFORTS,
    modelIdCandidates,
    routeAvatarColor,
    routeLetter,
    ROUTE_APIS,
  } from "./route-meta";
  import type { DshModelRoute, ModelsCatalogPreset, RouteModel } from "$lib/types";

  let {
    route,
    routes,
    catalogPresets,
    autoFocusCredential = false,
    onCredentialFocused,
    onremove,
    saveRoutes,
    lastSaveError,
  }: {
    route: DshModelRoute;
    routes: DshModelRoute[];
    catalogPresets: ModelsCatalogPreset[];
    /** 新建引导：挂载即聚焦凭据输入；完成后经 onCredentialFocused 清除。 */
    autoFocusCredential?: boolean;
    onCredentialFocused?: () => void;
    /** 请求移除（确认对话框由分区持有）。 */
    onremove?: () => void;
    /** 父级持久化回调（全量 routes 落库并刷新读面）。 */
    saveRoutes: (next: DshModelRoute[]) => Promise<boolean>;
    /** 父级最近一次保存失败原因（走查 R4：内联透传服务端错误明文）。 */
    lastSaveError: () => string | null;
  } = $props();

  // Endpoint 草稿（全局 Save；tab 切换重挂载自然重置）。
  // svelte-ignore state_referenced_locally
  let baseURLDraft = $state(route.baseURL);
  // svelte-ignore state_referenced_locally
  let apiDraft = $state(route.api);
  // Models 草稿。
  // svelte-ignore state_referenced_locally
  let modelsDraft = $state<RouteModel[]>(route.models.map((entry) => ({ ...entry })));
  // svelte-ignore state_referenced_locally
  let modelsValid = $state<boolean[]>(route.models.map(() => true));
  let saving = $state(false);
  let keyDraft = $state("");
  let keyVisible = $state(false);
  let rejection = $state<string | null>(null);
  let savedFlash = $state(false);
  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  /** 新建引导（autoFocus 路径的提示行；挂载语义=初始捕获）。 */
  // svelte-ignore state_referenced_locally
  let addedHint = $state(autoFocusCredential);
  let credInput = $state<HTMLInputElement | null>(null);
  /** Models 条目元素（加模型后 scrollIntoView 定位锚）。 */
  let modelItemEls: (HTMLElement | null)[] = [];

  /** 补全池：当前 provider 置顶 + 跨 provider 净化 + 已建路由并集。 */
  const candidates = $derived(
    modelIdCandidates(catalogPresets, route.provider, routes.flatMap((r) => r.models)),
  );

  const endpointDirty = $derived(
    baseURLDraft.trim() !== route.baseURL || apiDraft !== route.api,
  );
  const modelsDirty = $derived(JSON.stringify(modelsDraft) !== JSON.stringify(route.models));
  const modelsAllValid = $derived(modelsValid.every((flag) => flag));
  const saveDisabled = $derived(
    !(endpointDirty || modelsDirty) || !modelsAllValid || modelsDraft.length === 0 || saving,
  );

  $effect(() => {
    if (autoFocusCredential && credInput !== null) {
      credInput.focus();
      onCredentialFocused?.();
    }
  });

  $effect(() => {
    return () => {
      if (savedTimer !== null) clearTimeout(savedTimer);
    };
  });

  /** 全局 Save：endpoint + models 全部脏改动合并落库（密钥草稿一并携带）。 */
  async function saveAll(): Promise<void> {
    const baseURL = baseURLDraft.trim();
    if (!/^https?:\/\//.test(baseURL)) {
      rejection = "Base URL 需为 http(s) 地址。";
      return;
    }
    saving = true;
    rejection = null;
    const key = keyDraft.trim();
    const ok = await saveRoutes(
      routes.map((existing) =>
        existing.provider === route.provider
          ? {
              ...existing,
              baseURL,
              api: apiDraft,
              models: modelsDraft.map((entry) => ({ ...entry })),
              ...(key.length > 0 ? { apiKey: key } : {}),
            }
          : existing,
      ),
    );
    saving = false;
    if (!ok) {
      rejection = lastSaveError() ?? "保存失败，请重试。";
      return;
    }
    keyDraft = "";
    addedHint = false;
    savedFlash = true;
    if (savedTimer !== null) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (savedFlash = false), 1500);
  }

  /** 密钥旁路：blur/Enter 保存（基于已存 route 态 + 密钥；空 = no-op）。 */
  async function saveCredential(): Promise<void> {
    const key = keyDraft.trim();
    if (key.length === 0) return;
    saving = true;
    const ok = await saveRoutes(
      routes.map((existing) =>
        existing.provider === route.provider ? { ...existing, apiKey: key } : existing,
      ),
    );
    saving = false;
    if (!ok) {
      rejection = lastSaveError() ?? "密钥保存失败，请重试。";
      return;
    }
    rejection = null;
    keyDraft = "";
    addedHint = false;
  }

  function setModelAt(index: number, next: RouteModel): void {
    modelsDraft = modelsDraft.map((entry, i) => (i === index ? next : entry));
  }

  function setModelValidity(index: number, valid: boolean): void {
    if (modelsValid[index] === valid) return;
    modelsValid = modelsValid.map((flag, i) => (i === index ? valid : flag));
  }

  function removeModel(index: number): void {
    modelsDraft = modelsDraft.filter((_, i) => i !== index);
    modelsValid = modelsValid.filter((_, i) => i !== index);
  }

  /** 条目级 dirty（折叠行小圆点）：草稿与已存路由逐条对照。 */
  function modelEntryDirty(index: number): boolean {
    const draft = modelsDraft[index];
    const saved = route.models[index];
    if (draft === undefined || saved === undefined) return true;
    return JSON.stringify(draft) !== JSON.stringify(saved);
  }

  /** 加模型：默认三档 efforts + 空 id 挂载即展开 + 滚入视野。 */
  async function addModel(): Promise<void> {
    modelsDraft = [...modelsDraft, { id: "", efforts: [...DEFAULT_MODEL_EFFORTS], inputTypes: ["text"] }];
    modelsValid = [...modelsValid, false];
    await tick();
    modelItemEls[modelItemEls.length - 1]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
</script>

<div class="space-y-3">
  <!-- 块 1 · Identity 标题行：全局动作（Remove + Save）在右端，与 title/meta 同栏。 -->
  <div class="flex items-start gap-2">
    {#if route.iconUrl}
      <img
        src={route.iconUrl}
        alt=""
        class="mt-px h-6 w-6 shrink-0 rounded object-contain dark:invert"
        onerror={(event) => ((event.currentTarget as HTMLImageElement).style.display = "none")}
      />
    {:else}
      <span
        class="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-semibold text-white"
        style="background: {routeAvatarColor(route)}"
        aria-hidden="true">{routeLetter(route)}</span
      >
    {/if}
    <div class="flex min-w-0 flex-1 items-center justify-between gap-2.5">
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold" title="{route.provider}（路由名即凭据映射键）">
          {route.provider}
        </p>
        <p class="mt-0.5 truncate text-[10px] text-muted-foreground" title={route.baseURL}>
          {route.baseURL.replace(/^https?:\/\//, "")} · {route.models.length} 个模型
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2.5">
        <button
          type="button"
          class="relative flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors after:absolute after:-inset-2 after:content-[''] hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
          aria-label="删除此路由"
          title="删除此路由"
          disabled={saving}
          onclick={() => onremove?.()}
        >
          <IconTrash class="h-4 w-4" aria-hidden="true" />
        </button>
        <Button
          size="sm"
          class="relative h-9 px-3 text-xs after:absolute after:-top-1 after:-bottom-1 after:left-0 after:right-0 after:content-['']"
          disabled={saveDisabled}
          onclick={() => void saveAll()}
        >
          {savedFlash ? "已保存 ✓" : saving ? "保存中…" : "保存"}
        </Button>
      </div>
    </div>
  </div>

  {#if addedHint}
    <p class="text-[11px] font-medium text-primary">
      路由「{route.provider}」已添加——粘贴它的 API Key 完成接通。
    </p>
  {/if}

  <!-- 块 2 · Endpoint。 -->
  <section class="space-y-1.5 rounded-md border border-border p-2" aria-label="Endpoint">
    <span class="text-[11px] font-medium text-muted-foreground">Endpoint</span>
    <div class="flex gap-1.5">
      <Input
        class="h-8 flex-1 font-mono text-xs"
        aria-label="Base URL"
        placeholder="https://api.example.com/v1"
        bind:value={baseURLDraft}
        disabled={saving}
      />
    </div>
    <label class="block space-y-0.5">
      <span class="text-[10px] text-muted-foreground">wire 协议</span>
      <select
        class="h-8 w-full rounded-md border border-border bg-background px-2 text-xs"
        aria-label="wire 协议"
        bind:value={apiDraft}
        disabled={saving}
      >
        {#each ROUTE_APIS as protocol (protocol)}
          <option value={protocol}>{protocol}</option>
        {/each}
      </select>
    </label>
  </section>

  <!-- 块 3 · Credential：常驻 password + eye；blur/Enter 保存（输入即更新）。 -->
  <section class="space-y-1.5 rounded-md border border-border p-2" aria-label="Credential">
    <div class="flex gap-1.5">
      <div class="relative min-w-0 flex-1">
        <Input
          class="h-8 pr-9 font-mono text-xs"
          type={keyVisible ? "text" : "password"}
          autocomplete="off"
          aria-label="API Key"
          placeholder={route.hasKey ? "已保存（输入即更新）" : "sk-..."}
          bind:ref={credInput}
          bind:value={keyDraft}
          disabled={saving}
          onblur={() => void saveCredential()}
          onkeydown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveCredential();
            }
          }}
        />
        <button
          type="button"
          class="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors after:absolute after:-inset-2.5 after:content-[''] hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          aria-label={keyVisible ? "隐藏 API Key" : "显示 API Key"}
          aria-pressed={keyVisible}
          title={keyVisible ? "隐藏 API Key" : "显示 API Key"}
          disabled={saving}
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
    <span class="text-[10px] text-muted-foreground">
      仅存本机；失焦或回车即保存，密钥任何界面都不回显。
    </span>
  </section>

  <!-- 块 4 · Models：ModelListItem 列表 + 加模型。 -->
  <section class="space-y-1.5" aria-label="Models">
    <div class="flex items-center justify-between">
      <span class="text-[11px] font-medium text-muted-foreground">模型列表</span>
      <div class="flex items-center gap-1.5">
        {#if modelsDraft.length === 0}
          <span class="text-[10px] text-amber-700">路由至少需要一个模型 id。</span>
        {/if}
        <Button size="sm" variant="ghost" class="h-7 px-2 text-[11px]" disabled={saving} onclick={() => void addModel()}>
          + 加模型
        </Button>
      </div>
    </div>
    <div class="space-y-1.5">
      {#each modelsDraft as entry, index (index)}
        <div bind:this={modelItemEls[index]}>
          <ModelListItem
            model={entry}
            candidates={candidates}
            api={apiDraft}
            baseURL={baseURLDraft.trim()}
            provider={route.provider}
            hasKey={route.hasKey}
            disabled={saving}
            dirty={modelEntryDirty(index)}
            initialExpanded={entry.id === ""}
            onchange={(next) => setModelAt(index, next)}
            onremove={() => removeModel(index)}
            onvalidity={(valid) => setModelValidity(index, valid)}
          />
        </div>
      {/each}
    </div>
  </section>

  {#if rejection}
    <p class="text-xs text-destructive" role="alert">{rejection}</p>
  {/if}
</div>
