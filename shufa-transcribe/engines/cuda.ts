/**
 * 意图列表（维持 ≤5）：
 * 1. CUDA 引擎适配（Linux + NVIDIA，venv 内 python 执行 engines/cuda.py）
 * 2. 哨兵行 JSON 结果解析
 *
 * 原始需求（2026-10-01）：将 Qwen3-ASR 选型落地为书法项目的推荐转录配置，跨平台兼容。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { run, venvPython } from "../lib.ts";
import type { EngineAdapter, EngineResult, TranscribeOptions } from "./types.ts";

const SENTINEL = "###JSON###";

interface CudaPayload {
  text: string;
  language: string | null;
}

function parseSentinelJson(stdout: string): CudaPayload {
  // from_pretrained 可能向 stdout 打进度信息，只认最后一个哨兵行
  const line = stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(SENTINEL))
    .pop();
  if (!line) throw new Error("cuda runner 未返回哨兵 JSON（模型加载失败？查看 stderr）");
  return JSON.parse(line.slice(SENTINEL.length)) as CudaPayload;
}

export const cudaAdapter: EngineAdapter = {
  kind: "cuda",
  async isReady(): Promise<boolean> {
    // qwen_asr 为 venv 内安装的第三方包，以可导入性探测代替文件存在性
    if (!existsSync(venvPython())) return false;
    const r = await run([venvPython(), "-c", "import qwen_asr"]);
    return r.code === 0;
  },
  async transcribe(opts: TranscribeOptions): Promise<EngineResult> {
    const args = [venvPython(), path.join(import.meta.dir, "cuda.py"), opts.wavPath, opts.model];
    if (opts.language) args.push(opts.language);
    const r = await run(args);
    if (r.code !== 0) {
      throw new Error(`cuda 引擎失败（exit ${r.code}）\n${r.stderr.slice(-2000)}`);
    }
    const payload = parseSentinelJson(r.stdout);
    return { text: payload.text, language: payload.language ?? undefined };
  },
};
