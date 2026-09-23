"""焦点区剪辑：从讲评视频裁出矩形区域 → 转正 → 小体积 H.264 mp4。

意图（原始需求 2026-09-22）：分析 HTML 需要"可控、可重播的动态讲解"——把老师
讲解焦点区域（bbox 为转正坐标系 (x,y,w,h)）从源视频裁成可循环 mp4，base64 内嵌
自包含 HTML。体积控制：360p / crf30 / veryfast / 24fps / AAC 64k（保留讲解人声）。
滤镜链顺序固定：先 transpose 转正（rotate_cw_steps 由 orient 模块产出，旋转元数据
缺失时使用）→ 再 crop（参数即转正坐标系）→ scale；bbox 先按转正后实际尺寸在
Python 侧钳制并对齐到偶数（libx264/yuv420p 要求，偶数 x/y 还避免色度错位）。
写后自验：ffprobe 校验时长>0、尺寸正确、大小>0，失败抛 RuntimeError（含 stderr 尾部）。
"""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
from pathlib import Path

_HOMEBREW_BIN = "/opt/homebrew/bin"
_STD_VCODEC = [
    "-c:v", "libx264", "-crf", "30", "-preset", "veryfast",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
]


def _bin(name: str) -> str:
    """定位 ffmpeg 系可执行文件：先 PATH，回退 Apple Silicon Homebrew 路径。"""
    found = shutil.which(name)
    if found:
        return found
    fallback = Path(_HOMEBREW_BIN) / name
    if fallback.exists():
        return str(fallback)
    raise RuntimeError(f"{name} 不可用：不在 PATH，也不在 {_HOMEBREW_BIN}/{name}")


def _transpose_filters(steps: int) -> list[str]:
    """顺时针 90° 步数 → ffmpeg transpose 滤镜（3 ≡ 逆时针 90°，一次搞定）。"""
    steps %= 4
    if steps == 0:
        return []
    if steps == 1:
        return ["transpose=1"]  # 顺时针 90°
    if steps == 2:
        return ["transpose=1", "transpose=1"]
    return ["transpose=2"]


def _source_dims(video: Path) -> tuple[int, int]:
    """读取原始存储宽高（transpose 作用在存储帧上，与容器旋转元数据无关）。"""
    out = subprocess.run(
        [_bin("ffprobe"), "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "json", str(video)],
        capture_output=True, text=True, check=True, timeout=60,
    ).stdout
    s = json.loads(out)["streams"][0]
    return int(s["width"]), int(s["height"])


def _clamp_even(
    bbox: tuple[int, int, int, int], width: int, height: int,
) -> tuple[int, int, int, int]:
    """bbox 钳进转正坐标系边界并四元对齐偶数；返回 (x, y, w, h)。"""
    x, y, w, h = (int(v) for v in bbox)
    x = max(0, min(x, width - 2)) & ~1
    y = max(0, min(y, height - 2)) & ~1
    w = max(2, min(w, width - x)) & ~1
    h = max(2, min(h, height - y)) & ~1
    return x, y, w, h


def make_focus_clip(
    video: Path,
    out_path: Path,
    bbox: tuple[int, int, int, int],   # 转正坐标系 (x, y, w, h)
    rotate_cw_steps: int = 0,          # 顺时针 90° 步数
    start_s: float = 0.0,
    end_s: float | None = None,        # None = 到片尾
    height: int = 360,
    with_audio: bool = True,
    enhance: bool = True,              # 音频降噪+响度归一 / 视频降噪+统一调色
) -> dict:
    """单遍 ffmpeg 裁剪焦点区 → 转正 mp4。返回 {"path", "bytes", "duration_s", "mime"}。

    enhance：麦克风远近/环境噪声 → afftdn 降噪 + loudnorm 响度归一（EBU R128，
    播放音量稳定）；画质 → hqdn3d 时域降噪 + eq 轻度统一对比/饱和。滤镜均为
    单遍低成本（实测整片编码 +50% 以内，6s 级），故默认开启。
    """
    if end_s is not None and end_s <= start_s:
        raise ValueError(f"end_s ({end_s}) 必须大于 start_s ({start_s})")

    src_w, src_h = _source_dims(video)
    if rotate_cw_steps % 2 == 1:
        src_w, src_h = src_h, src_w  # 转正后宽高互换，bbox 在该坐标系下钳制
    x, y, w, h = _clamp_even(bbox, src_w, src_h)

    chain = _transpose_filters(rotate_cw_steps)
    chain.append(f"crop=w={w}:h={h}:x={x}:y={y}")
    if enhance:
        # 在裁剪后的小画面上做降噪/调色，省算力；轻度参数避免涂抹笔迹细节
        chain.append("hqdn3d=1.5:1.5:6:6")
        chain.append("eq=contrast=1.06:saturation=1.05")
    chain.append(f"scale=-2:{int(height)}")  # -2 = 宽取偶数，保住 yuv420p
    chain.append("fps=24")

    cmd = [
        _bin("ffmpeg"), "-y", "-nostdin", "-v", "error",
        "-ss", f"{start_s:.3f}", "-i", str(video),
    ]
    if end_s is not None:
        cmd += ["-t", f"{end_s - start_s:.3f}"]
    cmd += ["-map", "0:v:0"]
    if with_audio:
        cmd += ["-map", "0:a:0?"]  # "?" = 源无音轨时不报错，仅出视频
    cmd += ["-vf", ",".join(chain), *_STD_VCODEC]
    if with_audio:
        if enhance:
            cmd += ["-af", "afftdn=nr=10:nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11"]
        cmd += ["-c:a", "aac", "-b:a", "64k"]
    else:
        cmd += ["-an"]
    cmd.append(str(out_path))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired as e:
        out_path.unlink(missing_ok=True)
        raise RuntimeError(f"ffmpeg 编码超时（>600s）：{e}") from e
    if proc.returncode != 0:
        out_path.unlink(missing_ok=True)  # 不留半成品给 HTML 内嵌
        tail = "\n".join(proc.stderr.strip().splitlines()[-15:])
        raise RuntimeError(f"ffmpeg 编码失败（exit {proc.returncode}）：\n{tail}")

    return _verify(out_path, int(height), w, h)


def _verify(out_path: Path, height: int, crop_w: int, crop_h: int) -> dict:
    """写后自验：文件非空 + h264 + 时长>0 + 尺寸符合滤镜链预期。"""
    if not out_path.is_file() or out_path.stat().st_size == 0:
        raise RuntimeError(f"自验失败：{out_path} 不存在或为空")
    out = subprocess.run(
        [_bin("ffprobe"), "-v", "error", "-show_format", "-show_streams",
         "-of", "json", str(out_path)],
        capture_output=True, text=True, check=True, timeout=60,
    ).stdout
    data = json.loads(out)
    vs = next(s for s in data["streams"] if s["codec_type"] == "video")
    duration = float(data["format"].get("duration") or 0)
    exp_w = round(crop_w * height / crop_h)
    exp_w += exp_w % 2  # scale=-2 取偶
    problems = []
    if vs.get("codec_name") != "h264":
        problems.append(f"codec={vs.get('codec_name')}（应为 h264）")
    if duration <= 0:
        problems.append(f"duration={duration}")
    if int(vs["height"]) != height:
        problems.append(f"height={vs['height']}（应为 {height}）")
    if abs(int(vs["width"]) - exp_w) > 2:
        problems.append(f"width={vs['width']}（应约 {exp_w}）")
    if problems:
        out_path.unlink(missing_ok=True)
        raise RuntimeError("剪辑自验失败：" + "；".join(problems))
    return {
        "path": out_path,
        "bytes": out_path.stat().st_size,
        "duration_s": duration,
        "mime": "video/mp4",
    }


def b64_video(path: Path) -> str:
    """mp4 → base64 字符串（供 data URI 内嵌：data:video/mp4;base64,<返回值>）。"""
    return base64.b64encode(path.read_bytes()).decode("ascii")
