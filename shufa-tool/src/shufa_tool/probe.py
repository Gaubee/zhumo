"""视频元数据探针：分辨率/时长/帧率/旋转矩阵。

意图（2026-09-22）：CLI 第一步，产出 ProbeInfo；旋转矩阵若存在则交给 orient 模块叠加内容探测。
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ProbeInfo:
    width: int
    height: int
    duration_s: float
    fps: float
    nb_frames: int
    metadata_rotation_cw: float  # 容器/display matrix 声明的顺时针旋转角度（度），无则 0
    has_audio: bool


def probe(video: Path) -> ProbeInfo:
    out = subprocess.run(
        [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", str(video),
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)
    vstream = next(s for s in data["streams"] if s["codec_type"] == "video")
    astreams = [s for s in data["streams"] if s["codec_type"] == "audio"]

    rotation = 0.0
    for sd in vstream.get("side_data_list", []) or []:
        if "displaymatrix" in sd:
            # ffmpeg 约定：rotation 为逆时针度数，取负转为顺时针
            rotation = -float(sd["rotation"])
    tags = vstream.get("tags", {}) or {}
    if "rotate" in tags:
        rotation = float(tags["rotate"])

    return ProbeInfo(
        width=int(vstream["width"]),
        height=int(vstream["height"]),
        duration_s=float(data["format"]["duration"]),
        fps=eval(vstream.get("r_frame_rate", "30/1")) if "/" in vstream.get("r_frame_rate", "") else float(vstream.get("r_frame_rate", 30)),  # noqa: S307
        nb_frames=int(vstream.get("nb_frames", 0)),
        metadata_rotation_cw=rotation % 360,
        has_audio=len(astreams) > 0,
    )
