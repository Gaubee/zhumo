/**
 * 意图：应用壳与跨栏交互（布局大重构 2026-09-22）。
 *  1) 壳组装：header / main.cols（桌面 ≥1000px 双列 grid，左=动态学习、右=静态总结，
 *     各自内部滚动，body 不滚）+ footer 通栏；移动端单列 document 流。
 *  2) 移动端分段 tabs（「动态学习/静态总结」，segmented control，role=tablist，
 *     aria-selected；body[data-tab] 驱动内容切换）。
 *  3) 旁注时间链接委托点击：preventDefault → 移动端若在静态 tab 先切回动态 →
 *     dispatchSeek(t) 跳转视频（events.ts 总线）。
 *  4) 测试钩子：#tab=summary 切 tab；#clickanno=N 模拟点击第 N+1 个旁注时间链接。
 * 播放器列表外置：ShufaPlayer 将字幕列表挂进 #dyn-pane（桌面位于播放器下方，
 * 移动端即「动态学习」tab 面板），布局不移动既有节点。
 */
import { dispatchSeek } from "./events";
import { ShufaPlayer } from "./player";
import {
  assetUrl,
  renderDynamicShell,
  renderFooter,
  renderHeader,
  renderMetaSection,
  renderStaticSection,
} from "./report";
import type { AnalysisData } from "./types";

type TabId = "dyn" | "summary";

function currentTab(): TabId {
  return document.body.dataset.tab === "summary" ? "summary" : "dyn";
}

export function mountApp(app: HTMLElement, data: AnalysisData): void {
  app.innerHTML = `<div class="shell">${renderHeader(data)}
<main class="cols">
  <div class="col col-dyn">${renderDynamicShell()}</div>
  <div class="col col-static" id="col-static" role="tabpanel" aria-labelledby="tab-summary">${renderStaticSection(
    data,
  )}${renderMetaSection(data)}</div>
</main>
${renderFooter(data)}</div>`;

  const mount = app.querySelector<HTMLDivElement>("#player-mount");
  const pane = app.querySelector<HTMLDivElement>("#dyn-pane");
  if (!mount || !pane) throw new Error("布局壳初始化失败：缺少播放器挂载点");
  new ShufaPlayer(mount, data.player, assetUrl, pane, {
    values: data.ink_curve,
    ts: data.frame_ts,
  });

  initTabs(app);
  initAnnoLinks(app);
  applyHashHooks(app);
}

/** 分段 tabs：点击/左右方向键切换，body[data-tab] + aria-selected 联动 */
function initTabs(app: HTMLElement): void {
  const buttons = Array.from(
    app.querySelectorAll<HTMLButtonElement>(".tabs .tab-btn"),
  );
  if (buttons.length === 0) return;
  const setTab = (tab: TabId): void => {
    document.body.dataset.tab = tab;
    for (const b of buttons) {
      b.setAttribute("aria-selected", String(b.dataset.tab === tab));
    }
  };
  for (const b of buttons) {
    b.addEventListener("click", () => setTab(b.dataset.tab === "summary" ? "summary" : "dyn"));
  }
  const tablist = buttons[0].closest<HTMLElement>(".tabs");
  tablist?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next: TabId = currentTab() === "dyn" ? "summary" : "dyn";
    setTab(next);
    buttons.find((b) => b.dataset.tab === next)?.focus();
    e.preventDefault();
  });
  setTab("dyn");
}

/** 旁注时间链接：移动端静态 tab 下先切回动态 tab，再经事件总线 seek */
function initAnnoLinks(app: HTMLElement): void {
  app.addEventListener("click", (e) => {
    const a =
      e.target instanceof Element
        ? e.target.closest<HTMLAnchorElement>("a.anno-time")
        : null;
    if (!a) return;
    e.preventDefault();
    const t = parseFloat(a.dataset.t ?? "");
    if (!Number.isFinite(t)) return;
    if (currentTab() === "summary") {
      app.querySelector<HTMLButtonElement>('.tab-btn[data-tab="dyn"]')?.click();
    }
    dispatchSeek(t);
  });
}

/** 测试钩子：#tab=summary 切换 tab；#clickanno=N 模拟点击第 N 个（0 起）时间链接 */
function applyHashHooks(app: HTMLElement): void {
  const q = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (q.get("tab") === "summary") {
    app.querySelector<HTMLButtonElement>('.tab-btn[data-tab="summary"]')?.click();
  }
  const n = parseInt(q.get("clickanno") ?? "", 10);
  if (Number.isInteger(n) && n >= 0) {
    const link = app.querySelectorAll<HTMLAnchorElement>("a.anno-time")[n];
    link?.click();
  }
}
