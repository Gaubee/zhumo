"""向导 OCR 模型预热（Owner 需求 2026-09-29：准备步骤缺模型安装步——
此前 PP-OCRv6 权重在首个分析任务里懒下载，73MB 落在任务关键路径上）。

两种模式：
  预热（缺省）：构造 RapidOCR 引擎（按档位从 ModelScope 懒下载并缓存到
    包内 models/），随后用合成图跑一次 rec 推理验证可用性。
  --check：只验缓存文件存在（不联网不下载）——向导嗅探/后验探测用；
    档位取 --size 或环境 SHUFA_OCR_SIZE（缺省 medium）。

RapidOCR 构造时会连带初始化 det/cls 副模型（即使 rec-only）——check 与
预热都覆盖这三个文件，避免「只下了 rec、首次运行又去拉 det」的半就绪态。
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def _models_dir() -> Path:
    import rapidocr

    return Path(rapidocr.__file__).parent / "models"


def _required_files(size: str) -> list[tuple[str, str]]:
    # (文件名, 说明)——det/cls 是 RapidOCR 引擎构造的固定副模型。
    return [
        (f"PP-OCRv6_rec_{size}.onnx", f"PP-OCRv6 {size} 识别模型"),
        ("PP-OCRv6_det_small.onnx", "检测副模型（引擎构造连带初始化）"),
        ("ch_ppocr_mobile_v2.0_cls_mobile.onnx", "方向分类副模型（引擎构造连带初始化）"),
    ]


def _resolve_size(explicit: str | None) -> str:
    from .ocr import DEFAULT_OCR_SIZE, normalize_ocr_size

    return normalize_ocr_size(explicit or os.environ.get("SHUFA_OCR_SIZE") or DEFAULT_OCR_SIZE)


def check(size: str) -> int:
    models = _models_dir()
    missing = [(name, what) for name, what in _required_files(size) if not (models / name).is_file()]
    if missing:
        for name, what in missing:
            print(f"[check] 缺少 {what}：{models / name}", file=sys.stderr)
        return 1
    print(f"[check] PP-OCRv6_{size} 模型已缓存（{models}）")
    return 0


def warm(size: str) -> int:
    from .ocr import _build_engine, recognize_crop

    print(f"[ocr] 预热 PP-OCRv6_{size}（RapidOCR 首次使用会从 ModelScope 下载并缓存）")
    engine = _build_engine(size)
    import numpy as np

    # 合成图验证：白底黑字方块。识别结果允许为空（旁路感知，空输出合法）——
    # 引擎构造成功 + 推理不抛异常 = 模型就绪。
    probe = np.full((64, 64, 3), 255, np.uint8)
    probe[16:48, 16:48] = 0
    result = recognize_crop(engine, probe)
    print(f"[ocr] 推理自检通过（合成图输出：{result.label!r} conf={result.confidence:.2f}）")
    return check(size)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="PP-OCRv6 模型预热/缓存检查（向导准备步骤）")
    parser.add_argument("--size", help="档位 medium|small（缺省读 SHUFA_OCR_SIZE，再缺省 medium）")
    parser.add_argument("--check", action="store_true", help="只检查缓存是否就绪，不联网")
    args = parser.parse_args(argv)
    try:
        size = _resolve_size(args.size)
    except ValueError as exc:
        print(f"[ocr] {exc}", file=sys.stderr)
        return 2
    return check(size) if args.check else warm(size)


if __name__ == "__main__":
    raise SystemExit(main())
