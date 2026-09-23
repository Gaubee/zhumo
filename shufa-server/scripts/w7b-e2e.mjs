#!/usr/bin/env node
/**
 * W7b 真实 agent E2E（Owner 供 LLM 凭据后一键跑）。
 *
 * 输入（env）：
 *   LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL   必填（--dry-run 除外）
 *   PORT=8239  DATA_ROOT=/tmp/shufa-w7b/data  VIDEO=<真实视频路径>  CHROME_PATH=<可执行>
 *   TIMEOUT_MS=900000（done 轮询上限，15 分钟）
 * 模式：
 *   默认          真实 agent 全链：向导（真实 key）→ 建任务 → 等 done → 断言
 *                 摘要帧/summary.json/results 行/登出态结果页渲染。
 *   --dry-run     无 key 链路回归：占位 LLM 跑到「建任务 + 失败收敛」为止
 *                 （沿用 W7a 失败路径断言），真实 agent 断言标记 SKIPPED。
 *
 * 自动完成：全新 DATA_ROOT 起 daemon → admin 向导（含 Models 真实 key 写入）→
 * 上传真实视频建任务 → 轮询帧 → 断言 → 清理（杀 daemon/Chrome）。
 * 退出码 0=全部 PASS，1=存在 FAIL。
 */
import { execSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const env = process.env;
const scriptPath = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(scriptPath, "..");
const PORT = Number(env.PORT ?? 8239);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_ROOT = env.DATA_ROOT ?? "/tmp/shufa-w7b/data";
const VIDEO = env.VIDEO ?? "/Users/kzf/Documents/书法/samples/20260922-124852.mp4";
const TIMEOUT_MS = Number(env.TIMEOUT_MS ?? 15 * 60 * 1000);
const ADMIN_USER = "admin";
const ADMIN_PASS = `w7b-${Date.now().toString(36)}`;
const PROMPT = "按步骤分析这段讲评视频，摘要由你撰写";

const results = [];
function record(ok, label) {
  results.push({ ok, label });
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
}
function skip(label) {
  results.push({ ok: true, label, skipped: true });
  console.log(`SKIPPED: ${label}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- DATA_ROOT 预处理（E2E 必须全新数据；首轮真实联调教训：残留 admin 使 needs_setup 翻假）----
// 默认路径自动清空；自定义路径非空即拒绝（防误删），显式 W7B_FRESH=1 才允许清。
{
  const isDefault = DATA_ROOT === "/tmp/shufa-w7b/data";
  if (existsSync(DATA_ROOT)) {
    const nonEmpty = readdirSync(DATA_ROOT).length > 0;
    if (nonEmpty && !isDefault && env.W7B_FRESH !== "1") {
      console.error(`DATA_ROOT 非空：${DATA_ROOT}（自定义路径须为空目录，或设 W7B_FRESH=1 允许清空）`);
      process.exit(1);
    }
    if (nonEmpty || isDefault) rmSync(DATA_ROOT, { recursive: true, force: true });
  }
}

// ---- daemon ----
const envFile = path.join(REPO, "runtime", "w7b.env");
function writeEnv() {
  mkdirSync(path.dirname(envFile), { recursive: true });
  mkdirSync(path.join(DATA_ROOT, "models"), { recursive: true });
  // whisper 下载步骤的嗅探文件（跳过真实下载；W7a 同款语义）
  writeFileSync(path.join(DATA_ROOT, "models", "ggml-base.bin"), "sniff-dummy\n");
  const llm = DRY_RUN
    ? { provider: "placeholder-llm", base: "http://127.0.0.1:1/v1", key: "sk-placeholder", model: "placeholder-model", api: "" }
    : {
        provider: env.LLM_PROVIDER ?? "",
        base: env.LLM_BASE_URL ?? "",
        key: env.LLM_API_KEY ?? "",
        model: env.LLM_MODEL ?? "",
        // 协议键（可选）：openai-completions / anthropic-messages，缺省走 daemon 默认
        api: env.LLM_API ?? "",
      };
  if (!DRY_RUN && (!llm.provider || !llm.base || !llm.key || !llm.model)) {
    console.error("缺少 LLM_PROVIDER/LLM_BASE_URL/LLM_API_KEY/LLM_MODEL（或使用 --dry-run）");
    process.exit(1);
  }
  writeFileSync(
    envFile,
    [
      `ADMIN_USERNAME=`,
      `ADMIN_PASSWORD=`,
      `JWT_SECRET=`,
      `SITE_BASE_URL=`,
      `LLM_PROVIDER=${llm.provider}`,
      `LLM_BASE_URL=${llm.base}`,
      `LLM_API_KEY=${llm.key}`,
      `LLM_API=${llm.api}`,
      `LLM_MODEL=${llm.model}`,
      `DATA_ROOT=${DATA_ROOT}`,
      `HOST=127.0.0.1`,
      `PORT=${PORT}`,
      "",
    ].join("\n"),
  );
}

let daemon = null;
function portListenerPids() {
  try {
    return execSync(`lsof -ti tcp:${PORT} -sTCP:LISTEN`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}
// W7b 联调教训：pnpm→tsx 是孙进程链，daemon.kill() 只杀 pnpm，tsx 带着内存里的
// 「已安装」状态变孤儿占住端口，后续运行全打到僵尸实例上。必须整组杀 + 端口兜底。
function killDaemonTree() {
  if (daemon?.pid) {
    try {
      process.kill(-daemon.pid, "SIGKILL"); // detached 进程组组长：负 pid 杀全组
    } catch {
      // 已退出
    }
  }
  daemon = null;
  for (const pid of portListenerPids()) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // 竞态已退出
    }
  }
}
async function startDaemon() {
  const stale = portListenerPids();
  if (stale.length > 0) {
    console.error(`端口 ${PORT} 已被占用（pid=${stale.join(",")}）——可能有孤儿 daemon，先清理再跑`);
    process.exit(1);
  }
  daemon = spawn("pnpm", ["--filter", "@zhumo/daemon", "start"], {
    cwd: REPO,
    env: { ...process.env, SHUFA_ENV: envFile },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // 进程组组长：killDaemonTree 以负 pid 整组回收
  });
  daemon.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
  daemon.stderr.on("data", (chunk) => process.stderr.write(`[daemon] ${chunk}`));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/bootstrap`);
      if (res.ok) return (await res.json());
    } catch {
      // 未起
    }
    await sleep(500);
  }
  throw new Error("daemon 启动超时");
}
process.on("exit", killDaemonTree);

// ---- oRPC 客户端（webui 依赖面，绝对路径动态导入） ----
async function rpcClient(token) {
  const orpcClient = await import(
    pathToFileURL(path.join(REPO, "webui/node_modules/@orpc/client/dist/index.mjs")).href
  );
  const wsAdapter = await import(
    pathToFileURL(path.join(REPO, "webui/node_modules/@orpc/client/dist/adapters/websocket/index.mjs")).href
  );
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/rpc${token ? `?token=${encodeURIComponent(token)}` : ""}`);
  const link = new wsAdapter.RPCLink({ websocket: ws });
  return orpcClient.createORPCClient(link);
}

// ---- 结果页渲染断言（headless Chrome + CDP） ----
async function assertResultPage(publicId, snippet) {
  const chromeCandidates = [
    env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/kzf/.agent-browser/browsers/chrome-149.0.7827.54/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ].filter(Boolean);
  const bin = chromeCandidates.find((p) => existsSync(p));
  if (!bin) {
    skip(`结果页渲染断言（未找到 Chrome，设置 CHROME_PATH）`);
    return;
  }
  const chrome = spawn(
    bin,
    ["--headless=new", `--remote-debugging-port=9339`, "--no-first-run", "--window-size=1360,900", "about:blank"],
    { stdio: "ignore" },
  );
  try {
    await sleep(2500);
    const list = await (await fetch("http://127.0.0.1:9339/json/list")).json();
    const page = list.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    const cdp = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    await cdp("Page.enable");
    await cdp("Page.navigate", { url: "about:blank" });
    await sleep(300);
    await cdp("Page.navigate", { url: `${BASE}/r/${publicId}` });
    await sleep(4500);
    const body = await cdp("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true });
    const text = body.result?.result?.value ?? "";
    const hasVideo = await cdp("Runtime.evaluate", { expression: "!!document.querySelector('video')", returnByValue: true });
    record(typeof text === "string" && text.includes(snippet), `登出态结果页含摘要文本（${JSON.stringify(snippet)}）`);
    record(hasVideo.result?.result?.value === true, "登出态结果页渲染 video 元素");
    ws.close();
  } finally {
    chrome.kill();
  }
}

// ---- 主流程 ----
writeEnv();
console.log(`== W7b E2E${DRY_RUN ? "（dry-run）" : ""} ==`);
let boot;
try {
  boot = await startDaemon();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
record(boot.needs_setup === true, "bootstrap 返回 needs_setup=true（全新 DATA_ROOT）");

const client = await rpcClient();

// 1. 向导：建管理员（直接签发 token）
const created = await client.setup.createAdmin({ username: ADMIN_USER, password: ADMIN_PASS });
record(!!created.token, "向导步 1：管理员创建并签发 JWT");

// 带 token 的连接（settings.put 需要 admin 角色）
const adminClient = await rpcClient(created.token);

// 2. 三个准备步骤（嗅探语义；webui-install 已随预编译产物分发下线，走查 R4）。步 1 创建管理员后 setup 面整体关闭（needsSetup 翻假），
//    重跑/继续走 admin.wizard 面（PRODUCT_DESIGN §2 settings 复用同一套组件）。
let bootAfterAdmin = null;
for (let i = 0; i < 20; i++) {
  bootAfterAdmin = await fetch(`${BASE}/api/bootstrap`).then((r) => r.json());
  if (bootAfterAdmin.needs_setup === false) break;
  await sleep(300);
}
record(bootAfterAdmin?.needs_setup === false, "创建管理员后 needs_setup 翻假（安装完成信号）");
for (const id of ["ffmpeg", "python-env", "whisper-model"]) {
  const step = await adminClient.admin.wizard.runStep({ id, force: false });
  record(step.status === "done", `向导步 2 [${id}] done（${(step.last_log ?? "").slice(0, 24)}）`);
}

// 3. Models 配置（真实 key 或占位）
if (!DRY_RUN) {
  await adminClient.admin.settings.put({ key: "llm_provider", value: env.LLM_PROVIDER });
  await adminClient.admin.settings.put({ key: "llm_base_url", value: env.LLM_BASE_URL });
  await adminClient.admin.settings.put({ key: "llm_api_key", value: env.LLM_API_KEY });
  await adminClient.admin.settings.put({ key: "llm_model", value: env.LLM_MODEL });
  if (env.LLM_API) await adminClient.admin.settings.put({ key: "llm_api", value: env.LLM_API });
  console.log(`Models 配置已写入 settings（llm_*${env.LLM_API ? " + llm_api" : ""}）`);
} else {
  console.log("dry-run：跳过真实 Models 写入（保持 .env 占位路由）");
}
// setup.complete 在步 1 后已被 setupGated 关闭（同上语义），安装完成信号见上。

// 4. 建任务（真实视频直传）
if (!existsSync(VIDEO)) {
  console.error(`视频不存在：${VIDEO}`);
  process.exit(1);
}
const b64 = readFileSync(VIDEO).toString("base64");
console.log(`上传视频 ${VIDEO}（base64 ${(b64.length / 1e6).toFixed(1)}MB）…`);
const taskOut = await adminClient.tasks.create({
  prompt: PROMPT,
  video: { filename: path.basename(VIDEO), data_base64: b64 },
});
record(!!taskOut.agent_session_id, `任务创建且会话已建（id=${taskOut.id}）`);

// 5. 帧轮询（真实模式等 done；dry-run 等 failed 收敛）
const cursor = { seq: 0 };
const frames = [];
let finalStatus = null;
const pollStart = Date.now();
while (Date.now() - pollStart < (DRY_RUN ? 120000 : TIMEOUT_MS)) {
  const detail = await adminClient.tasks.get({ id: taskOut.id, after_seq: cursor.seq });
  frames.push(...detail.frames);
  if (detail.frames.length > 0) cursor.seq = detail.frames.at(-1).seq;
  if (["done", "failed", "cancelled"].includes(detail.task.status)) {
    finalStatus = detail.task.status;
    break;
  }
  await sleep(DRY_RUN ? 2000 : 5000);
}

if (DRY_RUN) {
  record(finalStatus === "failed", `失败路径收敛（status=${finalStatus}，不悬挂）`);
  record(
    frames.some((f) => f.kind === "status" && f.payload?.status === "failed"),
    "收到 failed 状态帧",
  );
  record(frames.some((f) => f.kind === "user-text"), "首条 prompt 以 user-text 帧回放");
  console.log("== dry-run 结束（真实 agent 断言 SKIPPED） ==");
  for (const label of [
    "agent 亲写摘要（summary_write 实参 ≥200 字）",
    "summary.json 落盘于 .shufa",
    "results 行 + public_id 生成",
    "登出态 /r/{public_id} 200 且含摘要",
  ]) {
    skip(label);
  }
} else {
  record(finalStatus === "done", `任务收敛 done（status=${finalStatus}）`);
  // agent 亲写摘要的判定面：summary_write 工具调用的实参内容 ≥200 字。
  // 设计上摘要经工具落盘（聊天只回一句总评）——断言聊天文本长度是错的代理指标
  //（第二轮真实联调教训：agent 摘要写得漂亮，仅因聊天短被判 FAIL）。
  const summaryCalls = frames.filter(
    (f) => f.kind === "tool-call" && /summary_write$/.test(f.toolName ?? "")
      && String(f.payload?.arguments?.content ?? "").trim().length >= 200,
  );
  record(summaryCalls.length > 0, `agent 亲写摘要（summary_write 实参 ≥200 字：${summaryCalls.length} 次）`);
  const summarySnippet = String(summaryCalls.at(-1)?.payload?.arguments?.content ?? "").trim().slice(0, 24);

  // DB 断言
  const require = createRequire(path.join(REPO, "daemon/package.json"));
  const Database = require("better-sqlite3");
  const db = new Database(path.join(DATA_ROOT, "shufa.db"), { readonly: true });
  const row = db.prepare("SELECT result_id, status FROM tasks WHERE id = ?").get(taskOut.id);
  const result = row?.result_id
    ? db.prepare("SELECT public_id FROM results WHERE id = ?").get(row.result_id)
    : null;
  record(!!result?.public_id, `results 行 + public_id 生成（${result?.public_id ?? "无"}）`);
  const shufaRes = db
    .prepare("SELECT meta FROM resources WHERE name = '.shufa' AND owner_id = ?")
    .get(created.user.id);
  let summaryOnDisk = false;
  let summaryJsonText = "";
  if (shufaRes?.meta) {
    const dir = JSON.parse(shufaRes.meta).dir;
    for (const candidate of [path.join(dir, "summary.json")]) {
      if (existsSync(candidate)) {
        summaryOnDisk = true;
        summaryJsonText = readFileSync(candidate, "utf8");
        break;
      }
    }
  }
  record(summaryOnDisk, "summary.json 落盘于 .shufa 任务目录");
  db.close();

  // 公开面
  const anon = await fetch(`${BASE}/api/results/${result?.public_id ?? ""}`);
  record(anon.status === 200, "登出态 GET /api/results/{public_id} 200");
  await assertResultPage(
    result?.public_id ?? "none",
    summaryJsonText
      ? String(JSON.parse(summaryJsonText).paragraphs?.[0] ?? "").slice(0, 24)
      : summarySnippet,
  );
}

console.log("== 结果汇总 ==");
let failed = 0;
for (const item of results) {
  if (item.skipped) continue;
  if (!item.ok) failed += 1;
}
for (const item of results) {
  if (item.skipped) console.log(`SKIP: ${item.label}`);
}
console.log(`总计 ${results.filter((r) => !r.skipped).length} 项，FAIL ${failed}`);
killDaemonTree(); // 整组杀（pnpm→tsx 孙进程 + 端口兜底），exit 钩子再兜一层
process.exit(failed > 0 ? 1 : 0);
