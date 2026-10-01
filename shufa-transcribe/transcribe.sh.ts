/**
 * 意图列表（维持 ≤5）：
 * 1. CLI 参数解析（输入/引擎/模型/语言/热词/输出目录/dry-run）
 * 2. 输入收集（文件与目录展开为音频清单）
 * 3. 引擎选择（--engine > 环境变量 TRANSCRIBE_ENGINE > 平台自动探测）
 * 4. 批量派发与统一输出（每个音频写同名 .txt，旁边或 --out 目录）
 *
 * 原始需求（2026-10-01）：将 Qwen3-ASR 选型落地为书法项目的推荐转录配置，
 * 跨平台兼容（macOS MLX / Linux CUDA / 通用 CPU），部署目标 Mac mini。
 *
 * 用法：bun shufa-transcribe/transcribe.sh.ts <音频文件或目录...> [选项]
 *   --engine auto|mlx|cuda|cpu   引擎选择（默认 auto）
 *   --model small|large|<HF id>  模型档位（默认 small）
 *   --lang <Language>            语言固定（如 Chinese/English；默认自动检测）
 *   --context "楷书 中锋 提按…"   领域热词（mlx/cuda 引擎支持）
 *   --out <dir>                  输出目录（默认写音频旁边）
 *   --dry-run                    只打印执行计划
 */
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { AUDIO_EXTS, detectEngine, ensureWav16k, ROOT } from "./lib.ts";
import { resolveModel, type EngineAdapter, type EngineKind } from "./engines/types.ts";
import { mlxAdapter } from "./engines/mlx.ts";
import { cudaAdapter } from "./engines/cuda.ts";
import { cpuAdapter } from "./engines/cpu.ts";

interface CliOptions {
  inputs: string[];
  engine?: EngineKind;
  model?: string;
  language?: string;
  context?: string;
  outDir?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { inputs: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--engine": o.engine = argv[++i] as EngineKind; break;
      case "--model": o.model = argv[++i]; break;
      case "--lang": o.language = argv[++i]; break;
      case "--context": o.context = argv[++i]; break;
      case "--out": o.outDir = argv[++i]; break;
      case "--dry-run": o.dryRun = true; break;
      default: o.inputs.push(a);
    }
  }
  return o;
}

/** 目录递归展开 + 后缀过滤；非法输入直接抛错。 */
async function expandInput(input: string): Promise<string[]> {
  const st = await stat(input).catch(() => null);
  if (st === null) throw new Error(`输入不存在：${input}`);
  if (st.isFile()) return [input];
  const pattern = `**/*.{${AUDIO_EXTS.join(",")}}`;
  const entries = await new Bun.Glob(pattern).scan({ cwd: input, onlyFiles: true });
  return entries.sort().map((rel) => path.join(input, rel));
}

const VALID_ENGINES: readonly EngineKind[] = ["mlx", "cuda", "cpu"];

function pickAdapter(kind: EngineKind): EngineAdapter {
  switch (kind) {
    case "mlx": return mlxAdapter;
    case "cuda": return cudaAdapter;
    case "cpu": return cpuAdapter;
  }
}

const CJK = /\p{Script=Han}/u;

async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2));
  if (o.inputs.length === 0) {
    console.error("用法：bun shufa-transcribe/transcribe.sh.ts <音频文件或目录...> [--engine auto|mlx|cuda|cpu] [--model small|large] [--lang Chinese] [--context 热词] [--out dir] [--dry-run]");
    return 2;
  }

  const engine = o.engine ?? (process.env.TRANSCRIBE_ENGINE as EngineKind | undefined) ?? (await detectEngine());
  if (!VALID_ENGINES.includes(engine)) {
    console.error(`✗ 未知引擎 "${engine}"（可选：${VALID_ENGINES.join("/")})`);
    return 2;
  }
  const adapter = pickAdapter(engine);
  const model = resolveModel(engine, o.model);

  const files: string[] = [];
  for (const input of o.inputs) files.push(...(await expandInput(input)));
  const unique = [...new Set(files)];
  if (unique.length === 0) {
    console.error(`未找到音频文件（支持：${AUDIO_EXTS.join("/")}）`);
    return 2;
  }

  if (o.dryRun) {
    console.log(`[dry-run] 引擎=${engine} 模型=${model} 语言=${o.language ?? "自动"} 文件数=${unique.length}`);
    for (const f of unique) console.log(`  - ${f}`);
    return 0;
  }

  if (!(await adapter.isReady())) {
    console.error(`引擎 ${engine} 未就绪。请先运行：bun ${path.relative(process.cwd(), path.join(ROOT, "setup.sh.ts"))} --engine ${engine}`);
    return 1;
  }

  if (o.outDir) mkdirSync(o.outDir, { recursive: true });
  const usedNames = new Set<string>();
  const t0 = performance.now();
  let ok = 0;
  const failures: string[] = [];

  for (const file of unique) {
    const base = path.basename(file, path.extname(file));
    const started = performance.now();
    try {
      const wav = await ensureWav16k(file);
      const result = await adapter.transcribe({ wavPath: wav, model, language: o.language, context: o.context });
      const outPath = (() => {
        if (!o.outDir) return path.join(path.dirname(file), `${base}.txt`);
        let name = `${base}.txt`;
        let n = 2;
        while (usedNames.has(name)) name = `${base}_${n++}.txt`; // 批内同名防覆盖
        usedNames.add(name);
        return path.join(o.outDir, name);
      })();
      await Bun.write(outPath, result.text + "\n");
      ok++;
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      const han = result.text.length > 0 && CJK.test(result.text);
      console.log(`✓ ${path.relative(process.cwd(), file)} [${engine}/${model}] ${secs}s ${result.text.length}字${han ? "" : " ⚠️无中文"} → ${path.relative(process.cwd(), outPath)}`);
    } catch (e) {
      failures.push(file);
      console.error(`✗ ${file}：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const total = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`\n完成 ${ok}/${unique.length}（${total}s，引擎 ${engine}，模型 ${model}）`);
  return failures.length > 0 ? 1 : 0;
}

process.exit(await main());
