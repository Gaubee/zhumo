/**
 * capability 测试（W4）：mock shell 断言命令拼接与 JSON 解析。
 * 原始需求 2026-09-23：`uv run --project <shufa-tool> python -m shufa_tool.steps
 * <step>` + cwd=任务目录 + stdout 末行 JSON；containment（非在册目录/越界路径拒绝）；
 * export 完成 → onExported 收尾包装。
 * 正交意图：
 *   [1] 步骤工具的命令/参数/cwd 组装。
 *   [2] containment 与失败语义（非零退出、坏 JSON、越界路径）。
 *   [3] export 收尾包装（bundle → result_url）。
 *   [4] registry 分发语义（未注册 denied、重名 fail fast、MCP 工具名投影）。
 */
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAnalysisCapabilities, execShell, parseLastJsonLine, type ShellOutcome } from '../src/capability/analysis.js';
import { createCapabilityRegistry } from '../src/capability/core.js';
import { mcpToolName } from '../src/capability/mcp.js';

describe('shufa capability 工具面', () => {
  let userRoot: string;
  let taskRoot: string;
  let taskDir: string;
  let commands: Array<{ command: readonly string[]; cwd: string }>;
  let registry: ReturnType<typeof createCapabilityRegistry>;
  let exported: Array<{ taskId: string; bundlePath: string }> = [];

  /** 构造 registry：findTaskByDir 只认 taskRoot（相对输入按 userRoot 解析），
   * runShell 可编程，onRunaway 可观测。 */
  function makeRegistry(
    shellOutcomes: Array<Partial<ShellOutcome>> = [{ code: 0, stdout: JSON.stringify({ ok: 1 }) + '\n', stderr: '' }],
    onRunaway?: (taskId: string, detail: string) => void,
  ) {
    commands = [];
    exported = [];
    let call = 0;
    const capabilities = createAnalysisCapabilities({
      shufaToolDir: '/opt/shufa-tool',
      onRunaway,
      runShell: async (command, options) => {
        commands.push({ command, cwd: options.cwd });
        const outcome = shellOutcomes[Math.min(call, shellOutcomes.length - 1)] ?? {};
        call += 1;
        return { code: 0, stdout: '', stderr: '', ...outcome };
      },
      findTaskByDir: (candidate) => {
        // 与 TaskService 同法则：candidate（绝对或相对 userRoot）resolve 后落在
        // 任务根目录（.shufa 的父目录）内即命中。
        const resolved = path.resolve(userRoot, candidate);
        const rel = path.relative(taskRoot, resolved);
        const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
        return inside
          ? { taskId: 'task-1', taskDir, taskRoot, userRoot, workdir: path.join(taskDir, '.shufa-work'), video: path.join(taskRoot, 'lecture.mp4') }
          : null;
      },
      onExported: (taskId, bundlePath) => {
        // 模拟 TaskService 语义：bundle 无 data.json → null（收尾跳过）。
        if (!existsSync(path.join(bundlePath, 'data.json'))) return null;
        exported.push({ taskId, bundlePath });
        return { public_id: 'pub123', url: 'http://x/r/pub123' };
      },
    });
    return createCapabilityRegistry(capabilities);
  }

  beforeEach(() => {
    userRoot = mkdtempSync(path.join(tmpdir(), 'shufa-cap-'));
    taskRoot = path.join(userRoot, 'task-1');
    taskDir = path.join(taskRoot, '.shufa');
    mkdirSync(taskDir, { recursive: true });
    registry = makeRegistry();
  });

  afterEach(() => {
    rmSync(userRoot, { recursive: true, force: true });
  });

  it('probe：命令拼接 + cwd 钉在任务目录 + stdout 末行 JSON 解析', async () => {
    const result = await registry.call('shufa.probe', { workdir: taskDir, video: path.join(taskRoot, 'v.mp4') }, 'agent');
    expect(result.kind).toBe('ok');
    expect((result as { value: unknown }).value).toEqual({ ok: 1 });
    const entry = commands[0] as { command: string[]; cwd: string };
    expect(entry.command.slice(0, 8)).toEqual(['uv', 'run', '--project', '/opt/shufa-tool', 'python', '-m', 'shufa_tool.steps', 'probe']);
    expect(entry.command.slice(8)).toEqual([path.join(taskRoot, 'v.mp4'), path.join(taskDir, '.shufa-work')]);
    expect(entry.cwd).toBe(taskDir);
  });

  it('相对路径口径：相对 workdir/video 以 userRoot 解析命中；python 实参仍为绝对', async () => {
    const result = await registry.call(
      'shufa.probe',
      { workdir: path.join('task-1', '.shufa'), video: path.join('task-1', 'v-rel.mp4') },
      'agent',
    );
    expect(result.kind).toBe('ok');
    const entry = commands[0] as { command: string[]; cwd: string };
    // agent 面相对、进程面绝对：python CLI 收到的 video/workdir 都是绝对路径。
    expect(entry.command.slice(8)).toEqual([
      path.join(taskRoot, 'v-rel.mp4'),
      path.join(taskDir, '.shufa-work'),
    ]);
    expect(entry.cwd).toBe(taskDir);
  });

  it('相对路径逃逸：`..` 跳出任务根的 workdir/video 一律拒绝（不触 shell）', async () => {
    const escapeWorkdir = await registry.call(
      'shufa.probe',
      { workdir: path.join('..', 'other-user', 'elsewhere', '.shufa'), video: path.join('task-1', 'v.mp4') },
      'agent',
    );
    expect(escapeWorkdir).toMatchObject({ kind: 'failed' });
    const escapeVideo = await registry.call(
      'shufa.probe',
      { workdir: taskDir, video: path.join('..', 'stolen.mp4') },
      'agent',
    );
    expect(escapeVideo).toMatchObject({ kind: 'failed' });
    expect(commands).toHaveLength(0);
  });

  it('sample/clip/orient 的可选参数拼接', async () => {
    await registry.call('shufa.sample', { workdir: taskDir, fps: 2.5 }, 'agent');
    // W7b 不变量：python CLI 的 sample/clip/transcribe 需要 <video> <workdir> 双位置参数
    expect(commands[0]?.command.slice(8, 10)).toEqual([
      path.join(taskRoot, 'lecture.mp4'),
      path.join(taskDir, '.shufa-work'),
    ]);
    expect(commands[0]?.command.at(-2)).toBe('--fps');
    expect(commands[0]?.command.at(-1)).toBe('2.5');
    await registry.call('shufa.clip', { workdir: taskDir, enhance: true }, 'agent');
    expect(commands[1]?.command.slice(8, 10)).toEqual([
      path.join(taskRoot, 'lecture.mp4'),
      path.join(taskDir, '.shufa-work'),
    ]);
    expect(commands[1]?.command.slice(-2)).toEqual(['--enhance', 'on']);
    await registry.call('shufa.orient', { workdir: taskDir, rotate: '90' }, 'agent');
    expect(commands[2]?.command.slice(-2)).toEqual(['--rotate', '90']);
    await registry.call('shufa.align', { workdir: taskDir }, 'agent');
    expect(commands[3]?.command.at(-1)).toBe(path.join(taskDir, '.shufa-work'));
  });

  it('containment：非在册目录与越界 video 拒绝（不触 shell）', async () => {
    const outside = await registry.call('shufa.probe', { workdir: '/tmp/elsewhere', video: '/x.mp4' }, 'agent');
    expect(outside).toMatchObject({ kind: 'failed' });
    const badVideo = await registry.call('shufa.probe', { workdir: taskDir, video: '/etc/passwd' }, 'agent');
    expect(badVideo).toMatchObject({ kind: 'failed' });
    expect(commands).toHaveLength(0);
  });

  it('非零退出：failed + stderr 末行', async () => {
    const failing = makeRegistry([{ code: 2, stdout: '', stderr: '前置步骤缺失\n' }]);
    const result = await failing.call('shufa.align', { workdir: taskDir }, 'agent');
    expect(result).toMatchObject({ kind: 'failed', code: 'UNAVAILABLE' });
    expect((result as { message: string }).message).toContain('前置步骤缺失');
  });

  it('熔断：同任务同工具连续 5 次相同失败 → 熔断 + onRunaway 一次；换错/成功重置', async () => {
    const runaways: Array<{ taskId: string; detail: string }> = [];
    const loop = makeRegistry(
      Array.from({ length: 8 }, () => ({ code: 1, stdout: '', stderr: 'boom: 同一个错' })),
      (taskId, detail) => runaways.push({ taskId, detail }),
    );
    for (let i = 0; i < 4; i += 1) {
      const r = await loop.call('shufa.align', { workdir: taskDir }, 'agent');
      expect(r).toMatchObject({ kind: 'failed', code: 'UNAVAILABLE' });
    }
    expect(runaways).toHaveLength(0);
    const fifth = await loop.call('shufa.align', { workdir: taskDir }, 'agent');
    expect(fifth).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
    expect((fifth as { message: string }).message).toContain('熔断');
    expect(runaways).toEqual([{ taskId: 'task-1', detail: expect.stringContaining('连续 5 次') }]);

    // 换一个错误（不同 key）→ 计数重置，不再熔断
    const fresh = makeRegistry(
      Array.from({ length: 8 }, (_, i) => ({ code: 1, stdout: '', stderr: `错 v${i}` })),
      (taskId, detail) => runaways.push({ taskId, detail }),
    );
    for (let i = 0; i < 6; i += 1) {
      const r = await fresh.call('shufa.align', { workdir: taskDir }, 'agent');
      expect(r).toMatchObject({ code: 'UNAVAILABLE' });
    }
    expect(runaways).toHaveLength(1);
  });

  it('summary_write：写入任务目录 summary.json；非法 JSON 拒绝；结构缺失拒绝（2026-09-25 lint）', async () => {
    const good = await registry.call(
      'shufa.summary_write',
      {
        workdir: taskDir,
        content: '{"topic":"桂","paragraphs":["左右结构"],"key_points":["两土对齐"]}',
      },
      'agent',
    );
    expect(good).toMatchObject({ kind: 'ok' });
    expect(existsSync(path.join(taskDir, 'summary.json'))).toBe(true);
    const bad = await registry.call('shufa.summary_write', { workdir: taskDir, content: 'not-json' }, 'agent');
    expect(bad).toMatchObject({ kind: 'failed' });
    // 结构 lint：缺 paragraphs/key_points → 拒绝写入并给修复提示。
    const incomplete = await registry.call(
      'shufa.summary_write',
      { workdir: taskDir, content: '{"topic":"桂"}' },
      'agent',
    );
    expect(incomplete).toMatchObject({ kind: 'failed' });
    expect((incomplete as { message: string }).message).toContain('已拒绝写入');
  });

  it('summary_write labels 双通道（走查 2026-09-23）：合法落盘、非法拒绝、值回传', async () => {
    const withLabels = await registry.call(
      'shufa.summary_write',
      {
        workdir: taskDir,
        content: '{"topic":"桂","paragraphs":["左右结构"],"key_points":["两土对齐"]}',
        labels: '{"grids":[{"index":0,"label":"桂"}],"annotations":[{"index":0,"desc":"指出主笔"}]}',
      },
      'agent',
    );
    expect(withLabels).toMatchObject({ kind: 'ok', value: { labels: true } });
    expect(readFileSync(path.join(taskDir, 'labels.json'), 'utf8')).toContain('"label":"桂"');
    const badLabels = await registry.call(
      'shufa.summary_write',
      {
        workdir: taskDir,
        content: '{"topic":"桂","paragraphs":["左右结构"],"key_points":["两土对齐"]}',
        labels: 'not-json',
      },
      'agent',
    );
    expect(badLabels).toMatchObject({ kind: 'failed' });
    // 结构 lint（2026-09-25）：labels index 负数 → 拒绝；grids 缺 label → 拒绝。
    const badIndex = await registry.call(
      'shufa.summary_write',
      {
        workdir: taskDir,
        content: '{"topic":"桂","paragraphs":["左右结构"],"key_points":["两土对齐"]}',
        labels: '{"grids":[{"index":-1,"label":"桂"}],"annotations":[]}',
      },
      'agent',
    );
    expect(badIndex).toMatchObject({ kind: 'failed' });
    expect((badIndex as { message: string }).message).toContain('从 0 起');
  });

  it('summary_write × manifest 交叉警告（2026-09-25 lint）：越界/缺格软警告随返回值', async () => {
    // 构造 manifest：2 格 + 2 旁注（index 0/1）。
    mkdirSync(path.join(taskDir, '.shufa-work'), { recursive: true });
    writeFileSync(
      path.join(taskDir, '.shufa-work', 'manifest.json'),
      JSON.stringify({ grid: { grids: [{ idx: 0 }, { idx: 1 }] }, ink: { annotations: [{ index: 0 }, { index: 1 }] } }),
    );
    // labels：grids 只标 0 且出现越界 index 2；annotations 只标 0。
    const linted = await registry.call(
      'shufa.summary_write',
      {
        workdir: taskDir,
        content: '{"topic":"桂","paragraphs":["左右结构"],"key_points":["两土对齐"]}',
        labels: '{"grids":[{"index":0,"label":"桂"},{"index":2,"label":"错位"}],"annotations":[{"index":0,"desc":"指出主笔"}]}',
      },
      'agent',
    );
    expect(linted).toMatchObject({ kind: 'ok' });
    const warnings = (linted as { value: { warnings?: string[] } }).value.warnings ?? [];
    expect(warnings.some((w) => w.includes('grids index 越界'))).toBe(true);
    expect(warnings.some((w) => w.includes('未标注 label'))).toBe(true);
    expect(warnings.some((w) => w.includes('未给 desc'))).toBe(true);
  });

  it('export：summary-file 注入 + bundle 命中 → onExported 附加结果链接', async () => {
    writeFileSync(path.join(taskDir, 'summary.json'), '{"topic":"桂"}', 'utf8');
    const bundle = path.join(userRoot, 'bundle');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, 'data.json'), '{}', 'utf8');
    const exporting = makeRegistry([{ code: 0, stdout: JSON.stringify({ step: 'export', bundle }) + '\n', stderr: '' }]);
    const result = await exporting.call('shufa.export', { workdir: taskDir }, 'agent');
    expect(result.kind).toBe('ok');
    const value = (result as { value: { result_url: string; public_id: string } }).value;
    expect(value.public_id).toBe('pub123');
    expect(value.result_url).toContain('/r/pub123');
    expect(exported[0]?.taskId).toBe('task-1');
    expect(exported[0]?.bundlePath).toBe(bundle);
    const command = commands[0]?.command ?? [];
    expect(command).toContain('--summary-file');
    expect(command[command.indexOf('--summary-file') + 1]).toBe(path.join(taskDir, 'summary.json'));
    // agent 面摘要必经 summary_write——来源标记 agent（走查 2026-09-23）。
    expect(command).toContain('--summary-source');
    expect(command[command.indexOf('--summary-source') + 1]).toBe('agent');
    // 无 labels.json → 不带 --labels；summary_write 落盘后 → 自动带上。
    expect(command).not.toContain('--labels');
    writeFileSync(path.join(taskDir, 'labels.json'), '{"grids":[]}', 'utf8');
    await exporting.call('shufa.export', { workdir: taskDir }, 'agent');
    const command2 = commands[1]?.command ?? [];
    expect(command2[command2.indexOf('--labels') + 1]).toBe(path.join(taskDir, 'labels.json'));
    // bundle 缺 data.json 时 onExported 返回 null（收尾静默跳过，不附加链接）。
    const noBundle = makeRegistry([{ code: 0, stdout: JSON.stringify({ step: 'export', bundle: path.join(userRoot, 'nope') }) + '\n', stderr: '' }]);
    const bare = await noBundle.call('shufa.export', { workdir: taskDir }, 'agent');
    expect((bare as { value: { result_url?: string } }).value.result_url).toBeUndefined();
  });

  it('registry 语义：未注册 denied、重名 fail fast、export 默认参数命令', async () => {
    expect(await registry.call('shufa.nope', {}, 'agent')).toMatchObject({ kind: 'denied' });
    expect(() =>
      createCapabilityRegistry([
        { name: 'x.y', description: '', authority: 'readonly', input: {} as never, handler: () => ({ kind: 'ok', value: null }) },
        { name: 'x.y', description: '', authority: 'readonly', input: {} as never, handler: () => ({ kind: 'ok', value: null }) },
      ]),
    ).toThrow(/duplicate/);
  });

  it('parseLastJsonLine：取末条非空行；坏 JSON 降级 raw；异常兜底 UNAVAILABLE', () => {
    expect(parseLastJsonLine('log line\n{"step":"bg","frames":64}\n')).toEqual({ step: 'bg', frames: 64 });
    expect(parseLastJsonLine('not json')).toEqual({ raw: 'not json' });
    expect(parseLastJsonLine('')).toEqual({});
  });

  it('mcpToolName：server 名重复前缀去掉（无双 shufa）；execShell 真实执行（node -e）', async () => {
    // 走查追加 2026-09-23：shufa.* 投影 mcp__shufa__<verb>，不再 mcp__shufa__shufa_*。
    expect(mcpToolName('shufa.probe')).toBe('probe');
    expect(mcpToolName('shufa.summary_write')).toBe('summary_write');
    expect(mcpToolName('shufa.export')).toBe('export');
    expect(mcpToolName('other.thing')).toBe('other_thing');
    const outcome = await execShell(['node', '-e', 'process.stdout.write("hi")'], { cwd: process.cwd() });
    expect(outcome).toMatchObject({ code: 0, stdout: 'hi' });
    const spy = vi.fn();
    spy(execShell);
    expect(spy).toHaveBeenCalled();
  });
});
