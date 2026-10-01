/**
 * 意图列表（维持 ≤5）：
 * 1. 引擎就绪检查（未 setup 时给出可操作提示）
 * 2. 测试样本准备（macOS 用 say 合成中文语音；否则用模型自带样本/静音兜底）
 * 3. 端到端转录断言（真实语音要求非空且含汉字；静音仅验证管道连通）
 *
 * 原始需求（2026-10-01）：将 Qwen3-ASR 选型落地为书法项目的推荐转录配置，
 * 跨平台兼容，部署目标 Mac mini（部署后运行本脚本验收）。
 *
 * 用法：bun shufa-transcribe/check.sh.ts [--engine auto|mlx|cuda|cpu] [--model small|large]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectEngine, ROOT, run, TMP_DIR } from "./lib.ts";
import { resolveModel, type EngineAdapter, type EngineKind } from "./engines/types.ts";
import { mlxAdapter } from "./engines/mlx.ts";
import { cudaAdapter } from "./engines/cuda.ts";
import { cpuAdapter } from "./engines/cpu.ts";

const SAY_TEXT = "大家好，今天我们一起来学习楷书的基本笔画：横、竖、撇、捺、点。";

function pickAdapter(kind: EngineKind): EngineAdapter {
  switch (kind) {
    case "mlx": return mlxAdapter;
    case "cuda": return cudaAdapter;
    case "cpu": return cpuAdapter;
  }
}

/** 生成 1 秒 16kHz 单声道 s16 静音 WAV（仅验证管道连通）。 */
function makeSilenceWav(out: string): void {
  const sr = 16000;
  const n = sr; // 1 秒
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  writeFileSync(out, buf);
}

/** 优先级：say 合成中文（仅 macOS）→ 模型自带 zh.wav → 静音。 */
async function prepareSample(): Promise<{ wav: string; kind: "speech" | "silence" }> {
  if (process.platform === "darwin") {
    mkdirSync(TMP_DIR, { recursive: true });
    const wav = path.join(TMP_DIR, "check-sample.wav");
    let r = await run(["say", "-v", "Tingting", "-o", wav, "--data-format=LEI16@22050", SAY_TEXT]);
    if (r.code !== 0) {
      console.log("  ⚠️ 无 Tingting 中文语音，回退系统默认语音（识别结果可能非中文）");
      r = await run(["say", "-o", wav, "--data-format=LEI16@22050", SAY_TEXT]);
    }
    if (r.code === 0 && existsSync(wav)) return { wav, kind: "speech" };
    console.log("  ⚠️ say 合成失败，尝试兜底样本");
  }
  const zhSample = path.join(ROOT, "models", "sense-voice", "test_wavs", "zh.wav");
  if (existsSync(zhSample)) return { wav: zhSample, kind: "speech" };
  mkdirSync(TMP_DIR, { recursive: true });
  const silence = path.join(TMP_DIR, "silence.wav");
  makeSilenceWav(silence);
  console.log("  ⚠️ 无语音样本可用，使用静音样本（仅验证管道连通，不验证识别质量）");
  return { wav: silence, kind: "silence" };
}

const CJK = /\p{Script=Han}/u;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const engineArgIdx = argv.indexOf("--engine");
  const modelArgIdx = argv.indexOf("--model");
  const engine = (engineArgIdx >= 0 && argv[engineArgIdx + 1] && argv[engineArgIdx + 1] !== "auto"
    ? argv[engineArgIdx + 1]
    : await detectEngine()) as EngineKind;
  const model = resolveModel(engine, modelArgIdx >= 0 ? argv[modelArgIdx + 1] : undefined);

  console.log(`自检：引擎=${engine} 模型=${model} 平台=${process.platform}/${process.arch}`);
  const adapter = pickAdapter(engine);
  if (!(await adapter.isReady())) {
    console.error(`✗ 引擎未就绪。先运行：bun ${path.relative(process.cwd(), path.join(ROOT, "setup.sh.ts"))} --engine ${engine}`);
    return 1;
  }
  console.log("✓ 依赖就绪");

  const sample = await prepareSample();
  console.log(`样本：${sample.wav}（${sample.kind === "speech" ? "真实语音" : "静音"}）`);

  const t0 = performance.now();
  try {
    const result = await adapter.transcribe({ wavPath: sample.wav, model });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n识别结果（${secs}s）：\n${result.text}\n`);
    if (sample.kind === "speech") {
      if (result.text.length > 0 && CJK.test(result.text)) {
        console.log("✓ PASS：转录出中文文本");
        return 0;
      }
      console.error("✗ FAIL：真实语音未识别出中文文本");
      return 1;
    }
    console.log("✓ PASS：管道连通（静音样本，识别质量未验证——请用真实课程录音复测）");
    return 0;
  } catch (e) {
    console.error(`✗ FAIL：${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

process.exit(await main());
