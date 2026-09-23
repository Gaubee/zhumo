"""CLI 编排：视频 → 转正 → 田字格 → 旁注 → 转录 → 摘要 → 分析包。

意图（2026-09-22，用户原始需求；同日晚 Owner 反馈改为 HTTP 服务架构）：
  1. 提供视频，产出分析包（data.json + assets/，由 Vite 前端承载）
  2. 截取田字格内的字 + 老师旁注（含出现时间），旁注与生字关联
  3. 转录并总结讲解内容
  4. --serve 直接起 Vite 服务预览
用法：uv run shufa-analyze VIDEO [--out-dir DIR] [--serve] [--rotate auto]
      uv run shufa-serve [BUNDLE_DIR]

W6（2026-09-22）：流程段提取为 pipeline.py 阶段函数，本模块只做参数解析、
顺序调用与人类可读日志；离散步骤编排见 python -m shufa_tool.steps。
"""

from __future__ import annotations

import argparse
from pathlib import Path

from . import pipeline


def run(argv: list[str] | None = None) -> Path:
    ap = argparse.ArgumentParser(prog="shufa-analyze", description="书法/讲评视频 → 分析包（Vite 承载）")
    ap.add_argument("video", type=Path)
    ap.add_argument("--out-dir", type=Path, default=None,
                    help="分析包目录（默认 <workdir>/bundle，含 data.json + assets/）")
    ap.add_argument("--workdir", type=Path, default=None, help="中间产物目录")
    ap.add_argument("--fps", type=float, default=2.0, help="抽帧采样率（默认 2fps）")
    ap.add_argument("--rotate", default="auto",
                    help="转正方式：auto（内容探测）/ 0/90/180/270（顺时针角度）")
    ap.add_argument("--transcribe", choices=["auto", "off"], default="auto")
    ap.add_argument("--enhance", choices=["on", "off"], default="on",
                    help="音画增强：afftdn+loudnorm 音频 / hqdn3d+eq 画面（默认 on）")
    ap.add_argument("--serve", dest="serve", action="store_true", default=True,
                    help="完成后启动 Vite 服务（默认开）")
    ap.add_argument("--no-serve", dest="serve", action="store_false")
    ap.add_argument("--port", type=int, default=6173, help="服务端口（默认 6173）")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--summary-file", type=Path, default=None,
                    help="注入 JSON 摘要 {topic, paragraphs, key_points} 覆盖默认规则摘要")
    ap.add_argument("--labels", default="",
                    help="标签 JSON：{\"grids\":[{\"index\":0,\"label\":\"桂\"}],"
                         "\"annotations\":[{\"index\":1,\"desc\":\"△△与方框记号\"}]}，"
                         "或裸数组等价于 grids")
    args = ap.parse_args(argv)
    args.enhance = args.enhance == "on"

    video: Path = args.video.resolve()
    workdir: Path = args.workdir or video.parent / ".shufa-work" / video.stem
    workdir.mkdir(parents=True, exist_ok=True)

    print(f"[1/8] 探针 {video.name}")
    info = pipeline.probe_stage(video)
    print(f"      {info.width}x{info.height} {info.duration_s:.1f}s @ {info.fps:.0f}fps, "
          f"容器旋转声明 {info.metadata_rotation_cw}°")

    print(f"[2/8] 抽帧 {args.fps}fps")
    ts = pipeline.sample_stage(video, workdir, args.fps)
    print(f"      {len(ts)} 帧")

    print("[3/8] 旋转探测")
    orient = pipeline.orient_stage(workdir, args.rotate)
    steps, note = orient.steps, orient.note
    views = pipeline.load_views(workdir, steps)
    H, W = views.frames[0].shape[:2]
    print(f"      {note} → {W}x{H}")

    print("[4/8] 对齐 + 页面背景 + 田字格检测")
    gs = pipeline.grid_stage(workdir, views, args.rotate, steps, note)
    views, steps, note = gs.views, gs.steps, gs.note
    det = gs.det
    print(f"      {note}")
    print(f"      田字格 {len(det.grids)} 个：" +
          ", ".join(f"#{i}({g.center[0]:.0f},{g.center[1]:.0f})s={g.side:.0f}px"
                    for i, g in enumerate(det.grids)))

    print("[5/8] 笔迹与旁注时间线")
    isg = pipeline.ink_stage(workdir, views, det.grids, ts)
    ink, focus_gi = isg.analysis, isg.focus_gi
    print(f"      旁注簇 {len(ink.annotations)} 个：" +
          ", ".join(f"{a.first_ts:.1f}s({a.pixels}px)" for a in ink.annotations))

    print("[6/8] 裁剪与增强")
    cs = pipeline.clip_stage(
        video, workdir, views, det.grids, ts,
        annotations=[{"first_ts": a.first_ts, "bbox": list(a.bbox), "mask": a.mask_crop}
                     for a in ink.annotations],
        ink_curve=ink.ink_curve, analysis_end=ink.analysis_end,
        focus_gi=focus_gi, steps=steps, enhance=args.enhance)
    print(f"      焦点回放剪辑 {cs.clip_info['duration_s']:.1f}s / {cs.clip_info['bytes'] // 1024}KB")

    print("[7/8] 转录与摘要")
    transcript = None
    if args.transcribe == "auto" and info.has_audio:
        tsg = pipeline.transcribe_stage(video, workdir, has_audio=True)
        transcript = tsg.transcript
        if transcript is None:
            print("      mlx-whisper 不可用，跳过转录（uv sync --extra transcribe 安装）")
        else:
            print(f"      {len(transcript.segments)} 段")

    print("[8/8] 导出分析包")
    bundle = pipeline.export_stage(
        out_dir=args.out_dir or (workdir / "bundle"),
        views=views, grids=det.grids, ts=ts,
        probe_info=info, video_name=video.name,
        orient_note=note, final_steps=steps, enhance=args.enhance,
        ink_curve=ink.ink_curve, focus_gi=focus_gi,
        focus_bbox=cs.bbox,
        grids_data=cs.grids_data, annos_data=cs.annos_data,
        focus_crop=cs.focus_crop, timeline=cs.timeline,
        clip_info={"path": str(cs.clip_info["path"]),
                   "duration_s": cs.clip_info["duration_s"]},
        segments=transcript.segments if transcript else [],
        transcript_model=transcript.model if transcript else "",
        summary_file=args.summary_file, labels=args.labels)
    print(f"✔ 分析包：{bundle}")
    if args.serve:
        from .serve import serve_bundle
        serve_bundle(bundle, port=args.port, open_browser=not args.no_open)
    return bundle


def main() -> None:
    run()


if __name__ == "__main__":
    main()
