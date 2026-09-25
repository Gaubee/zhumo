<!--
  指令输入卡（走查 R6 按 skill-creator-v2 ComposerCard 重写）：
  附件行（素材视频 chip / 图片附件）→ 自动长高 textarea → 工具行
  （左簇：上下文表；右簇：附加图片 + 模型 chip + 强度 chip + 发送）。
  2026-09-25 前台对齐（Owner 指令「抄 skill-creator-v2」）：
  - 思考强度 chip：活动模型 efforts 档位（zcode 转数据源）；「跟随默认」= 不覆盖；
    running 禁用（本轮结束后再切，服务端同款拒绝）。
  - ContextMeter：上下文占用环 + 用量面板 + 压缩（oncompact 经 onsend("/compact")
    走 daemon 内核命令分流）。
  - 触发面板（2026-09-25 二轮，DSH 官方一致）：`/` = 内核命令注册表
    （composer.list，插件系统注册——非硬编码；选中即发送）、`$` = 内核技能
    注册表（user-invocable；选中留 $name token，daemon 展开为官方
    skill-invocation 双消息注入）。`@` 已按 Owner 裁决撤除（DSH 无此面板语义）。
-->
<script lang="ts">
  import IconFile from "@lucide/svelte/icons/file";
  import IconSend from "@lucide/svelte/icons/send";
  import IconSquare from "@lucide/svelte/icons/square";
  import IconZap from "@lucide/svelte/icons/zap";
  import IconChevronDown from "@lucide/svelte/icons/chevron-down";
  import IconCheck from "@lucide/svelte/icons/check";
  import IconImage from "@lucide/svelte/icons/image";
  import IconX from "@lucide/svelte/icons/x";
  import IconLoader from "@lucide/svelte/icons/loader-circle";
  import { Button } from "$lib/components/ui/button";
  import * as Popover from "$lib/components/ui/popover";
  import { routeAvatarColor, routeLetter, formatTokenCount } from "$lib/components/models/route-meta";
  import { api } from "$lib/api";
  import type { Attachment, AvailableModel } from "$lib/types";
  import TriggerMenu, { type MenuEntry } from "./TriggerMenu.svelte";
  import ContextMeter from "./ContextMeter.svelte";

  let {
    onsend,
    disabled = false,
    sending = false,
    videoName = null,
    placeholder = "描述分析需求，例如：分析起笔角度与收笔…",
    /** 可用模型清单（null/空 = 无已配路由，模型/强度 chip 隐藏）。 */
    models = null,
    defaultModel = null,
    /** 任务级模型覆盖（null = 跟随后台默认）。 */
    currentModel = null,
    /** 任务级思考强度档（null = 跟随默认）。 */
    currentEffort = null,
    /** 任务运行中：模型/强度菜单禁用（本轮结束后再切换）。 */
    running = false,
    /** 最近一轮用量（ContextMeter；null = 尚无回合）。 */
    usage = null,
    /** 活动模型上下文窗口（null = 回退 128k 假定值）。 */
    capacity = null,
    onsetmodel,
    onseteffort,
    /** 停止当前轮（W10）：running 态回调；缺省时 running 仍可排队发送。 */
    onstop = null,
    /** 队列编辑态（W10b）：发送按钮变「确认修改」，Enter=确认、Escape=取消。 */
    editingActive = false,
    /** 进入编辑时回填的队列文本（变化触发填充；null=非编辑）。 */
    editingDraft = null,
    onconfirmedit = null,
    oncanceledit = null,
  }: {
    onsend: (text: string, mode?: "followup" | "steer") => void;
    onstop?: (() => void) | null;
    editingActive?: boolean;
    editingDraft?: string | null;
    onconfirmedit?: ((text: string) => void) | null;
    oncanceledit?: (() => void) | null;
    disabled?: boolean;
    sending?: boolean;
    videoName?: string | null;
    placeholder?: string;
    models?: AvailableModel[] | null;
    defaultModel?: { provider: string; model: string } | null;
    currentModel?: { provider: string; model: string } | null;
    currentEffort?: string | null;
    running?: boolean;
    usage?: { in: number; out: number } | null;
    capacity?: number | null;
    onsetmodel?: (provider: string, model: string) => void;
    onseteffort?: (effort: string | null) => void;
  } = $props();

  let text = $state("");
  let menuOpen = $state(false);
  let effortOpen = $state(false);
  /** 附件（走查 R7：图片 ≤4MiB/张；上传后 chip 缩略预览，发送时注入路径）。 */
  let attachments = $state<Attachment[]>([]);
  let uploading = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);

  const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

  async function onFilesPicked(files: FileList | null): Promise<void> {
    if (files === null) return;
    uploading = true;
    try {
      for (const file of [...files]) {
        if (file.size > MAX_ATTACHMENT_BYTES) continue;
        if (attachments.some((a) => a.name === file.name && a.size === file.size)) continue;
        const dataBase64 = await fileToBase64(file);
        const uploaded = await api.uploadAttachment({ name: file.name, dataBase64 });
        attachments = [...attachments, uploaded];
      }
    } catch (e) {
      (window as unknown as { __attachError?: string }).__attachError =
        e instanceof Error ? e.message : String(e);
    } finally {
      uploading = false;
      if (fileInput !== null) fileInput.value = "";
    }
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result ?? "");
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  function removeAttachment(name: string): void {
    attachments = attachments.filter((a) => a.name !== name);
  }

  interface ModelGroup {
    provider: string;
    iconUrl?: string;
    models: AvailableModel[];
  }

  const groups = $derived.by(() => {
    const byProvider = new Map<string, ModelGroup>();
    for (const item of models ?? []) {
      let group = byProvider.get(item.provider);
      if (group === undefined) {
        group = { provider: item.provider, models: [] };
        if (item.iconUrl !== undefined) group.iconUrl = item.iconUrl;
        byProvider.set(item.provider, group);
      }
      group.models.push(item);
    }
    return [...byProvider.values()];
  });

  const activeModel = $derived(
    currentModel ?? (defaultModel !== null && groups.length > 0 ? defaultModel : null),
  );

  /** chip 标签：活动模型名；同 id 跨路由时加 provider 前缀区分。 */
  const chipLabel = $derived.by(() => {
    if (activeModel === null) return "默认";
    const sameIdProviders = groups
      .filter((g) => g.models.some((m) => m.model === activeModel.model))
      .map((g) => g.provider);
    const prefix = sameIdProviders.length > 1 ? `${activeModel.provider}/` : "";
    return `${prefix}${activeModel.model}`;
  });

  /** 活动模型的档位目录（无数据 = 强度 chip 隐藏）。 */
  const activeEfforts = $derived.by(() => {
    if (activeModel === null) return [];
    return (
      models?.find((m) => m.provider === activeModel.provider && m.model === activeModel.model)
        ?.efforts ?? []
    );
  });

  function isActive(provider: string, model: string): boolean {
    return activeModel !== null && activeModel.provider === provider && activeModel.model === model;
  }

  // ------------------------------------------------------------ 触发面板状态

  /** 光标是否在首行（面板锚定条件；input/click/keyup 同步）。 */
  let caretOnFirstLine = $state(true);
  let slashMenu = $state<{ handleKeydown: (event: KeyboardEvent) => boolean } | null>(null);
  let kbMenu = $state<{ handleKeydown: (event: KeyboardEvent) => boolean } | null>(null);


  /** 内核目录（命令+技能；首次触发 `/` 或 `$` 时惰性拉取缓存一次）。 */
  let composerCommands = $state<MenuEntry[]>([]);
  let skillEntries = $state<MenuEntry[]>([]);
  let composerLoaded = $state(false);
  let composerFailed = $state(false);

  $effect(() => {
    if ((!text.startsWith("/") && !text.startsWith("$")) || composerLoaded || composerFailed) return;
    composerLoaded = true;
    void api
      .composerList()
      .then((out) => {
        composerCommands = out.commands.map((command) => ({
          value: `/${command.name}`,
          description: command.description,
          group: "命令",
          key: `command:${command.name}`,
        }));
        skillEntries = out.skills.map((skill) => ({
          value: `$${skill.name}`,
          description: skill.description,
          group: "技能",
          key: `skill:${skill.name}`,
        }));
      })
      .catch(() => {
        // 拉取失败一次即停（空态提示；下次重新进入组件再试）。
        composerFailed = true;
      });
  });

  function onSlashSelect(value: string): void {
    // 命令选中即执行发送（daemon 经内核 commands 分流，不进 LLM）。
    text = "";
    onsend(value);
  }

  function onSkillSelect(value: string): void {
    // 技能选中留 `$name ` token（官方语义：用户原话随行，daemon 展开注入）。
    const lines = text.split("\n");
    lines[0] = `${value} `;
    text = lines.join("\n");
    requestCaretEnd();
  }


  function syncCaret(): void {
    const el = textareaEl;
    if (el === null) return;
    const before = el.value.slice(0, el.selectionStart ?? 0);
    caretOnFirstLine = !before.includes("\n");
  }

  // ------------------------------------------------------------ 提交与键盘

  /** 队列编辑回填（W10b）：editingDraft 变化即填充（页面层点「编辑」时置入）。 */
  $effect(() => {
    if (editingDraft !== null && editingActive) text = editingDraft;
  });

  /** 页面层协调用（bind:this）：进入编辑前查输入框是否有未发送内容
   * （Owner 设计：有内容拒绝编辑模式）。 */
  export function draftLength(): number {
    return text.trim().length;
  }

  function submit(mode: "followup" | "steer" = "followup"): void {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending || disabled) return;
    // 队列编辑态（W10b）：发送=确认修改（文本回冻结段首条），不走 onsend。
    if (editingActive) {
      onconfirmedit?.(trimmed);
      text = "";
      attachments = [];
      return;
    }
    // 附件路径注入（走查 R7）：agent 经工具按路径读取图片。
    const attachLines = attachments
      .map((a) => `[图片附件 ${a.name}]：${a.path}`)
      .join("\n");
    onsend(attachLines.length > 0 ? `${trimmed}\n${attachLines}` : trimmed, mode);
    // W10 通道反馈：运行中发送走内核 inbox/steer，等待被消费——即时告知去向。
    if (running) notice(mode === "steer" ? "已引导当前轮（下一步即生效）" : "已排队，本轮结束后自动送达");
    text = "";
    attachments = [];
  }

  /** 通道反馈（W10）：3s 自清。 */
  let noticeText = $state<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function notice(message: string): void {
    noticeText = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (noticeText = null), 3000);
  }

  /** 停止当前轮（W10）：turn/end(cancelled) 帧与任务 done 状态由 WS 流到达。 */
  function stop(): void {
    onstop?.();
  }

  function onkeydown(event: KeyboardEvent): void {
    // 触发面板键盘先占（v2 同序：命令 → 知识库 → 资源；任一消费即止）。
    if (slashMenu?.handleKeydown(event)) return;
    if (kbMenu?.handleKeydown(event)) return;
    if (event.key === "Escape" && editingActive) {
      event.preventDefault();
      oncanceledit?.();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  /** 自动长高（1 行 → 4 行封顶内滚）。 */
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  $effect(() => {
    void text;
    const el = textareaEl;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  });

  function requestCaretEnd(): void {
    queueMicrotask(() => {
      const el = textareaEl;
      if (el !== null) el.selectionStart = el.selectionEnd = el.value.length;
    });
  }
</script>

<div class="relative rounded-xl border border-border bg-card p-2 shadow-sm">
  <!-- 触发面板（锚定卡片上方；键盘留 textarea，见 onkeydown 先占序）。 -->
  <TriggerMenu
    trigger="/"
    entries={composerCommands}
    {text}
    {caretOnFirstLine}
    menuLabel="命令"
    dataSlot="slash-menu"
    emptyMessage={composerFailed ? "命令目录不可用" : composerLoaded ? "无匹配命令" : "加载命令…"}
    sourceLabel="内核命令注册表"
    onSelect={(value) => onSlashSelect(value)}
    bind:this={slashMenu}
  />
  <TriggerMenu
    trigger="$"
    entries={skillEntries}
    {text}
    {caretOnFirstLine}
    menuLabel="技能"
    dataSlot="skill-menu"
    emptyMessage={composerFailed ? "技能目录不可用" : composerLoaded ? "无匹配技能" : "加载技能…"}
    sourceLabel="内核技能注册表（user-invocable）"
    onSelect={(value) => onSkillSelect(value)}
    bind:this={kbMenu}
  />

  {#if videoName !== null}
    <div class="mb-1.5 flex flex-wrap gap-1">
      <span
        class="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[10px]"
      >
        <IconFile class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="max-w-40 truncate">{videoName}</span>
      </span>
    </div>
  {/if}
  {#if attachments.length > 0 || uploading}
    <div class="mb-1.5 flex flex-wrap gap-1">
      {#each attachments as att (att.resourceId)}
        <span class="group/att relative flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-0.5 pl-0.5 pr-1.5">
          <img src={att.rawUrl(96)} alt={att.name} class="h-8 w-8 rounded object-cover" />
          <span class="max-w-28 truncate text-[10px]">{att.name}</span>
          <button
            type="button"
            class="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label="移除附件 {att.name}"
            onclick={() => removeAttachment(att.name)}
          >
            <IconX class="h-2.5 w-2.5" />
          </button>
        </span>
      {/each}
      {#if uploading}
        <span class="flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[10px] text-muted-foreground">
          <IconLoader class="h-3 w-3 animate-spin" aria-hidden="true" />
          上传中…
        </span>
      {/if}
    </div>
  {/if}
  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    multiple
    class="hidden"
    onchange={(event) => void onFilesPicked(event.currentTarget.files)}
  />
  {#if noticeText !== null}
    <div class="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground" role="status">
      <IconZap class="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{noticeText}</span>
    </div>
  {/if}
  <textarea
    bind:this={textareaEl}
    bind:value={text}
    {onkeydown}
    oninput={syncCaret}
    onclick={syncCaret}
    onkeyup={syncCaret}
    placeholder={editingActive ? "编辑队列消息（Enter 确认，Esc 取消）…" : placeholder}
    rows="1"
    class="block w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-6 outline-none placeholder:text-muted-foreground/70"
  ></textarea>
  <div class="mt-1 flex items-center gap-2 px-1">
    <div class="flex-1">
      <ContextMeter
        {usage}
        {capacity}
        disabled={disabled || sending || running}
        oncompact={() => onsend("/compact")}
      />
    </div>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      title="附加图片（≤4MiB/张）"
      aria-label="附加图片"
      disabled={uploading || disabled || sending}
      onclick={() => fileInput?.click()}
    >
      <IconImage class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
    {#if groups.length > 0}
      <Popover.Root open={menuOpen} onOpenChange={(open) => (menuOpen = open)}>
        <Popover.Trigger>
          {#snippet child({ props })}
            <button
              type="button"
              {...props}
              class="flex h-7 max-w-[200px] items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={running ? "本轮结束后再切换" : "切换本任务使用的模型"}
              aria-label="切换模型"
              disabled={running || disabled}
            >
              <span class="truncate">{chipLabel}</span>
              <IconChevronDown class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
            </button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Content class="w-64 p-0">
          <div class="max-h-72 overflow-y-auto p-1">
            {#each groups as group (group.provider)}
              <div class="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-muted-foreground">
                {#if group.iconUrl}
                  <img
                    src={group.iconUrl}
                    alt=""
                    class="h-3.5 w-3.5 rounded object-contain dark:invert"
                    onerror={(event) => ((event.currentTarget as HTMLImageElement).style.display = "none")}
                  />
                {:else}
                  <span
                    class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[8px] font-semibold text-white"
                    style="background: {routeAvatarColor({ provider: group.provider })}"
                    aria-hidden="true">{routeLetter({ provider: group.provider })}</span
                  >
                {/if}
                <span class="truncate">{group.provider}</span>
              </div>
              {#each group.models as item (item.provider + "::" + item.model)}
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 {isActive(item.provider, item.model)
                    ? "bg-accent-soft"
                    : ""}"
                  onclick={() => {
                    menuOpen = false;
                    onsetmodel?.(item.provider, item.model);
                  }}
                >
                  <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {#if isActive(item.provider, item.model)}
                      <IconCheck class="h-3 w-3" aria-hidden="true" />
                    {/if}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{item.name}</span>
                    {#if item.contextWindow !== undefined}
                      <span class="block truncate text-[10px] text-muted-foreground">
                        {formatTokenCount(item.contextWindow)} 上下文
                      </span>
                    {/if}
                  </span>
                  {#if (item.inputTypes ?? ["text"]).includes("image")}
                    <IconImage class="h-3 w-3 shrink-0 text-muted-foreground" aria-label="支持图片输入" />
                  {/if}
                </button>
              {/each}
            {/each}
            {#if defaultModel !== null}
              <div class="border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground">
                后台默认：{defaultModel.provider} / {defaultModel.model}
              </div>
            {/if}
          </div>
        </Popover.Content>
      </Popover.Root>
      {#if activeEfforts.length > 0 && onseteffort !== undefined}
        <Popover.Root open={effortOpen} onOpenChange={(open) => (effortOpen = open)}>
          <Popover.Trigger>
            {#snippet child({ props })}
              <button
                type="button"
                {...props}
                class="flex h-7 max-w-[140px] items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                title={running ? "本轮结束后再切换" : "思考强度档位"}
                aria-label="切换思考强度"
                disabled={running || disabled}
              >
                {#if currentEffort !== null}
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
                {/if}
                <span class="truncate">{currentEffort ?? "强度·默认"}</span>
                <IconChevronDown class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
              </button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Content class="w-48 p-0">
            <div class="max-h-64 overflow-y-auto p-1">
              <button
                type="button"
                class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 {currentEffort ===
                null
                  ? "bg-accent-soft"
                  : ""}"
                onclick={() => {
                  effortOpen = false;
                  onseteffort(null);
                }}
              >
                <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {#if currentEffort === null}
                    <IconCheck class="h-3 w-3" aria-hidden="true" />
                  {/if}
                </span>
                <span>跟随默认</span>
              </button>
              {#each activeEfforts as effort (effort)}
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 {currentEffort ===
                  effort
                    ? "bg-accent-soft"
                    : ""}"
                  onclick={() => {
                    effortOpen = false;
                    onseteffort(effort);
                  }}
                >
                  <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {#if currentEffort === effort}
                      <IconCheck class="h-3 w-3" aria-hidden="true" />
                    {/if}
                  </span>
                  <span>{effort}</span>
                </button>
              {/each}
            </div>
          </Popover.Content>
        </Popover.Root>
      {/if}
    {/if}
    {#if editingActive}
      <!-- W10b 队列编辑：发送位变「确认修改」+ 取消（Owner 设计）。 -->
      <Button
        size="sm"
        variant="outline"
        class="h-8 w-8 rounded-full p-0"
        disabled={disabled}
        onclick={() => oncanceledit?.()}
        aria-label="取消编辑"
        title="取消编辑（队列按原样放回）"
      >
        <IconX class="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        class="h-8 w-8 rounded-full p-0"
        disabled={sending || disabled || text.trim().length === 0}
        onclick={() => submit()}
        aria-label="确认修改"
        title="确认修改（该条及其后按原序放回队列）"
      >
        <IconCheck class="h-4 w-4" />
      </Button>
    {:else if running && text.trim().length === 0 && onstop !== null}
      <!-- W10 三态：运行中且无输入 → 停止（cancel{user}+keepInbox，任务回 done 可续聊）。 -->
      <Button
        size="sm"
        class="h-8 w-8 rounded-full p-0 hover:bg-destructive/10 hover:text-destructive"
        disabled={disabled}
        onclick={stop}
        aria-label="停止生成"
        title="停止生成（已排队的消息保留）"
      >
        <IconSquare class="h-3.5 w-3.5 fill-current" />
      </Button>
    {:else}
      {#if running && text.trim().length > 0}
        <!-- W10：运行中有输入 → 引导（steer，下一 step 边界消费，影响当前轮）。 -->
        <Button
          size="sm"
          variant="outline"
          class="h-8 w-8 rounded-full p-0"
          disabled={sending || disabled}
          onclick={() => submit("steer")}
          aria-label="引导当前轮"
          title="立即引导：不等本轮结束，下一步即生效"
        >
          <IconZap class="h-3.5 w-3.5" />
        </Button>
      {/if}
      <!-- running 时发送=排队（内核 next-turn inbox，本轮结束自动续跑）。 -->
      <Button
        size="sm"
        class="h-8 w-8 rounded-full p-0"
        disabled={sending || disabled || text.trim().length === 0}
        onclick={() => submit()}
        aria-label={running ? "排队发送" : "发送"}
        title={running ? "排队发送：本轮结束后自动送达" : "发送"}
      >
        <IconSend class="h-4 w-4" />
      </Button>
    {/if}
  </div>
</div>
