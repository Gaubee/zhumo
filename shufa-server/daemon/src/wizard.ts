/**
 * 安装向导引擎（PRODUCT_DESIGN.md §1 准备步骤、§4 setup/admin.wizard 路由）。
 * 原始需求 2026-09-23（W2'）；走查修订 2026-09-22（R3 dsh 包名 / R4 删 webui-install /
 * R5 三平台种子 / R6 whisper 型号+镜像+断点续传）；走查修订 2026-09-23
 * （BUG1 全量日志+终态行+后验嗅探 / BUG3 下载进度行原位替换）；Owner 需求
 * 2026-09-25（git 检测步骤——知识库修订历史的依赖）。
 * 正交意图：
 *   [1] 种子清单（按 OS 派生）与迁移落库（定义字段更新、下线行删除、运行态保留）。
 *   [2] 命令步骤：shell 执行 + 全量日志逐行追加（64KB 截断）+ 终态行 + 成功后验嗅探。
 *   [3] 下载步骤：HTTP(S) 断点续传（.download + Range 206）+ 进度行原位替换，原子落位。
 *   [4] 嗅探跳过 / force 重跑 / 同步互斥（并发 run 同一步骤拒绝）/ 运行中取消
 *       （走查 2026-09-24：命令组杀 + 下载 abort；取消回 pending，下载残留
 *       .download 供续传）。
 *   [5] whisper 步骤参数化：型号×镜像组装 URL 并持久化回行。
 */
import { spawn } from 'node:child_process';
import { refreshWindowsPath } from './win-path-refresh.js';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { WizardKind, WizardStep } from '@zhumo/contracts';
import {
  WHISPER_MIRRORS,
  WHISPER_MODEL_CATALOG,
  whisperModelIdFromRepo,
  whisperRepoFor,
} from '@zhumo/contracts';
import { saveEnvValues } from './config.js';
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

/** 单步日志上限（走查 BUG1）：超出截断头部并标注。 */
export const WIZARD_LOG_MAX_BYTES = 64 * 1024;
export const WIZARD_LOG_TRUNCATION_MARKER = '…（日志已截断）';
/** 下载进度行前缀（走查 BUG3）：同一下载会话内原位替换，不刷屏。 */
export const DOWNLOAD_PROGRESS_PREFIX = '已下载 ';
/** 命令成功但后验嗅探未通过的失败说明（走查 BUG1：如实反映 PATH/验证现状）。 */
export const POST_PROBE_FAILED_MESSAGE =
  '命令执行成功但嗅探未通过（依赖可能未进入当前 PATH，或需重开终端），请检查后强制重试';

/**
 * 单步全量日志写入面（走查 BUG1/BUG3）：last_log 从「仅最新一行」改为全量追加，
 * 64KB 截头；下载进度行特殊——同一下载会话内替换上一条进度行，非进度日志
 * （命令输出、终态行、嗅探说明）永久保留。单步同时只有一个 run（running 集合互斥），
 * 状态机无并发竞争。
 */
class StepLogWriter {
  private text: string;
  private progressOpen = false;

  constructor(
    private readonly db: SqliteDb,
    private readonly id: string,
    initial: string | null,
  ) {
    this.text = initial ?? '';
  }

  /** 追加一条普通日志（命令输出 / 终态行 / 嗅探说明）。 */
  append(line: string): void {
    this.write(line, false);
  }

  /** 追加下载进度行：上一条仍是进度行时原位替换。 */
  appendProgress(line: string): void {
    this.write(line, true);
  }

  private write(line: string, isProgress: boolean): void {
    if (isProgress && this.progressOpen) {
      const nl = this.text.lastIndexOf('\n');
      this.text = nl === -1 ? line : `${this.text.slice(0, nl + 1)}${line}`;
    } else {
      this.text = this.text ? `${this.text}\n${line}` : line;
    }
    this.progressOpen = isProgress;
    this.text = capStepLog(this.text);
    updateWizardProgress(this.db, this.id, { lastLog: this.text });
  }
}

/** 64KB 截头（走查 BUG1）：丢弃最老的行，头部标注截断标记；对齐换行与 UTF-8 字符边界。 */
export function capStepLog(text: string): string {
  let bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= WIZARD_LOG_MAX_BYTES) return text;
  const markerBytes = Buffer.byteLength(WIZARD_LOG_TRUNCATION_MARKER, 'utf8');
  const budget = WIZARD_LOG_MAX_BYTES - markerBytes - 1;
  bytes = bytes.subarray(bytes.byteLength - budget);
  // 对齐到下一换行（避免半行 + 多字节字符残片）。
  const nl = bytes.indexOf(0x0a);
  if (nl >= 0) bytes = bytes.subarray(nl + 1);
  let start = 0;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  bytes = bytes.subarray(start);
  return `${WIZARD_LOG_TRUNCATION_MARKER}\n${bytes.toString('utf8')}`;
}

/** whisper 下载步骤 id（R6 参数化的作用面）。 */
export const WHISPER_STEP_ID = 'whisper-model';

/**
 * 首发步骤清单（§1；走查修订 2026-09-22；2026-09-23 dsh 步骤退役；走查四轮
 * 2026-09-25：whisper 步骤改为预热管线真消费的模型；W9 2026-09-27 平台最优
 * 引擎——darwin/arm64 = mlx-whisper、win32/linux = faster-whisper
 * （CTranslate2），whisper 步骤恢复全平台（Intel mac 除外：mlx 无 x64 构建、
 * Owner 裁决 macOS 保留现行为即无转录）。Owner 需求 2026-09-25（git 检测
 * 步骤：知识库修订历史的依赖）。安装类命令为常见环境默认值，存量库可经种子
 * 迁移获得修订（不在册行删除）。三平台差异只在命令层：darwin=brew、
 * win32=winget、linux=apt-get；probe 均为跨平台命令。
 */

/** 平台最优转录引擎（W9）：darwin/arm64=mlx；win32/linux=faster；Intel mac 无。 */
export function whisperEngineFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): 'mlx' | 'faster' | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'mlx' : null;
  return 'faster';
}

export function defaultWizardSeeds(
  ctx: WizardContext,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): WizardSeedInput[] {
  const installFfmpeg =
    platform === 'darwin'
      ? 'brew install ffmpeg'
      : platform === 'win32'
        ? 'winget install -e --id Gyan.FFmpeg'
        : 'sudo apt-get install -y ffmpeg';
  // python-env 探测（四轮实证修正）：`uv --version` 只证明 uv 在，不证明 venv
  // 就绪——全新克隆上 sniff 误报「已安装」，whisper 预热直接炸「huggingface_hub
  // 未安装」。改验 venv 真实内容（--no-sync 不触发隐式安装，缺则快速失败）；
  // transcribe import 按引擎族（W9）：mlx 平台验 mlx_whisper、faster 平台验
  // faster_whisper；Intel mac 引擎缺失，只验基础管线依赖。
  const whisperEngine = whisperEngineFor(platform, arch);
  const pyProbeImports =
    whisperEngine === 'mlx'
      ? 'import cv2, numpy, huggingface_hub, mlx_whisper'
      : whisperEngine === 'faster'
        ? 'import cv2, numpy, huggingface_hub, faster_whisper'
        : 'import cv2, numpy';
  // git 检测步骤（Owner 需求 2026-09-25）：知识库（<DATA_ROOT>/knowledge）以 git
  // 做修订历史，缺失不阻塞——读写照常、历史面降级（admin.kb.revisions
  // available:false）。与 ffmpeg 不同，这里不代跑安装命令：git 无固定二进制路径
  // （macOS 常随命令行工具就位），检测未过时输出中文提示（缺它只是无历史、
  // 知识库可用）并以非零退出置 failed；用户装好后重试本步骤（或下次开机被动
  // 嗅探）即 done——复用命令步骤既有执行/重试语义，不另起新机制。
  const gitAdvice =
    platform === 'darwin'
      ? 'macOS 可运行 xcode-select --install（苹果命令行工具，含 git）或 brew install git'
      : platform === 'win32'
        ? '可运行 winget install -e --id Git.Git'
        : '可运行 sudo apt-get install -y git';
  const gitHint = `未检测到 git：知识库读写不受影响，仅修订历史不可用，${gitAdvice}，安装后重试本步骤`;
  // win32 的 shell 是 cmd.exe：括号组内命令分隔符为 & 而非 ;（其余平台 POSIX sh）。
  const checkGit =
    platform === 'win32'
      ? `git --version || (echo "${gitHint}" & exit 1)`
      : `git --version || (echo "${gitHint}"; exit 1)`;
  const steps: WizardSeedInput[] = [
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
      // --extra transcribe（走查四轮）：基础 sync 不含可选依赖，反而会卸掉
      // mlx-whisper/torch——转录能力静默消失。extra 自带平台标记，非 darwin
      // 上是空集，恒可安全传入。
      command: `uv sync --project "${ctx.shufaToolDir}" --extra transcribe`,
      probe: `uv run --no-sync --project "${ctx.shufaToolDir}" python -c "${pyProbeImports}"`,
      targetDir: ctx.shufaToolDir,
    },
    {
      id: 'git',
      kind: 'command',
      title: 'git（知识库修订历史）',
      command: checkGit,
      // 嗅探与 ffmpeg 步同型：exit 0 = 已装（开机被动嗅探命中即 done）。
      probe: 'git --version',
      // git 无固定二进制路径（PATH 上的系统依赖）——与 ffmpeg 步一致，仅展示用。
      targetDir: '系统 PATH',
    },
  ];
  // whisper 预热步骤（四轮；W9 全平台恢复）：默认官方源 + large-v3-turbo
  // （与 audio.py 缺省一致），repo 按引擎族（mlx-community / Systran）。
  const defaultModel = WHISPER_MODEL_CATALOG.find((m) => m.id === 'whisper-large-v3-turbo');
  if (defaultModel && whisperEngine) {
    steps.push({
      id: WHISPER_STEP_ID,
      kind: 'download',
      title: `whisper 转写模型（${whisperEngine === 'mlx' ? 'mlx' : 'faster-whisper'} · 可选型号 + 镜像源）`,
      command: null,
      url: `${WHISPER_MIRRORS[0].base}/${whisperRepoFor(defaultModel.id, whisperEngine)}`,
      targetDir: hfHubDir(),
    });
  }
  return steps;
}

/** HF 缓存根目录展示（与 warm_whisper.py 的 hub_root 同一解析规则）。 */
export function hfHubDir(): string {
  const hfHome = process.env.HF_HOME;
  const home = hfHome ? hfHome : path.join(os.homedir(), '.cache', 'huggingface');
  return path.join(home, 'hub');
}

/** 仓库在 HF 缓存中的目录名（models--org--name）。 */
export function whisperCacheRepoDir(repo: string): string {
  return path.join(hfHubDir(), `models--${repo.replace(/\//g, '--')}`);
}

/** 从行 url（模型页 https://host/org/name）反推仓库全名。 */
export function whisperRepoFromUrl(url: string | null): string | null {
  if (!url) return null;
  const m = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)$/.exec(url.trim());
  return m?.[1] ?? null;
}

/** 预热完成判定：snapshots 下存在权重文件。mlx 仓库新格式 .safetensors、
 * 老格式 weights.npz 都认（实证 whisper-tiny 即 npz）。 */
const WHISPER_WEIGHT_EXTS = ['.safetensors', '.npz'];
export function whisperCacheReady(repo: string): boolean {
  const dir = whisperCacheRepoDir(repo);
  if (!existsSync(dir)) return false;
  const snapshots = path.join(dir, 'snapshots');
  if (!existsSync(snapshots)) return false;
  const walk = (d: string): boolean => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) return true;
      } else if (
        WHISPER_WEIGHT_EXTS.some((ext) => entry.name.endsWith(ext)) &&
        // 走查 2026-09-26：snapshots 里的权重常态是软链——必须解析目标真实存在
        // 才算就绪（xet「零字节成功」会留 blobs/<etag> → 不存在分片的悬空链，
        // 仅按文件名判定会把损坏缓存误标已下载）。existsSync 跟随软链。
        existsSync(full)
      ) {
        return true;
      }
    }
    return false;
  };
  return walk(snapshots);
}

/** 预热中断判定（「恢复下载」依据）：blobs 下存在未落位残差——自管下载器的
 * `.download` 或 hf_hub 旧会话遗留的 `.incomplete`。 */
export function whisperCachePartial(repo: string): boolean {
  const dir = whisperCacheRepoDir(repo);
  if (!existsSync(dir)) return false;
  const blobs = path.join(dir, 'blobs');
  if (!existsSync(blobs)) return false;
  return readdirSync(blobs).some(
    (name) => name.endsWith('.download') || name.endsWith('.incomplete'),
  );
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
  /** 运行中步骤的取消句柄（走查 2026-09-24：cancel() 经此触达真实进程/流）。 */
  private readonly active = new Map<string, { kill: () => void }>();

  constructor(
    private readonly db: SqliteDb,
    private readonly seeds: WizardSeedInput[],
    private readonly options: {
      shell?: string;
      fetchImpl?: typeof fetch;
      /** .env 路径（四轮：whisper 选型持久化 SHUFA_WHISPER_REPO 用）。 */
      envFile?: string;
      /** shufa-tool 仓库根（四轮：warm_whisper 经 `uv run --project` 调用）。 */
      shufaToolDir?: string;
    } = {},
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
      if (reason) {
        const log = new StepLogWriter(this.db, row.id, row.last_log);
        log.append(reason);
        updateWizardProgress(this.db, row.id, { status: 'done' });
      }
    }
  }

  /**
   * 执行一步。返回终态视图：
   * - 已 done 且未 force：原样返回（跳过语义）；whisper 参数仍会先持久化，
   *   保证「已完成后换型号/镜像」的选择不丢，实际下载发生在下次 run。
   * - 嗅探通过且未 force：置 done（日志追加跳过原因，历史保留）。
   * - 否则真实执行命令/下载：全量日志逐行追加；命令结束后无论成败追加终态行
   *   （[完成] 退出码 0 / [失败] 退出码 N）；命令成功再做一次后验嗅探——
   *   通过 → done，不通过 → failed + 追加说明（走查 BUG1，2026-09-23）。
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
      // 四轮：显式选型即落 .env（SHUFA_WHISPER_REPO）——daemon 启动时透传给
      // 管线，转录用向导选的模型；url 恰与行一致（缺省重选）也要落，向导与
      // 管线从此同一事实源。
      if (params?.model !== undefined && this.options.envFile) {
        const { repo } = whisperRunArgsFromUrl(row.url);
        if (repo) saveEnvValues(this.options.envFile, { SHUFA_WHISPER_REPO: repo });
      }
    }
    if (!force && row.status === 'done') return toView(row);

    if (!force) {
      const skipReason = await this.sniff(row, seed);
      if (skipReason) {
        const log = new StepLogWriter(this.db, id, row.last_log);
        log.append(skipReason);
        updateWizardProgress(this.db, id, { status: 'done' });
        return toView(getWizardStep(this.db, id));
      }
    }

    this.running.add(id);
    const log = new StepLogWriter(this.db, id, row.last_log);
    /** 本轮取消标记：cancel() 置位后由 runCommand/runDownload 的收尾路径感知。 */
    const state = { cancelled: false };
    try {
      updateWizardProgress(this.db, id, { status: 'running' });
      log.append('开始执行…');
      if (row.kind === 'command') {
        const code = await this.runCommand(id, row, log, state);
        // 终态行（走查 BUG1）：无论成败都追加，退出码如实入库。
        log.append(code === 0 ? '[完成] 退出码 0' : `[失败] 退出码 ${code}`);
        if (code !== 0) {
          updateWizardProgress(this.db, id, { status: 'failed' });
        } else {
          // 后验嗅探（走查 BUG1）：命令成功 ≠ 依赖就绪（PATH 未生效等），重跑
          // probe 如实反映——不通过则 failed + 说明，引导用户强制重试。
          if (await this.probePasses(row, seed)) {
            updateWizardProgress(this.db, id, { status: 'done' });
          } else {
            log.append(POST_PROBE_FAILED_MESSAGE);
            updateWizardProgress(this.db, id, { status: 'failed' });
          }
        }
      } else if (id === WHISPER_STEP_ID && row.kind === 'download') {
        // 四轮：whisper 预热走 warm_whisper 子进程（HF 标准缓存 + 断点续传），
        // 非泛型 HTTP 下载。终态行 + 后验（缓存有权重）与命令步骤同型。
        const code = await this.runWhisperWarm(id, row, log, state, force);
        if (code !== 0) {
          updateWizardProgress(this.db, id, { status: 'failed' });
        } else if (whisperCacheReady(whisperRunArgsFromUrl(row.url).repo)) {
          log.append(`[完成] 退出码 0`);
          updateWizardProgress(this.db, id, { status: 'done' });
        } else {
          log.append(POST_PROBE_FAILED_MESSAGE);
          updateWizardProgress(this.db, id, { status: 'failed' });
        }
      } else {
        // 下载终态（完成行/失败行）同样追加；文件存在 + 尺寸校验即后验（R6 保持）。
        const doneLine = await this.runDownload(id, row, log, state, force);
        log.append(doneLine);
        updateWizardProgress(this.db, id, { status: 'done' });
      }
    } catch (error) {
      if (error instanceof WizardCancelledError) {
        // 用户取消 ≠ 失败：回 pending（按钮回到待执行/待下载）；下载残留
        // .download 保留，下次 run 自动 Range 续传。
        log.append(
          row.kind === 'download'
            ? '[中断] 用户取消（已下载部分保留，可续传）'
            : '[中断] 用户取消',
        );
        updateWizardProgress(this.db, id, { status: 'pending' });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        log.append(`[失败] ${message}`);
        updateWizardProgress(this.db, id, { status: 'failed' });
      }
    } finally {
      this.active.delete(id);
      this.running.delete(id);
    }
    return toView(getWizardStep(this.db, id));
  }

  /**
   * 取消运行中的步骤（走查 2026-09-24）：命令组杀（detached + 负 pid，连带
   * shell 孙进程），下载 abort。run() 的 catch 收尾置回 pending。未在运行 →
   * CONFLICT（前端按钮只在 running 态可见，兜底语义）。
   */
  async cancel(id: string): Promise<{ ok: true }> {
    if (!getWizardStep(this.db, id)) throw new WizardError('NOT_FOUND', `向导步骤不存在：${id}`);
    const handle = this.active.get(id);
    if (!handle) throw new WizardError('CONFLICT', `步骤未在执行中：${id}`);
    handle.kill();
    return { ok: true };
  }

  /** 返回跳过原因文案；不跳过返回 null。 */
  private async sniff(row: WizardStepRow, seed: WizardSeedInput | null): Promise<string | null> {
    if (row.id === WHISPER_STEP_ID && row.kind === 'download') {
      // 四轮：HF 缓存探测（snapshots 下有权重即就绪——含手工预置/其他工具共享）。
      const { repo } = whisperRunArgsFromUrl(row.url);
      if (whisperCacheReady(repo)) {
        return `嗅探：模型已在 HF 缓存，跳过（${whisperCacheRepoDir(repo)}）`;
      }
      return null;
    }
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

  /**
   * 后验嗅探（走查 BUG1）：命令成功后重跑 probe 验证依赖真实就绪；
   * 无 probe 定义的命令步骤视为通过（退出码即事实）。download 步骤的后验
   * 是「文件存在 + 尺寸校验」，在 runDownload 内完成，不走这里。
   */
  private async probePasses(row: WizardStepRow, seed: WizardSeedInput | null): Promise<boolean> {
    if (row.kind === 'download') {
      const file = downloadTargetPath(row.url ?? '', row.target_dir);
      return file !== null && existsSync(file);
    }
    const probe = seed?.probe ?? null;
    if (!probe) return true;
    return (
      (await runShellCapture(probe, path.dirname(row.target_dir), this.options.shell)) === 0
    );
  }

  /**
   * 命令步骤：工作目录取 target_dir（目录不存在退到其父级/家目录）。全量输出逐行入日志。
   * 取消（走查 2026-09-24）：POSIX detached 进程组 + 负 pid 组杀（连带 shell 的
   * 孙进程——TaskStop 只杀 shell 杀不掉 brew 的教训）；close 时读 cancelled 标记
   * 抛 WizardCancelledError 交 run() 收尾。
   */
  private async runCommand(
    id: string,
    row: WizardStepRow,
    log: StepLogWriter,
    state: { cancelled: boolean },
  ): Promise<number> {
    if (!row.command) throw new Error('步骤缺少 command 定义');
    const cwd = workDirFor(row.target_dir);
    const child = spawn(row.command, {
      cwd,
      shell: this.options.shell ?? true,
      detached: process.platform !== 'win32',
    });
    this.active.set(id, {
      kill: () => {
        state.cancelled = true;
        killProcessTree(child);
      },
    });
    const onLine = (chunk: Buffer | string): void => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) log.append(trimmed);
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    return new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (state.cancelled) reject(new WizardCancelledError());
        else resolve(code ?? -1);
      });
    });
  }

  /**
   * whisper 预热 runner（走查四轮；W9 顺延 2026-09-27）：`uv run --project
   * <shufa-tool> --extra transcribe python -m shufa_tool.warm_whisper`——
   * warm_whisper 五轮起是自管下载器（断点续传/校验免费，纯标准库零 venv
   * 依赖）；--extra 使步骤可乱序：未先跑 python-env 时 uv run 自动补装引擎
   * 依赖（uv run 只补缺不卸载，与 uv sync 的 exact 语义不同——mac 管线裸
   * uv run 数月末曾卸掉 mlx 即实证）。镜像经 HF_ENDPOINT。进度行（已下载 …）
   * 原位替换，其余逐行追加；取消 = 组杀（与命令步骤同型，killProcessTree）；
   * force 透传脚本端清缓存（覆盖下载）。
   */
  private async runWhisperWarm(
    id: string,
    row: WizardStepRow,
    log: StepLogWriter,
    state: { cancelled: boolean },
    force: boolean,
  ): Promise<number> {
    const toolDir = this.options.shufaToolDir;
    if (!toolDir) throw new Error('向导上下文缺少 shufaToolDir（warm_whisper 无法调用）');
    const { repo, endpoint } = whisperRunArgsFromUrl(row.url);
    const command = [
      'uv',
      'run',
      '--project',
      JSON.stringify(toolDir),
      '--extra',
      'transcribe',
      'python',
      '-m',
      'shufa_tool.warm_whisper',
      '--repo',
      JSON.stringify(repo),
      '--endpoint',
      JSON.stringify(endpoint),
      ...(force ? ['--force'] : []),
    ].join(' ');
    // PYTHONUTF8：Windows 控制台代码页（GBK）下 python 子进程输出按代码页
    // 编码，daemon 按 UTF-8 解码进 last_log 会乱码（2026-09-27 Owner 实测
    //「[失败]」→「[ʧ…]」）；强制 Python UTF-8 模式统一两端。
    const child = spawn(command, {
      cwd: toolDir,
      shell: this.options.shell ?? true,
      detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONUTF8: '1' },
    });
    this.active.set(id, {
      kill: () => {
        state.cancelled = true;
        killProcessTree(child);
      },
    });
    const onLine = (chunk: Buffer | string): void => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith(DOWNLOAD_PROGRESS_PREFIX)) log.appendProgress(trimmed);
        else log.append(trimmed);
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    return new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        if (state.cancelled) reject(new WizardCancelledError());
        else resolve(code ?? -1);
      });
    });
  }

  /**
   * 下载步骤：断点续传（走查 R6）。临时文件 `<target>.download`：启动时若存在
   * 即带 `Range: bytes=N-` 续传（206 → append，total 取 Content-Range；200 →
   * 服务端不支持 Range，从头覆盖写）。失败/中断保留 .download 供下次续传；
   * 尺寸校验通过后原子改名落位。进度行走 appendProgress（走查 BUG3：同一下载
   * 会话内原位替换，历史非进度日志保留）；完成行由 run() 追加。
   * 取消（走查 2026-09-24）：AbortController 断流，pipeline 抛错转
   * WizardCancelledError（.download 残留即续传基数）。
   */
  private async runDownload(
    id: string,
    row: WizardStepRow,
    log: StepLogWriter,
    state: { cancelled: boolean },
    force: boolean,
  ): Promise<string> {
    if (!row.url) throw new Error('步骤缺少 url 定义');
    const target = downloadTargetPath(row.url, row.target_dir);
    if (!target) throw new Error(`无法从 url 推导目标文件名：${row.url}`);
    mkdirSync(row.target_dir, { recursive: true });
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const tmp = `${target}.download`;
    // 覆盖下载（走查 2026-09-24 · 三轮）：force 丢弃 .download 残差从头下载。
    if (force) rmSync(tmp, { force: true });
    let resumeFrom = 0;
    const headers: Record<string, string> = {};
    if (existsSync(tmp)) {
      resumeFrom = statSync(tmp).size;
      headers.range = `bytes=${resumeFrom}-`;
    }
    const abort = new AbortController();
    this.active.set(id, {
      kill: () => {
        state.cancelled = true;
        abort.abort();
      },
    });
    let response: Response;
    let source: Readable;
    try {
      response = await fetchImpl(row.url, { redirect: 'follow', headers, signal: abort.signal });
      if (!response.ok || !response.body) {
        throw new Error(`下载失败：HTTP ${response.status}（${row.url}）`);
      }
      source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
      await this.pipeDownload(response, source, tmp, log, resumeFrom);
    } catch (error) {
      if (state.cancelled) throw new WizardCancelledError();
      throw error;
    }
    renameSync(tmp, target);
    const sizeMb = (statSync(target).size / MB).toFixed(1);
    return `下载完成：${target}（${sizeMb}MB）`;
  }

  /** 206/200 判定 + 流式落盘 + MB 粒度进度行（runDownload 的主体，取消外框单独包）。 */
  private async pipeDownload(
    response: Response,
    source: Readable,
    tmp: string,
    log: StepLogWriter,
    resumeFrom: number,
  ): Promise<void> {
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
    source.on('data', (chunk: Buffer) => {
      received += chunk.byteLength;
      // 进度写库按 MB 粒度节流，避免小包高频打 sqlite；分母含续传基数。
      // 进度行走原位替换（BUG3）：同一下载会话只保留最新一条进度，不刷屏。
      const done = baseSize + received;
      const mb = Math.floor(done / MB);
      if (mb !== lastLoggedMb) {
        lastLoggedMb = mb;
        const totalText = Number.isFinite(total) ? `${(total / MB).toFixed(1)}MB` : '未知大小';
        const pct = Number.isFinite(total) && total > 0 ? `（${Math.round((done / total) * 100)}%）` : '';
        log.appendProgress(`已下载 ${(done / MB).toFixed(1)}MB / ${totalText}${pct}`);
      }
    });
    await pipeline(source, createWriteStream(tmp, { flags: append ? 'a' : 'w' }));
    const finalSize = baseSize + received;
    if (Number.isFinite(total) && finalSize !== total) {
      // 保留 .download 供下次续传。
      throw new Error(`下载不完整：期望 ${total} 字节，实际 ${finalSize} 字节`);
    }
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
    // 走查 2026-09-24 · 三轮：.download 残差存在性（UI「恢复下载」依据）。
    // 四轮：whisper 步骤的残差 = HF blobs 下的 .incomplete 分块。
    resumable:
      row.kind === 'download' &&
      (row.id === WHISPER_STEP_ID
        ? whisperCachePartial(whisperRunArgsFromUrl(row.url).repo)
        : downloadResumable(row.url, row.target_dir)),
  };
}

/** download 步骤的 .download 残差存在（取消/中断遗留，可 Range 续传）。 */
export function downloadResumable(url: string | null, targetDir: string): boolean {
  const target = downloadTargetPath(url ?? '', targetDir);
  return target !== null && existsSync(`${target}.download`);
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

/** 从行 url（模型页）反推 whisper 型号（mlx/faster 两族仓库都认；识别不出 null）。 */
function whisperModelIdFromUrl(url: string | null): string | null {
  const repo = whisperRepoFromUrl(url);
  if (!repo) return null;
  return whisperModelIdFromRepo(repo);
}

/** 从行 url 前缀反推镜像源（识别不出回退 null → 调用方取 official）。 */
function whisperMirrorIdFromUrl(url: string | null): 'official' | 'cn' | null {
  if (!url) return null;
  const mirror = WHISPER_MIRRORS.find((m) => url.startsWith(`${m.base}/`));
  return mirror?.id ?? null;
}

/** 运行时引擎（单值）：darwin=mlx（含 Intel mac——只解析行上既有 url，不决定
 * 能否转录）、其余 faster。seeds 展示用带 arch 的 whisperEngineFor，这里的
 * 消费方全是已落库行的 url 解析，与 arch 无关。 */
function runtimeWhisperEngine(): 'mlx' | 'faster' {
  return process.platform === 'darwin' ? 'mlx' : 'faster';
}

/**
 * whisper 模型页 URL 组装（走查四轮；W9 引擎族）：`${mirror.base}/${repo}`——
 * base 即 HF_ENDPOINT（official=https://huggingface.co，cn=https://hf-mirror.com）。
 * params 只给一半时，另一半从行上既有 url 反推（换型号不动镜像、换镜像不动
 * 型号）；行上无痕迹回退 large-v3-turbo / official（与 audio.py 缺省一致）。
 * repo 取 engine 族（mlx=mlx-community/*，faster=Systran/faster-whisper-*）。
 * 未知型号抛错（由 run() 的 failed 路径或调用方直接感知）。
 */
export function resolveWhisperUrl(
  rowUrl: string | null,
  params: { model?: string; mirror?: 'official' | 'cn' },
  engine: 'mlx' | 'faster' = runtimeWhisperEngine(),
): string {
  const modelId = params.model ?? whisperModelIdFromUrl(rowUrl) ?? 'whisper-large-v3-turbo';
  const repo = whisperRepoFor(modelId, engine);
  if (!repo) {
    throw new Error(
      `未知的 whisper 模型型号：${modelId}（可选：${WHISPER_MODEL_CATALOG.map((m) => m.id).join('、')}）`,
    );
  }
  const mirrorId = params.mirror ?? whisperMirrorIdFromUrl(rowUrl) ?? 'official';
  const mirror = WHISPER_MIRRORS.find((m) => m.id === mirrorId) ?? WHISPER_MIRRORS[0];
  return `${mirror.base}/${repo}`;
}

/** 行 url → { repo, endpoint, mirrorId }（warm runner 的完整入参组）。 */
export function whisperRunArgsFromUrl(
  rowUrl: string | null,
  engine: 'mlx' | 'faster' = runtimeWhisperEngine(),
): {
  repo: string;
  endpoint: string;
  mirrorId: 'official' | 'cn';
} {
  const modelId = whisperModelIdFromUrl(rowUrl) ?? 'whisper-large-v3-turbo';
  const repo = whisperRepoFor(modelId, engine)!;
  const mirrorId = whisperMirrorIdFromUrl(rowUrl) ?? 'official';
  const mirror = WHISPER_MIRRORS.find((m) => m.id === mirrorId) ?? WHISPER_MIRRORS[0];
  return { repo, endpoint: mirror.base, mirrorId };
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
async function runShellCapture(command: string, cwd: string, shell?: string | boolean): Promise<number> {
  // Windows PATH 快照刷新（2026-09-25 Owner 实测）：winget 装完新终端可见、
  // daemon 嗅探仍失败——进程 PATH 是启动快照。probe 前重读注册表合并刷新，
  // 嗅探与运行时 spawn 同源（process.env.PATH）。非 win32 no-op。
  await refreshWindowsPath();
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

/** 用户取消的哨兵错误（走查 2026-09-24）：run() 捕获后回 pending，不计失败。 */
export class WizardCancelledError extends Error {
  constructor() {
    super('用户取消');
  }
}

/**
 * 进程组杀（走查 2026-09-24）：POSIX 下负 pid 广播到整组（shell 的孙进程一并
 * 收敛——TaskStop 只杀外层进程杀不掉孙进程的教训）；SIGTERM 后 3s 兜底 SIGKILL。
 * Windows 无进程组语义，退化为直接 kill（适配属初步未测试范畴）。
 */
function killProcessTree(child: import('node:child_process').ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
    return;
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      /* 组已随主进程退出 */
    }
  };
  signalGroup('SIGTERM');
  const killer = setTimeout(() => signalGroup('SIGKILL'), 3000);
  killer.unref?.();
}
