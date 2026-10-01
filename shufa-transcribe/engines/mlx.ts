/**
 * 意图列表（维持 ≤5）：
 * 1. MLX 引擎适配（macOS Apple Silicon，venv 内 mlx-qwen3-asr CLI）
 * 2. 参数映射与 stdout 文本回收
 *
 * 原始需求（2026-10-01）：将 Qwen3-ASR 选型落地为书法项目的推荐转录配置，跨平台兼容。
 * 说明：CLI 高级能力（--timestamps/--diarize/-f srt 等本适配器未暴露），
 * 直接使用 `.venv/bin/mlx-qwen3-asr --help` 查看。
 */
import { existsSync } from "node:fs";
import { run, venvBin } from "../lib.ts";
import type { EngineAdapter, EngineResult, TranscribeOptions } from "./types.ts";

export const mlxAdapter: EngineAdapter = {
  kind: "mlx",
  async isReady(): Promise<boolean> {
    return existsSync(venvBin("mlx-qwen3-asr"));
  },
  async transcribe(opts: TranscribeOptions): Promise<EngineResult> {
    const args = [
      venvBin("mlx-qwen3-asr"),
      opts.wavPath,
      "--model", opts.model,
      "-f", "txt",
      "--stdout-only", // 只打印不落盘，由上层统一写出
    ];
    if (opts.language) args.push("--language", opts.language);
    if (opts.context) args.push("--context", opts.context);
    const r = await run(args);
    if (r.code !== 0) {
      throw new Error(`mlx 引擎失败（exit ${r.code}）\n${r.stderr.slice(-2000)}`);
    }
    return { text: r.stdout.trim() };
  },
};
