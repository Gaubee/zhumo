"""共享分析管线：cli.run() 与 steps.py 离散步骤共用的同一套阶段实现。

意图（2026-09-22，W6）：把原 cli.run() 的连贯流程拆为离散阶段函数——
- cli.run() 单进程按序调用，数组驻留内存；
- steps.py 每步独立进程，经 WORKDIR（frames/、crops/、page_bg.png、
  manifest.json）接力状态。
两路共用同一实现，回归等价性由构造保证。跨进程传递的数组一律走无损
PNG（掩码/裁剪图）或可精确重建的确定性重算（帧读取/对齐/背景合成），
逐步执行与单进程执行产出一致。

阶段与产物对应（供 steps.py 逐步调用）：
  probe       视频元数据（ffprobe）
  sample      workdir/frames/f_*.jpg + 时间戳列表
  orient      旋转步数 + 依据说明（内容投影法，仅消 90° 步进）
  align       相位相关对齐（shifts 序列）
  bg          无笔迹页面背景 + 每帧手活动量（page_bg.png 预览版）
  grid        田字格检测 + 拼音带 180° 裁决 + 角点精化（debug_grids.png、
              最终 page_bg.png）
  ink         动态墨迹/旁注簇与时间线 + 焦点格（crops/anno_mask_*.png）
  clip        格字/旁注/焦点裁剪 + 回放剪辑（crops/*.png、focus_clip.mp4）
  transcribe  音轨转录（audio.wav，平台最优引擎可选：mac=mlx / win,linux=faster）
  export      汇总导出分析包（bundle/data.json + assets/）
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .audio import Transcript, extract_audio, transcribe
from .clips import make_focus_clip
from .crops import enhance_pencil, ink_render, warp_quad
from .export import export_bundle
from .frames import align_frames, load_frames, page_background, rotate_cw, sample_frames
from .grid import Grid, GridDetection, detect_grids_multiframe, refine_quad
from .ink import InkAnalysis, analyze_ink, grid_ink_curves
from .orient import detect_orientation_steps, orient_flip_by_pinyin
from .probe import ProbeInfo, probe
from .summarize import Summary, load_injected, summarize
from .transcript_lint import LintFix, lint_and_fix

TURN_NAME = {0: "无需旋转", 1: "顺时针 90°", 2: "180°", 3: "逆时针 90°"}


# ---------------------------------------------------------------- 基础工具 --

def _sharpest(frames: list[np.ndarray]) -> int:
    best, bi = -1.0, 0
    for i, f in enumerate(frames):
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        v = cv2.Laplacian(g, cv2.CV_64F).var()
        if v > best:
            best, bi = v, i
    return bi


def _grid_boxes(grids: list[Grid]) -> list[tuple[int, int, int, int]]:
    out = []
    for g in grids:
        x0, y0 = g.quad[:, 0].min(), g.quad[:, 1].min()
        x1, y1 = g.quad[:, 0].max(), g.quad[:, 1].max()
        out.append((int(x0), int(y0), int(x1 - x0), int(y1 - y0)))
    return out


def _flip_quads(quads: list[np.ndarray], w: int, h: int) -> list[np.ndarray]:
    """180° 翻转四边形坐标。"""
    return [np.stack([w - q[:, 0], h - q[:, 1]], axis=1).astype(np.float32) for q in quads]


def _changepoints(curve: list[float], ts: list[float], max_pts: int = 6) -> list[int]:
    """墨量跳变点（旁注写入时刻）+ 首末帧。"""
    if not curve:
        return [0]
    idxs = [0]
    for i in range(1, len(curve)):
        if curve[i] > curve[i - 1] + 60:
            idxs.append(i)
    if len(idxs) > max_pts - 1:  # 取跳变最大的若干个
        gains = sorted(idxs[1:], key=lambda i: curve[i] - curve[i - 1], reverse=True)
        idxs = [0] + sorted(gains[: max_pts - 1])
    if len(curve) - 1 not in idxs:
        idxs.append(len(curve) - 1)
    return sorted(set(idxs))


def _regrid_after_flip(grids: list[Grid], quads: list[np.ndarray]) -> list[Grid]:
    from .grid import _sort_rows_cols
    out = []
    for g, q in zip(grids, quads):
        g.quad = q
        out.append(g)
    _sort_rows_cols(out)
    return out


# ------------------------------------------------------- probe / sample --

def probe_stage(video: Path) -> ProbeInfo:
    """视频元数据探针（ffprobe）。"""
    return probe(video)


def sample_stage(video: Path, workdir: Path, fps: float = 2.0) -> list[float]:
    """均匀抽帧到 workdir/frames，返回时间戳列表（秒）。"""
    return sample_frames(video, workdir, fps)


# ------------------------------------------------------------- orient --

@dataclass
class OrientInfo:
    steps: int                    # 应顺时针旋转的 90° 步数
    note: str                     # 人类可读依据
    scores: dict[int, float]      # 各候选旋转的投影得分（手动模式为空）


def orient_stage(workdir: Path, rotate: str = "auto") -> OrientInfo:
    """旋转探测（原 run() [3/8]）：内容投影法消 90° 步进，180° 交给 grid 步裁决。"""
    frames_raw = load_frames(workdir / "frames")
    if not frames_raw:
        raise FileNotFoundError(f"工作目录缺少帧产物：{workdir / 'frames'}（先执行 sample 步骤）")
    rep = frames_raw[_sharpest(frames_raw)]
    if rotate == "auto":
        steps, scores = detect_orientation_steps(rep)
        note = f"内容探测：{TURN_NAME[steps]}（投影得分 " + \
               ", ".join(f"{k * 90}°:{v:.2f}" for k, v in scores.items()) + "）"
    else:
        steps = int(rotate) // 90
        scores = {}
        note = f"手动指定：{TURN_NAME[steps]}"
    return OrientInfo(steps=steps, note=note, scores=scores)


# --------------------------------------------------------------- views --

@dataclass
class Views:
    """转正 + 对齐后的页面试图组（与原 run() 中同名变量一一对应）。"""
    frames: list[np.ndarray]            # 转正后源帧（裁剪用）
    aligned: list[np.ndarray]           # 对齐帧（相位相关回正）
    shifts: list[tuple[float, float]]   # 每帧相对首帧平移（180° 翻转不改写，保持原语义）
    bg: np.ndarray                      # 无笔迹页面背景
    bg_gray: np.ndarray                 # 背景灰度


def flip_views(views: Views) -> Views:
    """拼音带裁决后再转 180°：位图逐张旋转，shifts 保持原值（原 run() 语义）。"""
    return Views(
        frames=[rotate_cw(f, 2) for f in views.frames],
        aligned=[rotate_cw(f, 2) for f in views.aligned],
        shifts=views.shifts,
        bg=rotate_cw(views.bg, 2),
        bg_gray=rotate_cw(views.bg_gray, 2),
    )


def load_views(workdir: Path, steps: int, flipped: bool = False) -> Views:
    """加载帧并转正、对齐、合成页面背景。确定性重算 ⇒ 与单进程执行位图一致。"""
    frames = load_frames(workdir / "frames", rotate_cw_steps=steps)
    if not frames:
        raise FileNotFoundError(f"工作目录缺少帧产物：{workdir / 'frames'}（先执行 sample 步骤）")
    aligned, shifts = align_frames(frames)
    bg = page_background(aligned)
    bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    v = Views(frames=frames, aligned=aligned, shifts=shifts, bg=bg, bg_gray=bg_gray)
    return flip_views(v) if flipped else v


def frame_activity_of(views: Views) -> list[int]:
    """每帧"手活动量"：深色且高饱和（皮肤/铅笔杆）像素数——格框候选降权用。"""
    med0 = float(np.median(views.bg_gray))
    out = []
    for f in views.aligned:
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        s = cv2.cvtColor(f, cv2.COLOR_BGR2HSV)[:, :, 1]
        out.append(int(((g < med0 - 25) & (s > 60)).sum()))
    return out


# ---------------------------------------------------------------- grid --

def grids_payload(grids: list[Grid]) -> list[dict]:
    """Grid 对象 → manifest 可序列化载荷（quad 全精度 JSON 浮点，往返无损）。"""
    out = []
    for i, g in enumerate(grids):
        out.append({
            "idx": i, "row": int(g.row), "col": int(g.col),
            "side": float(g.side), "visibility": float(g.visibility),
            "frame_idx": int(g.frame_idx),
            "center": [float(g.center[0]), float(g.center[1])],
            "quad": [[float(x), float(y)] for x, y in g.quad],
            "quad_src": ([[float(x), float(y)] for x, y in g.quad_src]
                         if g.quad_src is not None else None),
        })
    return out


def grids_from_payload(items: list[dict]) -> list[Grid]:
    """manifest 载荷 → Grid 对象（后续阶段与单进程路径使用同一接口）。"""
    out = []
    for it in items:
        qs = (np.array(it["quad_src"], dtype=np.float32)
              if it.get("quad_src") is not None else None)
        out.append(Grid(
            quad=np.array(it["quad"], dtype=np.float32),
            side=float(it["side"]), score=0.0,
            row=int(it["row"]), col=int(it["col"]),
            visibility=float(it["visibility"]),
            frame_idx=int(it["frame_idx"]), quad_src=qs,
        ))
    return out


@dataclass
class GridStage:
    views: Views           # 翻转裁决后的最终视图（后续阶段沿用）
    det: GridDetection
    steps: int             # 最终顺时针 90° 步数（裁决后）
    note: str              # 最终朝向说明
    flipped: bool          # 是否被拼音带裁决翻转
    payload: list[dict]    # manifest 接力载荷


def grid_stage(workdir: Path, views: Views, rotate: str,
               steps: int, note: str) -> GridStage:
    """田字格检测 + 拼音带 180° 裁决 + 角点精化（原 run() [4/8]）。

    同时落盘 debug_grids.png 与最终 page_bg.png（转正后）。
    """
    det = detect_grids_multiframe(views.frames, bg=views.bg,
                                  frame_activity=frame_activity_of(views))
    sharp_i = _sharpest(views.frames)
    H, W = views.frames[0].shape[:2]
    flipped = False
    if det.grids and rotate == "auto":
        # 拼音裁决必须用锐利单帧（合成背景会洗掉小字拼音导致误翻）
        flip, conf = orient_flip_by_pinyin(
            cv2.cvtColor(views.frames[sharp_i], cv2.COLOR_BGR2GRAY),
            [g.quad for g in det.grids])
        if flip and conf > 0.15:
            views = flip_views(views)
            det.grids = _regrid_after_flip(det.grids,
                                           _flip_quads([g.quad for g in det.grids], W, H))
            steps = (steps + 2) % 4
            note += f"；拼音带裁决再转 180°（置信度 {conf:.0%}）"
            flipped = True
        else:
            note += "；拼音带裁决保持朝向"
    cv2.imwrite(str(workdir / "debug_grids.png"),
                det.debug_overlay if det.debug_overlay is not None else views.bg)
    cv2.imwrite(str(workdir / "page_bg.png"), views.bg)

    # 角点精化：在检出来源帧上做边线拟合求交（对抗 eps 粗近似的 3~6px 角点偏差，
    # Owner 验收实证：桂格串入相邻树字、树格左留白右裁切）；quad_src 保留来源帧
    # 坐标供零跨帧误差裁剪，quad 平移到对齐坐标系供墨迹分析。
    for g in det.grids:
        g.quad = refine_quad(cv2.cvtColor(views.frames[g.frame_idx], cv2.COLOR_BGR2GRAY),
                             g.quad)
        g.quad_src = g.quad.copy()
        g.quad = g.quad + np.array(views.shifts[g.frame_idx], dtype=np.float32)
    return GridStage(views=views, det=det, steps=steps, note=note,
                     flipped=flipped, payload=grids_payload(det.grids))


# ----------------------------------------------------------------- ink --

@dataclass
class InkStage:
    analysis: InkAnalysis
    focus_gi: int                  # 焦点格 = 周边旁注活动最强者
    curves: dict[int, list[float]]
    payload: dict                  # manifest 接力载荷（掩码已落盘 crops/）


def ink_stage(workdir: Path, views: Views, grids: list[Grid],
              ts: list[float]) -> InkStage:
    """动态墨迹/旁注时间线 + 每格墨量曲线 + 焦点格判定（原 run() [5/8]）。"""
    frames_gray = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in views.aligned]
    boxes = _grid_boxes(grids)
    ink = analyze_ink(views.aligned, views.bg, boxes, ts, shifts=views.shifts)
    curves = grid_ink_curves(frames_gray, views.bg_gray, boxes)

    # 焦点格 = 周边旁注活动最强者
    ref_i = ink.clean_final_idx
    ref_gray = cv2.cvtColor(views.aligned[ref_i], cv2.COLOR_BGR2GRAY)
    last_diff = cv2.subtract(views.bg_gray.astype(np.int16), ref_gray.astype(np.int16))
    dyn_near = []
    for gi, g in enumerate(grids):
        cx, cy = int(g.center[0]), int(g.center[1])
        r = int(g.side * 2.2)
        x0, y0 = max(0, cx - r), max(0, cy - r)
        zone = last_diff[y0:cy + r, x0:cx + r] > 16
        dyn_near.append((int(zone.sum()), gi))
    dyn_near.sort(reverse=True)
    focus_gi = dyn_near[0][1] if dyn_near else 0

    cropdir = workdir / "crops"
    cropdir.mkdir(parents=True, exist_ok=True)
    annos = []
    for i, a in enumerate(ink.annotations):
        cv2.imwrite(str(cropdir / f"anno_mask_{i}.png"), a.mask_crop)  # 无损，供 clip 步复用
        annos.append({"index": i, "bbox": list(a.bbox), "first_ts": float(a.first_ts),
                      "pixels": int(a.pixels), "mask": f"crops/anno_mask_{i}.png"})
    payload = {
        "annotations": annos,
        "ink_curve": [float(v) for v in ink.ink_curve],
        "analysis_end": int(ink.analysis_end),
        "clean_final_idx": int(ink.clean_final_idx),
        "dropped_clusters": int(ink.dropped_clusters),
        "grid_ink_curves": {str(k): v for k, v in curves.items()},
    }
    return InkStage(analysis=ink, focus_gi=focus_gi, curves=curves, payload=payload)


# ---------------------------------------------------------------- clip --

@dataclass
class ClipStage:
    clip_info: dict                    # make_focus_clip 返回值
    bbox: tuple[int, int, int, int]    # 焦点区 (x0, y0, x1, y1)，对齐坐标系
    grids_data: list[dict]             # 含 crop ndarray（导出用）
    annos_data: list[dict]
    focus_crop: np.ndarray
    timeline: list[dict]               # {"ts": float, "img": ndarray}
    payload: dict                      # manifest 接力载荷（裁剪图已落盘 crops/）


def clip_stage(
    video: Path,
    workdir: Path,
    views: Views,
    grids: list[Grid],
    ts: list[float],
    *,
    annotations: list[dict],   # {"first_ts": float, "bbox": [x,y,w,h], "mask": ndarray}
    ink_curve: list[float],
    analysis_end: int,
    focus_gi: int,
    steps: int,
    enhance: bool = True,
) -> ClipStage:
    """焦点区裁剪/增强/时间线/回放剪辑（原 run() [6/8]）。裁剪图全部落盘 crops/。"""
    cropdir = workdir / "crops"
    cropdir.mkdir(parents=True, exist_ok=True)
    frames_gray = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in views.aligned]
    bg_gray = views.bg_gray
    boxes = _grid_boxes(grids)
    H, W = views.frames[0].shape[:2]

    grids_data = []
    for gi, g in enumerate(grids):
        # 直接在角点来源帧上裁剪：角点在该帧坐标系内闭环，无跨帧平移残差。
        # pad_ratio 0.08 给边框外留呼吸白边（Owner：裁剪别太狠）。
        crop = enhance_pencil(warp_quad(
            views.frames[g.frame_idx], g.quad_src if g.quad_src is not None else g.quad,
            pad_ratio=0.08))
        static_in = cv2.subtract(
            bg_gray[boxes[gi][1]:boxes[gi][1] + boxes[gi][3],
                    boxes[gi][0]:boxes[gi][0] + boxes[gi][2]].astype(np.int16),
            frames_gray[0][boxes[gi][1]:boxes[gi][1] + boxes[gi][3],
                           boxes[gi][0]:boxes[gi][0] + boxes[gi][2]].astype(np.int16),
        )
        pre_written = (static_in > 16).sum() > g.side * g.side * 0.02
        grids_data.append({
            "idx": gi, "row": g.row, "col": g.col,
            "visibility": round(g.visibility, 2),
            "crop": crop,  # ndarray，导出时落盘
            "note": "开场已写好" if pre_written else "片段内书写",
        })
        cv2.imwrite(str(cropdir / f"grid_{gi}.png"), crop)

    # 焦点格大图与时间线（格用其来源帧：零跨帧误差；时间线帧取对齐坐标系）
    fg = grids[focus_gi]
    focus_crop = enhance_pencil(warp_quad(
        views.frames[fg.frame_idx], fg.quad_src if fg.quad_src is not None else fg.quad,
        pad_ratio=0.08))
    cv2.imwrite(str(cropdir / "focus.png"), focus_crop)
    r = int(fg.side * 2.2)
    cx, cy = int(fg.center[0]), int(fg.center[1])
    x0, y0 = max(0, cx - r), max(0, cy - r)
    x1, y1 = min(W, cx + r), min(H, cy + r)
    timeline = []
    for i in _changepoints(ink_curve, ts):
        timeline.append({"ts": ts[i], "img": enhance_pencil(views.aligned[i][y0:y1, x0:x1])})

    # 焦点区回放剪辑：源视频直出（30fps、含讲解原声），转正后裁剪，截到平静区间
    clip_info = make_focus_clip(
        video, workdir / "focus_clip.mp4",
        bbox=(x0, y0, x1 - x0, y1 - y0), rotate_cw_steps=steps,
        end_s=ts[analysis_end - 1] + 0.5, enhance=enhance,
    )

    annos_data = []
    for i, a in enumerate(annotations):
        crop = ink_render(a["mask"])  # ndarray 白底渲染图
        cv2.imwrite(str(cropdir / f"anno_{i}.png"), crop)
        annos_data.append({"first_ts": float(a["first_ts"]), "bbox": list(a["bbox"]),
                           "crop": crop, "desc": ""})
    for i, t in enumerate(timeline):
        cv2.imwrite(str(cropdir / f"tl_{i}.png"), t["img"])

    payload = {
        "path": "focus_clip.mp4",
        "duration_s": clip_info["duration_s"],
        "bytes": clip_info["bytes"],
        "bbox": [int(x0), int(y0), int(x1), int(y1)],
        "timeline_ts": [t["ts"] for t in timeline],
        "enhance": bool(enhance),
        "grid_notes": [g["note"] for g in grids_data],
        "grid_crops": [f"crops/grid_{i}.png" for i in range(len(grids_data))],
        "anno_crops": [f"crops/anno_{i}.png" for i in range(len(annos_data))],
        "focus_crop": "crops/focus.png",
        "timeline_crops": [f"crops/tl_{i}.png" for i in range(len(timeline))],
    }
    return ClipStage(clip_info=clip_info, bbox=(x0, y0, x1, y1),
                     grids_data=grids_data, annos_data=annos_data,
                     focus_crop=focus_crop, timeline=timeline, payload=payload)


# ---------------------------------------------------------- transcribe --

@dataclass
class TranscribeStage:
    transcript: Transcript | None
    payload: dict   # {"model","segments"} 或 {"skipped":"transcribe","reason":...}


def transcribe_stage(video: Path, workdir: Path, has_audio: bool) -> TranscribeStage:
    """提取音轨 + mlx-whisper 转录（原 run() [7/8] 前半段）。无音轨/无 mlx 时降级。"""
    if not has_audio:
        return TranscribeStage(None, {"skipped": "transcribe", "reason": "视频无音轨"})
    wav = workdir / "audio.wav"
    extract_audio(video, wav)
    transcript = transcribe(wav)
    if transcript is None:
        return TranscribeStage(None, {"skipped": "transcribe",
                                      "reason": "mlx-whisper 不可用（uv sync --extra transcribe 安装）"})
    return TranscribeStage(transcript, {"model": transcript.model,
                                        "segments": transcript.segments})


# --------------------------------------------------------------- export --

def _previews(views: Views, ts: list[float], x0: int, y0: int, x1: int, y1: int,
              step_s: float = 1.0) -> list[tuple[float, np.ndarray]]:
    """进度条 hover 预览帧：焦点区每 step_s 一张，缩到高 90px 控体积。"""
    out: list[tuple[float, np.ndarray]] = []
    stride = max(1, int(round(step_s * (len(ts) / (ts[-1] if ts else 1)))))
    for i in range(0, len(views.aligned), stride):
        small = cv2.resize(views.aligned[i][y0:y1, x0:x1], None,
                           fx=90 / max(1, y1 - y0), fy=90 / max(1, y1 - y0),
                           interpolation=cv2.INTER_AREA)
        out.append((ts[i], small))
    return out


def export_stage(
    *,
    out_dir: Path,
    views: Views,
    grids: list[Grid],
    ts: list[float],
    probe_info: ProbeInfo,
    video_name: str,
    orient_note: str,
    final_steps: int,
    enhance: bool,
    ink_curve: list[float],
    focus_gi: int,
    focus_bbox: tuple[int, int, int, int],
    grids_data: list[dict],
    annos_data: list[dict],
    focus_crop: np.ndarray,
    timeline: list[dict],
    clip_info: dict,
    segments: list[dict],
    transcript_model: str,
    summary_file: Path | str | None = None,
    labels: Path | str | None = None,
    summary_source: str = "injected",
) -> Path:
    """摘要/标签注入、旁注↔生字关联、时间轴条目并导出分析包（原 run() [7/8] 后半 + [8/8]）。
    summary_source：摘要来源标记（agent=模型亲写 / injected=文件注入），走查
    2026-09-23：agent 亲写曾被 load_injected 一律标成 injected，来源不可辨。"""
    x0, y0, x1, y1 = focus_bbox

    text = "".join(s["text"] for s in segments)
    if summary_file:
        try:
            summary: Summary = load_injected(Path(summary_file), source=summary_source)
        except Exception as e:
            raise ValueError(f"摘要 JSON 读取失败（{summary_file}）：{e}") from e
    else:
        summary = summarize(text)
    if labels:
        try:
            lab = json.loads(Path(labels).read_text("utf-8"))
        except Exception as e:
            raise ValueError(f"标签 JSON 读取失败（{labels}）：{e}") from e
        if isinstance(lab, list):  # 裸数组 = 仅格标签
            lab = {"grids": lab}
        for item in lab.get("grids", []):
            if 0 <= item["index"] < len(grids_data):
                grids_data[item["index"]]["label"] = item["label"]
                # note 覆盖（走查 2026-09-23）：无语义标注时 note 退化为管线占位
                # 文案（"开场已写好/片段内书写"），labels 可给逐格真说明。
                if item.get("note"):
                    grids_data[item["index"]]["note"] = item["note"]
        for item in lab.get("annotations", []):
            if 0 <= item["index"] < len(annos_data):
                annos_data[item["index"]]["desc"] = item["desc"]
    # 焦点字优先取焦点格 label（一个字），topic 是整段标题不该充当 focus_char。
    focus_char = (grids_data[focus_gi].get("label") or "") or summary.topic

    # 旁注/字幕 ↔ 生字关联：转录文本命中标签者直取；无命中则延续上一焦点
    # （讲解具有连续性，"上下要对齐""纠正一下"仍在讲之前那个字）。
    # Owner 注（2026-09-22）：一段讲解可能同时针对多个字——命中多个标签全保留。
    labels_list = [g["label"] for g in grids_data if g.get("label")]

    # 转录同音字 lint（Owner 要求 2026-09-25：写入结构化数据时自动校验）：
    # 锚点 = 本视频生字（labels 格 label + 焦点字）。误转字在导出面校正并
    # 留痕——manifest 不动（保引擎原始输出可溯源），下方生字关联、时间轴
    # 条目与正文全部消费校正稿（实证：原「要注意这个柜」校正为「桂」后，
    # 段落↔生字关联才命中）。带调匹配避免「图/土」类近音误伤。
    segments, transcript_fixes = lint_and_fix(
        segments, [focus_char, *labels_list])

    segs = segments
    seg_grids: list[list[str]] = []
    current: list[str] = []
    for s in segs:
        hit = [l for l in labels_list if l in s["text"]]
        if hit:
            current = hit
        seg_grids.append(list(current))
    for ai, a in enumerate(annos_data):
        t0 = a["first_ts"]
        t1 = annos_data[ai + 1]["first_ts"] if ai + 1 < len(annos_data) else \
            (segs[-1]["end"] if segs else t0 + 5.0)
        assoc: set[str] = set()
        for s, gl in zip(segs, seg_grids):
            if s["start"] < t1 and s["end"] > t0:
                assoc.update(gl)
        if not assoc and labels_list:  # 回退：空间最近格的标签
            bx = a["bbox"]
            acx, acy = bx[0] + bx[2] / 2, bx[1] + bx[3] / 2
            near = min(grids, key=lambda g: (g.center[0] - acx) ** 2 + (g.center[1] - acy) ** 2)
            near_lab = grids_data[grids.index(near)].get("label")
            if near_lab:
                assoc.add(near_lab)
        a["grids"] = sorted(assoc)

    # 关键帧：开场 + 每个旁注写入时刻（缩略图取该时刻的焦点区画面）
    def _thumb(t: float) -> np.ndarray:
        i = min(range(len(ts)), key=lambda k: abs(ts[k] - t))
        return enhance_pencil(views.aligned[i][y0:y1, x0:x1])

    entries: list[dict] = [{
        "type": "kf", "t": 0.0, "thumb": _thumb(0.0),
        "title": "开场", "desc": "练习已写好，老师开始讲评",
        "grids": list(labels_list),
    }]
    for ai, a in enumerate(annos_data):
        entries.append({
            "type": "kf", "t": a["first_ts"], "thumb": _thumb(a["first_ts"]),
            "title": f"旁注 {ai + 1}", "desc": a.get("desc", ""),
            "grids": a.get("grids", []),
        })
    for s, gl in zip(segs, seg_grids):
        entries.append({"type": "seg", "t0": s["start"], "t1": s["end"],
                        "text": s["text"], "grids": gl})
    entries.sort(key=lambda e: e.get("t", e.get("t0", 0.0)))

    enhance_note = ("音频 afftdn 降噪 + loudnorm 响度归一（EBU R128）；"
                    "画面 hqdn3d 降噪 + 轻度统一调色") if enhance else "未启用（--enhance off）"
    # 数据质量告警（走查 2026-09-23）：语义缺失显性化，导出面自检不静默。
    stage_warnings: list[str] = []
    degenerate_notes = sum(
        1 for g in grids_data if g.get("note") in ("开场已写好", "片段内书写"))
    if grids_data and degenerate_notes == len(grids_data):
        stage_warnings.append(
            "田字格说明为管线占位文案（无逐格语义标注，labels 未覆盖 note）")
    bundle = export_bundle(
        out_dir,
        video_name=video_name,
        video_duration=f"{probe_info.duration_s:.1f}s",
        video_resolution=f"{probe_info.width}x{probe_info.height}",
        orientation_note=orient_note,
        enhance_note=enhance_note,
        grids=grids_data,
        annotations=annos_data,
        focus={"grid_idx": focus_gi, "char": focus_char, "crop": focus_crop,
               "timeline": timeline},
        clip_path=Path(clip_info["path"]),
        clip_duration=clip_info["duration_s"],
        entries=entries,
        transcript_model=transcript_model,
        transcript_segments=segments,
        transcript_fixes=transcript_fixes,
        summary={"topic": summary.topic, "paragraphs": summary.paragraphs,
                 "key_points": summary.key_points, "source": summary.source},
        ink_curve=ink_curve,
        frame_ts=ts,
        previews=_previews(views, ts, x0, y0, x1, y1),
        limitations=[],
        warnings=stage_warnings,
        raw_stats={"steps": final_steps, "grids": len(grids_data),
                   "annotations": len(annos_data), "frames": len(ts)},
    )
    return bundle
