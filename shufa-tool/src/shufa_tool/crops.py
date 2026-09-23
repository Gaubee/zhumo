"""裁剪输出：田字格透视转正裁剪、旁注增强裁剪、焦点区时间线序列。

意图（2026-09-22）：所有面向 HTML 的图像产物在此统一生成；
铅笔浅灰笔迹用 CLAHE + 灰阶拉伸增强；格内字另产"纯墨迹白底图"。
"""

from __future__ import annotations

import cv2
import numpy as np

GRID_OUT = 320  # 田字格裁剪输出边长


def order_quad_tl(q: np.ndarray) -> np.ndarray:
    """四角规范排序为 [左上, 右上, 右下, 左下]，保证透视裁剪方向一致。

    approxPolyDP 输出的角点顺序取决于轮廓追踪方向（外/内轮廓、起点任意），
    直接喂给 getPerspectiveTransform 会随机得到镜像/旋转的裁剪
    （2026-09-22 实证：田字格一览与焦点大图方向错乱，时间线正常——
    后者不经透视变换）。min/max(x+y / y-x) 启发式对近轴对齐四边形成立。
    """
    s = q[:, 0] + q[:, 1]
    d = q[:, 1] - q[:, 0]
    tl = q[int(np.argmin(s))]
    br = q[int(np.argmax(s))]
    tr = q[int(np.argmin(d))]
    bl = q[int(np.argmax(d))]
    return np.stack([tl, tr, br, bl]).astype(np.float32)


def warp_quad(img: np.ndarray, quad: np.ndarray, out_size: int = GRID_OUT,
              pad_ratio: float = 0.0) -> np.ndarray:
    """四边形区域透视变换为正方形（角点先规范排序，方向稳定）。

    pad_ratio>0 时向外扩边（用于带拼音上下文）。"""
    q = order_quad_tl(np.asarray(quad, dtype=np.float32))
    c0 = q.mean(axis=0)
    if pad_ratio > 0:
        q = c0 + (q - c0) * (1 + 2 * pad_ratio)
    dst = np.array(
        [[0, 0], [out_size - 1, 0], [out_size - 1, out_size - 1], [0, out_size - 1]],
        dtype=np.float32,
    )
    M = cv2.getPerspectiveTransform(q, dst)
    return cv2.warpPerspective(img, M, (out_size, out_size),
                               flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255))


def enhance_pencil(img_bgr: np.ndarray) -> np.ndarray:
    """浅灰铅笔笔迹增强：CLAHE + 2%/98% 灰阶拉伸。"""
    lab = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2LAB)
    l = lab[:, :, 0]
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    l = clahe.apply(l)
    lo, hi = np.percentile(l, 2), np.percentile(l, 98)
    l = np.clip((l.astype(np.float32) - lo) / max(hi - lo, 1) * 255, 0, 255).astype(np.uint8)
    lab[:, :, 0] = l
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def ink_render(mask: np.ndarray, size: int | None = None,
               color: tuple[int, int, int] = (60, 60, 70)) -> np.ndarray:
    """掩码 → 白底墨迹图（柔边）。"""
    soft = cv2.GaussianBlur(mask, (3, 3), 0).astype(np.float32) / 255.0
    out = np.full((*mask.shape, 3), 255, np.uint8)
    for c in range(3):
        out[:, :, c] = (255 - soft * (255 - color[c])).astype(np.uint8)
    if size is not None and size != mask.shape[0]:
        out = cv2.resize(out, (size, size), interpolation=cv2.INTER_CUBIC)
    return out
