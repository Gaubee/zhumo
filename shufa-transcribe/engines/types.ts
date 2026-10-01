/**
 * 意图列表（维持 ≤5）：
 * 1. 引擎类型/模型档位的类型定义
 * 2. 引擎适配器统一协议（isReady + transcribe）
 * 3. 模型标识解析（档位 → 各引擎的具体模型 ID）
 *
 * 原始需求（2026-10-01）：将 Qwen3-ASR 选型落地为书法项目的推荐转录配置，
 * 跨平台兼容（macOS MLX / Linux CUDA / 通用 CPU），部署目标 Mac mini。
 */

export type EngineKind = "mlx" | "cuda" | "cpu";
export type ModelTier = "small" | "large";

export interface TranscribeOptions {
  /** 已规范化为 16kHz 单声道 s16 WAV 的音频路径 */
  wavPath: string;
  /** 解析后的最终模型标识（HF repo id，或 cpu 引擎的固定名） */
  model: string;
  /** 语言名（Qwen3 体系用英文全称如 "Chinese"）；不传 = 自动检测 */
  language?: string;
  /** 领域热词上下文（书法术语等），mlx/cuda 引擎支持 */
  context?: string;
}

export interface EngineResult {
  text: string;
  language?: string;
}

export interface EngineAdapter {
  kind: EngineKind;
  /** 依赖是否已安装（venv 内可执行文件存在性） */
  isReady(): Promise<boolean>;
  transcribe(opts: TranscribeOptions): Promise<EngineResult>;
}

/** 各引擎的模型档位映射。override 可传档位名或完整 HF repo id。 */
export function resolveModel(kind: EngineKind, override?: string): string {
  if (override === "small" || override === "large" || !override) {
    const tier: ModelTier = override ?? "small";
    switch (kind) {
      // 社区预量化权重（mlx-qwen3-asr 作者发布）：small=517MB，large≈2GB
      case "mlx":
        return tier === "small"
          ? "moona3k/mlx-qwen3-asr-0.6b-4bit"
          : "moona3k/mlx-qwen3-asr-1.7b-8bit";
      case "cuda":
        return tier === "small" ? "Qwen/Qwen3-ASR-0.6B" : "Qwen/Qwen3-ASR-1.7B";
      case "cpu":
        // SenseVoice-Small int8（2024-07-17 版支持标点/ITN；2025-09-09 粤语版无标点，不选）
        return "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17";
    }
  }
  return override; // 透传完整模型 id，便于自行指定量化变体
}
