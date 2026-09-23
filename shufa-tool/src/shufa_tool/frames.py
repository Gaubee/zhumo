"""抽帧与页面背景模型。

意图（2026-09-22）：均匀采样帧供全流程使用；用逐像素最大亮度合成"无笔迹页面背景"
（笔迹/手只让像素变暗且会移开，取历史最亮即还原纸面+印刷内容）。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import cv2
import numpy as np

TARGET_FPS = 2.0
MAX_FRAMES = 160


def sample_frames(video: Path, workdir: Path, fps: float = TARGET_FPS) -> list[float]:
    """均匀抽帧存 JPEG 到 workdir/frames，返回时间戳列表（秒）。"""
    fdir = workdir / "frames"
    fdir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(video),
         "-vf", f"fps={fps}", "-q:v", "2", str(fdir / "f_%04d.jpg")],
        check=True,
    )
    files = sorted(fdir.glob("f_*.jpg"))
    if len(files) > MAX_FRAMES:  # 超长视频二次抽样，保持均匀覆盖
        step = len(files) / MAX_FRAMES
        keep = {int(i * step) for i in range(MAX_FRAMES)}
        files = [f for i, f in enumerate(files) if i in keep]
    return [i / fps for i in range(len(files))]


def rotate_cw(img: np.ndarray, steps: int) -> np.ndarray:
    """顺时针旋转 steps 个 90°。"""
    k = (4 - steps % 4) % 4  # np.rot90 为逆时针
    return np.ascontiguousarray(np.rot90(img, k)) if k else img


def load_frames(fdir: Path, rotate_cw_steps: int = 0) -> list[np.ndarray]:
    """读取帧并顺时针旋转 rotate_cw_steps 个 90°。"""
    frames = []
    for f in sorted(fdir.glob("f_*.jpg")):
        img = cv2.imread(str(f))
        if img is None:
            continue
        frames.append(rotate_cw(img, rotate_cw_steps))
    return frames


def align_frames(frames: list[np.ndarray]) -> tuple[list[np.ndarray], list[tuple[float, float]]]:
    """相位相关估计每帧相对首帧的平移并回正，返回 (对齐帧, 平移列表)。

    手持漂移（本视频实测 dx -8.5~1.8px）若不校正：
    合成背景会把 1px 印刷线洗糊、bg-frame 差分在边缘产生双影噪声。
    """
    ref_gray = cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY).astype(np.float32)
    win = cv2.createHanningWindow((ref_gray.shape[1], ref_gray.shape[0]), cv2.CV_32F)
    H, W = ref_gray.shape
    aligned: list[np.ndarray] = [frames[0]]
    shifts: list[tuple[float, float]] = [(0.0, 0.0)]
    for f in frames[1:]:
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32)
        (dx, dy), _ = cv2.phaseCorrelate(ref_gray, g, win)
        aligned.append(align_to_ref(f, dx, dy))
        shifts.append((float(dx), float(dy)))
    return aligned, shifts


def page_background(frames: list[np.ndarray]) -> np.ndarray:
    """逐像素取历史最亮 → 无笔迹页面（印刷体保留，动态笔迹/手被去除）。

    输入必须是已对齐帧（见 align_frames）。
    """
    stack = np.stack(frames, axis=0)
    return np.max(stack, axis=0)


def align_to_ref(frame: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """按 (dx,dy) 平移帧至首帧坐标系。"""
    H, W = frame.shape[:2]
    M = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(frame, M, (W, H), flags=cv2.INTER_LINEAR,
                          borderValue=(255, 255, 255))
