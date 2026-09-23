/**
 * 意图：自定义视频播放器 + 时间轴实时同步（原始需求 2026-09-22；
 * 交互与视觉自 src/shufa_tool/player.py 的内联 JS 移植为 TS class）。
 * 交互清单：播放/暂停（按钮 / 点击画面 / 空格，空格仅在播放器可见且焦点不在
 * 交互元素时拦截）、进度条拖拽 seek（已播填充 + 播放位置游标）、旁注活动量
 * 墨迹图层（自 track 顶边向上生长的半透明 SVG，hover 渐显，不与进度条重叠）、
 * 关键帧菱形标记可点击 + hover tooltip、当前/总时长、倍速循环 1.0/1.5/2.0、循环开关
 * （默认开）、静音开关；时间轴 seg/kf 按时间混排、活跃条目高亮 +
 * scrollIntoView 跟随（滚动至列表顶部，配合 scroll-snap/scroll-padding 与
 * 末尾撑高；用户手动滚动后 4s 内不打扰）、每条 seg 独立背景进度填充
 * （transform:scaleX）、点击条目 seek、进度条渲染 kf 菱形。
 * 跨栏跳转：监听 events.ts 的 "shufa:seek"（保持播放状态仅更新进度，元数据
 * 未就绪时挂起至 loadedmetadata 应用）；字幕列表可外置到 listHost（布局壳的
 * #dyn-pane）。同步由 rAF（播放中）+ timeupdate/seeked（兜底）驱动；测试钩子：
 * location.hash #seek=X 初始化后跳转并暂停；window.__testState 暴露同步状态
 * （t 与 currentTime 同值，后者为跨栏跳转走查别名）。
 */
import { onSeek } from "./events";
import {
  clamp01,
  createPreviewPopover,
  createRatePopover,
  createVolumePopover,
  fmtClock,
  type PopoverHandle,
  type PreviewProbe,
} from "./popovers";
import type { PlayerData, PlayerEntry, PlayerKfEntry, PlayerSegEntry } from "./types";

const KF_WIN = 1.5; // kf 活跃窗口（秒）：|当前时刻 - kf 时刻| < KF_WIN
const SCROLL_HOLD_MS = 4000; // 用户手动滚动后暂停自动跟随的时长
const EPS = 1e-4; // seg 边界容差：t0 <= ct < t1

export function esc(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function entryTime(e: PlayerEntry): number {
  return e.type === "seg" ? e.t0 : e.t;
}

const SVG_PLAY =
  '<svg viewBox="0 0 16 16" aria-hidden="true" class="sp-i-play"><path d="M4.5 2.2v11.6L14 8z"/></svg>';
const SVG_PAUSE =
  '<svg viewBox="0 0 16 16" aria-hidden="true" class="sp-i-pause"><path d="M3.5 2.5h3.2v11H3.5zM9.3 2.5h3.2v11H9.3z"/></svg>';
const SVG_VOL_ON =
  '<svg viewBox="0 0 16 16" aria-hidden="true" class="sp-von"><path d="M2 6h2.6L9 2.6v10.8L4.6 10H2z"/><path d="M11 5.2a4 4 0 0 1 0 5.6M12.6 3.6a6.2 6.2 0 0 1 0 8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const SVG_VOL_OFF =
  '<svg viewBox="0 0 16 16" aria-hidden="true" class="sp-voff"><path d="M2 6h2.6L9 2.6v10.8L4.6 10H2z"/><path d="M11 6.2l3.6 3.6M14.6 6.2L11 9.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/** 暴露给测试/走查的同步状态 */
export interface PlayerTestState {
  t: number;
  /** t 的别名（跨栏跳转走查用，与 t 恒等） */
  currentTime: number;
  duration: number;
  playing: boolean;
  rate: number;
  loop: boolean;
  muted: boolean;
  volume: number;
  previewNaturalWidth: number;
  previewSrc: string;
  active: number[];
}
declare global {
  interface Window {
    __testState?: PlayerTestState;
  }
}

interface ItemRef {
  el: HTMLElement;
  fill: HTMLElement | null;
  kind: "seg" | "kf";
  t0: number;
  t1: number;
  t: number;
  fillRatio: number;
}

function gridsHtml(grids: string[]): string {
  if (grids.length === 0) return "";
  return `<span class="sp-chips">${grids
    .map((g) => `<span class="sp-chip">${esc(g)}</span>`)
    .join("")}</span>`;
}

function segHtml(e: PlayerSegEntry, idx: number): string {
  return `<div class="sp-item" role="button" tabindex="0" data-kind="seg" data-idx="${idx}" data-t0="${e.t0.toFixed(
    3,
  )}" data-t1="${e.t1.toFixed(3)}">
<time>${e.t0.toFixed(1)}–${e.t1.toFixed(1)}s</time>
<div class="sp-body"><div class="sp-itemfill"></div>
<div class="sp-text">${esc(e.text)}</div>
${gridsHtml(e.grids)}</div></div>`;
}

function kfHtml(e: PlayerKfEntry, idx: number, assetUrl: (p: string) => string): string {
  return `<div class="sp-item" role="button" tabindex="0" data-kind="kf" data-idx="${idx}" data-t="${e.t.toFixed(
    3,
  )}">
<time>${e.t.toFixed(1)}s</time>
<img class="sp-kf-img" src="${assetUrl(e.thumb)}" alt="关键帧 ${esc(e.title)}" />
<div class="sp-body"><div class="sp-itemfill"></div>
<div class="sp-kf-title">${esc(e.title)}</div>
<div class="sp-kf-desc">${esc(e.desc)}</div>
${gridsHtml(e.grids)}</div></div>`;
}

function markHtml(e: PlayerKfEntry, idx: number): string {
  return `<button type="button" class="sp-mark" data-idx="${idx}" data-t="${e.t.toFixed(
    3,
  )}" data-tip="${esc(e.title)}" aria-label="关键帧：${esc(e.title)}"></button>`;
}

/** 旁注活动量曲线数据（顶层 ink_curve + frame_ts，0.5s 步进） */
export interface InkCurveData {
  values: number[];
  ts: number[];
}

/**
 * 旁注活动量墨迹图层：track 内半透明 SVG（area 35% + 描线），x=t/duration 归一、
 * y=[0,max] 归一。位于 track 填充之上、kf 菱形标记之下；默认 opacity 0，hover 由
 * CSS 过渡到 0.55。数据不足两帧或缺时长时返回空串（不渲染图层）。
 */
function inkSvgHtml(ink: InkCurveData | undefined, duration: number): string {
  if (!ink || duration <= 0) return "";
  const n = Math.min(ink.values.length, ink.ts.length);
  if (n < 2) return "";
  const W = 1000;
  const H = 40;
  const mx = Math.max(...ink.values.slice(0, n)) || 1;
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = clamp01((ink.ts[i] ?? 0) / duration) * W;
    const y = H - 3 - clamp01((ink.values[i] ?? 0) / mx) * (H - 8);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const area = `M0,${H} L${pts.join(" L")} L${W},${H} Z`;
  return `<svg class="sp-ink" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
<path class="sp-ink-area" d="${area}"></path>
<polyline class="sp-ink-line" points="${pts.join(" ")}" vector-effect="non-scaling-stroke"></polyline>
</svg>`;
}

export class ShufaPlayer {
  private readonly root: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly media: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly progress: HTMLElement;
  private readonly track: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly cursor: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly rateBtn: HTMLButtonElement;
  private readonly loopBtn: HTMLButtonElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly flash: HTMLElement;
  private readonly list: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly previewPop: PopoverHandle;
  private readonly volumePop: PopoverHandle;
  private readonly ratePop: PopoverHandle;
  private previewProbe: PreviewProbe | null = null;
  private readonly items: ItemRef[] = [];
  private readonly markEls: HTMLButtonElement[] = [];

  private duration: number;
  private rafId = 0;
  private dragging = false;
  private userScrollUntil = 0;
  private everStarted = false;
  private inView = true;
  private lastActiveKey: string | null = null;
  private lastTimeText = "";
  private flashTimer = 0;
  private reduceMotion = false;
  private pendingSeek: number | null = null;
  private readonly offSeek: () => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;

  constructor(
    container: HTMLElement,
    data: PlayerData,
    assetUrl: (p: string) => string,
    listHost?: HTMLElement,
    ink?: InkCurveData,
  ) {
    const entries = [...data.entries].sort((a, b) => entryTime(a) - entryTime(b));
    this.duration = data.duration > 0 ? data.duration : 0;

    const itemsHtml: string[] = [];
    const marksHtml: string[] = [];
    entries.forEach((e, i) => {
      if (e.type === "seg") {
        itemsHtml.push(segHtml(e, i));
      } else {
        itemsHtml.push(kfHtml(e, i, assetUrl));
        marksHtml.push(markHtml(e, i));
      }
    });

    const section = document.createElement("section");
    section.className = "shufa-player";
    section.innerHTML = `<div class="sp-layout">
  <div class="sp-stage">
    <div class="sp-media" title="点击画面 播放 / 暂停">
      <video class="sp-video" preload="metadata" playsinline></video>
      <div class="sp-flash" aria-hidden="true"></div>
    </div>
    <div class="sp-controls">
      <button type="button" class="sp-btn sp-toggle" aria-label="播放 / 暂停">${SVG_PLAY}${SVG_PAUSE}</button>
      <div class="sp-progress" aria-label="播放进度（可拖拽）">
        <div class="sp-track"><div class="sp-fill"></div>${inkSvgHtml(ink, this.duration)}${marksHtml.join("")}<div class="sp-cursor"></div></div>
      </div>
      <span class="sp-time">0:00 / ${fmtClock(this.duration)}</span>
      <button type="button" class="sp-btn sp-rate" aria-label="播放速度">1.0×</button>
      <button type="button" class="sp-btn sp-loop" aria-pressed="true" aria-label="循环重播">循环</button>
      <button type="button" class="sp-btn sp-mute" aria-pressed="false" aria-label="静音切换">${SVG_VOL_ON}${SVG_VOL_OFF}</button>
    </div>
    <p class="sp-hint">菱形标记＝旁注写入时刻，点击条目或标记可跳转 · 悬停进度条预览画面</p>
  </div>
</div>`;
    container.appendChild(section);
    this.root = section;

    // 字幕列表：默认在 .sp-layout 内；布局壳传入 listHost 时外置（#dyn-pane），
    // 便于移动端作为「动态学习」tab 面板、桌面端位于播放器正下方。
    const list = document.createElement("div");
    list.className = "sp-list";
    list.tabIndex = 0;
    list.setAttribute("aria-label", "时间轴：字幕与关键帧");
    list.innerHTML = itemsHtml.join("");
    const host = listHost ?? section.querySelector<HTMLElement>(".sp-layout");
    if (!host) throw new Error("播放器初始化失败：找不到 .sp-layout 且未提供列表宿主");
    host.appendChild(list);
    this.list = list;

    const video = section.querySelector<HTMLVideoElement>("video.sp-video");
    if (!video) throw new Error("播放器初始化失败：找不到 video 元素");
    this.video = video;
    this.video.src = assetUrl(data.video);
    const q = <T extends Element>(sel: string): T => {
      const el = section.querySelector<T>(sel);
      if (!el) throw new Error(`播放器初始化失败：找不到 ${sel}`);
      return el;
    };
    this.media = q<HTMLElement>(".sp-media");
    this.toggleBtn = q<HTMLButtonElement>(".sp-toggle");
    this.progress = q<HTMLElement>(".sp-progress");
    this.track = q<HTMLElement>(".sp-track");
    this.fill = q<HTMLElement>(".sp-fill");
    this.cursor = q<HTMLElement>(".sp-cursor");
    this.timeEl = q<HTMLElement>(".sp-time");
    this.rateBtn = q<HTMLButtonElement>(".sp-rate");
    this.loopBtn = q<HTMLButtonElement>(".sp-loop");
    this.muteBtn = q<HTMLButtonElement>(".sp-mute");
    this.flash = q<HTMLElement>(".sp-flash");

    entries.forEach((e, i) => {
      const el = this.list.querySelector<HTMLElement>(`.sp-item[data-idx="${i}"]`);
      if (!el) return;
      this.items.push({
        el,
        fill: el.querySelector<HTMLElement>(".sp-itemfill"),
        kind: e.type,
        t0: e.type === "seg" ? e.t0 : 0,
        t1: e.type === "seg" ? e.t1 : 0,
        t: e.type === "kf" ? e.t : 0,
        fillRatio: -1,
      });
    });
    this.markEls = Array.from(section.querySelectorAll<HTMLButtonElement>(".sp-mark"));

    this.controls = q<HTMLElement>(".sp-controls");
    this.previewPop = createPreviewPopover(
      this.progress,
      this.track,
      () => this.duration,
      data.previews ?? [],
      assetUrl,
      (p) => {
        this.previewProbe = p;
      },
    );
    this.volumePop = createVolumePopover(this.muteBtn, this.controls, this.video);
    this.ratePop = createRatePopover(this.rateBtn, this.controls, this.video);

    this.onKeyDown = (e: KeyboardEvent): void => this.handleSpaceKey(e);
    try {
      this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      /* 环境不支持时按常规处理 */
    }
    this.bindEvents();
    this.offSeek = onSeek((t) => this.seekFromBus(t));
    this.positionMarks();
    this.video.loop = true;
    this.setPlayingClass();
    this.sync();
    this.applySeekHook();
    this.applyPopoverHooks();
  }

  private bindEvents(): void {
    const v = this.video;
    v.addEventListener("play", () => {
      this.everStarted = true;
      this.setPlayingClass();
      this.kick();
    });
    v.addEventListener("playing", () => this.setPlayingClass());
    v.addEventListener("pause", () => {
      this.setPlayingClass();
      this.stopRaf();
      this.sync();
    });
    v.addEventListener("ended", () => {
      this.setPlayingClass();
      this.stopRaf();
      this.sync();
    });
    v.addEventListener("timeupdate", () => this.sync());
    v.addEventListener("seeked", () => this.sync());
    v.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(v.duration) && v.duration > 0) this.duration = v.duration;
      this.positionMarks();
      this.sync();
      // 跨栏跳转在元数据就绪前到达：此刻补应用
      if (this.pendingSeek != null) {
        const t = this.pendingSeek;
        this.pendingSeek = null;
        this.seekTo(t);
      }
    });
    v.addEventListener("volumechange", () => {
      // 图标联动：显式静音或音量为 0 都显示静音图标
      const off = v.muted || v.volume === 0;
      this.muteBtn.classList.toggle("sp-muted", off);
      this.muteBtn.setAttribute("aria-pressed", String(off));
      this.sync();
    });

    this.media.addEventListener("click", () => this.togglePlay(true));

    // 空格键：仅当播放器区域可见时拦截，且不抢占交互元素焦点
    if ("IntersectionObserver" in window) {
      this.inView = false;
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.target === this.root) this.inView = entry.isIntersecting;
          }
        },
        { threshold: 0.2 },
      );
      io.observe(this.root);
    }
    document.addEventListener("keydown", this.onKeyDown);

    // 时间轴列表：点击/回车跳转；用户滚动意图 → 暂停自动跟随
    this.list.addEventListener("click", (e) => this.seekFromItem(e.target));
    this.list.addEventListener("keydown", (e) => {
      this.holdScroll();
      if (e.key === "Enter") this.seekFromItem(e.target);
    });
    this.list.addEventListener("wheel", () => this.holdScroll(), { passive: true });
    this.list.addEventListener("touchmove", () => this.holdScroll(), { passive: true });
    this.list.addEventListener("pointerdown", () => this.holdScroll());

    // hover 态同步为 class：墨迹图层显隐不依赖 CSS :hover（合成事件钩子同样生效）
    this.progress.addEventListener("pointerenter", () =>
      this.progress.classList.add("sp-hovering"),
    );
    this.progress.addEventListener("pointerleave", () =>
      this.progress.classList.remove("sp-hovering"),
    );

    // 进度条：按下拖拽 seek
    this.progress.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      this.dragging = true;
      this.everStarted = true;
      try {
        this.progress.setPointerCapture(e.pointerId);
      } catch {
        /* 某些浏览器不支持 pointer capture，拖拽仍可用 */
      }
      this.dragTo(e.clientX);
      e.preventDefault();
    });
    this.progress.addEventListener("pointermove", (e) => {
      if (this.dragging) this.dragTo(e.clientX);
    });
    this.progress.addEventListener("pointerup", (e) => {
      if (this.dragging) {
        this.dragging = false;
        this.dragTo(e.clientX);
      }
    });
    this.progress.addEventListener("pointercancel", () => {
      this.dragging = false;
    });

    // 关键帧标记：点击 seek；hover tooltip 由 CSS 实现
    for (const m of this.markEls) {
      m.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.everStarted = true;
        this.seekTo(parseFloat(m.dataset.t ?? "0"));
      });
    }

    this.toggleBtn.addEventListener("click", () => this.togglePlay(false));
    // 倍速改由 Popover 菜单切换（popovers.ts），ratechange 事件联动按钮文字
    this.loopBtn.addEventListener("click", () => {
      this.video.loop = !this.video.loop;
      this.loopBtn.setAttribute("aria-pressed", String(this.video.loop));
      this.sync();
    });
    this.muteBtn.addEventListener("click", () => {
      this.video.muted = !this.video.muted;
    });
  }

  private handleSpaceKey(e: KeyboardEvent): void {
    if (!(e.code === "Space" || e.key === " " || e.key === "Spacebar") || !this.inView) return;
    const ae = document.activeElement;
    if (ae instanceof HTMLElement) {
      const tag = ae.tagName;
      if (
        tag === "BUTTON" ||
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        tag === "A" ||
        tag === "VIDEO" ||
        ae.isContentEditable
      ) {
        return;
      }
    }
    e.preventDefault();
    this.togglePlay(false);
  }

  private setPlayingClass(): void {
    this.root.classList.toggle(
      "sp-playing",
      !this.video.paused && !this.video.ended,
    );
  }

  private flashIcon(): void {
    this.flash.innerHTML = this.video.paused || this.video.ended ? SVG_PLAY : SVG_PAUSE;
    this.flash.classList.add("sp-show");
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.flash.classList.remove("sp-show"), 420);
  }

  private togglePlay(fromMedia: boolean): void {
    if (this.video.paused || this.video.ended) {
      const p = this.video.play();
      p?.catch(() => {
        /* 自动播放策略拒绝时静默，用户可再点一次 */
      });
    } else {
      this.video.pause();
    }
    if (fromMedia) this.flashIcon();
  }

  private seekTo(t: number): void {
    if (!Number.isFinite(t)) return;
    if (this.duration > 0) t = Math.max(0, Math.min(this.duration, t));
    try {
      this.video.currentTime = t;
    } catch {
      /* 元数据未就绪时忽略，loadedmetadata 后会重新同步 */
    }
    this.sync();
  }

  private positionMarks(): void {
    for (const m of this.markEls) {
      const t = parseFloat(m.dataset.t ?? "");
      if (this.duration > 0 && Number.isFinite(t)) {
        m.style.left = `${(clamp01(t / this.duration) * 100).toFixed(3)}%`;
      }
    }
  }

  private sync(): void {
    const ct = this.video.currentTime || 0;
    const r = this.duration > 0 ? clamp01(ct / this.duration) : 0;
    this.fill.style.transform = `scaleX(${r.toFixed(4)})`;
    this.cursor.style.left = `${(r * 100).toFixed(3)}%`;

    const txt = `${fmtClock(ct)} / ${fmtClock(this.duration)}`;
    if (txt !== this.lastTimeText) {
      this.timeEl.textContent = txt;
      this.lastTimeText = txt;
    }

    const activeSet = new Set<number>();
    const activeIdx: number[] = [];
    let key = "";
    this.items.forEach((it, i) => {
      let on: boolean;
      let f: number;
      if (it.kind === "seg") {
        on = ct >= it.t0 - EPS && ct < it.t1 - EPS;
        f = it.t1 > it.t0 ? clamp01((ct - it.t0) / (it.t1 - it.t0)) : 0;
      } else {
        const d = ct - it.t;
        on = Math.abs(d) < KF_WIN; // 对称窗口：逼近渐满，|Δt|≥窗口即熄灭
        f = clamp01(1 - Math.max(0, -d) / KF_WIN);
      }
      if (on) {
        activeSet.add(i);
        activeIdx.push(i);
        key += `${i},`;
      }
      if (Math.abs(f - it.fillRatio) > 0.0005) {
        it.fillRatio = f;
        it.fill?.style.setProperty("transform", `scaleX(${f.toFixed(4)})`);
      }
    });

    if (key !== this.lastActiveKey) {
      this.lastActiveKey = key;
      const behavior: ScrollBehavior = this.reduceMotion ? "auto" : "smooth";
      this.items.forEach((it, j) => {
        const on2 = activeSet.has(j);
        if (it.el.hasAttribute("data-active") !== on2) {
          if (on2) it.el.setAttribute("data-active", "1");
          else it.el.removeAttribute("data-active");
          if (on2 && this.everStarted && Date.now() >= this.userScrollUntil) {
            try {
              it.el.scrollIntoView({ block: "start", behavior });
            } catch {
              it.el.scrollIntoView();
            }
          }
        }
      });
    }

    window.__testState = {
      t: Math.round(ct * 1000) / 1000,
      currentTime: Math.round(ct * 1000) / 1000,
      duration: Math.round(this.duration * 1000) / 1000,
      playing: !this.video.paused && !this.video.ended,
      rate: this.video.playbackRate,
      loop: this.video.loop,
      muted: this.video.muted,
      volume: Math.round(this.video.volume * 1000) / 1000,
      previewNaturalWidth: this.previewProbe?.naturalWidth ?? 0,
      previewSrc: this.previewProbe?.src ?? "",
      active: activeIdx,
    };
  }

  private tick = (): void => {
    this.rafId = 0;
    this.sync();
    if (!this.video.paused && !this.video.ended) {
      this.rafId = requestAnimationFrame(this.tick);
    }
  };

  private kick(): void {
    if (!this.rafId) this.rafId = requestAnimationFrame(this.tick);
  }

  private stopRaf(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private seekFromItem(target: EventTarget | null): void {
    const el = target instanceof Element ? target.closest<HTMLElement>(".sp-item") : null;
    if (!el) return;
    const t =
      el.dataset.kind === "seg"
        ? parseFloat(el.dataset.t0 ?? "0")
        : parseFloat(el.dataset.t ?? "0");
    this.seekTo(t);
  }

  /**
   * 跨栏跳转（events.ts "shufa:seek"）：保持当前播放状态，仅更新进度；
   * seekTo 内部会刷新进度条填充/游标。元数据未就绪时挂起，loadedmetadata 补应用。
   */
  private seekFromBus(t: number): void {
    this.everStarted = true;
    if (this.video.readyState >= 1) {
      this.seekTo(t);
      return;
    }
    this.pendingSeek = t;
  }

  private holdScroll(): void {
    this.userScrollUntil = Date.now() + SCROLL_HOLD_MS;
  }

  private ratioAt(clientX: number): number {
    const rect = this.track.getBoundingClientRect();
    return rect.width > 0 ? clamp01((clientX - rect.left) / rect.width) : 0;
  }

  private dragTo(clientX: number): void {
    if (this.duration > 0) this.seekTo(this.ratioAt(clientX) * this.duration);
  }

  /** 测试钩子：URL 带 #seek=X 时，元数据就绪后 seek 到 X 并暂停 */
  private applySeekHook(): void {
    const m = /seek=([0-9.]+)/.exec(location.hash || "");
    if (!m) return;
    const t = parseFloat(m[1]);
    if (!Number.isFinite(t)) return;
    this.everStarted = true;
    const apply = (): void => {
      try {
        this.video.currentTime = t;
      } catch {
        /* 忽略 */
      }
      this.video.pause();
      this.sync();
    };
    if (this.video.readyState >= 1) apply();
    else this.video.addEventListener("loadedmetadata", apply, { once: true });
  }

  /** 卸载：移除全局监听与动画帧，清理 DOM（含外置的字幕列表） */
  destroy(): void {
    this.stopRaf();
    window.clearTimeout(this.flashTimer);
    this.offSeek();
    document.removeEventListener("keydown", this.onKeyDown);
    this.previewPop.destroy();
    this.volumePop.destroy();
    this.ratePop.destroy();
    this.list.remove();
    this.root.remove();
  }

  /**
   * 测试钩子：URL 带 #popover=… 时模拟 hover 并保持 Popover 打开（data-open="1"）。
   * - #popover=preview&t=12.3 ：向进度条 12.3s 处派发 pointer 事件流（真实 hover 路径）并 pin；
   * - #popover=volume[&volume=0.35&wheel=up|down&n=N] ：设初始音量后在静音钮上派发 N 次
   *   wheel 事件（步进 5%）并 pin；
   * - #popover=rate ：pin 倍速菜单。
   * 三者均不依赖媒体元数据（音量可随时设置、布局由 getBoundingClientRect 强制同步计算），
   * 因此同步执行一次——wheel 计数不可重复派发。
   */
  private applyPopoverHooks(): void {
    const h = location.hash.replace(/^#/, "");
    if (!h) return;
    const q = new URLSearchParams(h);
    const kind = q.get("popover");
    if (!kind) return;
    if (kind === "preview") {
      const t = parseFloat(q.get("t") ?? "");
      const rect = this.track.getBoundingClientRect();
      const dur = this.duration > 0 ? this.duration : 1;
      const x = rect.left + (Number.isFinite(t) ? clamp01(t / dur) : 0.5) * rect.width;
      // 真实 hover 路径：pointerenter/pointermove 事件驱动 hoverAt，再 pin 保持打开
      this.progress.dispatchEvent(
        new PointerEvent("pointerenter", { clientX: x, clientY: rect.top, bubbles: true }),
      );
      this.progress.dispatchEvent(
        new PointerEvent("pointermove", { clientX: x, clientY: rect.top, bubbles: true }),
      );
      this.previewPop.pin();
      this.sync();
      return;
    }
    if (kind === "volume") {
      const v0 = parseFloat(q.get("volume") ?? "");
      const dir = q.get("wheel");
      const n = parseInt(q.get("n") ?? "0", 10);
      if (Number.isFinite(v0)) this.video.volume = Math.round(clamp01(v0) * 100) / 100;
      if ((dir === "up" || dir === "down") && n > 0) {
        for (let i = 0; i < n; i++) {
          this.muteBtn.dispatchEvent(
            new WheelEvent("wheel", {
              deltaY: dir === "up" ? -120 : 120,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      }
      this.volumePop.pin();
      this.sync();
      return;
    }
    if (kind === "rate") {
      this.ratePop.pin();
      this.sync();
    }
  }
}
