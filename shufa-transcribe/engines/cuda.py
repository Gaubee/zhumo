# 意图：CUDA 服务器上的 Qwen3-ASR 推理 runner（被 engines/cuda.ts 以子进程调用，结果经 ###JSON### 哨兵行返回）。
# 原始需求（2026-10-01）：将 Qwen3-ASR 选型落地为书法项目的推荐转录配置（Linux+CUDA 路径）。
import json
import sys

import torch
from qwen_asr import Qwen3ASRModel


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: cuda.py <wav> <model-id> [language]", file=sys.stderr)
        return 2
    wav, model_id = sys.argv[1], sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 else None

    model = Qwen3ASRModel.from_pretrained(
        model_id,
        dtype=torch.bfloat16,
        device_map="cuda:0",
    )
    results = model.transcribe(audio=wav, language=language)
    r = results[0]
    payload = {"text": r.text, "language": getattr(r, "language", None)}
    print("###JSON###" + json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
