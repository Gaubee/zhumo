"""分析包导出：data.json + assets/（媒体落盘为文件），供 Vite 前端 HTTP 承载。

意图（2026-09-22，Owner 反馈"不要单文件，用 HTTP 服务基于 Vite 承载"）：
废弃 base64 单文件 HTML——CLI 产出分析包（JSON 引用相对资产路径），由
shufa-serve 用 Vite dev server 承载。资产落文件：体积不膨胀、视频可流式
range 播放、浏览器可独立缓存。
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from . import __version__


def write_png(img: np.ndarray, path: Path) -> str:
    """ndarray → PNG 文件，返回相对 bundle 根的资产路径。"""
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError(f"PNG 编码失败：{path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.tobytes())
    return f"{path.parent.name}/{path.name}"


def export_bundle(
    out_dir: Path,
    *,
    video_name: str,
    video_duration: str,
    video_resolution: str,
    orientation_note: str,
    enhance_note: str,
    grids: list[dict],          # {idx,row,col,visibility,note,label,crop:ndarray}
    annotations: list[dict],    # {first_ts,desc,grids,crop:ndarray}
    focus: dict,                # {grid_idx,char,crop:ndarray,timeline:[{ts,img}]}
    clip_path: Path,            # 焦点回放 mp4（已生成于 workdir）
    clip_duration: float,
    entries: list[dict],        # 播放器时间轴条目（thumb 为 ndarray 的转文件）
    transcript_model: str,
    transcript_segments: list[dict],
    summary: dict,
    ink_curve: list[float],
    frame_ts: list[float],
    previews: list[tuple[float, "np.ndarray"]],
    limitations: list[str],
    raw_stats: dict,
    warnings: list[str] | None = None,  # 数据质量告警（走查 2026-09-23：语义缺失要显性化）
) -> Path:
    """构建分析包目录：<out>/data.json + <out>/assets/*。返回 out_dir。"""
    assets = out_dir / "assets"
    assets.mkdir(parents=True, exist_ok=True)

    grids_out = []
    for g in grids:
        grids_out.append({
            "idx": g["idx"], "row": g["row"], "col": g["col"],
            "visibility": g["visibility"], "note": g.get("note", ""),
            "label": g.get("label", ""),
            "crop": write_png(g["crop"], assets / f"grid_{g['idx']}.png"),
        })
    annos_out = []
    for i, a in enumerate(annotations):
        img = a["crop"]
        # 呼吸留白：墨迹按外接框紧裁会把笔画贴边裁断（Owner：28.5s 圭底部被裁到），
        # 按最长边 18% 外扩白边，最小 18px。crop 已是白底渲染图，四周补白即可。
        pad = max(18, int(0.18 * max(img.shape[:2])))
        img = np.pad(img, ((pad, pad), (pad, pad), (0, 0)),
                     mode="constant", constant_values=255)
        annos_out.append({
            "idx": i, "first_ts": a["first_ts"], "desc": a.get("desc", ""),
            "grids": a.get("grids", []),
            "crop": write_png(img, assets / f"anno_{i}.png"),
        })
    entries_out = []
    for i, e in enumerate(entries):
        e = dict(e)
        if "thumb" in e:  # ndarray 关键帧缩略图 → 文件
            e["thumb"] = write_png(e["thumb"], assets / f"kf_{i}.png")
        entries_out.append(e)
    previews_out = []
    for i, (t, img) in enumerate(previews):  # 进度条 hover 预览帧（JPEG 控体积）
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 78])
        if not ok:
            raise RuntimeError("预览帧 JPEG 编码失败")
        (assets / f"preview_{i}.jpg").write_bytes(buf.tobytes())
        previews_out.append({"t": t, "src": f"assets/preview_{i}.jpg"})
    clip_rel = "assets/focus_clip.mp4"
    shutil.copyfile(clip_path, out_dir / clip_rel)

    # 数据质量告警（Owner 2026-09-23：语义缺失不能静默——导出面自检）。
    all_warnings = list(warnings or [])
    no_desc = [a for a in annos_out if not a["desc"]]
    if annos_out and no_desc:
        all_warnings.append(
            f"旁注语义缺失：{len(no_desc)}/{len(annos_out)} 处旁注无描述"
            "（labels 未提供或未覆盖，阅读体验降级）")
    no_label = [g for g in grids_out if not g["label"]]
    if grids_out and no_label:
        all_warnings.append(
            f"生字格语义缺失：{len(no_label)}/{len(grids_out)} 个田字格无 label"
            "（旁注/转录与生字的关联不可用）")
    if not transcript_segments:
        all_warnings.append("转录为空：语音讲解内容不在分析包内")
    if summary.get("source") == "heuristic":
        all_warnings.append("摘要为规则兜底生成，未经模型/人工撰写")

    data = {
        "version": __version__,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "video": {"name": video_name, "duration": video_duration,
                  "resolution": video_resolution},
        "orientation_note": orientation_note,
        "enhance_note": enhance_note,
        "player": {
            "video": clip_rel,
            "duration": clip_duration,
            "entries": entries_out,
            "previews": previews_out,
        },
        "chars": grids_out,
        "focus_grid_idx": focus["grid_idx"],
        "focus_char": focus.get("char", ""),
        "annotations": annos_out,
        "transcript": {"model": transcript_model, "segments": transcript_segments},
        "summary": summary,
        "ink_curve": ink_curve,
        "frame_ts": frame_ts,
        "limitations": limitations,
        "raw_stats": raw_stats,
        "warnings": all_warnings,
    }
    (out_dir / "data.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return out_dir
