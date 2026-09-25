"""音频转录：提取音轨 + 平台最优 whisper 引擎（可选依赖，W9 2026-09-27）。

意图（2026-09-22）：讲解内容总结需要语音转录；引擎不可用时降级跳过，HTML 仅
呈现视觉产物。同音字修正表用于书法教学高频误转（桂字→柜子等）。

引擎策略（Owner 裁决「每平台最优」）：darwin=mlx-whisper（Apple Silicon
本地最优；Intel mac 上 mlx 无构建 → 降级跳过，维持 W9 前行为）；win32/linux
=faster-whisper（CTranslate2，CPU int8 / CUDA auto）。两引擎产物统一投影为
segments[{start,end,text}]，下游（summarize/export）无感。
"""

from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

# whisper 高频同音字误转（教学语境）
ZH_FIXES: list[tuple[str, str]] = [
    ("柜子", "桂字"),
    ("桂花的桂字", "桂花的「桂」字"),
    # tǔ/tú 近音：2026-09-24 两次导出实录把「这个土…」误转成「这个图…」。
    # 只收完整短语，严禁一刀切把「图」换「土」（「图」是常用字）。
    # 顺序约束：成对短语必须排在「现在的这个图」之前——「现在的这个图跟
    # 这个图」同时命中两条，若「现在的这个图」先跑会吃掉前一个「图」，
    # 成对词条失配，残留「…跟这个图」漏修。两条与上方桂字段、下方对齐段
    # 的模式与产物互不含对方子串，无交叉影响。
    # 未收「个图有点靠里」「个图有点偏」类短变体：锚点不足，易误伤合法
    #「图」（如指版面图例的「那个图有点偏」），待更多实证再补。
    ("这个图跟这个图", "这个土跟这个土"),
    ("现在的这个图", "现在的这个土"),
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


MLX_MODEL_REPO = "mlx-community/whisper-large-v3-turbo"
FASTER_MODEL_REPO = "Systran/faster-whisper-large-v3-turbo"


def transcribe(wav: Path, model_repo: str | None = None) -> Transcript | None:
    """转录入口（W9 引擎策略层）：darwin=mlx-whisper、其余=faster-whisper；
    当前平台的引擎未安装则返回 None（调用方降级）。

    仓库选择（走查四轮）：显式实参 > SHUFA_WHISPER_REPO（向导预热时由 daemon
    从 .env 透传，值已是引擎族正确的仓库全名）> 平台默认 large-v3-turbo。
    模型已由向导 warm_whisper 预热进 HF 标准缓存，此处不再触发隐式下载。
    """
    repo = model_repo or os.environ.get("SHUFA_WHISPER_REPO", "")
    if sys.platform == "darwin":
        return _transcribe_mlx(wav, repo or MLX_MODEL_REPO)
    return _transcribe_faster(wav, repo or FASTER_MODEL_REPO)


def _project_segments(raw_segments, attr: bool) -> list[dict]:
    """统一投影 {start,end,text}（经 _apply_fixes）；attr=True 取属性（faster），
    否则按下标（mlx 返回 dict 列表）。"""
    segs = []
    for s in raw_segments:
        if attr:
            start, end, text = s.start, s.end, s.text
        else:
            start, end, text = s["start"], s["end"], s["text"]
        segs.append({
            "start": round(float(start), 2),
            "end": round(float(end), 2),
            "text": _apply_fixes(str(text).strip()),
        })
    return segs


def _transcribe_mlx(wav: Path, repo: str) -> Transcript | None:
    try:
        import mlx_whisper  # type: ignore[import-not-found]
    except ImportError:
        return None
    raw = mlx_whisper.transcribe(str(wav), path_or_hf_repo=repo, language="zh")
    segs = _project_segments(raw.get("segments", []), attr=False)
    return _finish(segs, repo)


def _transcribe_faster(wav: Path, repo: str) -> Transcript | None:
    try:
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]
    except ImportError:
        return None
    # device/compute auto：有 CUDA 用 float16、纯 CPU 用 int8（CTranslate2 语义）。
    # vad_filter 过滤静音段——长讲评视频里 whisper 静音幻觉的主要来源。
    model = WhisperModel(repo, device="auto", compute_type="auto")
    segments_iter, _info = model.transcribe(str(wav), language="zh", vad_filter=True)
    segs = _project_segments(segments_iter, attr=True)
    return _finish(segs, repo)


def _finish(segs: list[dict], repo: str) -> Transcript:
    # 记录实际解析出的 repo（显式实参/env/默认值三者合一），而非可能为 None
    # 的 model_repo 形参——否则 manifest/bundle 里 transcript.model 恒为 null
    # （2026-09-24 两次导出 500「与契约不符」的根因）。
    return Transcript(segments=segs, model=repo)
