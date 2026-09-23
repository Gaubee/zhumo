"""田字格检测：在无笔迹页面背景上找"实线方框 + 内部虚线十字"的格子。

意图（2026-09-22）：印刷格线为细黑实线方框，内部横竖两条点状虚线。
流程：二值化 → findContours → 四边形近似 → 尺寸/方度过滤 →
边框覆盖检查 → 虚线中线软评分 → NMS 去重 → 按(行,列)排序。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Grid:
    quad: np.ndarray          # 4x2 float32，四角点（所在帧坐标系）
    side: float               # 平均边长(px)
    score: float              # 综合(边框覆盖, 虚线中线)得分
    row: int = 0
    col: int = 0
    label: str = ""           # 可选：人工/OCR 提供的拼音或字
    visibility: float = 1.0   # 边框覆盖率，部分遮挡时 <1
    frame_idx: int = 0        # 检出来源帧（换坐标系时需按该帧平移量校正）
    quad_src: np.ndarray | None = None  # 来源帧坐标系下的精化角点（裁剪用，零跨帧误差）

    @property
    def center(self) -> tuple[float, float]:
        return float(self.quad[:, 0].mean()), float(self.quad[:, 1].mean())


@dataclass
class GridDetection:
    grids: list[Grid] = field(default_factory=list)
    debug_overlay: np.ndarray | None = None


def _dark_mask(bg_gray: np.ndarray) -> np.ndarray:
    """印刷细线的自适应阈值：纸面中位数减固定偏移（细线是抗锯齿灰，非纯黑）。"""
    thr = float(np.median(bg_gray)) - 38
    mask = (bg_gray < max(thr, 40)).astype(np.uint8) * 255
    # 闭运算桥接抗锯齿断裂
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=2)


def _side_coverage(mask: np.ndarray, p: np.ndarray, q: np.ndarray) -> float:
    """线段 pq 上暗像素采样覆盖率。"""
    n = max(int(np.hypot(*(q - p))) // 2, 8)
    ts = np.linspace(0.04, 0.96, n)[:, None]
    pts = (p[None, :] * (1 - ts) + q[None, :] * ts).astype(np.float32)
    ok = 0
    for x, y in pts:
        x0, y0 = int(x), int(y)
        patch = mask[max(0, y0 - 1):y0 + 2, max(0, x0 - 1):x0 + 2]
        if patch.size and patch.max() > 0:
            ok += 1
    return ok / n


def _dashed_mid_score(mask: np.ndarray, quad: np.ndarray) -> float:
    """中线虚线评分：中行/中列上墨覆盖处于虚线区间且分段数≥3。"""
    v1 = quad[1] - quad[0]
    v2 = quad[3] - quad[0]
    scores = []
    half = 0.36  # 采样内部 72% 区域，避开边框
    for axis in (0, 1):  # 0=中行(沿 v1), 1=中列(沿 v2)
        pts = []
        for t in np.linspace(0.5 - half, 0.5 + half, 48):
            u, w = (t, 0.5) if axis == 0 else (0.5, t)
            pts.append(quad[0] + v1 * u + v2 * w)
        seg = np.array(pts, dtype=np.float32)
        hits = np.zeros(len(seg), dtype=bool)
        for i, (x, y) in enumerate(seg):
            x0, y0 = int(x), int(y)
            patch = mask[max(0, y0):y0 + 2, max(0, x0):x0 + 2]
            hits[i] = patch.size > 0 and patch.max() > 0
        cov = hits.mean()
        runs = int(np.sum(hits[1:] != hits[:-1]) + (1 if hits[0] else 0))
        dashed = (0.18 <= cov <= 0.8) and runs >= 4
        scores.append(1.0 if dashed else (0.4 if 0.12 <= cov <= 0.85 else 0.0))
    return float(sum(scores) / 2)


def detect_grids(bg_bgr: np.ndarray, min_side: int = 30, max_side: int = 220,
                 frame_idx: int = 0) -> GridDetection:
    gray = cv2.cvtColor(bg_bgr, cv2.COLOR_BGR2GRAY)
    mask = _dark_mask(gray)
    H, W = mask.shape
    lo, hi = min_side, max_side
    contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    cands: list[Grid] = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < lo * lo * 0.5 or area > hi * hi * 2.0:
            continue
        for eps in (0.02, 0.04, 0.06, 0.08):
            ap = cv2.approxPolyDP(cnt, eps * cv2.arcLength(cnt, True), True)
            if len(ap) == 4:
                break
        if len(ap) != 4:
            continue
        quad = ap.reshape(4, 2).astype(np.float32)
        sides = [np.linalg.norm(quad[i] - quad[(i + 1) % 4]) for i in range(4)]
        smin, smax = min(sides), max(sides)
        if not (lo <= smin and smax <= hi):
            continue
        if smin / smax < 0.72:  # 方度
            continue
        border = float(np.mean([
            _side_coverage(mask, quad[i], quad[(i + 1) % 4]) for i in range(4)
        ]))
        if border < 0.62:
            continue
        dash = _dashed_mid_score(mask, quad)
        cands.append(Grid(
            quad=quad, side=float(np.mean(sides)),
            score=border * 0.6 + dash * 0.4, visibility=border,
            frame_idx=frame_idx,
        ))
    # NMS（包含感知：小框被大框包含时 inter/min_area = 1，必删）
    cands.sort(key=lambda g: g.score, reverse=True)
    kept = _nms_kept(cands)
    _sort_rows_cols(kept)
    return GridDetection(grids=kept, debug_overlay=_overlay(bg_bgr, kept))


def _nms_kept(cands: list[Grid], thr: float = 0.5) -> list[Grid]:
    kept: list[Grid] = []
    for g in cands:
        x0, y0 = g.quad[:, 0].min(), g.quad[:, 1].min()
        x1, y1 = g.quad[:, 0].max(), g.quad[:, 1].max()
        drop = False
        for k in kept:
            kx0, ky0 = k.quad[:, 0].min(), k.quad[:, 1].min()
            kx1, ky1 = k.quad[:, 0].max(), k.quad[:, 1].max()
            ix = max(0, min(x1, kx1) - max(x0, kx0))
            iy = max(0, min(y1, ky1) - max(y0, ky0))
            inter = ix * iy
            smaller = min((x1 - x0) * (y1 - y0), (kx1 - kx0) * (ky1 - ky0))
            if smaller > 0 and inter / smaller > thr:
                drop = True
                break
        if not drop:
            kept.append(g)
    return kept


def refine_quad(gray: np.ndarray, quad: np.ndarray, search: int = 30) -> np.ndarray:
    """剖面峰值吸附：沿边法向扫描暗度覆盖剖面，把每条边吸到印刷边框上。

    动机（2026-09-22 Owner 验收，四轮迭代的最终形态）：桂格粗四边形底边 100px
    vs 顶边 75px——右下角被邻域墨迹带偏 25px，任何"围绕粗边做局部拟合"的方案
    （走廊 PCA/偏移直方图/RANSAC）都救不了腐坏的起点。剖面法不依赖粗边形状：
    印刷边框是"沿边跨度上暗度覆盖率最高的峰"（实证覆盖率 0.95 vs 局部笔画
    ≤0.6）。每个角独立吸附：竖边按上/下半剖面定 x，横边按左/右半剖面定 y，
    天然兼容页面 ~2° 旋转倾斜。峰值覆盖 <0.45 视为无边框证据，保留原位。
    """
    from .crops import order_quad_tl

    # 输入角点是 approxPolyDP 的任意顺序（实证有 [tl,bl,br,tr] 逆序），
    # 半带逻辑假设 [tl,tr,br,bl] 规范序——入口必须先规范化，否则角错位。
    q = order_quad_tl(np.asarray(quad, dtype=np.float32))
    thr = float(np.median(gray)) - 38
    dark = gray < max(thr, 40)
    H, W = gray.shape

    def snap_corner(ci: int, vertical: bool) -> None:
        """单角吸附：竖边角点在其行带内找最强暗列（定 x）；横边角点在其列带内
        找最强暗行（定 y）。行带/列带 = 该角所在半边（由调用方算好传入上下文）。"""
        if vertical:
            ymid_v = (q[0, 1] + q[3, 1]) / 2 if ci in (0, 3) else (q[1, 1] + q[2, 1]) / 2
            y0, y1 = int(min(q[ci, 1], ymid_v)), int(max(q[ci, 1], ymid_v))
            if y1 - y0 < 8:
                return
            x_now = int(round(q[ci, 0]))
            xs = np.arange(max(0, x_now - search), min(W, x_now + search + 1))
            if len(xs) < 5:
                return
            cov = np.asarray([dark[y0:y1, int(x)].mean() for x in xs])
            if cov.max() < 0.45:
                return
            q[ci, 0] = float(xs[int(np.argmax(cov))])
        else:
            xmid_h = (q[0, 0] + q[1, 0]) / 2 if ci in (0, 1) else (q[3, 0] + q[2, 0]) / 2
            x0, x1 = int(min(q[ci, 0], xmid_h)), int(max(q[ci, 0], xmid_h))
            if x1 - x0 < 8:
                return
            y_now = int(round(q[ci, 1]))
            ys = np.arange(max(0, y_now - search), min(H, y_now + search + 1))
            if len(ys) < 5:
                return
            cov = np.asarray([dark[int(y), x0:x1].mean() for y in ys])
            if cov.max() < 0.45:
                return
            q[ci, 1] = float(ys[int(np.argmax(cov))])

    for ci in range(4):  # 竖边角点：tl/bl 左竖边、tr/br 右竖边
        snap_corner(ci, vertical=True)
    for ci in range(4):  # 横边角点：tl/tr 上横边、bl/br 下横边
        snap_corner(ci, vertical=False)
    return order_quad_tl(q)


def _refine_once(gray: np.ndarray, quad: np.ndarray, corridor: int) -> np.ndarray:
    """单轮精化：走廊暗点集上的 RANSAC 直线拟合。

    为什么是 RANSAC（三轮实证迭代）：真边框在页面旋转/透视下是**斜线**，
    1D 偏移直方图假设偏移沿边恒定，斜线被摊薄到多个 bin、聚类失败；
    PCA 全量拟合则被走廊里的邻格线/铅笔团拉偏。RANSAC 对"主导直线 + 离群
    局部墨迹"是教科书解：内点最多的线胜出，内点需 t 覆盖率≥0.55（贯穿边），
    多条候选线取内点中位偏移最小者——粗边来自真实轮廓，真边线必是最近的
    强直线（邻格线远在 ~25px 外）。
    """
    from .crops import order_quad_tl

    thr = float(np.median(gray)) - 38
    dark = gray < max(thr, 40)
    H, W = gray.shape
    rng = np.random.default_rng(0)
    n_t = 42
    lines = []
    for i in range(4):
        p, q = quad[i], quad[(i + 1) % 4]
        d = q - p
        length = float(np.hypot(*d)) or 1.0
        dn = d / length
        nrm = np.array([-dn[1], dn[0]])
        cand: list[tuple[float, float, float]] = []  # (t, off, point)
        for ti, t in enumerate(np.linspace(0.08, 0.92, n_t)):
            base = p + dn * (t * length)
            for o in range(-corridor, corridor + 1):
                x = int(round(base[0] + nrm[0] * o))
                y = int(round(base[1] + nrm[1] * o))
                if 0 <= x < W and 0 <= y < H and dark[y, x]:
                    off = (x - base[0]) * nrm[0] + (y - base[1]) * nrm[1]
                    cand.append((ti * (1.0 / n_t), off, (float(x), float(y))))
        if len(cand) < 30:
            lines.append((p.copy(), q.copy()))
            continue
        pts = np.asarray([c[2] for c in cand])
        ts = np.asarray([c[0] for c in cand])
        offs = np.asarray([c[1] for c in cand])
        best: tuple[int, np.ndarray | None] = (0, None)
        n = len(pts)
        for _ in range(200):
            i1, i2 = rng.choice(n, 2, replace=False)
            if abs(ts[i1] - ts[i2]) < 0.3:  # 避免同局部队（同一 blob 两点假线）
                continue
            dv = pts[i2] - pts[i1]
            norm = float(np.hypot(*dv))
            if norm < 1e-3:
                continue
            dv = dv / norm
            nv = np.array([-dv[1], dv[0]])
            dist = np.abs((pts - pts[i1]) @ nv)
            inl = dist < 1.5
            cnt = int(inl.sum())
            if cnt > best[0]:
                best = (cnt, None if cnt < 20 else (inl, pts[i1], dv, nv))
        inl, base_pt, dv, nv = best[1] if best[1] else (None, None, None, None)
        ok = False
        if inl is not None:
            cov = len({round(float(t) * n_t) for t in ts[inl]}) / n_t
            med_off = float(np.median(offs[inl]))
            # 内点贯穿边（t 覆盖率）且线体离粗边不太远（邻格线会被此条淘汰）
            if cov >= 0.55 and abs(med_off) <= corridor:
                arr = pts[inl]
                mean = arr.mean(axis=0)
                _, _, vt = np.linalg.svd(arr - mean, full_matrices=False)
                dirv = vt[0]
                proj = (arr - mean) @ dirv
                lines.append((mean + dirv * proj.min(), mean + dirv * proj.max()))
                ok = True
        if not ok:
            lines.append((p.copy(), q.copy()))
    corners = []
    for i in range(4):
        (a0, a1), (b0, b1) = lines[i], lines[(i + 1) % 4]
        inter = _line_intersect(a0, a1, b0, b1)
        corners.append(inter if inter is not None else quad[(i + 1) % 4])
    return order_quad_tl(np.asarray(corners, dtype=np.float32))


def _line_intersect(p0: np.ndarray, p1: np.ndarray, q0: np.ndarray,
                    q1: np.ndarray) -> np.ndarray | None:
    d1, d2 = p1 - p0, q1 - q0
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) < 1e-6:
        return None
    t = ((q0[0] - p0[0]) * d2[1] - (q0[1] - p0[1]) * d2[0]) / den
    return p0 + d1 * t


def detect_grids_multiframe(frames: list[np.ndarray], top_k: int = 7,
                            bg: np.ndarray | None = None,
                            frame_activity: list[float] | None = None) -> GridDetection:
    """多帧投票检测：手持漂移会让合成背景洗掉 1px 印刷线，格线几何必须取自单帧。

    取最锐利的 top_k 帧分别检测，NMS 合并（位置跨帧仅差数 px，IoU 可并）。
    frame_activity：每帧"动态量"（手/阴影像素数）。手入镜会污染格框四边形
    （vision 实证：桂格框因来自有手帧而外扩 82px vs 真实 75px），
    候选得分按 1/(1+activity/2000) 降权，优先采纳无手帧的几何。
    """
    scored = []
    for i, f in enumerate(frames):
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        scored.append((cv2.Laplacian(g, cv2.CV_64F).var(), i))
    scored.sort(reverse=True)
    # 锐度 top_k 偏向后段（手入镜反而增加边缘数）；补首末帧保证手出现前的干净帧在列
    idxs = [i for _, i in scored[:top_k]]
    idxs += list(range(min(3, len(frames)))) + list(range(max(0, len(frames) - 3), len(frames)))
    all_grids: list[Grid] = []
    for i in dict.fromkeys(idxs):  # 去重保序
        d = detect_grids(frames[i], frame_idx=i)
        for g in d.grids:
            if frame_activity is not None and i < len(frame_activity):
                g.score *= 1.0 / (1.0 + frame_activity[i] / 2000.0)
            all_grids.append(g)
    all_grids.sort(key=lambda g: g.score, reverse=True)
    kept = _nms_kept(all_grids, thr=0.45)
    _sort_rows_cols(kept)
    canvas = bg if bg is not None else frames[scored[0][1]]
    return GridDetection(grids=kept, debug_overlay=_overlay(canvas, kept))


def _sort_rows_cols(grids: list[Grid]) -> None:
    """按 y 聚成行、行内按 x 排序，赋 row/col。"""
    if not grids:
        return
    grids.sort(key=lambda g: g.center[1])
    rows: list[list[Grid]] = []
    for g in grids:
        placed = False
        for row in rows:
            ref = row[0].center[1]
            if abs(g.center[1] - ref) < 0.6 * g.side:
                row.append(g)
                placed = True
                break
        if not placed:
            rows.append([g])
    for r, row in enumerate(rows):
        row.sort(key=lambda g: g.center[0])
        for c, g in enumerate(row):
            g.row, g.col = r, c


def _overlay(bg_bgr: np.ndarray, grids: list[Grid]) -> np.ndarray:
    vis = bg_bgr.copy()
    for i, g in enumerate(grids):
        pts = g.quad.astype(int).reshape(-1, 1, 2)
        cv2.polylines(vis, [pts], True, (0, 0, 255), 2)
        cx, cy = (int(g.center[0]), int(g.center[1]))
        cv2.putText(vis, f"#{i}", (cx - 10, cy + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 1)
    return vis
