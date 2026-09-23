/**
 * 播放器 Popover 三件套（自 shufa-tool web/src/popovers.ts 逐字移植，BUG5 结果页复刻）：
 *  1) 进度条悬停预览——跟随鼠标水平位置的帧预览图 + 厘秒时间 M:SS.CC（取 |t_hover - t_preview| 最小帧，防越界钳制）；
 *     预览窗居中：left = clamp(锚点x − 实测宽度/2, 4, trackW − w − 4)，图片 onload 与 resize 时重算；
 *     面板上移至 track 顶边上方，不压墨迹图层/菱形标记；
 *  2) 竖向音量条——拖拽/滚轮/键盘调节 video.volume（滚轮 preventDefault 阻页面滚动，步进 5%，量值四舍五入到百分位）；
 *  3) 竖排倍速菜单——0.5×/1.0×/1.5×/2.0×，点击切换并收起，当前速率高亮。
 * 交互约定：hover 意图 ~120ms 出现、移出 ~150ms 消失（防抖动）；点击面板/锚点外收起；
 * 面板以 data-open="1" 驱动 CSS 过渡（opacity/translateY 120ms）；pin() 供测试钩子强制保持打开。
 * 附带共享小工具 clamp01/fmtClock（player.ts 亦复用，避免循环依赖）。
 * 移植差异：PreviewFrame 改为本文件局部类型（结构同 @zhumo/contracts 的 player.previews 元素）。
 */

/** 进度条悬停预览帧（约每 1s 一张） */
export interface PreviewFrame {
  t: number;
  src: string;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function fmtClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return `${m}:${x < 10 ? "0" : ""}${x}`;
}

/** 预览窗专用：M:SS.CC 厘秒格式，截断（floor）不夸大预览时刻；+1e-4 抗浮点表示误差 */
export function fmtClockCs(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const totalCs = Math.floor(s * 100 + 1e-4);
  const cs = totalCs % 100;
  const secTotal = (totalCs - cs) / 100;
  const m = Math.floor(secTotal / 60);
  const sec = secTotal % 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec}.${cs < 10 ? "0" : ""}${cs}`;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface PopoverHandle {
  readonly panel: HTMLElement;
  isOpen(): boolean;
  open(): void;
  close(): void;
  /** 测试钩子：强制打开，且不被延时关闭/点击外部收起 */
  pin(): void;
  destroy(): void;
}

export interface PreviewProbe {
  naturalWidth: number;
  src: string;
}

interface HoverOpts {
  openDelayMs?: number;
  closeDelayMs?: number;
  /** 点击 anchor 切换开合（触摸/键盘友好，如倍速菜单） */
  toggleOnClick?: boolean;
  onOpen?: () => void;
}

/** 通用 hover-intent Popover：锚点/面板进出防抖、focus 键盘可达、点击外部收起 */
export function createHoverPopover(
  anchor: HTMLElement,
  panel: HTMLElement,
  opts: HoverOpts = {},
): PopoverHandle {
  const openDelay = opts.openDelayMs ?? 120;
  const closeDelay = opts.closeDelayMs ?? 150;
  let openTimer = 0;
  let closeTimer = 0;
  let pinned = false;

  const clearTimers = (): void => {
    window.clearTimeout(openTimer);
    window.clearTimeout(closeTimer);
  };
  const isOpen = (): boolean => panel.getAttribute("data-open") === "1";
  const open = (): void => {
    clearTimers();
    if (!isOpen()) {
      panel.setAttribute("data-open", "1");
      opts.onOpen?.();
    }
  };
  const close = (): void => {
    if (pinned) return;
    clearTimers();
    panel.removeAttribute("data-open");
  };
  const openSoon = (): void => {
    if (pinned || isOpen()) return;
    clearTimers();
    openTimer = window.setTimeout(open, openDelay);
  };
  const closeSoon = (): void => {
    if (pinned || !isOpen()) return;
    clearTimers();
    closeTimer = window.setTimeout(close, closeDelay);
  };

  anchor.addEventListener("mouseenter", openSoon);
  anchor.addEventListener("mouseleave", closeSoon);
  panel.addEventListener("mouseenter", clearTimers); // 移入面板取消关闭（如音量拖拽）
  panel.addEventListener("mouseleave", closeSoon);
  anchor.addEventListener("focusin", open);
  anchor.addEventListener("focusout", closeSoon);

  const onDocDown = (e: PointerEvent): void => {
    if (pinned) return;
    const t = e.target;
    if (t instanceof Node && (anchor.contains(t) || panel.contains(t))) return;
    clearTimers();
    close();
  };
  document.addEventListener("pointerdown", onDocDown);

  if (opts.toggleOnClick) {
    anchor.addEventListener("click", (e) => {
      e.preventDefault();
      if (isOpen()) close();
      else open();
    });
  }

  return {
    panel,
    isOpen,
    open,
    close,
    pin(): void {
      pinned = true;
      open();
    },
    destroy(): void {
      clearTimers();
      document.removeEventListener("pointerdown", onDocDown);
      panel.remove();
    },
  };
}

/** 面板水平居中对齐锚点并钳制在定位父级内（防越界） */
function positionAboveAnchor(anchor: HTMLElement, panel: HTMLElement): void {
  const host = anchor.offsetParent;
  if (!(host instanceof HTMLElement)) return;
  const pw = panel.offsetWidth || 80;
  const left = clampNum(
    anchor.offsetLeft + anchor.offsetWidth / 2 - pw / 2,
    4,
    Math.max(4, host.clientWidth - pw - 4),
  );
  panel.style.left = `${left}px`;
}

/** 1) 进度条悬停预览：面板中心跟随锚点（鼠标在 track 内的 t→px），取最近预览帧；
 * 宽度实测居中校正 + 边缘钳制；previews 为空时仅显示时间 */
export function createPreviewPopover(
  progress: HTMLElement,
  track: HTMLElement,
  getDuration: () => number,
  previews: PreviewFrame[],
  assetUrl: (p: string) => string,
  onProbe: (p: PreviewProbe) => void,
): PopoverHandle {
  const panel = document.createElement("div");
  panel.className = "sp-pop sp-pv";
  panel.innerHTML = '<img class="sp-pv-img" alt="预览帧" /><span class="sp-pv-time"></span>';
  progress.appendChild(panel);
  const img = panel.querySelector<HTMLImageElement>(".sp-pv-img");
  const timeEl = panel.querySelector<HTMLElement>(".sp-pv-time");
  if (!img || !timeEl) throw new Error("预览 Popover 初始化失败");

  let lastClientX: number | null = null;

  /** 居中定位：left = clamp(锚点x − w/2, 4, trackW − w − 4)；面板与 track 同宽容器内 */
  const place = (clientX: number): void => {
    const rect = track.getBoundingClientRect();
    const pw = panel.offsetWidth || 140;
    const anchorX = clientX - rect.left;
    const left = clampNum(anchorX - pw / 2, 4, Math.max(4, rect.width - pw - 4));
    panel.style.left = `${left}px`;
  };

  img.addEventListener("load", () => {
    panel.setAttribute("data-img-ok", img.naturalWidth > 0 ? "1" : "0");
    onProbe({ naturalWidth: img.naturalWidth, src: img.currentSrc || img.src });
    if (lastClientX !== null) place(lastClientX); // 图片加载后宽度可能变化，重算居中
  });
  img.addEventListener("error", () => {
    panel.setAttribute("data-img-ok", "0");
    onProbe({ naturalWidth: 0, src: img.src });
  });

  // 窗口/列宽变化时重算（仅在打开态；收起态下次 hover 自然重算）
  const onResize = (): void => {
    if (panel.getAttribute("data-open") === "1" && lastClientX !== null) place(lastClientX);
  };
  window.addEventListener("resize", onResize);

  const hoverAt = (clientX: number): void => {
    lastClientX = clientX;
    const rect = track.getBoundingClientRect();
    const dur = getDuration();
    const ratio = rect.width > 0 && dur > 0 ? clamp01((clientX - rect.left) / rect.width) : 0;
    const t = ratio * dur;
    let best: PreviewFrame | null = null;
    for (const p of previews) {
      if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    }
    if (best && img.dataset.src !== best.src) {
      panel.removeAttribute("data-img-ok");
      onProbe({ naturalWidth: 0, src: best.src });
      img.dataset.src = best.src;
      img.src = assetUrl(best.src);
    }
    timeEl.textContent = fmtClockCs(t);
    place(clientX);
  };
  progress.addEventListener("pointerenter", (e) => hoverAt(e.clientX));
  progress.addEventListener("pointermove", (e) => hoverAt(e.clientX));

  const pop = createHoverPopover(progress, panel, { openDelayMs: 120, closeDelayMs: 150 });
  const origDestroy = pop.destroy;
  return {
    ...pop,
    destroy(): void {
      window.removeEventListener("resize", onResize);
      origDestroy.call(pop);
    },
  };
}

export const RATE_STEPS: number[] = [0.5, 1, 1.5, 2];

/** 2) 竖向音量条：拖拽 / 滚轮（hover 即可调，步进 5%）/ 键盘方向键；提升音量自动解除静音 */
export function createVolumePopover(
  anchor: HTMLButtonElement,
  controls: HTMLElement,
  video: HTMLVideoElement,
): PopoverHandle {
  const panel = document.createElement("div");
  panel.className = "sp-pop sp-vol";
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "音量");
  panel.innerHTML =
    '<span class="sp-vol-val"></span>' +
    '<div class="sp-vol-track" role="slider" tabindex="0" aria-label="音量" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100">' +
    '<div class="sp-vol-fill"></div></div>';
  controls.appendChild(panel);
  const valEl = panel.querySelector<HTMLElement>(".sp-vol-val");
  const trackEl = panel.querySelector<HTMLElement>(".sp-vol-track");
  const fillEl = panel.querySelector<HTMLElement>(".sp-vol-fill");
  if (!valEl || !trackEl || !fillEl) throw new Error("音量 Popover 初始化失败");

  const refresh = (): void => {
    const pct = Math.round(video.volume * 100);
    fillEl.style.height = `${pct}%`;
    valEl.textContent = `${pct}%`;
    trackEl.setAttribute("aria-valuenow", String(pct));
    trackEl.setAttribute("aria-valuetext", `${pct}%`);
  };

  const setVolume = (v: number): void => {
    const nv = Math.round(clamp01(v) * 100) / 100;
    video.volume = nv;
    if (nv > 0 && video.muted) video.muted = false; // 提升音量自动解除静音
    refresh();
  };

  video.addEventListener("volumechange", refresh);
  refresh();

  // 竖向轨道拖拽
  let dragging = false;
  const volAt = (clientY: number): number => {
    const rect = trackEl.getBoundingClientRect();
    return rect.height > 0 ? 1 - clamp01((clientY - rect.top) / rect.height) : video.volume;
  };
  trackEl.addEventListener("pointerdown", (e) => {
    dragging = true;
    try {
      trackEl.setPointerCapture(e.pointerId);
    } catch {
      /* 不支持捕获时拖拽仍可用 */
    }
    setVolume(volAt(e.clientY));
    e.preventDefault();
  });
  trackEl.addEventListener("pointermove", (e) => {
    if (dragging) setVolume(volAt(e.clientY));
  });
  const endDrag = (): void => {
    dragging = false;
  };
  trackEl.addEventListener("pointerup", endDrag);
  trackEl.addEventListener("pointercancel", endDrag);

  // 键盘微调（方向键 ±5%）
  trackEl.addEventListener("keydown", (e) => {
    const step = 0.05;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      setVolume(video.volume + step);
      e.preventDefault();
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      setVolume(video.volume - step);
      e.preventDefault();
    }
  });

  // hover 状态下滚轮直接调节；preventDefault 阻止页面滚动（需 passive:false）
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    setVolume(video.volume + (e.deltaY < 0 ? 0.05 : -0.05));
  };
  anchor.addEventListener("wheel", onWheel, { passive: false });
  panel.addEventListener("wheel", onWheel, { passive: false });

  return createHoverPopover(anchor, panel, {
    onOpen: () => positionAboveAnchor(anchor, panel),
  });
}

/** 3) 竖排倍速菜单：点击切换并收起，当前速率 aria-pressed 高亮；按钮文字跟随当前速率 */
export function createRatePopover(
  anchor: HTMLButtonElement,
  controls: HTMLElement,
  video: HTMLVideoElement,
): PopoverHandle {
  const panel = document.createElement("div");
  panel.className = "sp-pop sp-rate-menu";
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", "播放速度");
  panel.innerHTML = RATE_STEPS.map(
    (r) =>
      `<button type="button" class="sp-rate-item" role="menuitemradio" data-rate="${r}" aria-pressed="false">${r.toFixed(1)}×</button>`,
  ).join("");
  controls.appendChild(panel);

  const refresh = (): void => {
    const cur = video.playbackRate;
    for (const btn of panel.querySelectorAll<HTMLButtonElement>(".sp-rate-item")) {
      btn.setAttribute("aria-pressed", String(parseFloat(btn.dataset.rate ?? "") === cur));
    }
    anchor.textContent = `${cur.toFixed(1)}×`;
  };
  video.addEventListener("ratechange", refresh);
  refresh();

  const pop = createHoverPopover(anchor, panel, {
    toggleOnClick: true,
    onOpen: () => positionAboveAnchor(anchor, panel),
  });
  panel.addEventListener("click", (e) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLButtonElement>(".sp-rate-item") : null;
    if (!btn) return;
    const r = parseFloat(btn.dataset.rate ?? "");
    if (Number.isFinite(r)) video.playbackRate = r;
    pop.close();
  });
  return pop;
}
