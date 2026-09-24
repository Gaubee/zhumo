<!--
  /r/{publicId} 结果页（PRODUCT_DESIGN §3）：完整复刻打磨版分析页（BUG5）。
  打磨版源：/Users/kzf/Documents/书法/shufa-tool/web/src/（layout.ts + report.ts +
  player.ts + popovers.ts + events.ts + style.css）。移植映射：
    layout.ts 应用壳   → 本模板 .shufa-report 根 + main.cols 双列 + 移动端 tabs
    report.ts 静态区块 → 本模板 header/静态总结/方法与参数/footer（Svelte 转义替代 esc()）
    player.ts          → $lib/result/player.ts（播放器 + 墨迹曲线 + 字幕列表挂进 #dyn-pane）
    popovers/events    → $lib/result/popovers.ts、$lib/result/events.ts（shufa:seek 总线）
    style.css          → $lib/result/report.css（.shufa-report 前缀收口）
  资产经 asset() 相对拼接 /api/results/{publicId}/assets/*（公开 + Range 206）。
  数据形状以 @zhumo/contracts AnalysisData 为准（daemon zod 校验后返回；
  orientation_note/enhance_note/focus_*/summary.source 为可缺省，模板层做空安全兜底）。
-->
<script lang="ts">
  import type { AnalysisAnnotation, AnalysisChar, AnalysisData } from "@zhumo/contracts";
  import { dispatchSeek } from "$lib/result/events";
  import { ShufaPlayer } from "$lib/result/player";
  import "$lib/result/report.css";
  import { onMount } from "svelte";

  let { publicId }: { publicId: string } = $props();

  let data = $state<AnalysisData | null>(null);
  let error = $state<string | null>(null);

  /** 移动端分段 tabs 状态（桌面 ≥1000px 时 tabs 隐藏，恒为 dyn） */
  let tab = $state<"dyn" | "summary">("dyn");
  let playerMount = $state<HTMLElement | null>(null);
  let dynPane = $state<HTMLElement | null>(null);
  let tabDynBtn = $state<HTMLButtonElement | null>(null);
  let tabSummaryBtn = $state<HTMLButtonElement | null>(null);

  /** 分析包内相对路径（assets/x.png）→ 公开资产面相对 URL */
  const asset = (path: string): string => `/api/results/${encodeURIComponent(publicId)}/${path}`;

  onMount(async () => {
    try {
      const response = await fetch(`/api/results/${encodeURIComponent(publicId)}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `结果不存在或已下架（HTTP ${response.status}）`);
      }
      const body = (await response.json()) as {
        public_id: string;
        title: string | null;
        created_at: string;
        data: AnalysisData;
      };
      data = body.data;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });

  /** 播放器：挂载到 #player-mount，字幕列表外置 #dyn-pane（桌面播放器正下方/移动端动态 tab 面板） */
  $effect(() => {
    const d = data;
    const mount = playerMount;
    const pane = dynPane;
    if (!d || !mount || !pane) return;
    const player = new ShufaPlayer(mount, d.player, asset, pane, {
      values: d.ink_curve,
      ts: d.frame_ts,
    });
    return () => player.destroy();
  });

  $effect(() => {
    const d = data;
    if (d) document.title = `书写讲评分析 · ${d.video.name}`;
  });

  function setTab(next: "dyn" | "summary"): void {
    tab = next;
  }

  /** 分段 tabs 左右方向键切换（打磨版 layout.ts initTabs） */
  function onTabsKeydown(e: KeyboardEvent): void {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next: "dyn" | "summary" = tab === "dyn" ? "summary" : "dyn";
    tab = next;
    (next === "dyn" ? tabDynBtn : tabSummaryBtn)?.focus();
    e.preventDefault();
  }

  /** 旁注时间链接：移动端静态 tab 下先切回动态 tab，再经事件总线 seek（layout.ts initAnnoLinks） */
  function onAnnoTime(e: MouseEvent, t: number): void {
    e.preventDefault();
    if (tab === "summary") tab = "dyn";
    dispatchSeek(t);
  }

  function fmtPercent(v: number): string {
    return `${Math.round(v * 100)}%`;
  }

  /** 静态总结行：田字格 × 归属旁注（按 label 关联），未归属的旁注归入 orphan 行（report.ts renderStaticSection） */
  interface StaticRow {
    /** null = 未关联旁注组 */
    char: AnalysisChar | null;
    related: AnalysisAnnotation[];
  }
  const staticRows = $derived.by<StaticRow[]>(() => {
    const d = data;
    if (!d) return [];
    const rows: StaticRow[] = [];
    const used = new Set<number>();
    for (const g of d.chars) {
      const related: AnalysisAnnotation[] = [];
      d.annotations.forEach((a, i) => {
        if (a.grids.includes(g.label)) {
          related.push(a);
          used.add(i);
        }
      });
      rows.push({ char: g, related });
    }
    const orphan = d.annotations.filter((_, i) => !used.has(i));
    if (orphan.length > 0) rows.push({ char: null, related: orphan });
    return rows;
  });

  /** 内容总结副标：摘要来源（heuristic=规则摘要/injected=精修摘要）+ 讲解对象（report.ts） */
  const SRC_MAP: Record<string, string> = { heuristic: "规则摘要", injected: "精修摘要" };
  const summarySub = $derived.by<string>(() => {
    const s = data?.summary;
    if (!s) return "";
    const src = s.source ? (SRC_MAP[s.source] ?? s.source) : "";
    const topic = s.topic ? `${src ? " · " : ""}讲解对象「${s.topic}」` : "";
    return `${src}${topic}`;
  });

  /** 方法与参数 dl 条目（report.ts renderMetaSection；契约可缺省字段在此兜底） */
  const metaItems = $derived.by<Array<[string, string]>>(() => {
    const d = data;
    if (!d) return [];
    const minVis = d.chars.length > 0 ? Math.min(...d.chars.map((c) => c.visibility)) : 0;
    return [
      ["视频", `${d.video.name}（${d.video.resolution}，${d.video.duration}）`],
      ["旋转校正", d.orientation_note ?? ""],
      ["田字格检测", `${d.chars.length} 格 · 最小可见度 ${fmtPercent(minVis)}`],
      ["旁注簇", `${d.annotations.length} 处`],
      ["回放剪辑", `${d.player.duration.toFixed(1)}s（音画已增强）`],
      ["音画增强", d.enhance_note || "未启用"],
      ["转录模型", d.transcript.model || "未使用"],
      ["已知局限", d.limitations.length > 0 ? d.limitations.join("；") : "无"],
    ];
  });

  /** 页脚原始统计（report.ts renderFooter） */
  const statsText = $derived(
    data
      ? Object.entries(data.raw_stats)
          .map(([k, v]) => `${k}=${v}`)
          .join(" · ")
      : "",
  );
</script>

{#snippet annoCard(a: AnalysisAnnotation)}
  <div class="anno-card">
    <img class="anno-thumb" src={asset(a.crop)} alt="旁注：{a.desc}" />
    <div class="anno-info">
      <p class="anno-line">
        <!-- svelte-ignore a11y_invalid_attribute -->
        <a
          href="#"
          class="anno-time"
          data-t={a.first_ts.toFixed(2)}
          onclick={(e) => onAnnoTime(e, a.first_ts)}>{a.first_ts.toFixed(1)}s</a
        >
      </p>
      <p class="anno-desc">{a.desc}</p>
    </div>
  </div>
{/snippet}

{#if error}
  <div class="shufa-report">
    <div class="boot-error">
      <h2>分析加载失败</h2>
      <p>{error}</p>
      <p class="dim">排查建议：确认分享链接有效且结果未下架，然后刷新重试。</p>
    </div>
  </div>
{:else if !data}
  <div class="shufa-report">
    <p class="boot-loading">分析加载中…</p>
  </div>
{:else if data}
  <div class="shufa-report" data-tab={tab}>
    <header class="hero">
      <div class="seal">书<br />评</div>
      <div class="hero-text">
        <h1>书写讲评分析</h1>
        <p class="sub">{`${data.video.name} · ${data.video.duration} · 生成于 ${data.generated_at}`}</p>
        <p class="sub dim hero-note">{data.orientation_note ?? ""}</p>
      </div>
    </header>

    <main class="cols">
      <!-- 左列：动态学习（视频 + 移动端 tabs + 字幕列表宿主） -->
      <div class="col col-dyn">
        <section id="dynamic">
          <h2>动态学习 <small>视频 + 时间轴 · 点击字幕/关键帧跳转 · 含老师原声</small></h2>
          <div id="player-mount" bind:this={playerMount}></div>
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
          <nav class="tabs" role="tablist" aria-label="内容切换" onkeydown={onTabsKeydown}>
            <button
              type="button"
              class="tab-btn"
              role="tab"
              id="tab-dyn"
              data-tab="dyn"
              aria-selected={tab === "dyn"}
              aria-controls="dyn-pane"
              bind:this={tabDynBtn}
              onclick={() => setTab("dyn")}>动态学习</button
            >
            <button
              type="button"
              class="tab-btn"
              role="tab"
              id="tab-summary"
              data-tab="summary"
              aria-selected={tab === "summary"}
              aria-controls="col-static"
              bind:this={tabSummaryBtn}
              onclick={() => setTab("summary")}>静态总结</button
            >
          </nav>
          <!-- 播放器把 .sp-list 追加进此宿主（player.ts listHost） -->
          <div id="dyn-pane" role="tabpanel" aria-labelledby="tab-dyn" bind:this={dynPane}></div>
        </section>
      </div>

      <!-- 右列：静态总结 + 方法与参数 -->
      <div class="col col-static" id="col-static" role="tabpanel" aria-labelledby="tab-summary">
        <section id="static">
          <h2>静态总结 <small>田字格 + 笔记 · 适合复盘</small></h2>
          {#each staticRows as row (row.char ? `c${row.char.idx}` : "orphan")}
            <div class="char-row">
              {#if row.char}
                <div class="char-grid">
                  <img src={asset(row.char.crop)} alt="田字格：{row.char.label}" />
                  <div class="cap">
                    {row.char.label}{#if row.char.idx === data.focus_grid_idx}<span class="chip"
                        >讲解焦点</span
                      >{/if}
                  </div>
                </div>
                <div class="char-info">
                  <h3>「{row.char.label}」<span class="chip">{row.char.note}</span></h3>
                  <p class="dim-line">关联旁注 {row.related.length} 处</p>
                  <div class="char-annos">
                    {#if row.related.length > 0}
                      {#each row.related as a (a.idx)}{@render annoCard(a)}{/each}
                    {:else}
                      <p class="dim anno-empty">本片段无针对该字的旁注</p>
                    {/if}
                  </div>
                </div>
              {:else}
                <div class="char-grid"><div class="cap dim">未关联</div></div>
                <div class="char-info">
                  <h3>未关联旁注</h3>
                  <p class="dim-line">未能从转录判定归属生字</p>
                  <div class="char-annos">
                    {#each row.related as a (a.idx)}{@render annoCard(a)}{/each}
                  </div>
                </div>
              {/if}
            </div>
          {/each}

          <h2 class="sub-h2">内容总结 <small>{summarySub}</small></h2>
          <div class="summary">
            {#each data.summary.paragraphs as para, i (i)}
              <p>{para}</p>
            {/each}
            {#if data.summary.key_points.length > 0}
              <ul class="points">
                {#each data.summary.key_points as point, i (i)}
                  <li>{point}</li>
                {/each}
              </ul>
            {/if}
          </div>
        </section>

        <section id="meta">
          <h2>方法与参数</h2>
          <dl class="meta">
            {#each metaItems as [k, v]}
              <dt>{k}</dt><dd>{v}</dd>
            {/each}
          </dl>
        </section>
      </div>
    </main>

    <footer>由 shufa-tool v{data.version} 生成 · 原始统计：{statsText}</footer>
  </div>
{/if}
