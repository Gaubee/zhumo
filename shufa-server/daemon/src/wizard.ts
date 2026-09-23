/**
 * 安装向导引擎（PRODUCT_DESIGN.md §1 准备步骤、§4 setup/admin.wizard 路由）。
 * 原始需求 2026-09-23（W2'）；走查修订 2026-09-22（R3 dsh 包名 / R4 删 webui-install /
 * R5 三平台种子 / R6 whisper 型号+镜像+断点续传）。
 * last_log 逐行更新、进度写库；嗅探默认跳过、force 强制。
 * 正交意图：
 *   [1] 种子清单（按 OS 派生）与迁移落库（定义字段更新、下线行删除、运行态保留）。
 *   [2] 命令步骤：shell 执行 + last-line-log 逐行入库。
 *   [3] 下载步骤：HTTP(S) 断点续传（.download + Range 206）+ 进度入库，原子落位。
 *   [4] 嗅探跳过 / force 重跑 / 同步互斥（并发 run 同一步骤拒绝）。
 *   [5] whisper 步骤参数化：型号×镜像组装 URL 并持久化回行。
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { WizardKind, WizardStep } from '@zhumo/contracts';
import { WHISPER_MODEL_CATALOG, WHISPER_MIRRORS } from '@zhumo/contracts';
import type { SqliteDb } from './db/database.js';
import {
  getWizardStep,
  listWizardSteps,
  seedWizardSteps,
  updateWizardProgress,
  updateWizardStepUrl,
  type WizardStepRow,
} from './db/store.js';

/** 向导步骤运行环境（目标目录派生依据）。 */
export interface WizardContext {
  dataRoot: string;
  /** shufa-tool 仓库根（python-env 步骤的 uv sync --project 指向）。 */
  shufaToolDir: string;
}

/** run() 的可选运行参数（走查 R6）：whisper 型号与镜像源。 */
export interface WizardRunParams {
  model?: string;
  mirror?: 'official' | 'cn';
}

export interface WizardSeedInput {
  id: string;
  kind: WizardKind;
  title: string;
  command?: string | null;
  url?: string | null;
  targetDir: string;
  /** 嗅探命令（exit 0 = 已装/已就绪）；download 步骤嗅探=目标文件存在。 */
  probe?: string | null;
}

const MB = 1024 * 1024;

/** whisper 下载步骤 id（R6 参数化的作用面）。 */
export const WHISPER_STEP_ID = 'whisper-model';

/**
 * 首发步骤清单（§1；走查修订 2026-09-22；2026-09-23 dsh 步骤退役——内核是
 * `@deepseek-ai/dsh-*` SDK 进程内嵌（随 `pnpm install` 就位），不是系统依赖，
 * 全局安装一个用不到的 CLI 是误导）。安装类命令为常见环境默认值，存量库可经
 * 种子迁移获得修订。三平台差异只在命令层：darwin=brew、win32=winget、
 * linux=apt-get；probe 均为跨平台命令。
 */
export function defaultWizardSeeds(ctx: WizardContext): WizardSeedInput[] {
  const modelsDir = path.join(ctx.dataRoot, 'models');
  const platform = process.platform;
  const installFfmpeg =
    platform === 'darwin'
      ? 'brew install ffmpeg'
      : platform === 'win32'
        ? 'winget install -e --id Gyan.FFmpeg'
        : 'sudo apt-get install -y ffmpeg';
  // whisper 默认取官方源 + base 模型（R6：型号/镜像可经 run 参数切换并持久化）。
  const defaultModel = WHISPER_MODEL_CATALOG.find((m) => m.id === 'base');
  if (!defaultModel) throw new Error('WHISPER_MODEL_CATALOG 缺少 base 模型定义');
  // python 分析环境（2026-09-23，迁移暂停后的部署补课）：管线工具经 `uv run`
  // 调用，向导把依赖预热显性化——首次分析不再隐式下载依赖。uv sync 幂等。
  return [
    {
      id: 'ffmpeg',
      kind: 'command',
      title: 'ffmpeg（视频探测/剪辑/缩略图）',
      command: installFfmpeg,
      probe: 'ffmpeg -version',
      targetDir: '系统 PATH',
    },
    {
      id: 'python-env',
      kind: 'command',
      title: 'Python 分析环境（uv sync 预热依赖）',
      command: `uv sync --project "${ctx.shufaToolDir}"`,
      probe: 'uv --version',
      targetDir: ctx.shufaToolDir,
    },
    {
      id: WHISPER_STEP_ID,
      kind: 'download',
      title: 'whisper 转写模型（可选型号 + 镜像源）',
      command: null,
      url: `${WHISPER_MIRRORS[0].base}/${defaultModel.file}`,
      targetDir: modelsDir,
    },
  ];
}

/** 幂等种子落库（不覆盖既有状态）。 */
export function installWizardSeeds(db: SqliteDb, seeds: WizardSeedInput[]): void {
  seedWizardSteps(
    db,
    seeds.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      command: s.command ?? null,
      url: s.url ?? null,
      target_dir: s.targetDir,
    })),
  );
}

export function listSteps(db: SqliteDb): WizardStep[] {
  return listWizardSteps(db).map(toView);
}

export class WizardRunner {
  /** 同一步骤并发 run 的互斥集合。 */
  private readonly running = new Set<string>();

  constructor(
    private readonly db: SqliteDb,
    private readonly seeds: WizardSeedInput[],
    private readonly options: { shell?: string; fetchImpl?: typeof fetch } = {},
  ) {}

  /** 全量步骤视图（setup.steps 与 admin.wizard.steps 共用）。 */
  list(): WizardStep[] {
    return listSteps(this.db);
  }

  /**
   * 开机被动嗅探（走查 R1）：pending 步骤逐条探测，命中即置 done——已装依赖
   * 在页面打开时就该显示「已安装 + 按钮锁定」，而不是等用户点一次运行。
   * 只探测不执行；单条探测失败（依赖缺失）静默保持 pending；单条 5s 超时不拖死启动。
   */
  async sniffAll(): Promise<void> {
    for (const row of listWizardSteps(this.db)) {
      if (row.status !== 'pending' || this.running.has(row.id)) continue;
      const seed = this.seeds.find((s) => s.id === row.id) ?? null;
      const reason = await Promise.race([
        this.sniff(row, seed),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (reason) updateWizardProgress(this.db, row.id, { status: 'done', lastLog: reason });
    }
  }

  /**
   * 执行一步。返回终态视图：
   * - 已 done 且未 force：原样返回（跳过语义）；whisper 参数仍会先持久化，
   *   保证「已完成后换型号/镜像」的选择不丢，实际下载发生在下次 run。
   * - 嗅探通过且未 force：置 done（last_log 记录跳过原因）。
   * - 否则真实执行命令/下载，进度逐行写库。
   * params（走查 R6）：whisper-model 步骤提供 model/mirror 时按 catalog+mirror
   * 组装 URL 并持久化回行；未提供时用行上既有 url。
   */
  async run(id: string, force: boolean, params?: WizardRunParams): Promise<WizardStep> {
    let row = getWizardStep(this.db, id);
    if (!row) throw new WizardError('NOT_FOUND', `向导步骤不存在：${id}`);
    if (this.running.has(id)) {
      throw new WizardError('CONFLICT', `步骤正在执行中：${id}`);
    }
    const seed = this.seeds.find((s) => s.id === id) ?? null;
    if (
      id === WHISPER_STEP_ID &&
      row.kind === 'download' &&
      (params?.model !== undefined || params?.mirror !== undefined)
    ) {
      const url = resolveWhisperUrl(row.url, params);
      if (url !== row.url) {
        updateWizardStepUrl(this.db, id, url);
        row = getWizardStep(this.db, id) ?? row;
      }
    }
    if (!force && row.status === 'done') return toView(row);

    if (!force) {
      const skipReason = await this.sniff(row, seed);
      if (skipReason) {
        updateWizardProgress(this.db, id, { status: 'done', lastLog: skipReason });
        return toView(getWizardStep(this.db, id));
      }
    }

    this.running.add(id);
    try {
      updateWizardProgress(this.db, id, { status: 'running', lastLog: '开始执行…' });
      const finalLog =
        row.kind === 'command'
          ? await this.runCommand(id, row)
          : await this.runDownload(id, row);
      updateWizardProgress(this.db, id, { status: 'done', lastLog: finalLog });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateWizardProgress(this.db, id, { status: 'failed', lastLog: message });
    } finally {
      this.running.delete(id);
    }
    return toView(getWizardStep(this.db, id));
  }

  /** 返回跳过原因文案；不跳过返回 null。 */
  private async sniff(row: WizardStepRow, seed: WizardSeedInput | null): Promise<string | null> {
    if (row.kind === 'download') {
      const file = downloadTargetPath(row.url ?? '', row.target_dir);
      if (file && existsSync(file)) return `嗅探：文件已存在，跳过（${file}）`;
      return null;
    }
    const probe = seed?.probe ?? null;
    if (!probe) return null;
    const code = await runShellCapture(probe, path.dirname(row.target_dir), this.options.shell);
    if (code === 0) return '嗅探：依赖已就绪，跳过';
    return null;
  }

  /** 命令步骤：工作目录取 target_dir（目录不存在退到其父级/家目录）。 */
  private async runCommand(id: string, row: WizardStepRow): Promise<string> {
    if (!row.command) throw new Error('步骤缺少 command 定义');
    const cwd = workDirFor(row.target_dir);
    const child = spawn(row.command, {
      cwd,
      shell: this.options.shell ?? true,
    });
    let lastLine = '';
    const onLine = (chunk: Buffer | string): void => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
          lastLine = trimmed;
          updateWizardProgress(this.db, id, { lastLog: trimmed });
        }
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) throw new Error(`命令退出码 ${code}（最后一行：${lastLine || '无输出'}）`);
    return lastLine || '命令执行完成';
  }

  /**
   * 下载步骤：断点续传（走查 R6）。临时文件 `<target>.download`：启动时若存在
   * 即带 `Range: bytes=N-` 续传（206 → append，total 取 Content-Range；200 →
   * 服务端不支持 Range，从头覆盖写）。失败/中断保留 .download 供下次续传；
   * 尺寸校验通过后原子改名落位。
   */
  private async runDownload(id: string, row: WizardStepRow): Promise<string> {
    if (!row.url) throw new Error('步骤缺少 url 定义');
    const target = downloadTargetPath(row.url, row.target_dir);
    if (!target) throw new Error(`无法从 url 推导目标文件名：${row.url}`);
    mkdirSync(row.target_dir, { recursive: true });
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const tmp = `${target}.download`;
    let resumeFrom = 0;
    const headers: Record<string, string> = {};
    if (existsSync(tmp)) {
      resumeFrom = statSync(tmp).size;
      headers.range = `bytes=${resumeFrom}-`;
    }
    const response = await fetchImpl(row.url, { redirect: 'follow', headers });
    if (!response.ok || !response.body) {
      throw new Error(`下载失败：HTTP ${response.status}（${row.url}）`);
    }
    // 206=续传（append + Content-Range 总长）；起点与本地不符说明 .download 已失效，
    // 丢弃重来，下轮从零开始。200（或无 Content-Range）=不支持 Range，从头覆盖。
    let baseSize = 0;
    let total = Number.NaN;
    let append = false;
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get('content-range'));
      if (range && range.start === resumeFrom) {
        baseSize = resumeFrom;
        total = range.total;
        append = true;
      } else {
        rmSync(tmp, { force: true });
        throw new Error(
          `续传起点不一致（本地 ${resumeFrom} 字节，服务端 ${range?.start ?? '未知'}），已重置临时文件，请重试`,
        );
      }
    } else {
      const totalHeader = response.headers.get('content-length');
      total = totalHeader ? Number.parseInt(totalHeader, 10) : Number.NaN;
    }
    let received = 0;
    let lastLoggedMb = -1;
    const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    source.on('data', (chunk: Buffer) => {
      received += chunk.byteLength;
      // 进度写库按 MB 粒度节流，避免小包高频打sqlite；分母含续传基数。
      const done = baseSize + received;
      const mb = Math.floor(done / MB);
      if (mb !== lastLoggedMb) {
        lastLoggedMb = mb;
        const totalText = Number.isFinite(total) ? `${(total / MB).toFixed(1)}MB` : '未知大小';
        const pct = Number.isFinite(total) && total > 0 ? `（${Math.round((done / total) * 100)}%）` : '';
        updateWizardProgress(this.db, id, {
          lastLog: `已下载 ${(done / MB).toFixed(1)}MB / ${totalText}${pct}`,
        });
      }
    });
    await pipeline(source, createWriteStream(tmp, { flags: append ? 'a' : 'w' }));
    const finalSize = baseSize + received;
    if (Number.isFinite(total) && finalSize !== total) {
      // 保留 .download 供下次续传。
      throw new Error(`下载不完整：期望 ${total} 字节，实际 ${finalSize} 字节`);
    }
    renameSync(tmp, target);
    const sizeMb = (statSync(target).size / MB).toFixed(1);
    return `下载完成：${target}（${sizeMb}MB）`;
  }
}

export function toView(row: WizardStepRow | null): WizardStep {
  if (!row) throw new WizardError('NOT_FOUND', '向导步骤不存在');
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    command: row.command,
    url: row.url,
    target_dir: row.target_dir,
    status: row.status,
    last_log: row.last_log,
    updated_at: row.updated_at,
  };
}

/** download 目标文件：<target_dir>/<url 最后一段路径>。 */
export function downloadTargetPath(url: string, targetDir: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').filter(Boolean).pop();
    return base ? path.join(targetDir, base) : null;
  } catch {
    return null;
  }
}

/** 从行 url 文件名反推 whisper 型号（识别不出回退 null → 调用方取 base）。 */
function whisperModelIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const file = url.split('/').pop() ?? '';
  return WHISPER_MODEL_CATALOG.find((m) => m.file === file)?.id ?? null;
}

/** 从行 url 前缀反推镜像源（识别不出回退 null → 调用方取 official）。 */
function whisperMirrorIdFromUrl(url: string | null): 'official' | 'cn' | null {
  if (!url) return null;
  const mirror = WHISPER_MIRRORS.find((m) => url.startsWith(`${m.base}/`));
  return mirror?.id ?? null;
}

/**
 * whisper URL 组装（走查 R6）：params 只给一半时，另一半从行上既有 url 反推
 * （换型号不动镜像、换镜像不动型号）；行上无痕迹分别回退 base / official。
 * 未知型号抛错（由 run() 的 failed 路径或调用方直接感知）。
 */
export function resolveWhisperUrl(
  rowUrl: string | null,
  params: { model?: string; mirror?: 'official' | 'cn' },
): string {
  const modelId = params.model ?? whisperModelIdFromUrl(rowUrl) ?? 'base';
  const model = WHISPER_MODEL_CATALOG.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(
      `未知的 whisper 模型型号：${modelId}（可选：${WHISPER_MODEL_CATALOG.map((m) => m.id).join('、')}）`,
    );
  }
  const mirrorId = params.mirror ?? whisperMirrorIdFromUrl(rowUrl) ?? 'official';
  const mirror = WHISPER_MIRRORS.find((m) => m.id === mirrorId) ?? WHISPER_MIRRORS[0];
  return `${mirror.base}/${model.file}`;
}

/** Content-Range 解析（`bytes N-M/total`）；非标准格式返回 null。 */
function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

function workDirFor(targetDir: string): string {
  if (existsSync(targetDir)) return targetDir;
  const parent = path.dirname(targetDir);
  return existsSync(parent) ? parent : path.resolve('.');
}

/** 嗅探/探针用：跑 shell 命令只取退出码，输出丢弃。 */
function runShellCapture(command: string, cwd: string, shell?: string | boolean): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: shell ?? true });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

export class WizardError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message);
  }
}
