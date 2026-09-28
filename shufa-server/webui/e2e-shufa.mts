/**
 * 真实端到端测试（Owner 2026-09-28 授权：复用 .env 与数据库、烧真实 LLM）：
 * 临时用户 → WS login → tasks.create（真实视频）→ 轮询终态 → 产物质量断言。
 * 2026-09-27 起不再清场：任务、results 行与产物目录全部保留，结果页链接打印
 * 在尾部供 Owner 亲验（Owner 质询「你的会话历史呢？」——每轮 e2e 都可回溯）。
 * 运行（mini 上）：cd daemon && npx tsx ../e2e-shufa.mts [视频路径] [daemon-url]
 * 断言门槛（终态契约）：fact 必带 source 段引用且引文逐字出自所引段；高风险
 * 分析词不得混入 fact；labels 非空 label 单汉字；grid_idx 存在。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { RPCLink } from '@orpc/client/websocket';
import { createORPCClient } from '@orpc/client';
// 校验表与 daemon 同源（Codex 五审 P2：两份复制表漂移=网内自洽假阳性）。
const { VISUAL_RE, RISKY_RE, ANY_QUOTE_RE, factEvidenceErrors, nonFactQuoteErrors } = await import(
  '../daemon/src/capability/analysis.js'
);

const videoPath = process.argv[2] ?? '';
const daemonUrl = process.argv[3] ?? 'ws://127.0.0.1:8217';
const webuiBase = process.env.E2E_WEBUI_URL ?? 'http://127.0.0.1:8217'; // daemon 静态托管 webui/dist
const DATA_ROOT = process.env.E2E_DATA_ROOT ?? path.join(process.env.HOME!, 'Library/Application Support/zhumo');
if (!existsSync(videoPath)) {
  console.error('用法: npx tsx ../e2e-shufa.mts <视频绝对路径> [ws-url]');
  process.exit(2);
}

// ---- 1. 临时用户（账号保留——产物供审计，不再即弃）----
const { hashPassword } = await import('../daemon/src/auth.js');
const { openDatabase } = await import('../daemon/src/db/database.js');
const { createUser } = await import('../daemon/src/db/store.js');
const db = openDatabase(DATA_ROOT);
const TEST_USER = `e2e-${Date.now().toString(36)}`;
createUser(db, { username: TEST_USER, passwordHash: hashPassword('e2e-pass'), role: 'user' });
console.log(`[e2e] 临时用户 ${TEST_USER} 已建（本轮保留，供 Owner 审计）`);

// ---- 2. oRPC over WS ----
function wsOpen(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url);
    sock.addEventListener('open', () => resolve(sock), { once: true });
    sock.addEventListener('error', () => reject(new Error(`ws 连接失败: ${url}`)), { once: true });
  });
}
const ws = await wsOpen(`${daemonUrl}/ws/rpc`);
const rpc = createORPCClient(new RPCLink({ websocket: ws })) as any;
const login = await rpc.auth.login({ username: TEST_USER, password: 'e2e-pass' });
console.log(`[e2e] 登录成功（${login.user.username}）`);
ws.close();
const authWs = await wsOpen(`${daemonUrl}/ws/rpc?token=${encodeURIComponent(login.token)}`);
const auth = createORPCClient(new RPCLink({ websocket: authWs })) as any;

// ---- 3. 创建任务（真实视频 + 默认模型）----
const dataBase64 = readFileSync(videoPath).toString('base64');
const PROMPT =
  '请按手册全流程分析这段讲评视频：转正对齐、田字格检测、旁注批注提取、焦点回放剪辑与语音转录；把旁注与对应生字关联，最后由你阅读转录与画面产物亲自撰写摘要（教师点评要点 + 练习建议），并导出分析包。';
const created = await auth.tasks.create({
  prompt: PROMPT,
  video: { filename: path.basename(videoPath), data_base64: dataBase64 },
});
console.log(`[e2e] 任务已创建: ${created.id}（轮询至终态…）`);

// ---- 4. 轮询终态（真实 LLM 全流程，宽限 20 分钟）----
const deadline = Date.now() + 20 * 60_000;
let task: any = created;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 8_000));
  const out = await auth.tasks.get({ id: created.id, after_seq: 0 });
  task = out.task;
  if (task && ['done', 'failed', 'cancelled'].includes(task.status)) break;
}
console.log(`[e2e] 终态: ${task?.status ?? 'TIMEOUT'}${task?.error ? ` error=${task.error}` : ''}`);

// ---- 5. 产物断言（终态三态契约）----
const failures: string[] = [];
function check(cond: boolean, label: string): void {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
  if (!cond) failures.push(label);
}
if (task?.status !== 'done') {
  failures.push(`终态非 done: ${task?.status}`);
} else {
  // 任务目录定位：users/<TEST_USER>/<date-id>/
  const usersRoot = path.join(DATA_ROOT, 'users', TEST_USER);
  const dirs = readdirSync(usersRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const shufaDir = dirs.length === 1 ? path.join(usersRoot, dirs[0]!, '.shufa') : null;

  if (shufaDir === null || !existsSync(shufaDir)) {
    failures.push('任务 .shufa 目录不存在');
  } else {
    const labels = JSON.parse(readFileSync(path.join(shufaDir, 'labels.json'), 'utf8'));
    const summary = JSON.parse(readFileSync(path.join(shufaDir, 'summary.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(shufaDir, '.shufa-work', 'manifest.json'), 'utf8'));
    const data = JSON.parse(readFileSync(path.join(shufaDir, '.shufa-work', 'bundle', 'data.json'), 'utf8'));
    const segments: string[] = (manifest.transcribe?.segments ?? []).map((s: any) => s.text ?? '');
    const transcript = segments.join('');

    console.log('\n=== labels ===');
    console.log(JSON.stringify(labels, null, 2));
    console.log('\n=== summary ===');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\n=== 断言 ===');
    // 1) 非空 label 必须单汉字（挡「未点名格」类编造占位）
    for (const g of labels.grids ?? []) {
      if (g.label !== '') check(/^[\u4e00-\u9fff]$/.test(g.label), `labels.grids[${g.index}].label="${g.label}" 为单汉字（非编造占位）`);
    }
    // 2) summary 结构
    check((summary.paragraphs ?? []).length >= 2, 'summary.paragraphs ≥ 2');
    check((summary.key_points ?? []).length >= 1, 'summary.key_points ≥ 1');
    // 3) 三态契约：每条 claim 必须是合法对象（纯 string 已被 daemon 拒绝——
    //    产物里再出现即契约回退）；fact 证据（source 界内 + 任意长度引文
    //    逐字 + 逐句锚点）用 daemon 同源 helper 复核。
    const claims = [...(summary.paragraphs ?? []), ...(summary.key_points ?? [])];
    for (const [i, c] of claims.entries()) {
      const where = i < (summary.paragraphs ?? []).length ? `paragraphs[${i}]` : `key_points[${i - (summary.paragraphs ?? []).length}]`;
      if (typeof c === 'string' || c === null || !['fact', 'inference', 'suggestion'].includes(c?.kind)) {
        check(false, `${where} 为合法三态对象（得到 ${JSON.stringify(c)?.slice(0, 40)}）`);
        continue;
      }
      if (c.kind === 'fact') {
        for (const err of factEvidenceErrors(c as { kind: string; text: string; source: number[] }, segments, where)) {
          check(false, err);
        }
      } else {
        for (const err of nonFactQuoteErrors(c as { kind: string; text: string }, transcript, where)) {
          check(false, err);
        }
      }
    }
    // 4) 高风险分析词不得混入 fact（与 daemon RISKY_RE 同源；引号内原话豁免）。
    for (const [i, c] of claims.entries()) {
      if (c?.kind !== 'fact') continue;
      check(!RISKY_RE.test(String(c.text ?? '').replace(ANY_QUOTE_RE, '')), `第 ${i + 1} 条 fact 无高风险分析词`);
    }
    // 5) annotations desc 全给
    const annoCount = manifest.ink?.annotations?.length ?? 0;
    check((labels.annotations ?? []).length >= annoCount && annoCount > 0, `annotations desc 全给（${(labels.annotations ?? []).length}/${annoCount}）`);
    // 6) data.json 面板
    for (const c of data.chars ?? []) {
      if (c.label) check(/^[\u4e00-\u9fff]$/.test(c.label), `data.chars[${c.idx}].label="${c.label}" 单汉字`);
    }
    check((data.annotations ?? []).every((a: any) => typeof a.grid_idx === 'number'), 'annotations.grid_idx 全存在（格级关联）');
    check((data.summary?.paragraphs ?? []).length >= 2, 'data.summary 已注入');
    // 7) desc 无视觉动作词（daemon 硬拦后的产物面复核；同源 VISUAL_RE。
    //    用 .match 而非 .test——g 旗标下 test 的 lastIndex 跨调用有状态）。
    for (const a of labels.annotations ?? []) {
      check(!String(a.desc ?? '').match(VISUAL_RE), `labels.annotations[${a.index}].desc 无视觉动作词`);
    }
    for (const c of claims) {
      check(!String(typeof c === 'string' ? c : c?.text ?? '').replace(ANY_QUOTE_RE, '').match(VISUAL_RE), 'summary 段落无未豁免视觉动作词');
    }
  }
}

// ---- 6. 产物保留 + 审计链接（不清场）----
authWs.close();
const resultRow = db
  .prepare('SELECT public_id FROM results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
  .get(created.id) as { public_id: string } | undefined;
console.log('\n=== 审计材料（保留，未清场）===');
console.log(`  用户: ${TEST_USER} / 密码: e2e-pass`);
console.log(`  任务: ${created.id}（终态 ${task?.status ?? 'TIMEOUT'}）`);
if (resultRow) console.log(`  结果页: ${webuiBase}/r/${resultRow.public_id}`);
console.log(`  产物目录: ${path.join(DATA_ROOT, 'users', TEST_USER)}`);

console.log(failures.length === 0 ? '\n[e2e] 全部断言通过 ✓' : `\n[e2e] 失败 ${failures.length} 项:\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
