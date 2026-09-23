"""笔迹提取：动态墨迹掩码、旁注连通域聚类、出现时间线。

意图（2026-09-22）：
- 印刷体与开场已写内容是静态的（首帧即有），讲解时新增的旁注是动态墨迹。
- dynamic = (bg - 末帧) 且不属于 dilate(首帧墨迹)。
- 每个旁注簇取末帧裁剪 + 首次出现时间（计数达到末帧 25% 并连续 2 帧）。
- 另输出：每帧旁注区墨量曲线（HTML 折线）、田字格内墨量曲线。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Annotation:
    bbox: tuple[int, int, int, int]     # x, y, w, h（末帧全图坐标）
    first_ts: float                      # 首次出现（秒）
    mask_crop: np.ndarray                # 末帧动态墨迹掩码（bbox 裁剪）
    pixels: int                          # 末帧墨迹像素数


@dataclass
class InkAnalysis:
    annotations: list[Annotation] = field(default_factory=list)
    ink_curve: list[float] = field(default_factory=list)      # 每帧动态墨量（平静区间内）
    raw_curve: list[float] = field(default_factory=list)      # 每帧原始动态墨量(运动敏感)
    grid_ink_curves: dict[int, list[float]] = field(default_factory=dict)  # 格 idx → 帧墨量
    last_frame_idx: int = 0
    clean_final_idx: int = 0   # 末段无手且旁注最全的帧（用于裁剪）
    annotation_map: np.ndarray | None = None   # 旁注全图（最强证据合成）
    analysis_end: int = 0                      # 平静区间终点（不含）
    dropped_clusters: int = 0                  # 未通过首现校验而丢弃的簇数


MAX_BLOB_PX = 8000  # 手/手臂连通域远大于笔画（实测手 ~22k px，笔画 ≤4k）


def _remove_large_blobs(mask: np.ndarray, max_px: int = MAX_BLOB_PX) -> np.ndarray:
    n, labels, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8))
    out = mask.copy()
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] > max_px:
            out[labels == i] = 0
    return out


def _ink_of(frame_gray: np.ndarray, bg_gray: np.ndarray, thresh: int = 16) -> np.ndarray:
    diff = cv2.subtract(bg_gray.astype(np.int16), frame_gray.astype(np.int16))
    mask = (diff > thresh).astype(np.uint8) * 255
    return cv2.medianBlur(mask, 3)  # 去椒盐


def _low_sat(frame_bgr: np.ndarray, thr: int = 60) -> np.ndarray:
    """低饱和度掩码：灰铅笔笔迹 S<60；皮肤/黄铅笔高饱和，一招物理分离。"""
    s = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)[:, :, 1]
    return s < thr


def analyze_ink(
    frames_bgr: list[np.ndarray],
    bg_bgr: np.ndarray,
    grid_boxes: list[tuple[int, int, int, int]],
    timestamps: list[float],
    shifts: list[tuple[float, float]] | None = None,
) -> InkAnalysis:
    result = InkAnalysis(last_frame_idx=len(frames_bgr) - 1)
    bg_gray = cv2.cvtColor(bg_bgr, cv2.COLOR_BGR2GRAY)
    frames_gray = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames_bgr]

    # 曝光归一化：自动曝光随手/画面变化（本视频纸面灰度 172~188 波动），
    # 不归一则开场暗帧会整页误报、亮帧笔迹丢失。以背景纸面灰度为基准，
    # 逐帧加性平移对齐。
    med_bg = float(np.median(bg_gray))
    page_sel = bg_gray > med_bg - 15
    p_bg = float(np.median(bg_gray[page_sel])) if page_sel.sum() else med_bg
    normed: list[np.ndarray] = []
    for g in frames_gray:
        sel = g > med_bg - 15
        p = float(np.median(g[sel])) if sel.sum() > 1000 else p_bg
        normed.append(np.clip(g.astype(np.int16) + int(round(p_bg - p)), 0, 255).astype(np.uint8))

    static = _ink_of(normed[0], bg_gray)
    static_dil = cv2.dilate(static, np.ones((5, 5), np.uint8), iterations=2)

    dynamic_masks: list[np.ndarray] = []
    for i, fr_bgr in enumerate(frames_bgr):
        ink = _ink_of(normed[i], bg_gray)
        dyn = cv2.bitwise_and(ink, cv2.bitwise_not(static_dil))
        # 去掉田字格内部：格内变化（笔尖指示）不并入旁注
        for (x, y, w, h) in grid_boxes:
            dyn[y:y + h, x:x + w] = 0
        # 颜色过滤：只保留灰色笔迹像素（去手/铅笔杆）
        dyn = cv2.bitwise_and(dyn, ( _low_sat(fr_bgr).astype(np.uint8) * 255))
        dyn = _remove_large_blobs(dyn)  # 残余大块（阴影等）兜底
        dynamic_masks.append(dyn)
        result.raw_curve.append(float((dyn > 0).sum()))

    # 尾部运动截断：视频结尾常有翻页/移镜。运动检测看"原始"动态量——
    # 页面移动时持久化 AND 先崩塌、曲线先跌，原始差分才暴涨。
    def _calm(i: int) -> bool:
        if result.raw_curve[i] > 12000:
            return False
        if shifts is not None and i > 0:
            jx = abs(shifts[i][0] - shifts[i - 1][0])
            jy = abs(shifts[i][1] - shifts[i - 1][1])
            if max(jx, jy) > 2.0:
                return False
        return True

    calm_frames = [i for i in range(len(dynamic_masks)) if _calm(i)]
    end = (max(calm_frames) + 1) if calm_frames else len(dynamic_masks)

    # 复现过滤：铅笔笔迹对比度仅 5~15 灰阶，单帧时隐时现（实测像素轨迹：
    # 同一像素对比度 6↔94 波动），逐帧 AND 会整段抹掉真笔迹，逐帧 OR 会
    # 累积全部瞬态噪声（实测 115k px 噪声网）。笔迹一旦写入会反复出现——
    # 取"出现 ≥4 帧"的像素为墨迹，噪声（视差边缘/阴影）通常无此持续性。
    freq = np.zeros(dynamic_masks[0].shape, np.uint16)
    for i in range(end):
        freq += (dynamic_masks[i] > 0).astype(np.uint16)
    recurrent = (freq >= 4).astype(np.uint8) * 255
    result.ink_curve = [float((dynamic_masks[i] > 0).sum()) for i in range(end)]
    result.annotation_map = recurrent
    result.analysis_end = end
    result.clean_final_idx = end - 1  # 最后平静帧（裁剪用）

    # 旁注语义约束：旁注必然写在某格附近（欧氏距离 ≤2.6 格边长），远离所有格
    # 的复现噪声（纸板边缘阴影、页面污渍）一律排除。实测标定：15s 长横指示线
    # 中心距格心 189px（保留），6s 语义不明晕染团 231px（排除）。
    def _near_grid(cx: float, cy: float) -> bool:
        for (x, y, w, h) in grid_boxes:
            r = 2.6 * max(w, h)
            gx, gy = x + w / 2, y + h / 2
            if (cx - gx) ** 2 + (cy - gy) ** 2 <= r * r:
                return True
        return False

    final = recurrent
    # 膨胀聚类：间距 < dil 的笔画合并为同一旁注组（12px：△△/口口/圭 组间距 ~30px+，
    # 曾用 25px 把三组合并成一簇，vision 验收 FAIL 后收紧）
    merged = cv2.dilate(final, np.ones((13, 13), np.uint8))
    n, labels = cv2.connectedComponents((merged > 0).astype(np.uint8))
    H, W = final.shape
    for lab in range(1, n):
        region = (labels == lab) & (final > 0)
        px = int(region.sum())
        if px < 200:  # 噪点/碎片
            continue
        ys, xs = np.where(region)
        x0, x1 = int(xs.min()), int(xs.max()) + 1
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        w, h = x1 - x0, y1 - y0
        if w > 0.9 * W or h > 0.9 * H:
            continue
        # 边缘/长条噪声：贴画面边（页缘、桌面交界）或极端长宽比
        if x0 <= 8 or y0 <= 8 or x1 >= W - 8 or y1 >= H - 8:
            continue
        if min(w, h) < 24 or max(w, h) / max(min(w, h), 1) > 4:
            continue
        if not _near_grid(x0 + w / 2, y0 + h / 2):
            continue
        # 首现时间：平滑覆盖率 ≥0.3 且随后 5 帧平均覆盖 ≥0.2（允许笔迹闪烁，
        # 排除单帧阴影/噪团突现）。永不触发 → 丢弃该簇（疑似持续噪声）。
        cov = []
        for i in range(end):
            c = int(((labels == lab) & (dynamic_masks[i] > 0)).sum())
            cov.append(c / max(px, 1))
        k = 2
        smooth = [sum(cov[max(0, i - k):i + 1]) / len(cov[max(0, i - k):i + 1])
                  for i in range(end)]
        onset = None
        for i in range(end):
            if smooth[i] < 0.3:
                continue
            window = cov[i:min(end, i + 5)]
            if window and sum(window) / len(window) >= 0.2:
                onset = i
                break
        if onset is None:
            result.dropped_clusters += 1
            continue
        first_ts = timestamps[onset]
        result.annotations.append(Annotation(
            bbox=(x0, y0, x1 - x0, y1 - y0),
            first_ts=first_ts,
            mask_crop=region[y0:y1, x0:x1].astype(np.uint8) * 255,
            pixels=px,
        ))
    result.annotations.sort(key=lambda a: (a.first_ts, a.bbox[1], a.bbox[0]))
    return result


def grid_ink_curves(
    frames_gray: list[np.ndarray],
    bg_gray: np.ndarray,
    grid_boxes: list[tuple[int, int, int, int]],
) -> dict[int, list[float]]:
    """每个田字格内墨量随时间变化（用于判断格内是否发生书写/指示活动）。"""
    out: dict[int, list[float]] = {}
    for gi, (x, y, w, h) in enumerate(grid_boxes):
        curve = []
        for fr in frames_gray:
            diff = cv2.subtract(
                bg_gray[y:y + h, x:x + w].astype(np.int16),
                fr[y:y + h, x:x + w].astype(np.int16),
            )
            curve.append(float((diff > 16).sum()))
        out[gi] = curve
    return out
