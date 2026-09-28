/**
 * shufa 分析管线 → agent 工具面（PRODUCT_DESIGN.md §6；SKILL.md 步骤手册）。
 * 原始需求 2026-09-23（W4）：probe/sample/orient/align/bg/grid/ink/clip/transcribe
 * /export 暴露为 readonly 工具（shell → `uv run --project <shufa-tool> python
 * -m shufa_tool.steps <step>`）；summary_write 限定写任务目录内 summary.json；
 * export 完成后回调 onExported 建结果行 + 推 result 帧。summary 步骤不提供
 * 工具——由 agent 亲自撰写（Owner 产品决策，2026-09-23）。
 * 正交意图：
 *   [1] shell 执行面：命令拼接 + cwd=任务目录 + stdout 末行 JSON 解析。
 *   [2] 任务目录约束：所有工具的 workdir/video 必须落在已登记任务目录内
 *       （相对输入以绑定 userRoot 为基准解析——agent cwd=用户根目录）。
 *   [3] 能力清单：10 个工具定义（readonly）+ registry 组装。
 * 进程面边界（架构调整 2026-09-23）：agent 面的 workdir/video/labels/out_dir
 *   允许相对 cwd（用户根目录）路径；传给 shufa-tool python CLI 的实参一律由
 *   daemon resolve 成绝对路径——「agent 面相对、进程面绝对」。
 * 偏差说明：probe 的 video 也限制在任务目录内（上传→分析自有视频的产品语义，
 *   收窄优于 §6 的字面 readonly）。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TerminalAnalysisSummarySchema } from '@zhumo/contracts';
import { refreshWindowsPath } from '../win-path-refresh.js';
import type { CapabilityCallResult, CapabilityDefinition } from './core.js';

/** shell 执行结果（测试注入 mock 的封闭形状）。 */
export interface ShellOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (
  command: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
) => Promise<ShellOutcome>;

/** 默认 shell 执行面（execFile，不经 shell 解析，参数数组直传）。 */
export const execShell: ShellRunner = (command, options) =>
  new Promise((resolve, reject) => {
    execFile(command[0] ?? '', command.slice(1) as string[], options, (error, stdout, stderr) => {
      const code = error === null ? 0 : ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1);
      if (error !== null && typeof code !== 'number') {
        reject(error);
        return;
      }
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** 任务绑定（tasks 服务实现；capability 层只消费）。 */
export interface TaskLocation {
  taskId: string;
  /** 任务 .shufa 目录（shell 的 cwd；summary.json/frames 落点）。 */
  taskDir: string;
  /** 任务根目录（.shufa 的父目录；视频/路径 containment 边界）。 */
  taskRoot: string;
  /** 用户根目录（taskRoot 父目录；相对输入的解析基准，= agent 会话 cwd）。 */
  userRoot: string;
  /** 管线 WORKDIR 规范路径（绝对；各步骤共享，manifest.json 所在）。 */
  workdir: string;
  /** 任务内视频绝对路径（probe/sample/clip/transcribe 的 video 位置参数）。 */
  video: string;
}

export interface AnalysisCapabilityDeps {
  /** shufa-tool 仓库根（含 pyproject.toml；--project 指向它）。 */
  shufaToolDir: string;
  runShell?: ShellRunner;
  /**
   * 按路径定位在册任务；未登记返回 null。candidate 允许相对路径（相对注册时
   * 的 userRoot，即 agent cwd）——由实现方逐绑定 resolve 后 containment。
   */
  findTaskByDir(path: string): TaskLocation | null;
  /** export 成功后的产品侧收尾（建 results 行 + 推 result 帧）；返回 null = 收尾失败。 */
  onExported(taskId: string, bundlePath: string): { public_id: string; url: string } | null;
  /** 熔断回调：同一任务同一工具连续 N 次相同失败时触发（任务置 failed + 取消会话）。
   * 实证 2026-09-23 W7b：glm-4.7 在路径错误时循环重试 150+ 次/25 分钟烧 token。 */
  onRunaway?(taskId: string, detail: string): void;
}

/** 同一任务同一工具连续相同失败次数上限（超过即熔断）。 */
export const RUNAWAY_LIMIT = 5;

/** stdout 末行 JSON 解析（SKILL.md 约定：末行恒为一行 JSON）。 */
export function parseLastJsonLine(stdout: string): unknown {
  const lines = stdout.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { raw: line };
    }
  }
  return {};
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text) as unknown;
    return true;
  } catch {
    return false;
  }
}

function failed(message: string): CapabilityCallResult {
  return { kind: 'failed', code: 'INVALID_OPERATION', message };
}

/** 路径 containment：candidate 必须落在 root 内（relative 不以 '..' 开头且不为绝对）。 */
function contains(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 组装 shufa.* 能力清单。containment：workdir/video（相对输入按绑定 userRoot
 * 解析）必须落在某个在册任务根目录内；步骤的 WORKDIR 参数一律用绑定的规范
 * workdir（各步骤共享同一 manifest），shell cwd 钉在 .shufa 目录。
 */
export function createAnalysisCapabilities(deps: AnalysisCapabilityDeps): CapabilityDefinition[] {
  const runShell = deps.runShell ?? execShell;
  // 熔断计数：taskId → { key: 同错判定键, count: 连续次数 }；成功或换错即重置。
  const failureStreaks = new Map<string, { key: string; count: number }>();

  function noteFailure(context: TaskLocation, step: string, detail: string): CapabilityCallResult {
    const key = `${step}:${detail.slice(0, 200)}`;
    const streak = failureStreaks.get(context.taskId);
    const count = streak?.key === key ? streak.count + 1 : 1;
    failureStreaks.set(context.taskId, { key, count });
    if (count >= RUNAWAY_LIMIT) {
      const reason = `${step} 连续 ${count} 次相同失败（最后错误：${detail.slice(0, 120)}）`;
      deps.onRunaway?.(context.taskId, reason);
      return {
        kind: 'failed',
        code: 'INVALID_OPERATION',
        message: `熔断：${reason}。请停止重试，向用户报告失败原因。`,
      };
    }
    return { kind: 'failed', code: 'UNAVAILABLE', message: `${step} 失败：${detail.slice(0, 400)}` };
  }


  /**
   * 解析任务上下文（架构调整 2026-09-23 相对路径口径）：workdir 允许相对路径，
   * 由 findTaskByDir 逐绑定以 userRoot 为基准解析；video 以命中绑定的 userRoot
   * 解析后做 containment。进程面实参保持绝对（runStep 的位置参数全用 ctx 的
   * 规范绝对字段；input 里的原始路径只经 resolve(userRoot, ·) 落地）。
   */
  function resolveContext(input: {
    workdir: string;
    video?: string;
  }): TaskLocation | CapabilityCallResult {
    const location = deps.findTaskByDir(input.workdir);
    if (!location) {
      return failed(`workdir 不在任何在册任务目录内：${input.workdir}`);
    }
    if (input.video !== undefined && !contains(location.taskRoot, path.resolve(location.userRoot, input.video))) {
      return failed(`video 必须位于任务目录内：${input.video}`);
    }
    return location;
  }

  async function runStep(
    context: TaskLocation,
    step: string,
    args: readonly string[],
  ): Promise<CapabilityCallResult> {
    // --extra transcribe（W9 顺延 2026-09-27）：转录步骤的引擎依赖（mac=mlx /
    // win,linux=faster-whisper）随运行自愈——向导 python-env 未跑/未成时，
    // uv run 自动补装（uv run 只补缺不卸载，与 uv sync exact 语义不同）。
    // PYTHONUTF8：Windows 控制台 GBK 下统一 python 子进程输出为 UTF-8，
    // 与 daemon 解码一致（管线 stdout 末行 JSON 解析依赖此点）。
    // PATH 自愈（2026-09-25 实证补全）：daemon 从旧终端继承的 PATH 可能不含
    // winget 后装的 ffmpeg——refreshWindowsPath 重读注册表合并进 process.env，
    // 且必须发生在下方 env 展开之前，子进程才能拿到刷新后的快照。0afa879
    // 当时只接了向导嗅探（runShellCapture），agent 管线漏接导致 probe 的
    // ffprobe 裸抛 WinError 2。非 win32 no-op。
    await refreshWindowsPath();
    const command = [
      'uv',
      'run',
      '--project',
      deps.shufaToolDir,
      '--extra',
      'transcribe',
      'python',
      '-m',
      'shufa_tool.steps',
      step,
      ...args,
    ];
    const outcome = await runShell(command, {
      cwd: context.taskDir,
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    if (outcome.code !== 0) {
      const detail = outcome.stderr.trim().split('\n').at(-1) ?? `exit ${outcome.code}`;
      return noteFailure(context, step, detail);
    }
    failureStreaks.delete(context.taskId);
    return { kind: 'ok', value: parseLastJsonLine(outcome.stdout) };
  }

  const workdirField = { workdir: z.string().min(1).describe('任务 .shufa 工作目录（相对当前工作目录即用户根目录；也可绝对路径）') };

  const definitions: CapabilityDefinition[] = [
    {
      name: 'shufa.probe',
      description: '步骤1：ffprobe 元数据并初始化 WORKDIR（会重置 WORKDIR，等于重开一次分析）',
      authority: 'readonly',
      input: z.object({ ...workdirField, video: z.string().min(1).describe('讲评视频路径（任务目录内；相对当前工作目录或绝对路径）') }),
      handler: (raw) => {
        const input = z.object({ workdir: z.string(), video: z.string() }).safeParse(raw);
        if (!input.success) return failed('参数不合法');
        const ctx = resolveContext(input.data);
        if ('kind' in ctx) return ctx;
        // python CLI 进程面恒为绝对路径（agent 面相对、进程面绝对）。
        return runStep(ctx, 'probe', [path.resolve(ctx.userRoot, input.data.video), ctx.workdir]);
      },
    },
    {
      name: 'shufa.sample',
      description: '步骤2：均匀抽帧（frames/f_*.jpg）',
      authority: 'readonly',
      input: z.object({ ...workdirField, fps: z.number().positive().optional() }),
      handler: (raw) => {
        const input = z.object({ workdir: z.string(), fps: z.number().optional() }).safeParse(raw);
        if (!input.success) return failed('参数不合法');
        const ctx = resolveContext(input.data);
        if ('kind' in ctx) return ctx;
        return runStep(ctx, 'sample', [
          ctx.video,
          ctx.workdir,
          ...(input.data.fps !== undefined ? ['--fps', String(input.data.fps)] : []),
        ]);
      },
    },
    {
      name: 'shufa.orient',
      description: '步骤3：内容投影转正（90° 步进；可 --rotate 手动指定）',
      authority: 'readonly',
      input: z.object({ ...workdirField, rotate: z.enum(['auto', '90', '180', '270']).optional() }),
      handler: (raw) => {
        const input = z
          .object({ workdir: z.string(), rotate: z.enum(['auto', '90', '180', '270']).optional() })
          .safeParse(raw);
        if (!input.success) return failed('参数不合法');
        const ctx = resolveContext(input.data);
        if ('kind' in ctx) return ctx;
        return runStep(ctx, 'orient', [
          ctx.workdir,
          ...(input.data.rotate !== undefined ? ['--rotate', input.data.rotate] : []),
        ]);
      },
    },
    ...(['align', 'bg', 'grid', 'ink'] as const).map((step): CapabilityDefinition => ({
      name: `shufa.${step}`,
      description: {
        align: '步骤4：相位相关逐帧对齐',
        bg: '步骤5：无笔迹页面背景（page_bg.png）',
        grid: '步骤6：田字格检测 + 180° 裁决 + 角点精化（debug_grids.png）',
        ink: '步骤7：旁注墨迹簇 + 出现时间线 + 焦点格',
      }[step],
      authority: 'readonly',
      input: z.object(workdirField),
      handler: (raw) => {
        const input = z.object(workdirField).safeParse(raw);
        if (!input.success) return failed('参数不合法');
        const ctx = resolveContext(input.data);
        if ('kind' in ctx) return ctx;
        return runStep(ctx, step, [ctx.workdir]);
      },
    })),
    {
      name: 'shufa.transcribe',
      description: '步骤9：mlx-whisper 转录（无音轨/无环境时自动跳过不阻塞）',
      authority: 'readonly',
      input: z.object(workdirField),
      handler: (raw) => {
        const input = z.object(workdirField).safeParse(raw);
        if (!input.success) return failed('参数不合法');
        const ctx = resolveContext(input.data);
        if ('kind' in ctx) return ctx;
        return runStep(ctx, 'transcribe', [ctx.video, ctx.workdir]);
      },
    },
    {
      name: 'shufa.clip',
      description: '步骤8：格字/旁注/焦点裁剪增强 + 焦点回放剪辑（crops/*、focus_clip.mp4）',
      authority: 'readonly',
      input: z.object({ ...workdirField, enhance: z.boolean().optional() }),
      handler: (raw) => {
        const input = z.object({ workdir: z.string(), enhance: z.boolean().optional() }).safeParse(raw);
        if (!input.success) return failed('参数不合法');
        const ctx = resolveContext(input.data);
        if ('kind' in ctx) return ctx;
        return runStep(ctx, 'clip', [
          ctx.video,
          ctx.workdir,
          ...(input.data.enhance === true ? ['--enhance', 'on'] : []),
        ]);
      },
    },
    {
      name: 'shufa.summary_write',
      description:
        '把你亲自撰写的讲评摘要写入任务目录 summary.json（topic/paragraphs/key_points）。'
        + 'paragraphs/key_points 元素一律为对象：{"kind":"fact","text":…,"source":[转录段下标]}（老师说过的话，引文逐字出自所引段）、'
        + '{"kind":"inference","text":…}（你的分析判断）、{"kind":"suggestion","text":…}（练习建议）；纯字符串会被拒绝。'
        + '存在旁注/田字格时必须同时给 labels（语义标注：旁注描述、生字格标签），否则结果页语义层为空',
      authority: 'readonly',
      input: z.object({
        ...workdirField,
        content: z.string().min(1).describe('summary.json 完整内容（JSON 文本）'),
        labels: z.string().optional().describe(
          'labels.json 完整内容（JSON 文本，可选但强烈建议）：'
          + '{"grids":[{"index":0,"label":"<生字>"}],"annotations":[{"index":0,"desc":"指出的问题（仅转录能支撑的内容）"}]}——'
          + 'index 对应检测顺序；label 只标转录明确点到的字，未点名的格留空串或省略',
        ),
      }),
      handler: (raw) => {
        const input = z
          .object({ workdir: z.string(), content: z.string(), labels: z.string().optional() })
          .safeParse(raw);
        if (!input.success) return failed('参数不合法');
        const ctx = resolveContext(input.data);
        if ('kind' in ctx) return ctx;
        if (!isJsonText(input.data.content)) return failed('content 不是合法 JSON 文本');
        if (input.data.labels !== undefined && !isJsonText(input.data.labels)) {
          return failed('labels 不是合法 JSON 文本');
        }
        // 结构 lint（Owner 裁决 2026-09-25：不能只靠 skill 遵守——服务端 zod
        // 校验 + manifest 交叉核对，警告随返回值给 agent 修复重写）。
        const summaryCheck = SummaryContentSchema.safeParse(JSON.parse(input.data.content));
        if (!summaryCheck.success) {
          return failed(
            `summary 结构不合法（已拒绝写入，请修复后重写）：${summaryCheck.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('；')}`,
          );
        }
        let labelsParsed: unknown;
        if (input.data.labels !== undefined) {
          const labelsCheck = LabelsContentSchema.safeParse(JSON.parse(input.data.labels));
          if (!labelsCheck.success) {
            return failed(
              `labels 结构不合法（已拒绝写入，请修复后重写；约定 grids[].index/annotations[].index 从 0 起、对应检测顺序）：${labelsCheck.error.issues
                .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
                .join('；')}`,
            );
          }
          labelsParsed = labelsCheck.data;
        }
        // 语义 lint（Owner 2026-09-28：引文忠实/时间在界/旁注时间一致——
        // 硬校验，错误即拒绝写入，agent 修复后重写）。
        const semanticErrors = lintContentSemantics(ctx.taskDir, summaryCheck.data, labelsParsed);
        if (semanticErrors.length > 0) {
          return failed(
            `summary/labels 语义校验未通过（已拒绝写入，请修复后重写）：${semanticErrors.join('；')}`,
          );
        }
        const warnings = lintLabelsAgainstManifest(ctx.taskDir, labelsParsed);
        const target = path.join(ctx.taskDir, 'summary.json');
        try {
          mkdirSync(ctx.taskDir, { recursive: true });
          writeFileSync(target, input.data.content, { encoding: 'utf8', mode: 0o600 });
          // labels 与摘要一并落盘（走查 2026-09-23：agent 之前没有任何工具能写
          // labels.json，旁注 desc/生字 label/关联全部静默为空）。
          if (input.data.labels !== undefined && labelsParsed !== undefined) {
            writeFileSync(
              path.join(ctx.taskDir, 'labels.json'),
              input.data.labels,
              { encoding: 'utf8', mode: 0o600 },
            );
          }
        } catch (error) {
          return {
            kind: 'failed',
            code: 'UNAVAILABLE',
            message: `summary.json 写入失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
        return {
          kind: 'ok',
          value: {
            written: target,
            labels: input.data.labels !== undefined,
            ...(warnings.length > 0
              ? {
                  warnings,
                  warnings_note:
                    '以上警告可修复后重新调用 summary_write 覆盖写入（summary/labels 结构已通过基本校验）',
                }
              : {}),
          },
        };
      },
    },
    {
      name: 'shufa.export',
      description:
        '步骤10：导出分析包（bundle/）。完成后自动生成公开结果链接（result 帧推送），把链接转告用户',
      authority: 'readonly',
      input: z.object({
        ...workdirField,
        labels: z.string().optional().describe('labels.json 路径（可选，任务目录内）'),
        out_dir: z.string().optional().describe('输出目录（可选；缺省 WORKDIR/bundle）'),
      }),
      handler: (raw) => {
        const input = z
          .object({ workdir: z.string(), labels: z.string().optional(), out_dir: z.string().optional() })
          .safeParse(raw);
        if (!input.success) return failed('参数不合法');
        const ctx = resolveContext(input.data);
        if ('kind' in ctx) return ctx;
        const summaryFile = path.join(ctx.taskDir, 'summary.json');
        const args = [ctx.workdir, '--summary-file', summaryFile];
        // labels 双通道：summary_write 落盘的 labels.json 自动带上（主通道，
        // 走查 2026-09-23）；显式 labels 参数保持兼容（任务目录内）。
        const autoLabels = path.join(ctx.taskDir, 'labels.json');
        if (input.data.labels !== undefined && !contains(ctx.taskRoot, path.resolve(ctx.userRoot, input.data.labels))) {
          return failed(`labels 必须位于任务目录内：${input.data.labels}`);
        }
        if (input.data.labels !== undefined) {
          args.push('--labels', path.resolve(ctx.userRoot, input.data.labels));
        } else if (existsSync(autoLabels)) {
          args.push('--labels', autoLabels);
        }
        // agent 面的摘要必经 summary_write 亲写——来源标记 agent（区别于 CLI 人工注入）。
        args.push('--summary-source', 'agent');
        if (input.data.out_dir !== undefined) args.push('--out-dir', path.resolve(ctx.userRoot, input.data.out_dir));
        return runStep(ctx, 'export', args);
      },
    },
  ];
  return definitions.map((definition) => wrapExportCompletion(definition, deps));
}

/**
 * 给 export 能力包装「bundle 检测 → onExported」收尾（保持 definitions 纯净的
 * 装配位）：解析 stdout 末行 JSON 的 bundle 字段，存在即回调并附加结果链接。
 */
export function wrapExportCompletion(
  definition: CapabilityDefinition,
  deps: AnalysisCapabilityDeps,
): CapabilityDefinition {
  if (definition.name !== 'shufa.export') return definition;
  const inner = definition.handler;
  return {
    ...definition,
    handler: async (raw, principal) => {
      const result = await inner(raw, principal);
      if (result.kind !== 'ok') return result;
      const value = result.value as { bundle?: unknown };
      const workdir = (raw as { workdir?: string } | null)?.workdir;
      // workdir 原样回传（相对路径由 findTaskByDir 按 userRoot 解析，勿在此
      // path.resolve——那会锚到 daemon 进程 cwd 而非用户根目录）。
      const location = workdir ? deps.findTaskByDir(workdir) : null;
      if (location === null || typeof value.bundle !== 'string') return result;
      // 终态门禁（Codex 五审 P1-1 / 六审 P1 fail-closed：CLI/手工注入的
      // summary 不经 summary_write 的 zod 硬校验——产品入口在建 results 行
      // 前对 bundle 内 summary 复核终态契约。data.json 缺失/损坏/非法一律
      // 拒绝导出，不得进入 onExported——fail-open 会给坏 bundle 建结果行）。
      try {
        const bundleData = JSON.parse(
          readFileSync(path.join(value.bundle, 'data.json'), 'utf8'),
        ) as { summary?: unknown };
        const terminal = TerminalAnalysisSummarySchema.safeParse(bundleData.summary);
        if (!terminal.success) {
          return failed(
            `bundle summary 未达终态契约（paragraphs/key_points 须全为 {kind,text[,source]} 对象；fact 必带非空 source）：${terminal.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('；')}`,
          );
        }
      } catch (error) {
        return failed(
          `bundle data.json 不可读或非法（拒绝导出）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const exported = deps.onExported(location.taskId, value.bundle);
      return exported === null
        ? result
        : {
            kind: 'ok',
            value: { ...value, result_url: exported.url, public_id: exported.public_id },
          };
    },
  };
}

// ------------------------------------------------ 共享校验表（daemon lint 与
// e2e 产物断言同一来源——Codex 五审 P2：两份复制表会漂移成网内自洽假阳性）。

/** 视觉动作黑名单（agent 看不到画面；引号内转录原话豁免）。 */
export const VISUAL_RE = /(圈画|画了圈|圈出|圈点|划出|勾出|红笔|笔迹|示范|归位纠正)/g;
/** fact 兜底风险词表（终态主门是 source+锚点；此表拦已知的无源分析词形。
 * AFk7oLRzFQlm 实证漏项已补：圈出/圈点/先肯定/搭对/同一条竖线/迎让/归位）。 */
export const RISKY_RE = /(中轴|垂直线|竖直线|同一条竖线|重心|最关键|最容易|正对|正下方|匀称|比例|部件错位|对位标准|动手纠正|未对齐|逐字精讲|圈出|圈点|先肯定|以鼓励|搭对了|迎让|归位)/;
/** ≥4 字配对引文（硬校验域；短引文同音变体易误伤，不做逐字硬核）。 */
export const QUOTE_RE = /「([^」]{4,})」|“([^”]{4,})”|『([^』]{4,})』/g;
/** 任意长度配对引号（捕获组给逐字核验用——六审 P1：短引号如「桂」也是
 * 原话声明，不核会留下「引号里的字不在所引段」的夹带面）。 */
export const ANY_QUOTE_CAPTURE_RE = /「([^」]+)」|“([^”]+)”|『([^』]+)』/g;
/** 任意长度引号整段剥除（词表豁免域——「重心」这类短引号也是原话，五审 P2 误伤修复）。 */
export const ANY_QUOTE_RE = /「[^」]*」|“[^”]*”|『[^』]*』/g;
/** 归一化：去空白与标点（引文/锚点比对共用）。 */
export function normalizeClaimText(t: string): string {
  return t.replace(/[\s，。、；：？！,.;:?!"'（）()「」『』…—·]/g, '');
}
export function quoteOf(m: RegExpMatchArray): string {
  return m[1] ?? m[2] ?? m[3] ?? '';
}

/**
 * fact 证据核验（终态唯一事实门，六审并档）：
 * 1. source 界内（引用不存在的转录段 → 拒）；
 * 2. 引文逐字：text 里**任意长度**的配对引号（「」“”『』），其内容
 *    （归一化后）必须逐字出现在 source 所指段的拼接里——短引号也是
 *    原话声明（run13 反例：「桂」是左右结构…source=[2,3] 而那两段没有
 *    「桂」字，六审 P1）；
 * 3. 溯源锚点：每个句子（归一化后 ≥4 字）须含一段 ≥4 字连续原文，且
 *    锚点**不跨段**（逐段核——段边界拼接会造出伪锚点，六审风险点）。
 * 判据经 run12/run13 真实产物校准。返回错误列表（空=通过）。
 */
export function factEvidenceErrors(
  claim: { kind: string; text: string; source: number[] },
  segments: string[],
  where: string,
): string[] {
  if (claim.kind !== 'fact') return [];
  const errors: string[] = [];
  const bad = claim.source.filter((idx) => idx >= segments.length || idx < 0);
  if (bad.length > 0) {
    errors.push(`${where} 引用了不存在的转录段（${bad.join(',')}；共 ${segments.length} 段）`);
    return errors;
  }
  const segNorms = claim.source.map((idx) => normalizeClaimText(segments[idx] ?? ''));
  // source 有序性（七审 P2：乱序/重复拼接可造出不存在的短语）。
  for (let i = 1; i < claim.source.length; i += 1) {
    if (claim.source[i]! <= claim.source[i - 1]!) {
      errors.push(`${where} 的 source 必须是严格递增的去重下标序列`);
      return errors;
    }
  }
  // 连续 run 拼接（八审 P1：非连续 source 直接拼接可拼造跨 gap 伪引文——
  // 反例 segments=[老师说上下|中间讲别的|要对齐]、source=[0,2]、引文
  // 「上下要对齐」。引文只能命中**连续段**的拼接，一段原话不会被中间
  // 插入的别的内容隔开）。
  const runs: string[] = [];
  let current = segNorms[0] ?? '';
  for (let i = 1; i < claim.source.length; i += 1) {
    if (claim.source[i]! === claim.source[i - 1]! + 1) {
      current += segNorms[i]!;
    } else {
      runs.push(current);
      current = segNorms[i]!;
    }
  }
  runs.push(current);
  // 2) 引文逐字（任意长度；对某条连续 run 核——老师的句子可能被相邻分段
  // 切开，但不能跨 gap）。
  for (const m of claim.text.matchAll(ANY_QUOTE_CAPTURE_RE)) {
    const q = quoteOf(m);
    if (!runs.some((run) => run.includes(normalizeClaimText(q)))) {
      errors.push(`${where} 引文「${q}」未见于其声明的来源段（fact 只能引 source 所指连续段的原话）`);
    }
  }
  // 3) 子句锚点（八审 P1：只按句号切句挡不住「真话，夹带。」——逗号/
  //    顿号/冒号/破折号从句各自须有锚点；≥4 字含 ≥4 字连续原文且不跨段，
  //    <4 字须整句出现在所引某段。以冒号结尾的前导子句是中文标签惯例
  //    （「讲解对象：…」），标签不是陈述，豁免锚点）。
  const clauses = claim.text
    .split(/(?<=[。；！？\n，、：])|(?<=——)/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  for (const clause of clauses) {
    if (clause.endsWith('：') || clause.endsWith(':')) continue; // 前导标签
    // 引文内容已对 source 连续 run 逐字核过（自证）。锚点只核**非引文
    // 散文**：含已核引文的子句，其 ≤6 字散文视为引导/连接语（「老师强调」
    // 「并再次重复」类）豁免；>6 字仍须锚点（防借引文夹带长编造）。
    const prose = clause.replace(ANY_QUOTE_RE, '');
    const hasVerifiedQuote = prose !== clause;
    const ns = normalizeClaimText(prose);
    if (ns.length === 0) continue;
    if (hasVerifiedQuote && ns.length <= 6) continue;
    if (ns.length < 4) {
      if (!segNorms.some((seg) => seg.includes(ns))) {
        errors.push(`${where} 的子句无原文支撑：「${clause}」（短子句须整句出现在所引某段中）`);
      }
      continue;
    }
    let anchored = false;
    for (const seg of segNorms) {
      for (let k = 0; k + 4 <= ns.length && !anchored; k += 1) {
        if (seg.includes(ns.slice(k, k + 4))) anchored = true;
      }
      if (anchored) break;
    }
    if (!anchored) {
      errors.push(
        `${where} 的子句无原文锚点：「${clause}」——每个子句须含所引段 ≥4 字连续原话；夹带内容改 {"kind":"inference"} 或删除`,
      );
    }
  }
  return errors;
}

/**
 * 非 fact claim（inference/suggestion）的引文核验（七审 P1：1 字引号同样
 * 是原话声明，「老师说「丙」」在全文无「丙」时是伪造——任意长度、对转录
 * 全文逐字）。daemon lint 与 e2e 共用。
 */
export function nonFactQuoteErrors(
  claim: { kind: string; text: string },
  transcriptText: string,
  where: string,
): string[] {
  if (claim.kind === 'fact') return [];
  const haystack = normalizeClaimText(transcriptText);
  const errors: string[] = [];
  for (const m of claim.text.matchAll(ANY_QUOTE_CAPTURE_RE)) {
    const q = quoteOf(m);
    if (!haystack.includes(normalizeClaimText(q))) {
      errors.push(`${where} 引文「${q}」未见于转录（分析/建议段引老师原话同样要忠实）`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------- summary/labels 结构 lint

/**
 * summary/labels × manifest 语义 lint（Owner 要求 2026-09-28 复盘 CCxdbVrruwNO：
 * 「写入结构化数据时自动校验」此前只有结构 zod + index/缺标软警告——引文与
 * 时间戳无人核对，转述错误原样落盘）：
 * - 引文忠实：paragraphs/key_points 中 ≥4 字的「」引文（去空白标点后）必须
 *   逐字存在于转录原文——手册本就要求「引用要忠实」，写入面硬校验；
 * - 时间在界：summary 全文与 labels desc 的 t≈Xs 不得超出视频时长；
 * - 旁注时间一致：labels.annotations[].desc 的 t≈ 与 manifest 该旁注
 *   first_ts 偏差 ≤3s（页面时间线按它跳转，错值误导复盘）。
 * 返回错误列表（非空=拒绝写入，agent 修复后重写）；manifest 缺席跳过。
 */
function lintContentSemantics(
  taskDir: string,
  summary: { topic: string; paragraphs: SummaryClaim[]; key_points: SummaryClaim[] },
  labels: unknown,
): string[] {
  const errors: string[] = [];
  let manifest: {
    probe?: { duration_s?: number };
    transcribe?: { segments?: Array<{ text?: string }> };
    ink?: { annotations?: Array<{ first_ts?: number }> };
  } | null = null;
  try {
    manifest = JSON.parse(readFileSync(path.join(taskDir, '.shufa-work', 'manifest.json'), 'utf8'));
  } catch {
    // manifest 缺失 = 管线步骤未跑完（Codex 评审 2026-09-28：跳过会让硬校验
    // 整体可绕过——summary 必须在 transcribe 完成后写入）。
    return ['管线 manifest 不存在（probe/transcribe 未完成）——请先跑完前置步骤再写 summary'];
  }
  const transcriptText = (manifest?.transcribe?.segments ?? [])
    .map((s) => String(s.text ?? ''))
    .join('');
  const duration = manifest?.probe?.duration_s ?? 0;

  const claims = [...summary.paragraphs, ...summary.key_points];
  const texts = claims.map(claimText);
  const segments = manifest?.transcribe?.segments ?? [];

  // 0) fact 证据核验（终态唯一事实门，六审并档）：source 界内 + 任意长度
  // 引文逐字（只对所引段）+ 逐句 ≥4 字原文锚点（不跨段）。
  const segmentTexts = segments.map((s) => String(s.text ?? ''));
  claims.forEach((claim, i) => {
    errors.push(
      ...factEvidenceErrors(claim as { kind: string; text: string; source: number[] }, segmentTexts, `第 ${i + 1} 条 fact`),
    );
  });

  // 1) 引文忠实：inference/suggestion 的**任意长度**引文对转录全文核
  // （七审 P1：1 字引号也是原话声明；fact 的引文已由 0) 分域核过。
  // 空转录＝无证据：带引号即拒——与 python validator 同规）。
  const strippedQuotes = (t: string): string => t.replace(ANY_QUOTE_RE, '');
  claims.forEach((claim, i) => {
    if (claim.kind === 'fact') return;
    errors.push(...nonFactQuoteErrors(claim as { kind: string; text: string }, transcriptText, `第 ${i + 1} 条`));
  });

  // 2) 视觉动词黑名单（Codex 三审 P1：agent 看不到画面，任何视觉动作断言
  // 都是编造——run5 三条 desc 全写「圈画」实证）。豁免域=任意长度引号
  // （五审 P2：「重心」等短引号也是原话，≥4 字豁免会误伤）。
  const visualRe = VISUAL_RE;
  const checkVisual = (text: string, where: string) => {
    for (const m of strippedQuotes(text).matchAll(visualRe)) {
      errors.push(`${where}：视觉动作「${m[1]}」无证据——你看不到画面，删除或改为转录原话引用`);
    }
  };
  texts.forEach((t, i) => checkVisual(t, `summary 第 ${i + 1} 条`));

  // 3) 时间全遍历（topic/段落/要点/labels desc；秒字变体；负数显式拒绝；
  // 三审补充：裸「15s/28.5秒」列表形态也核——凡 数字+s/秒 一律对时长）。
  const timeRe = /(\d+(?:\.\d+)?)\s*(?:s|秒)/g;
  const negTimeRe = /(?<!\d)-(\d+(?:\.\d+)?)\s*(?:s|秒)/; // 前邻数字=范围写法（5.4-11.2s）不算负数
  const checkTime = (text: string, where: string) => {
    if (duration <= 0) return;
    if (negTimeRe.test(text)) {
      errors.push(`${where}：出现负数时间戳`);
      return;
    }
    for (const m of text.matchAll(timeRe)) {
      if (Number(m[1]) > duration + 0.5) {
        errors.push(`${where}：t≈${m[1]}s 超出视频时长 ${duration.toFixed(1)}s`);
      }
    }
  };
  checkTime(`${summary.topic}\n${texts.join('\n')}`, 'summary');

  // 4) labels：desc 时间/视觉动词 + 旁注 ±3s + label 字级证据（非空 label
  // 必须在转录中出现过——多字视频无证据标注在此拦截）。
  const annos = manifest?.ink?.annotations ?? [];
  const labelsObj = labels as { annotations?: unknown; grids?: unknown } | undefined;
  if (Array.isArray(labelsObj?.annotations)) {
    (labelsObj!.annotations as Array<{ index?: unknown; desc?: unknown }>).forEach((item, i) => {
      if (typeof item.index !== 'number' || typeof item.desc !== 'string') return;
      checkVisual(item.desc, `labels.annotations[${i}].desc`);
      checkTime(item.desc, `labels.annotations[${item.index}].desc`);
      if (annos.length === 0) return;
      const real = annos[item.index]?.first_ts;
      if (real === undefined) return;
      for (const m of item.desc.matchAll(timeRe)) {
        if (Math.abs(Number(m[1]) - real) > 3) {
          errors.push(
            `labels.annotations[${item.index}].desc：t≈${m[1]}s 与旁注实际时间 ${real}s 偏差超 3s（以 manifest first_ts 为准）`,
          );
        }
      }
    });
  }
  if (transcriptText && Array.isArray(labelsObj?.grids)) {
    (labelsObj!.grids as Array<{ index?: unknown; label?: unknown }>).forEach((g, i) => {
      if (typeof g.label !== 'string' || g.label === '') return;
      if (!transcriptText.includes(g.label)) {
        errors.push(
          `labels.grids[${i}].label「${g.label}」未在转录中出现——无逐格证据的字不标（留空）`,
        );
      }
    });
  }

  // 5) fact 兜底词表（终态主门=source+锚点；此表只拦已知的无源分析词形，
  //    引号内原话豁免——豁免域为任意长度引号）。
  const riskyRe = RISKY_RE;
  claims.forEach((claim, i) => {
    if (claim.kind !== 'fact') return;
    const hit = riskyRe.exec(strippedQuotes(claim.text));
    if (hit) {
      errors.push(
        `第 ${i + 1} 条 fact 含分析判断「${hit[1]}」——老师没说过的判断须改为 {"kind":"inference"} 或删除`,
      );
    }
  });

  return errors;
}

/**
 * summary 段落元素（2026-09-28 终态：AFk7oLRzFQlm 词表漏检实证——黑名单
 * 追不上措辞变体，改为证据强制）：fact 必须引转录 segment（source 索引
 * 数组，机器核存在性）；推断/建议自认 kind。纯 string 不再允许——每条
 * 陈述被迫显式归类（无源内容进不了 fact）。
 */
const SummaryClaimSchema = z.union([
  z.object({
    kind: z.literal('fact'),
    text: z.string().min(1),
    source: z.array(z.number().int().min(0)).min(1),
  }),
  z.object({
    kind: z.enum(['inference', 'suggestion']),
    text: z.string().min(1),
  }),
]);
type SummaryClaim = z.infer<typeof SummaryClaimSchema>;

/** summary.json 内容结构（结果页静态总结消费面）。 */
const SummaryContentSchema = z.object({
  topic: z.string().min(1, 'topic 不能为空'),
  paragraphs: z.array(SummaryClaimSchema).min(1, 'paragraphs 至少一段'),
  key_points: z.array(SummaryClaimSchema).min(1, 'key_points 至少一条'),
});

/** 段落纯文本（lint 与渲染面统一取 text）。 */
function claimText(claim: SummaryClaim): string {
  return claim.text;
}

/** labels.json 内容结构（语义层：grids[].label 生字 / annotations[].desc 旁注）。 */
const LabelsContentSchema = z.object({
  grids: z
    .array(
      z.object({
        index: z.number().int().min(0, 'index 从 0 起'),
        // 空串 = 转录未点名的格（f202ed82 实证：min(1) + 缺格警告会诱导
        // agent 编造「未点名格」类占位标签骗过校验——留空必须是一等公民）。
        label: z.string(),
        note: z.string().optional(),
      }),
    )
    .min(1, 'grids 至少一条（检测出田字格时）'),
  annotations: z
    .array(
      z.object({
        index: z.number().int().min(0, 'index 从 0 起'),
        desc: z.string().min(1, 'desc 不能为空'),
      }),
    )
    .default([]),
});

/**
 * labels × manifest 交叉核对（软警告，不阻断写入）：
 * - index 越界（≥ 检测出的 grids/annotations 数）——结果页关联会落空；
 * - 检测出的格未全部标注 label——转录↔生字关联缺格；
 * - manifest 缺席（早期步骤未跑）跳过交叉核对。
 */
function lintLabelsAgainstManifest(taskDir: string, labels: unknown): string[] {
  if (labels === undefined || labels === null) return [];
  const { grids, annotations } = labels as { grids: Array<{ index: number }>; annotations: Array<{ index: number }> };
  const warnings: string[] = [];
  let manifest: { grid?: { grids?: unknown[] }; ink?: { annotations?: unknown[] } } | null = null;
  try {
    // manifest 与 summary.json 同任务目录（taskDir/.shufa-work/）。
    manifest = JSON.parse(readFileSync(path.join(taskDir, '.shufa-work', 'manifest.json'), 'utf8'));
  } catch {
    return warnings; // manifest 未生成：跳过交叉核对（结构校验已过）
  }
  const gridCount = manifest?.grid?.grids?.length ?? 0;
  const annoCount = manifest?.ink?.annotations?.length ?? 0;
  if (gridCount > 0) {
    const outOfRange = grids.filter((g) => g.index >= gridCount);
    if (outOfRange.length > 0) {
      warnings.push(
        `labels.grids index 越界：${outOfRange.map((g) => g.index).join(',')} ≥ 检测格数 ${gridCount}（index 从 0 起、对应检测顺序）`,
      );
    }
    // 「缺格未标」不再警告（f202ed82 实证：转录没点名的格留空是手册要求的
    // 正确行为，警告会把 agent 推向编造占位标签「未点名格」骗过校验）。
  }
  if (annoCount > 0) {
    const outOfRange = annotations.filter((a) => a.index >= annoCount);
    if (outOfRange.length > 0) {
      warnings.push(
        `labels.annotations index 越界：${outOfRange.map((a) => a.index).join(',')} ≥ 检测旁注数 ${annoCount}（index 从 0 起、对应检测顺序）`,
      );
    }
    const described = new Set(annotations.map((a) => a.index));
    const missingAnno = Array.from({ length: annoCount }, (_, i) => i).filter((i) => !described.has(i));
    if (missingAnno.length > 0) {
      warnings.push(`检测出 ${annoCount} 条旁注中有 ${missingAnno.length} 条未给 desc（缺 index：${missingAnno.join(',')}）——旁注语义层不完整`);
    }
  }
  return warnings;
}
