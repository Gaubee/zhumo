# 意图：CPU 兜底引擎 runner（sherpa-onnx SenseVoice，被 engines/cpu.ts 子进程调用，结果经 ###JSON### 哨兵行返回）。
# 原始需求（2026-10-01）：跨平台兜底——无 MLX 也无 CUDA 的机器（含 Windows/Intel Mac）。
import json
import sys
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


def load_mono_16k(path: str) -> np.ndarray:
    """读 WAV 为 float32 单声道 16kHz。正常路径由上层 ffmpeg 规范化，此处仅防御直通的 WAV。"""
    with wave.open(path, "rb") as w:
        sr, ch, sw, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit(f"unexpected sample width {sw}, expect s16 wav")
    data = np.frombuffer(raw, dtype=np.int16)
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1).astype(np.int16)
    f = data.astype(np.float32) / 32768.0
    if sr != 16000:
        t = np.arange(len(f), dtype=np.float64) / sr
        target_n = int(len(f) * 16000 / sr)
        f = np.interp(np.linspace(0, t[-1], target_n), t, f).astype(np.float32)
    return f


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: cpu.py <wav> <model-dir>", file=sys.stderr)
        return 2
    wav, model_dir = sys.argv[1], Path(sys.argv[2])
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model_dir / "model.int8.onnx"),
        tokens=str(model_dir / "tokens.txt"),
        use_itn=True,  # 输出标点 + 数字规范化（ITN）
        num_threads=4,
    )
    stream = recognizer.create_stream()
    stream.accept_waveform(recognizer.sample_rate, load_mono_16k(wav))
    recognizer.decode_stream(stream)
    print("###JSON###" + json.dumps({"text": stream.result.text}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
