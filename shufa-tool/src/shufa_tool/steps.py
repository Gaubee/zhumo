"""离散步骤命令行：uv run python -m shufa_tool.steps <command> [args]

意图（2026-09-22，W6，PRODUCT_DESIGN.md §6）：把 shufa-analyze 的连贯流程拆为
离散步骤命令，供 agent 逐步调用编排——每步从 WORKDIR 读写产物并合并
manifest.json 状态，agent 在步骤之间可检查中间产物、亲自撰写摘要后导出。

约定（agent 契约）：
- 每步 stdout 末行恒为一行 JSON（机器可读结果）；人类日志走 stderr；
- 失败时退出码非 0，stdout 末行 {"step":..., "error":"中文原因"}；
- 状态接力：probe 初始化 manifest.json，后续步骤合并写入：
    probe       manifest 基座 + video/probe
    sample      workdir/frames/f_*.jpg + manifest.sample{fps,count,ts}
    orient      manifest.orient{steps,pre_flip_steps,flipped,note,scores,mode}
    align       manifest.align{frames,max_abs_shift}
    bg          workdir/page_bg.png（预览版）+ manifest.bg{frame_activity}
    grid        workdir/debug_grids.png + page_bg.png（最终版）+
                manifest.orient 更新 + manifest.grid{grids,sides}
    ink         workdir/crops/anno_mask_*.png + manifest.ink + manifest.focus
    clip        workdir/crops/*.png + focus_clip.mp4 + manifest.clip
    transcribe  workdir/audio.wav + manifest.transcribe（不可用时 skipped）
    export      workdir/bundle/（data.json + assets/）+ manifest.export
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

from . import __version__
from . import pipeline


class StepError(Exception):
    """步骤级失败（中文消息，直接面向 agent）。"""


# ------------------------------------------------------------ manifest --

def _load_manifest(workdir: Path) -> dict:
    f = workdir / "manifest.json"
    if not f.exists():
        raise StepError(f"工作目录缺少 manifest.json（先执行 probe 步骤）：{workdir}")
    try:
        return json.loads(f.read_text("utf-8"))
    except json.JSONDecodeError as e:
        raise StepError(f"manifest.json 损坏（重跑 probe 可重建）：{e}") from e


def _save_manifest(workdir: Path, m: dict) -> None:
    workdir.mkdir(parents=True, exist_ok=True)
    (workdir / "manifest.json").write_text(
        json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")


def _require(m: dict, *keys: str) -> None:
    order = {"probe": 1, "sample": 2, "orient": 3, "align": 4, "bg": 5, "grid": 6,
             "ink": 7, "clip": 8, "transcribe": 9}
    missing = [k for k in keys if k not in m]
    if missing:
        hint = " → ".join(sorted((k for k in missing if k in order), key=lambda k: order[k]))
        raise StepError(f"缺少前置步骤产物：manifest 缺少 {','.join(missing)}"
                        f"（请先执行步骤：{hint or 'probe'}）")


def _views_of(workdir: Path, m: dict) -> "pipeline.Views":
    """按 manifest 记录的朝向（含拼音裁决翻转）重建视图组——与单进程执行位图一致。"""
    o = m.get("orient")
    if not o:
        raise StepError("manifest 缺少 orient（请先执行 orient 步骤）")
    return pipeline.load_views(Path(m["workdir"]), int(o["pre_flip_steps"]),
                               bool(o.get("flipped")))


def _check_video(args_video: Path, m: dict) -> Path:
    video = Path(args_video).resolve()
    if str(video) != m.get("video"):
        print(f"警告：传入视频与 manifest 记录不一致（{video} ≠ {m.get('video')}）",
              file=sys.stderr)
    return video


# --------------------------------------------------------------- commands --

def cmd_probe(args: argparse.Namespace) -> dict:
    video = Path(args.video).resolve()
    if not video.exists():
        raise StepError(f"视频不存在：{video}")
    workdir = Path(args.workdir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    print(f"[probe] ffprobe {video.name}", file=sys.stderr)
    info = pipeline.probe_stage(video)
    print(f"        {info.width}x{info.height} {info.duration_s:.1f}s @ {info.fps:.0f}fps, "
          f"容器旋转声明 {info.metadata_rotation_cw}°, 音轨 {'有' if info.has_audio else '无'}",
          file=sys.stderr)
    # probe 重新初始化工作目录（重跑 = 重开一次分析）
    m = {
        "version": __version__,
        "video": str(video),
        "video_name": video.name,
        "workdir": str(workdir),
        "probe": {
            "width": info.width, "height": info.height,
            "duration_s": info.duration_s, "fps": info.fps,
            "nb_frames": info.nb_frames,
            "metadata_rotation_cw": info.metadata_rotation_cw,
            "has_audio": info.has_audio,
        },
    }
    _save_manifest(workdir, m)
    return {"step": "probe", "video": str(video), "width": info.width,
            "height": info.height, "duration_s": round(info.duration_s, 2),
            "fps": round(info.fps, 2), "has_audio": info.has_audio,
            "metadata_rotation_cw": info.metadata_rotation_cw}


def cmd_sample(args: argparse.Namespace) -> dict:
    workdir = Path(args.workdir).resolve()
    m = _load_manifest(workdir)
    video = _check_video(args.video, m)
    print(f"[sample] 抽帧 {args.fps}fps → {workdir / 'frames'}", file=sys.stderr)
    ts = pipeline.sample_stage(video, workdir, args.fps)
    print(f"         {len(ts)} 帧", file=sys.stderr)
    m["sample"] = {"fps": float(args.fps), "count": len(ts),
                   "ts": [float(t) for t in ts]}
    _save_manifest(workdir, m)
    return {"step": "sample", "fps": float(args.fps), "frames": len(ts)}


def cmd_orient(args: argparse.Namespace) -> dict:
    workdir = Path(args.workdir).resolve()
    m = _load_manifest(workdir)
    _require(m, "sample")
    if args.rotate != "auto":
        try:
            if int(args.rotate) % 90 != 0 or not (-270 <= int(args.rotate) <= 270):
                raise ValueError
        except ValueError:
            raise StepError("--rotate 仅支持 auto 或 0/90/180/270（顺时针角度）") from None
    o = pipeline.orient_stage(workdir, args.rotate)
    print(f"[orient] {o.note}", file=sys.stderr)
    m["orient"] = {
        "steps": o.steps, "pre_flip_steps": o.steps, "flipped": False,
        "note": o.note, "mode": args.rotate,
        "scores": {str(k): v for k, v in o.scores.items()},
    }
    _save_manifest(workdir, m)
    return {"step": "orient", "cw_steps": o.steps, "note": o.note}


def cmd_align(args: argparse.Namespace) -> dict:
    workdir = Path(args.workdir).resolve()
    m = _load_manifest(workdir)
    _require(m, "orient")
    print("[align] 相位相关对齐（逐帧回正）", file=sys.stderr)
    views = _views_of(workdir, m)
    shifts = views.shifts
    max_dx = max(abs(dx) for dx, _ in shifts) if shifts else 0.0
    max_dy = max(abs(dy) for _, dy in shifts) if shifts else 0.0
    print(f"         {len(shifts)} 帧，最大平移 dx={max_dx:.1f}px dy={max_dy:.1f}px",
          file=sys.stderr)
    m["align"] = {"frames": len(shifts),
                  "max_abs_shift": [round(max_dx, 2), round(max_dy, 2)]}
    _save_manifest(workdir, m)
    return {"step": "align", "frames": len(shifts),
            "max_abs_shift": [round(max_dx, 2), round(max_dy, 2)]}


def cmd_bg(args: argparse.Namespace) -> dict:
    workdir = Path(args.workdir).resolve()
    m = _load_manifest(workdir)
    _require(m, "orient")
    print("[bg] 合成无笔迹页面背景", file=sys.stderr)
    views = _views_of(workdir, m)
    activity = pipeline.frame_activity_of(views)
    cv2.imwrite(str(workdir / "page_bg.png"), views.bg)  # 预览版（grid 步后为最终转正版）
    print(f"     page_bg.png + 手活动量（峰值 {max(activity) if activity else 0}px）",
          file=sys.stderr)
    m["bg"] = {"frame_activity": activity}
    _save_manifest(workdir, m)
    return {"step": "bg", "frames": len(activity)}


def cmd_grid(args: argparse.Namespace) -> dict:
    workdir = Path(args.workdir).resolve()
    m = _load_manifest(workdir)
    _require(m, "orient")
    o = m["orient"]
    print("[grid] 多帧投票田字格检测 + 拼音带 180° 裁决 + 角点精化", file=sys.stderr)
    views = _views_of(workdir, m)
    gs = pipeline.grid_stage(workdir, views, o.get("mode", "auto"),
                             int(o["steps"]), str(o["note"]))
    m["orient"].update({"steps": gs.steps, "flipped": gs.flipped, "note": gs.note})
    sides = [int(round(g.side)) for g in gs.det.grids]
    m["grid"] = {"grids": gs.payload, "sides": sides}
    _save_manifest(workdir, m)
    print(f"       田字格 {len(sides)} 个：{sides}；{m['orient']['note']}", file=sys.stderr)
    return {"step": "grid", "grids": len(sides), "sides": sides,
            "cw_steps": gs.steps, "flipped": gs.flipped}


def cmd_ink(args: argparse.Namespace) -> dict:
    workdir = Path(args.workdir).resolve()
    m = _load_manifest(workdir)
    _require(m, "grid", "sample")
    print("[ink] 动态墨迹提取 + 旁注时间线 + 焦点格判定", file=sys.stderr)
    views = _views_of(workdir, m)
    grids = pipeline.grids_from_payload(m["grid"]["grids"])
    ts = [float(t) for t in m["sample"]["ts"]]
    isg = pipeline.ink_stage(workdir, views, grids, ts)
    m["ink"] = isg.payload
    m["focus"] = {"grid_idx": isg.focus_gi}
    _save_manifest(workdir, m)
    annos = isg.payload["annotations"]
    print(f"      旁注簇 {len(annos)} 个（丢弃 {isg.payload['dropped_clusters']}），"
          f"焦点格 #{isg.focus_gi}", file=sys.stderr)
    return {"step": "ink", "annotations": len(annos),
            "first_ts": [round(a["first_ts"], 2) for a in annos],
            "dropped_clusters": isg.payload["dropped_clusters"],
            "focus_grid_idx": isg.focus_gi}


def cmd_clip(args: argparse.Namespace) -> dict:
    workdir = Path(args.workdir).resolve()
    m = _load_manifest(workdir)
    _require(m, "grid", "ink", "focus")
    video = _check_video(args.video, m)
    print(f"[clip] 焦点区裁剪/增强/回放剪辑（enhance={'on' if args.enhance == 'on' else 'off'}）",
          file=sys.stderr)
    views = _views_of(workdir, m)
    grids = pipeline.grids_from_payload(m["grid"]["grids"])
    ts = [float(t) for t in m["sample"]["ts"]]
    annos = []
    for a in m["ink"]["annotations"]:
        mask = cv2.imread(str(workdir / a["mask"]), cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise StepError(f"旁注掩码读取失败：{a['mask']}（重跑 ink 步骤）")
        annos.append({"first_ts": a["first_ts"], "bbox": a["bbox"], "mask": mask})
    cs = pipeline.clip_stage(
        video, workdir, views, grids, ts,
        annotations=annos, ink_curve=m["ink"]["ink_curve"],
        analysis_end=int(m["ink"]["analysis_end"]),
        focus_gi=int(m["focus"]["grid_idx"]),
        steps=int(m["orient"]["steps"]), enhance=args.enhance == "on")
    m["clip"] = cs.payload
    _save_manifest(workdir, m)
    print(f"       焦点回放剪辑 {cs.payload['duration_s']:.1f}s / "
          f"{cs.payload['bytes'] // 1024}KB", file=sys.stderr)
    return {"step": "clip", "duration_s": round(cs.payload["duration_s"], 2),
            "bytes": cs.payload["bytes"], "timeline": len(cs.payload["timeline_ts"]),
            "bbox": cs.payload["bbox"]}


def cmd_transcribe(args: argparse.Namespace) -> dict:
    workdir = Path(args.workdir).resolve()
    m = _load_manifest(workdir)
    _require(m, "probe")
    video = _check_video(args.video, m)
    print("[transcribe] 提取音轨 + mlx-whisper 转录", file=sys.stderr)
    tsg = pipeline.transcribe_stage(video, workdir, bool(m["probe"]["has_audio"]))
    m["transcribe"] = tsg.payload
    _save_manifest(workdir, m)
    if tsg.transcript is None:
        print(f"      ⚠ 转录跳过：{tsg.payload.get('reason', '未知原因')}", file=sys.stderr)
        return {"step": "transcribe", "skipped": "transcribe",
                "reason": tsg.payload.get("reason", "")}
    segs = tsg.transcript.segments
    print(f"      {len(segs)} 段（模型 {tsg.transcript.model}）", file=sys.stderr)
    # 转录全文随返回值给 agent（走查 2026-09-23 实证：工具面没有其它读转录的
    # 通道，提示词却要求"阅读转录全文"——模型要么编要么写占位）。超长截断，
    # 全文在 manifest/bundle 里。
    text = "".join(s["text"] for s in segs)
    trimmed = text if len(text) <= 8000 else text[:8000] + "…（截断，全文见 transcript）"
    return {"step": "transcribe", "segments": len(segs),
            "model": tsg.transcript.model,
            "transcript": [{"start": round(float(s["start"]), 2),
                            "end": round(float(s["end"]), 2),
                            "text": s["text"]} for s in segs],
            "transcript_text": trimmed}


def cmd_export(args: argparse.Namespace) -> dict:
    workdir = Path(args.workdir).resolve()
    m = _load_manifest(workdir)
    _require(m, "probe", "sample", "orient", "grid", "ink", "focus", "clip")
    if not args.summary_file or not Path(args.summary_file).is_file():
        raise StepError(f"摘要文件不存在：{args.summary_file}"
                        f"（请阅读转录全文与旁注截图后撰写 summary.json）")
    labels_note = f", labels={args.labels}" if args.labels else ""
    print(f"[export] 汇总导出分析包（summary={args.summary_file}{labels_note}）",
          file=sys.stderr)

    views = _views_of(workdir, m)
    grids = pipeline.grids_from_payload(m["grid"]["grids"])
    ts = [float(t) for t in m["sample"]["ts"]]
    p = m["probe"]
    probe_info = pipeline.ProbeInfo(
        width=int(p["width"]), height=int(p["height"]),
        duration_s=float(p["duration_s"]), fps=float(p["fps"]),
        nb_frames=int(p.get("nb_frames", 0)),
        metadata_rotation_cw=float(p["metadata_rotation_cw"]),
        has_audio=bool(p["has_audio"]))

    def _imread(rel: str, flag: int = cv2.IMREAD_COLOR, what: str = "") -> np.ndarray:
        img = cv2.imread(str(workdir / rel), flag)
        if img is None:
            raise StepError(f"{what}读取失败：{rel}（请按顺序补跑产出它的步骤）")
        return img

    grids_data = []
    for i, gp in enumerate(m["grid"]["grids"]):
        grids_data.append({
            "idx": i, "row": gp["row"], "col": gp["col"],
            "visibility": round(float(gp["visibility"]), 2),
            "crop": _imread(m["clip"]["grid_crops"][i], what="格字裁剪图"),
            "note": m["clip"]["grid_notes"][i],
        })
    annos_data = []
    for i, ap_ in enumerate(m["ink"]["annotations"]):
        annos_data.append({
            "first_ts": float(ap_["first_ts"]), "bbox": ap_["bbox"],
            "crop": _imread(m["clip"]["anno_crops"][i], what="旁注渲染图"),
            "desc": "",
        })
    timeline = [{"ts": t, "img": _imread(rel, what="时间线帧")}
                for t, rel in zip(m["clip"]["timeline_ts"], m["clip"]["timeline_crops"])]
    focus_crop = _imread(m["clip"]["focus_crop"], what="焦点大图")

    tp = m.get("transcribe", {})
    bundle = pipeline.export_stage(
        out_dir=args.out_dir or (workdir / "bundle"),
        views=views, grids=grids, ts=ts,
        probe_info=probe_info, video_name=m["video_name"],
        orient_note=str(m["orient"]["note"]), final_steps=int(m["orient"]["steps"]),
        enhance=bool(m["clip"]["enhance"]), ink_curve=m["ink"]["ink_curve"],
        focus_gi=int(m["focus"]["grid_idx"]),
        focus_bbox=tuple(int(v) for v in m["clip"]["bbox"]),
        grids_data=grids_data, annos_data=annos_data,
        focus_crop=focus_crop, timeline=timeline,
        clip_info={"path": str(workdir / "focus_clip.mp4"),
                   "duration_s": float(m["clip"]["duration_s"])},
        segments=tp.get("segments", []),
        transcript_model=tp.get("model", ""),
        summary_file=args.summary_file, labels=args.labels,
        summary_source=args.summary_source)
    data = json.loads((bundle / "data.json").read_text("utf-8"))
    m["export"] = {"bundle": str(bundle), "grids": len(data["chars"]),
                   "annotations": len(data["annotations"]),
                   "entries": len(data["player"]["entries"])}
    _save_manifest(workdir, m)
    print(f"         ✔ 分析包：{bundle}", file=sys.stderr)
    warnings = data.get("warnings", [])
    for w in warnings:  # 数据质量告警显性化（stderr + 返回 JSON 双通道）
        print(f"         ⚠ {w}", file=sys.stderr)
    return {"step": "export", "bundle": str(bundle), "grids": m["export"]["grids"],
            "annotations": m["export"]["annotations"],
            "entries": m["export"]["entries"],
            "warnings": warnings}


# ------------------------------------------------------------------ list --

_LIST_HEADER = (
    f"shufa_tool.steps — 书法/讲评视频分析离散步骤（v{__version__}）\n"
)

_LIST_TEXT = _LIST_HEADER + """\

用法：uv run python -m shufa_tool.steps <command> [args]   （在 shufa-tool 目录下）
约定：每步 stdout 末行恒为一行 JSON 结果；人类日志走 stderr；失败退出码非 0
      且 stdout 末行 {"step":"...","error":"中文原因"}。状态经 WORKDIR/manifest.json 接力。

按序步骤（WORKDIR = 工作目录）：
  list                                              列出本说明
  probe    VIDEO WORKDIR                            ffprobe 元数据 → manifest 基座
  sample   VIDEO WORKDIR [--fps 2.0]                抽帧 → WORKDIR/frames/
  orient   WORKDIR [--rotate auto|0|90|180|270]     内容投影转正 → manifest.orient
  align    WORKDIR                                  相位相关对齐 → manifest.align
  bg       WORKDIR                                  页面背景 → page_bg.png + manifest.bg
  grid     WORKDIR                                  田字格检测+180°裁决+角点精化
                                                    → debug_grids.png + manifest.grid
  ink      WORKDIR                                  动态墨迹/旁注时间线+焦点格
                                                    → crops/anno_mask_*.png + manifest.ink/focus
  clip     VIDEO WORKDIR [--enhance on|off]         裁剪/增强/回放剪辑
                                                    → crops/*.png + focus_clip.mp4 + manifest.clip
  transcribe VIDEO WORKDIR                          音轨转录（mlx-whisper）
                                                    → audio.wav + manifest.transcribe
                                                    无 mlx 环境时 {"skipped":"transcribe"}，不阻塞
  export   WORKDIR --summary-file F [--labels F] [--out-dir D]
                                                    摘要/标签注入 + 旁注↔生字关联 → bundle/

机器可读输出样例：
  probe       {"step":"probe","width":1920,"height":1080,"duration_s":31.2,"has_audio":true}
  sample      {"step":"sample","fps":2.0,"frames":62}
  orient      {"step":"orient","cw_steps":1,"note":"内容探测：顺时针 90°（投影得分 ...）"}
  align       {"step":"align","frames":62,"max_abs_shift":[8.5,1.8]}
  bg          {"step":"bg","frames":62}
  grid        {"step":"grid","grids":3,"sides":[75,75,75,75],"cw_steps":1,"flipped":false}
  ink         {"step":"ink","annotations":3,"first_ts":[6.0,15.0,22.5],"focus_grid_idx":1}
  clip        {"step":"clip","duration_s":24.5,"bytes":1536000,"timeline":4,"bbox":[x,y,x,y]}
  transcribe  {"step":"transcribe","segments":9,"model":"mlx-community/whisper-large-v3-turbo"}
  export      {"step":"export","bundle":"/…/bundle","grids":3,"annotations":3,"entries":15}
"""


# ------------------------------------------------------------------ main --

def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="python -m shufa_tool.steps",
        description="书法/讲评视频分析离散步骤（供 agent 逐步编排；list 查看说明）")
    sub = ap.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="列出全部步骤与说明")

    p = sub.add_parser("probe", help="视频元数据探针（初始化 WORKDIR/manifest.json）")
    p.add_argument("video", type=Path)
    p.add_argument("workdir", type=Path)

    p = sub.add_parser("sample", help="均匀抽帧 → WORKDIR/frames/")
    p.add_argument("video", type=Path)
    p.add_argument("workdir", type=Path)
    p.add_argument("--fps", type=float, default=2.0, help="采样率（默认 2fps）")

    p = sub.add_parser("orient", help="内容投影旋转探测（90° 步进）")
    p.add_argument("workdir", type=Path)
    p.add_argument("--rotate", default="auto", help="auto 或 0/90/180/270（顺时针角度）")

    p = sub.add_parser("align", help="相位相关逐帧对齐")
    p.add_argument("workdir", type=Path)

    p = sub.add_parser("bg", help="合成无笔迹页面背景 page_bg.png")
    p.add_argument("workdir", type=Path)

    p = sub.add_parser("grid", help="田字格检测 + 拼音带 180° 裁决 + 角点精化")
    p.add_argument("workdir", type=Path)

    p = sub.add_parser("ink", help="动态墨迹/旁注时间线 + 焦点格判定")
    p.add_argument("workdir", type=Path)

    p = sub.add_parser("clip", help="焦点区裁剪/增强/回放剪辑")
    p.add_argument("video", type=Path)
    p.add_argument("workdir", type=Path)
    p.add_argument("--enhance", choices=["on", "off"], default="on",
                   help="音画增强（默认 on）")

    p = sub.add_parser("transcribe", help="音频转录（mlx-whisper，可选依赖）")
    p.add_argument("video", type=Path)
    p.add_argument("workdir", type=Path)

    p = sub.add_parser("export", help="汇总导出分析包 bundle/")
    p.add_argument("workdir", type=Path)
    p.add_argument("--out-dir", type=Path, default=None, help="分析包目录（默认 WORKDIR/bundle）")
    p.add_argument("--summary-file", type=Path, default=None,
                   help="agent 撰写的摘要 JSON {topic, paragraphs, key_points}（必需）")
    p.add_argument("--labels", default="",
                   help="标签 JSON：{\"grids\":[…],\"annotations\":[…]}（裸数组=格标签）")
    p.add_argument("--summary-source", default="injected",
                   choices=["agent", "injected"],
                   help="摘要来源标记（agent=模型经 summary_write 亲写；走查 2026-09-23 补）")
    return ap


_COMMANDS = {
    "probe": cmd_probe, "sample": cmd_sample, "orient": cmd_orient,
    "align": cmd_align, "bg": cmd_bg, "grid": cmd_grid, "ink": cmd_ink,
    "clip": cmd_clip, "transcribe": cmd_transcribe, "export": cmd_export,
}


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    if args.command == "list":
        print(_LIST_TEXT)  # 本命令的载荷就是说明文本本身
        return
    try:
        payload = _COMMANDS[args.command](args)
    except StepError as e:
        print(f"错误：{e}", file=sys.stderr)
        print(json.dumps({"step": args.command, "error": str(e)}, ensure_ascii=False))
        raise SystemExit(1) from None
    except Exception as e:  # ffmpeg/ffprobe/cv2 等底层失败也保证 stdout JSON 契约
        print(f"错误：{type(e).__name__}: {e}", file=sys.stderr)
        print(json.dumps({"step": args.command, "error": str(e)}, ensure_ascii=False))
        raise SystemExit(1) from None
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
