"""内容旋转探测：容器无旋转矩阵时，从画面本身推断转正方向。

意图（2026-09-22，原始需求"视频有旋转问题"）：
- 阶段一：投影轮廓法在 {0,90,180,270} 中选出"文字行水平"的候选（90° 步进消除）。
  印刷文字行在正确朝向下，行方向暗像素投影呈强周期峰值；旋转 90° 后投影平滑。
- 阶段二（180° 消歧）在 grid.py 检出田字格后进行：拼音标签带位于格子"上方"为正立。
"""

from __future__ import annotations

import cv2
import numpy as np

from .frames import rotate_cw


def _row_profile_peakiness(gray: np.ndarray) -> float:
    """文字行周期性强度：纸面墨迹行投影的 FFT 谱峰占比（行距滞后带 25~95px）。

    两个关键防误判（2026-09-22 实测迭代）：
    - 只统计"最大亮连通域（纸面）"内的中等灰度墨迹，排除深色纸板/桌面的锐利边界；
    - 用谱峰占比而非高频 std——std 会被孤立锐边（纸边、桌面交界）虚假抬高。
    实测：正确族 0.12~0.17 vs 错误族 0.015~0.03，5~8× 分离，多帧一致。
    180° 步进无判别力（周期性翻转不变），交给拼音带裁决。
    """
    med = float(np.median(gray))
    bright = (gray > med - 15).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bright)
    if n < 2:
        return 0.0
    big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    page = cv2.dilate((labels == big).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    ink = (gray < med - 25) & page
    prof = ink.sum(axis=1) / np.maximum(page.sum(axis=1), 1).astype(np.float32)
    prof = prof - prof.mean()
    smooth = np.convolve(prof, np.ones(31) / 31, mode="same")
    hf = prof - smooth
    spec = np.abs(np.fft.rfft(hf)) ** 2
    freqs = np.fft.rfftfreq(len(hf))
    band = (freqs > 1 / 95) & (freqs < 1 / 25)
    return float(spec[band].max() / (spec.sum() + 1e-9))


def detect_orientation_steps(frame: np.ndarray) -> tuple[int, dict[int, float]]:
    """返回应顺时针旋转的 90° 步数（在 0/2 二选一意义下）及各候选得分。

    只消 90° 步进：得分最高的候选 c 与 c+2 同为"文字水平"，取较低者，
    180° 由 orient_flip_by_pinyin 在田字格检出后裁决。
    """
    scores: dict[int, float] = {}
    gray0 = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    for cw in range(4):
        scores[cw] = _row_profile_peakiness(rotate_cw(gray0, cw))
    # 得分最高者即"文字行水平"的朝向；其 +2 族成员同为水平，180° 交给拼音带裁决
    best = max(scores, key=scores.get)  # type: ignore[arg-type]
    return best, scores


def orient_flip_by_pinyin(
    gray: np.ndarray,
    quads: list[np.ndarray],
    band_h: float = 0.5,
) -> tuple[bool, float]:
    """180° 裁决：正立时拼音标签带在田字格上方（多数票）。

    必须传入锐利单帧的灰度图——合成背景会洗掉小字号拼音，导致误判
    （2026-09-22 实证：bg 合成上裁决误翻 180°，单帧 3/3 格投票正确）。
    每格比较上方/下方各 band_h 格高带的墨迹密度，≥2/3 格投"下"才翻转。
    返回 (是否翻转, 平均置信度)。
    """
    dark = (gray < np.clip(np.median(gray) - 38, 0, 255)).astype(np.float32)
    H = gray.shape[0]
    ups, downs, votes = [], [], []
    for q in quads:
        xs, ys = q[:, 0], q[:, 1]
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = float(ys.min()), float(ys.max())
        h = y1 - y0
        if h < 8:
            continue
        top = dark[max(0, int(y0 - band_h * h)):max(0, int(y0)), x0:x1]
        bot = dark[min(H, int(y1)):min(H, int(y1 + band_h * h)), x0:x1]
        if top.size == 0 or bot.size == 0:
            continue
        up, down = float(top.mean()), float(bot.mean())
        ups.append(up)
        downs.append(down)
        votes.append(down > up)
    if not votes:
        return False, 0.0
    flip_votes = sum(votes)
    need = max(2, (len(votes) * 2 + 1) // 3)
    conf = float(np.median([abs(u - d) / max(u, d, 1e-6)
                            for u, d in zip(ups, downs)]))
    return flip_votes >= need, conf
