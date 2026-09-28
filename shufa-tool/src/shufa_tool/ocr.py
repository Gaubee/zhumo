"""PP-OCRv6 单格识别适配层。

意图（原始需求 2026-09-28）：把 OCR 作为独立的机器感知旁路接入书法管线。
1. 只暴露经真实手写样本验证的 small/medium 档位；
2. 每张 320px 格图使用 rec-only，避免整页检测把田字格线当文本；
3. 识别失败返回可序列化的空结果，由调用方决定是否展示，不污染转录证据。
模型由 RapidOCR 3.9.2 按档位从 ModelScope 懒下载并缓存。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

OCR_SIZES = ("medium", "small")
DEFAULT_OCR_SIZE = "medium"


@dataclass(frozen=True)
class OCRResult:
    label: str
    confidence: float
    failed: bool = False


def normalize_ocr_size(size: str | None) -> str:
    """校验管理员/CLI 输入；tiny 有已知手写精度坍塌，故不接受。"""
    value = (size or DEFAULT_OCR_SIZE).strip().lower()
    if value not in OCR_SIZES:
        raise ValueError(f"OCR 档位仅支持 {', '.join(OCR_SIZES)}（tiny 不开放：手写准确率不足）")
    return value


def _prepare_crop(crop: np.ndarray) -> np.ndarray:
    """压掉裁剪边缘的田字格线，同时保留中心笔画供 rec 模型识别。"""
    if crop.ndim == 2:
        gray = crop
    else:
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]
    # clip_stage 已留 8% 呼吸边；再白化最外圈，避免 rec-only 把边框当笔画。
    border = max(2, int(round(min(h, w) * 0.08)))
    clean = gray.copy()
    clean[:border, :] = 255
    clean[-border:, :] = 255
    clean[:, :border] = 255
    clean[:, -border:] = 255
    # 统一为 RapidOCR 接受的 3 通道图。保持原始灰度，不做激进二值化，
    # 防止毛笔/铅笔的细灰笔画在阈值化时消失。
    return cv2.cvtColor(clean, cv2.COLOR_GRAY2BGR)


def _build_engine(size: str) -> Any:
    try:
        from rapidocr import RapidOCR
        from rapidocr.utils.typings import ModelType, OCRVersion
    except ImportError as exc:  # pragma: no cover - 由 CLI 的可选 extra 覆盖
        raise RuntimeError("OCR 依赖未安装，请执行 uv sync --extra ocr") from exc
    try:
        return RapidOCR(
            params={
                "Global.use_det": False,
                "Global.use_cls": False,
                "Global.use_rec": True,
                "Global.text_score": 0.0,
                "Rec.model_type": ModelType[size.upper()],
                "Rec.ocr_version": OCRVersion.PPOCRV6,
            }
        )
    except Exception as exc:
        raise RuntimeError(f"OCR 模型初始化失败：{exc}") from exc


def recognize_crop(engine: Any, crop: np.ndarray) -> OCRResult:
    """识别单个格子；引擎输出异常或空串均降级为空结果。"""
    try:
        result = engine(_prepare_crop(crop), use_det=False, use_cls=False, use_rec=True)
        texts = getattr(result, "txts", None)
        scores = getattr(result, "scores", None)
        if not texts or not scores:
            return OCRResult("", 0.0)
        label = "".join(str(text).strip() for text in texts).strip()
        score_values = [float(score) for score in scores]
        confidence = min(score_values) if label and score_values else 0.0
        if not np.isfinite(confidence):
            confidence = 0.0
        return OCRResult(label, max(0.0, min(1.0, confidence)))
    except Exception:
        # OCR 是旁路感知；单格失败不能让导出或证据链失败。
        return OCRResult("", 0.0, failed=True)


def recognize_crops(crops: list[Path], size: str | None = None) -> list[dict[str, object]]:
    """批量识别 crop 文件，返回 manifest 可直接写入的结构。"""
    normalized = normalize_ocr_size(size)
    engine = _build_engine(normalized)
    rows: list[dict[str, object]] = []
    for crop_path in crops:
        try:
            idx = int(crop_path.stem.removeprefix("grid_"))
        except ValueError as exc:
            raise ValueError(f"格字裁剪图文件名无效：{crop_path.name}") from exc
        crop = cv2.imread(str(crop_path), cv2.IMREAD_COLOR)
        if crop is None:
            result = OCRResult("", 0.0, failed=True)
        else:
            result = recognize_crop(engine, crop)
        rows.append({
            "idx": idx,
            "label_ocr": result.label,
            "label_ocr_conf": round(result.confidence, 4),
            "failed": result.failed,
        })
    return rows
