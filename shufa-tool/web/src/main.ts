/**
 * 意图：应用入口（原始需求 2026-09-22）——加载 /data.json、运行时校验，
 * 交给 layout.ts 组装应用壳（header/双列 main/footer + 播放器 + tabs）。
 * 加载期间显示「分析加载中…」；失败显示中文错误与排查建议。
 */
import "./style.css";
import { mountApp } from "./layout";
import { validateAnalysisData } from "./types";

function showError(title: string, detail: string): void {
  const app = document.getElementById("app");
  if (!app) return;
  app.innerHTML = `<div class="boot-error"><h2>${title}</h2><p>${detail}</p>
<p class="dim">排查建议：确认 dev server 以环境变量 SHUFA_DATA 指向包含 data.json 与 assets/ 的分析包目录，然后刷新重试。</p></div>`;
}

async function boot(): Promise<void> {
  const app = document.getElementById("app");
  if (!app) return;

  let res: Response;
  try {
    res = await fetch("/data.json");
  } catch (err) {
    showError("分析加载失败", `无法请求 /data.json（${err instanceof Error ? err.message : String(err)}）`);
    return;
  }
  if (!res.ok) {
    showError("分析加载失败", `GET /data.json 返回 ${res.status}，分析包可能未正确挂载。`);
    return;
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    showError("分析加载失败", "data.json 不是合法 JSON。");
    return;
  }

  let data;
  try {
    data = validateAnalysisData(raw);
  } catch (err) {
    showError(
      "分析数据校验失败",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  document.title = `书写讲评分析 · ${data.video.name}`;
  mountApp(app, data);
}

boot().catch((err: unknown) => {
  showError("页面渲染失败", err instanceof Error ? err.message : String(err));
});
