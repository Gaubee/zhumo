/**
 * 意图列表（维持 ≤5）：
 * 1. CPU 引擎适配（任意平台兜底，venv 内 python 执行 engines/cpu.py + sherpa-onnx SenseVoice）
 * 2. 模型目录解析与哨兵行 JSON 结果解析
 *
 * 原始需求（2026-10-01）：将 Qwen3-ASR 选型落地为书法项目的推荐转录配置，跨平台兼容。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { run, venvPython } from "../lib.ts";
import type { EngineAdapter, EngineResult, TranscribeOptions } from "./types.ts";

const SENTINEL = "###JSON###";
const MODEL_DIR = path.resolve(import.meta.dir, "..", "models", "sense-voice");

interface CpuPayload {
  text: string;
}

export const cpuAdapter: EngineAdapter = {
  kind: "cpu",
  async isReady(): Promise<boolean> {
    const modelReady =
      existsSync(path.join(MODEL_DIR, "model.int8.onnx")) && existsSync(path.join(MODEL_DIR, "tokens.txt"));
    if (!existsSync(venvPython())) return false;
    const r = await run([venvPython(), "-c", "import sherpa_onnx"]);
    return modelReady && r.code === 0;
  },
  async transcribe(opts: TranscribeOptions): Promise<EngineResult> {
    // cpu 引擎无 language/context 概念（SenseVoice 自动区分中英日韩粤）
    void opts;
    const r = await run([venvPython(), path.join(import.meta.dir, "cpu.py"), opts.wavPath, MODEL_DIR]);
    if (r.code !== 0) {
      throw new Error(`cpu 引擎失败（exit ${r.code}）\n${r.stderr.slice(-2000)}`);
    }
    const line = r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(SENTINEL))
      .pop();
    if (!line) throw new Error("cpu runner 未返回哨兵 JSON（模型文件缺失？先运行 setup.sh.ts）");
    const payload = JSON.parse(line.slice(SENTINEL.length)) as CpuPayload;
    return { text: payload.text };
  },
};
