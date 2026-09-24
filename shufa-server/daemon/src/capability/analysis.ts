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
import type { CapabilityCallResult, CapabilityDefinition } from './core.js';

/** shell 执行结果（测试注入 mock 的封闭形状）。 */
export interface ShellOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export type ShellRunner = (command: readonly string[], options: { cwd: string }) => Promise<ShellOutcome>;

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
    const command = [
      'uv',
      'run',
      '--project',
      deps.shufaToolDir,
      'python',
      '-m',
      'shufa_tool.steps',
      step,
      ...args,
    ];
    const outcome = await runShell(command, { cwd: context.taskDir });
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
        + '存在旁注/田字格时必须同时给 labels（语义标注：旁注描述、生字格标签），否则结果页语义层为空',
      authority: 'readonly',
      input: z.object({
        ...workdirField,
        content: z.string().min(1).describe('summary.json 完整内容（JSON 文本）'),
        labels: z.string().optional().describe(
          'labels.json 完整内容（JSON 文本，可选但强烈建议）：'
          + '{"grids":[{"index":0,"label":"桂"}],"annotations":[{"index":0,"desc":"指出主笔起了钩"}]}——'
          + 'index 对应检测顺序；label 用于转录↔生字关联与旁注归属',
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

// ---------------------------------------------------------------- summary/labels 结构 lint

/** summary.json 内容结构（结果页静态总结消费面）。 */
const SummaryContentSchema = z.object({
  topic: z.string().min(1, 'topic 不能为空'),
  paragraphs: z.array(z.string().min(1)).min(1, 'paragraphs 至少一段'),
  key_points: z.array(z.string().min(1)).min(1, 'key_points 至少一条'),
});

/** labels.json 内容结构（语义层：grids[].label 生字 / annotations[].desc 旁注）。 */
const LabelsContentSchema = z.object({
  grids: z
    .array(
      z.object({
        index: z.number().int().min(0, 'index 从 0 起'),
        label: z.string().min(1, 'label 不能为空'),
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
    const labeled = new Set(grids.map((g) => g.index));
    const missing = Array.from({ length: gridCount }, (_, i) => i).filter((i) => !labeled.has(i));
    if (missing.length > 0) {
      warnings.push(`检测出 ${gridCount} 个田字格中有 ${missing.length} 个未标注 label（缺格 index：${missing.join(',')}）——转录与生字的关联会缺失`);
    }
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
