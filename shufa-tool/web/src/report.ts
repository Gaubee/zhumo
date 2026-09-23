/**
 * 意图：报告页静态区块渲染（原始需求 2026-09-22；布局大重构 2026-09-22 调整；
 * 活动量曲线并入播放器进度条 2026-09-22：静态区独立曲线 SVG 已删，
 * ink_curve/frame_ts 由 layout.ts 传给播放器渲染进度条墨迹图层）。
 * 页头（印章 + 标题 + 视频信息，桌面端压缩为单行壳头）、动态学习外壳（播放器
 * 挂载点 + 移动端分段 tabs + 字幕列表宿主 #dyn-pane）、静态总结（逐字笔记 +
 * 未关联旁注 + 内容总结）、方法与参数 dl、页脚。
 * 旁注卡为横向卡片：缩略图 + 时间链接（a.anno-time，点击经 events.ts 跳转视频）
 * + 描述。播放器由 player.ts 挂载到 #player-mount。
 */
import type { AnalysisData, Annotation, CharItem } from "./types";

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

/** 分析包内相对路径（assets/x.png）→ 站点绝对路径（/assets/x.png） */
export function assetUrl(p: string): string {
  return `/${p.replace(/^\.?\//, "")}`;
}

function fmtPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function renderHeader(data: AnalysisData): string {
  return `<header class="hero">
  <div class="seal">书<br />评</div>
  <div class="hero-text">
    <h1>书写讲评分析</h1>
    <p class="sub">${esc(data.video.name)} · ${esc(data.video.duration)} · 生成于 ${esc(
      data.generated_at,
    )}</p>
    <p class="sub dim hero-note">${esc(data.orientation_note)}</p>
  </div>
</header>`;
}

export function renderDynamicShell(): string {
  return `<section id="dynamic"><h2>动态学习 <small>视频 + 时间轴 · 点击字幕/关键帧跳转 · 含老师原声</small></h2>
<div id="player-mount"></div>
<nav class="tabs" role="tablist" aria-label="内容切换">
  <button type="button" class="tab-btn" role="tab" id="tab-dyn" data-tab="dyn" aria-selected="true" aria-controls="dyn-pane">动态学习</button>
  <button type="button" class="tab-btn" role="tab" id="tab-summary" data-tab="summary" aria-selected="false" aria-controls="col-static">静态总结</button>
</nav>
<div id="dyn-pane" role="tabpanel" aria-labelledby="tab-dyn">
</div>
</section>`;
}

/** 旁注横向卡片：墨迹缩略图（72px 方形 contain）+ 时间链接 + 生成时机 + 描述 */
export function annotationCard(a: Annotation): string {
  return `<div class="anno-card">
  <img class="anno-thumb" src="${assetUrl(a.crop)}" alt="旁注：${esc(a.desc)}" />
  <div class="anno-info">
    <p class="anno-line"><a href="#" class="anno-time" data-t="${a.first_ts.toFixed(
      2,
    )}">${a.first_ts.toFixed(1)}s</a></p>
    <p class="anno-desc">${esc(a.desc)}</p>
  </div>
</div>`;
}

function charRow(g: CharItem, related: Annotation[], focusBadge: string): string {
  const noteBadge = `<span class="chip">${esc(g.note)}</span>`;
  const cards =
    related.length > 0
      ? related.map(annotationCard).join("")
      : '<p class="dim anno-empty">本片段无针对该字的旁注</p>';
  return `<div class="char-row">
  <div class="char-grid"><img src="${assetUrl(g.crop)}" alt="田字格：${esc(g.label)}" />
    <div class="cap">${esc(g.label)}${focusBadge}</div></div>
  <div class="char-info"><h3>「${esc(g.label)}」${noteBadge}</h3>
    <p class="dim-line">关联旁注 ${related.length} 处</p>
    <div class="char-annos">${cards}</div></div>
</div>`;
}

export function renderStaticSection(data: AnalysisData): string {
  const rows: string[] = [];
  const used = new Set<number>();
  for (const g of data.chars) {
    const related: Annotation[] = [];
    data.annotations.forEach((a, i) => {
      if (a.grids.includes(g.label)) {
        related.push(a);
        used.add(i);
      }
    });
    const isFocus = g.idx === data.focus_grid_idx;
    const focusBadge = isFocus ? '<span class="chip">讲解焦点</span>' : "";
    rows.push(charRow(g, related, focusBadge));
  }
  const orphan = data.annotations.filter((_, i) => !used.has(i));
  if (orphan.length > 0) {
    const cards = orphan.map(annotationCard).join("");
    rows.push(`<div class="char-row">
  <div class="char-grid"><div class="cap dim">未关联</div></div>
  <div class="char-info"><h3>未关联旁注</h3>
    <p class="dim-line">未能从转录判定归属生字</p>
    <div class="char-annos">${cards}</div></div>
</div>`);
  }

  const s = data.summary;
  const srcMap: Record<string, string> = { heuristic: "规则摘要", injected: "精修摘要" };
  const src = srcMap[s.source] ?? s.source;
  const paras = s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("");
  const ptsHtml =
    s.key_points.length > 0
      ? `<ul class="points">${s.key_points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`
      : "";
  const topicHtml = s.topic ? ` · 讲解对象「${esc(s.topic)}」` : "";

  return `<section id="static"><h2>静态总结 <small>田字格 + 笔记 · 适合复盘</small></h2>
${rows.join("\n")}
<h2 class="sub-h2">内容总结 <small>${esc(src)}${topicHtml}</small></h2>
<div class="summary">${paras}${ptsHtml}</div>
</section>`;
}

export function renderMetaSection(data: AnalysisData): string {
  const minVis =
    data.chars.length > 0 ? Math.min(...data.chars.map((c) => c.visibility)) : 0;
  const items: Array<[string, string]> = [
    ["视频", `${data.video.name}（${data.video.resolution}，${data.video.duration}）`],
    ["旋转校正", data.orientation_note],
    ["田字格检测", `${data.chars.length} 格 · 最小可见度 ${fmtPercent(minVis)}`],
    ["旁注簇", `${data.annotations.length} 处`],
    ["回放剪辑", `${data.player.duration.toFixed(1)}s（音画已增强）`],
    ["音画增强", data.enhance_note || "未启用"],
    ["转录模型", data.transcript.model || "未使用"],
    ["已知局限", data.limitations.length > 0 ? data.limitations.join("；") : "无"],
  ];
  const dl = items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  return `<section id="meta"><h2>方法与参数</h2><dl class="meta">${dl}</dl></section>`;
}

export function renderFooter(data: AnalysisData): string {
  const stats = Object.entries(data.raw_stats)
    .map(([k, v]) => `${esc(k)}=${v}`)
    .join(" · ");
  return `<footer>由 shufa-tool v${esc(data.version)} 生成 · 原始统计：${stats}</footer>`;
}
