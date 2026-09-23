"""音频转录：提取音轨 + mlx-whisper（可选依赖）。

意图（2026-09-22）：讲解内容总结需要语音转录；mlx-whisper 不可用时降级跳过，
HTML 仅呈现视觉产物。同音字修正表用于书法教学高频误转（桂字→柜子等）。
"""

from __future__ import annotations

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


def transcribe(wav: Path, model_repo: str = "mlx-community/whisper-large-v3-turbo") -> Transcript | None:
    """mlx-whisper 转录；未安装则返回 None（调用方降级）。"""
    try:
        import mlx_whisper  # type: ignore[import-not-found]
    except ImportError:
        return None
    raw = mlx_whisper.transcribe(str(wav), path_or_hf_repo=model_repo, language="zh")
    segs = []
    for s in raw.get("segments", []):
        segs.append({
            "start": round(float(s["start"]), 2),
            "end": round(float(s["end"]), 2),
            "text": _apply_fixes(str(s["text"]).strip()),
        })
    return Transcript(segments=segs, model=model_repo)
