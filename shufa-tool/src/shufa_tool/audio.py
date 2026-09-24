"""音频转录：提取音轨 + mlx-whisper（可选依赖）。

意图（2026-09-22）：讲解内容总结需要语音转录；mlx-whisper 不可用时降级跳过，
HTML 仅呈现视觉产物。同音字修正表用于书法教学高频误转（桂字→柜子等）。
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

# whisper 高频同音字误转（教学语境）
ZH_FIXES: list[tuple[str, str]] = [
    ("柜子", "桂字"),
    ("桂花的桂字", "桂花的「桂」字"),
    ("对正其", "对正齐"),
    ("对正齐", "对齐"),
]


@dataclass
class Transcript:
    segments: list[dict] = field(default_factory=list)  # {start, end, text}
    language: str = "zh"
    model: str = ""

    @property
    def full_text(self) -> str:
        return "".join(s["text"] for s in self.segments)


def extract_audio(video: Path, wav_out: Path) -> Path:
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(video),
         "-vn", "-ac", "1", "-ar", "16000", str(wav_out)],
        check=True,
    )
    return wav_out


def _apply_fixes(text: str) -> str:
    for a, b in ZH_FIXES:
        text = text.replace(a, b)
    return text


DEFAULT_MODEL_REPO = "mlx-community/whisper-large-v3-turbo"


def transcribe(wav: Path, model_repo: str | None = None) -> Transcript | None:
    """mlx-whisper 转录；未安装则返回 None（调用方降级）。

    仓库选择（走查四轮）：显式实参 > SHUFA_WHISPER_REPO（向导预热时由 daemon
    从 .env 透传）> 默认 large-v3-turbo。模型已由向导 warm_whisper 预热进
    HF 标准缓存，此处不再触发隐式下载。
    """
    repo = model_repo or os.environ.get("SHUFA_WHISPER_REPO", DEFAULT_MODEL_REPO)
    try:
        import mlx_whisper  # type: ignore[import-not-found]
    except ImportError:
        return None
    raw = mlx_whisper.transcribe(str(wav), path_or_hf_repo=repo, language="zh")
    segs = []
    for s in raw.get("segments", []):
        segs.append({
            "start": round(float(s["start"]), 2),
            "end": round(float(s["end"]), 2),
            "text": _apply_fixes(str(s["text"]).strip()),
        })
    # 记录实际解析出的 repo（显式实参/env/默认值三者合一），而非可能为 None
    # 的 model_repo 形参——否则 manifest/bundle 里 transcript.model 恒为 null
    # （2026-09-24 两次导出 500「与契约不符」的根因）。
    return Transcript(segments=segs, model=repo)
