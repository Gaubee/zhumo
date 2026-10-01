/**
 * 意图列表（维持 ≤5）：
 * 1. 子进程执行工具（跨平台 spawn + stdout/stderr 捕获）
 * 2. venv 与内部可执行文件路径解析（win32/darwin/linux）
 * 3. 平台/引擎自动探测（darwin+arm64→mlx；linux+cuda→cuda；其它→cpu）
 * 4. ffmpeg 发现与音频规范化（非 WAV 或需统一规格时转 16kHz 单声道 s16）
 *
 * 原始需求（2026-10-01）：将 Qwen3-ASR 选型落地为书法项目的推荐转录配置，
 * 跨平台兼容（macOS MLX / Linux CUDA / 通用 CPU），部署目标 Mac mini。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { EngineKind } from "./engines/types.ts";

export const ROOT = import.meta.dir;
export const TMP_DIR = path.join(ROOT, ".tmp");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 统一子进程入口：合并当前环境变量，完整捕获输出。可执行不存在时返回 code=127（Bun.spawn 会抛 ENOENT 而非返回非零）。 */
export async function run(cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<RunResult> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  if (opts?.env) Object.assign(childEnv, opts.env);
  try {
    const proc = Bun.spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
      cwd: opts?.cwd,
      env: childEnv,
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** 命令是否在 PATH 上可找到。 */
export async function hasCommand(cmd: string): Promise<boolean> {
  const probe = process.platform === "win32" ? ["where", cmd] : ["which", cmd];
  const r = await run(probe);
  return r.code === 0;
}

// ── venv 路径解析 ─────────────────────────────────────────────

export function venvDir(): string {
  return path.join(ROOT, ".venv");
}

/** venv 内可执行文件路径（win32 在 Scripts/ 且带 .exe）。 */
export function venvBin(name: string): string {
  const dir = process.platform === "win32" ? "Scripts" : "bin";
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(venvDir(), dir, name + ext);
}

export function venvPython(): string {
  return venvBin("python");
}

// ── 平台探测 ──────────────────────────────────────────────────

export async function detectEngine(): Promise<EngineKind> {
  if (process.platform === "darwin" && process.arch === "arm64") return "mlx";
  if (process.platform === "linux" && (await hasCommand("nvidia-smi"))) return "cuda";
  return "cpu";
}

// ── 音频规范化 ────────────────────────────────────────────────

export const AUDIO_EXTS = ["wav", "mp3", "m4a", "flac", "mp4", "aac", "ogg", "opus", "aiff", "wma", "webm"];

/**
 * 统一规范化为 16kHz 单声道 s16 WAV（cpu 引擎硬性要求；也消除各引擎格式差异）。
 * WAV 且无 ffmpeg 时直通（mlx/cuda 可自行处理）；非 WAV 且无 ffmpeg 时报错。
 */
export async function ensureWav16k(input: string): Promise<string> {
  const isWav = path.extname(input).toLowerCase() === ".wav";
  const ffmpeg = (await hasCommand("ffmpeg")) ? "ffmpeg" : null;
  if (!ffmpeg) {
    if (isWav) return input; // 直通降级，cpu 引擎内置重采样兜底
    throw new Error(`非 WAV 输入需要 ffmpeg（未找到）：${input}\n  macOS: brew install ffmpeg / Linux: apt install ffmpeg`);
  }
  await Bun.write(path.join(TMP_DIR, ".keep"), "");
  const base = path.basename(input, path.extname(input)) + ".wav";
  const out = path.join(TMP_DIR, base);
  const r = await run([
    ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
    "-i", input, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out,
  ]);
  if (r.code !== 0 || !existsSync(out)) {
    throw new Error(`ffmpeg 规范化失败：${input}\n${r.stderr.slice(-1000)}`);
  }
  return out;
}
