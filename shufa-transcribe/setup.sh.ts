/**
 * 意图列表（维持 ≤5）：
 * 1. 参数与目标引擎确定（--engine，默认平台探测）
 * 2. python ≥3.10 发现与 venv 创建（幂等）
 * 3. 引擎依赖安装（mlx-qwen3-asr / qwen-asr / sherpa-onnx）
 * 4. CPU 引擎模型下载与解压（SenseVoice int8，幂等）
 *
 * 原始需求（2026-10-01）：将 Qwen3-ASR 选型落地为书法项目的推荐转录配置，
 * 跨平台兼容（macOS MLX / Linux CUDA / 通用 CPU），部署目标 Mac mini。
 *
 * 用法：bun shufa-transcribe/setup.sh.ts [--engine auto|mlx|cuda|cpu]
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { detectEngine, ROOT, run, TMP_DIR, venvDir, venvPython } from "./lib.ts";
import type { EngineKind } from "./engines/types.ts";

const SENSE_VOICE_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2";
const SENSE_VOICE_INNER_DIR = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
const SENSE_VOICE_DIR = path.join(ROOT, "models", "sense-voice");

/**
 * 各平台 python 解释器候选。版本化名称优先于裸 python3（避开 uv/CLT 等
 * 非常规构建）；darwin 追加 Homebrew 绝对路径兜底——uv 的版本化符号链接
 * 同样是独立构建、建出的 venv 是坏的（2026-10-01 实测 encodings 缺失），
 * 绝对路径保证命中真正的 brew 构建。实际胜负由 createVenv 的健康度实测决定。
 */
function pythonCandidates(): string[][] {
  if (process.platform === "win32") {
    return [["py", "-3"], ["python"], ["python3"]];
  }
  if (process.platform === "darwin") {
    return [
      ["python3.15"], ["python3.14"], ["python3.13"], ["python3.12"], ["python3.11"], ["python3.10"],
      ["/opt/homebrew/bin/python3.15"], ["/opt/homebrew/bin/python3.14"], ["/opt/homebrew/bin/python3.13"], ["/opt/homebrew/bin/python3.12"],
      ["python3"],
    ];
  }
  return [["python3.15"], ["python3.14"], ["python3.13"], ["python3.12"], ["python3.11"], ["python3.10"], ["python3"]];
}

async function pythonVersionOk(cmd: string[]): Promise<boolean> {
  const r = await run([...cmd, "--version"]);
  const m = /Python 3\.(\d+)/.exec(r.stdout + r.stderr);
  return r.code === 0 && m !== null && Number(m[1]) >= 10;
}

/** 建出的 venv 必须实测可导入（uv 等独立构建会产出 encodings 缺失的坏 venv）。 */
async function createVenv(cmd: string[]): Promise<boolean> {
  const r = await run([...cmd, "-m", "venv", venvDir()]);
  if (r.code !== 0) return false;
  const v = await run([venvPython(), "-c", "import encodings, ensurepip"]);
  return v.code === 0;
}

function rmVenv(): void {
  rmSync(venvDir(), { recursive: true, force: true });
}

async function pipInstall(packages: string[]): Promise<void> {
  console.log(`  pip install ${packages.join(" ")}`);
  const r = await run([venvPython(), "-m", "pip", "install", ...packages]);
  if (r.code !== 0) {
    throw new Error(`pip 安装失败：\n${(r.stdout + r.stderr).slice(-3000)}`);
  }
}

async function setupCpuModel(): Promise<void> {
  if (existsSync(path.join(SENSE_VOICE_DIR, "model.int8.onnx"))) {
    console.log("  ✓ SenseVoice 模型已存在，跳过下载");
    return;
  }
  console.log("  下载 SenseVoice int8 模型（228MB）…");
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(path.join(ROOT, "models"), { recursive: true });
  const archive = path.join(TMP_DIR, "sense-voice.tar.bz2");
  const dl = await run(["curl", "-L", "--fail", "--progress-bar", "-o", archive, SENSE_VOICE_URL]);
  if (dl.code !== 0) throw new Error(`模型下载失败：\n${dl.stderr.slice(-1000)}`);
  console.log("  解压…");
  const ex = await run(["tar", "-xjf", archive, "-C", TMP_DIR]);
  if (ex.code !== 0) throw new Error(`解压失败：\n${ex.stderr.slice(-1000)}`);
  const inner = path.join(TMP_DIR, SENSE_VOICE_INNER_DIR);
  if (!existsSync(inner)) throw new Error(`解压后未找到目录：${inner}`);
  renameSync(inner, SENSE_VOICE_DIR);
  console.log(`  ✓ 模型就位于 ${path.relative(process.cwd(), SENSE_VOICE_DIR)}`);
}

async function main(): Promise<number> {
  const argEngine = process.argv.find((_, i, a) => a[i - 1] === "--engine");
  const engine = (argEngine && argEngine !== "auto" ? argEngine : await detectEngine()) as EngineKind;
  console.log(`目标引擎：${engine}（平台 ${process.platform}/${process.arch}）`);

  // 1. python ≥3.10 + 健康 venv（现存 venv 异常时自动重建——目录搬迁/坏解释器）
  if (existsSync(venvDir())) {
    const health = await run([venvPython(), "-c", "import encodings, ensurepip"]);
    if (health.code !== 0) {
      console.log("  现存 venv 异常（搬迁后绝对路径失效或解释器问题），重建…");
      rmVenv();
    }
  }
  if (!existsSync(venvDir())) {
    let created = false;
    for (const cmd of pythonCandidates()) {
      if (!(await pythonVersionOk(cmd))) continue;
      console.log(`  创建 venv（${cmd.join(" ")}）…`);
      if (await createVenv(cmd)) {
        created = true;
        break;
      }
      console.log("  ⚠️ 该解释器建不出健康 venv（uv 等独立构建的已知问题），换下一个候选");
      rmVenv();
    }
    if (!created) {
      console.error("✗ 无可建健康 venv 的 python ≥3.10。macOS: brew install python@3.14；Ubuntu: apt install python3.12 python3.12-venv");
      return 1;
    }
  }
  await pipInstall(["--upgrade", "pip"]);

  // 2. 引擎依赖（物理隔离：每个引擎只装自己的栈）
  switch (engine) {
    case "mlx":
      // httpx[socks]：本机 SOCKS 代理（mihomo/Clash 系）下 HF 下载必需
      await pipInstall(["mlx-qwen3-asr", "httpx[socks]"]);
      console.log("  提示：非 WAV 输入需系统 ffmpeg（brew install ffmpeg）；首次转录自动从 HF 下载模型（约 517MB@small）");
      break;
    case "cuda":
      await pipInstall(["qwen-asr", "httpx[socks]"]); // torch 由其依赖带入（Linux PyPI 轮子含 CUDA）
      console.log("  提示：首次运行自动从 HF 下载模型（0.6B≈2GB / 1.7B≈5GB 权重 bf16）");
      break;
    case "cpu":
      await pipInstall(["sherpa-onnx", "numpy"]);
      await setupCpuModel();
      break;
  }

  console.log(`\n✓ setup 完成（引擎 ${engine}）。自检：bun ${path.relative(process.cwd(), path.join(ROOT, "check.sh.ts"))}`);
  if (!process.env.HF_ENDPOINT && engine !== "cpu") {
    console.log("  提示：HF 直连慢/失败时 → export HF_ENDPOINT=https://hf-mirror.com 后重试");
  }
  return 0;
}

process.exit(await main());
