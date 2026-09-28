/**
 * 真实端到端测试（Owner 2026-09-28 授权：复用 .env 与数据库、烧真实 LLM）：
 * 临时用户 → WS login → tasks.create（真实视频）→ 轮询终态 → 产物质量断言 → 清场。
 * 运行（mini 上）：cd ~/Documents/书法/shufa-server && node --experimental-strip-types 不行——用：
 *   cd daemon && npx tsx ../e2e-shufa.mts [视频路径] [daemon-url]
 * 断言门槛（f202ed82 复盘）：labels 非空 label 必须单汉字（挡「未点名格」类
 * 编造占位）；summary 引文逐字复核；annotations desc 全给；grid_idx 存在。
 */
import { readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { RPCLink } from '@orpc/client/websocket';
import { createORPCClient } from '@orpc/client';

const videoPath = process.argv[2] ?? '';
const daemonUrl = process.argv[3] ?? 'ws://127.0.0.1:8217';
const DATA_ROOT = process.env.E2E_DATA_ROOT ?? path.join(process.env.HOME!, 'Library/Application Support/zhumo');
if (!existsSync(videoPath)) {
  console.error('用法: npx tsx ../e2e-shufa.mts <视频绝对路径> [ws-url]');
  process.exit(2);
}

// ---- 1. 临时用户（走查账号用完即弃）----
const { hashPassword } = await import('../daemon/src/auth.js');
const { openDatabase } = await import('../daemon/src/db/database.js');
const { createUser } = await import('../daemon/src/db/store.js');
const db = openDatabase(DATA_ROOT);
const TEST_USER = `e2e-${Date.now().toString(36)}`;
createUser(db, { username: TEST_USER, passwordHash: hashPassword('e2e-pass'), role: 'user' });
console.log(`[e2e] 临时用户 ${TEST_USER} 已建`);

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

// ---- 5. 产物断言 ----
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
    const transcript = (manifest.transcribe?.segments ?? []).map((s: any) => s.text ?? '').join('');

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
    // 3) 引文逐字复核（与 daemon 同规：≥4 字「」去标点后子串命中）
    const norm = (t: string) => t.replace(/[\s，。、；：？！,.;:?!"'（）()「」『』…—·]/g, '');
    const quotes = [...(summary.paragraphs ?? []), ...(summary.key_points ?? [])].join('\n').match(/[「“『]([^」”』]{4,})[」”』]/g) ?? [];
    for (const q of quotes) {
      const inner = q.slice(1, -1);
      check(norm(transcript).includes(norm(inner)), `引文逐字见于转录：「${inner}」`);
    }
    // 4) annotations desc 全给
    const annoCount = manifest.ink?.annotations?.length ?? 0;
    check((labels.annotations ?? []).length >= annoCount && annoCount > 0, `annotations desc 全给（${(labels.annotations ?? []).length}/${annoCount}）`);
    // 5) data.json 面板
    for (const c of data.chars ?? []) {
      if (c.label) check(/^[\u4e00-\u9fff]$/.test(c.label), `data.chars[${c.idx}].label="${c.label}" 单汉字`);
    }
    check((data.annotations ?? []).every((a: any) => typeof a.grid_idx === 'number'), 'annotations.grid_idx 全存在（格级关联）');
    check((data.summary?.paragraphs ?? []).length >= 2, 'data.summary 已注入');
    // 6) desc 无视觉动作词（Codex 三审硬拦后的产物面复核）。
    const VISUAL = /(圈画|画了圈|划出|勾出|红笔|笔迹|示范)/;
    for (const a of labels.annotations ?? []) {
      check(!VISUAL.test(a.desc ?? ''), `labels.annotations[${a.index}].desc 无视觉动作词`);
    }
    for (const para of [...(summary.paragraphs ?? []), ...(summary.key_points ?? [])]) {
      const t = typeof para === 'string' ? para : para?.text ?? '';
      check(!VISUAL.test(t.replace(/[「“『]([^」”』]{4,})[」”』]/g, '')), 'summary 段落无未豁免视觉动作词');
    }
    // 7) 建议条已声明（无「练习建议：」开头纯字符串）。
    for (const [i, c] of [...(summary.paragraphs ?? []), ...(summary.key_points ?? [])].entries()) {
      if (typeof c === 'string') check(!/^(练习建议|练习路径|建议)[:：]/.test(c), `第 ${i + 1} 条非未声明建议`);
    }
  }
}

// ---- 6. 清场（临时用户 + 任务）----
authWs.close();
try {
  db.prepare('DELETE FROM resources WHERE owner_id = (SELECT id FROM users WHERE username = ?)').run(TEST_USER);
  db.prepare('DELETE FROM task_queue WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = (SELECT id FROM users WHERE username = ?))').run(TEST_USER);
  db.prepare('DELETE FROM results WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = (SELECT id FROM users WHERE username = ?))').run(TEST_USER);
  db.prepare('DELETE FROM tasks WHERE owner_id = (SELECT id FROM users WHERE username = ?)').run(TEST_USER);
  db.prepare('DELETE FROM users WHERE username = ?').run(TEST_USER);
  rmSync(path.join(DATA_ROOT, 'users', TEST_USER), { recursive: true, force: true });
  console.log(`\n[e2e] 清场完成（${TEST_USER} 用户/任务/数据已删）`);
} catch (e) {
  console.warn('[e2e] 清场失败（手动清理）:', e);
}

console.log(failures.length === 0 ? '\n[e2e] 全部断言通过 ✓' : `\n[e2e] 失败 ${failures.length} 项:\n- ${failures.join('\n- ')}`);
process.exit(failures.length === 0 ? 0 : 1);
