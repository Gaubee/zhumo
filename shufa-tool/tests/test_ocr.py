from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import cv2
import numpy as np

from shufa_tool import pipeline
from shufa_tool.ocr import (
    _build_engine,
    _prepare_crop,
    normalize_ocr_size,
    recognize_crop,
    recognize_crops,
)


class FixedEngine:
    def __init__(self, result: object | None = None, error: Exception | None = None) -> None:
        self.result = result
        self.error = error

    def __call__(self, _image: np.ndarray, **_kwargs: object) -> object:
        if self.error:
            raise self.error
        return self.result


class OCRTests(unittest.TestCase):
    def test_tiny_is_not_an_exposed_ocr_size(self) -> None:
        self.assertEqual(normalize_ocr_size(None), "medium")
        self.assertEqual(normalize_ocr_size("small"), "small")
        with self.assertRaisesRegex(ValueError, "tiny 不开放"):
            normalize_ocr_size("tiny")

    def test_rapidocr_enum_parameters_match_the_installed_api(self) -> None:
        from rapidocr.utils.typings import ModelType, OCRVersion

        with patch("rapidocr.RapidOCR") as rapid_ocr:
            _build_engine("medium")
        params = rapid_ocr.call_args.kwargs["params"]
        self.assertIs(params["Rec.model_type"], ModelType.MEDIUM)
        self.assertIs(params["Rec.ocr_version"], OCRVersion.PPOCRV6)

    def test_empty_ctc_result_is_a_valid_empty_recognition(self) -> None:
        result = recognize_crop(FixedEngine(SimpleNamespace(txts=[], scores=[])), np.zeros((40, 40, 3), np.uint8))
        self.assertEqual((result.label, result.confidence, result.failed), ("", 0.0, False))

    def test_engine_exception_degrades_to_empty_recognition(self) -> None:
        result = recognize_crop(
            FixedEngine(error=RuntimeError("inference failed")),
            np.zeros((40, 40, 3), np.uint8),
        )
        self.assertEqual((result.label, result.confidence, result.failed), ("", 0.0, True))

    def test_preprocessing_whitens_the_crop_border(self) -> None:
        crop = np.zeros((40, 40, 3), dtype=np.uint8)
        prepared = _prepare_crop(crop)
        self.assertTrue(np.all(prepared[0, :, :] == 255))
        self.assertTrue(np.all(prepared[20, 20, :] == 0))

    def test_crop_filename_index_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            crop_path = Path(directory) / "grid_7.png"
            self.assertTrue(cv2.imwrite(str(crop_path), np.zeros((40, 40, 3), np.uint8)))
            engine = FixedEngine(SimpleNamespace(txts=["桂"], scores=[0.93]))
            with patch("shufa_tool.ocr._build_engine", return_value=engine):
                rows = recognize_crops([crop_path], "medium")
        self.assertEqual(rows[0]["idx"], 7)
        self.assertEqual(rows[0]["label_ocr"], "桂")
        self.assertAlmostEqual(float(rows[0]["label_ocr_conf"]), 0.93)

    def test_ocr_attachment_never_changes_the_transcript_label(self) -> None:
        grids = [{"idx": 0, "label": ""}, {"idx": 1, "label": "桂"}]
        pipeline._attach_ocr_results(
            grids,
            [
                {"idx": 0, "label_ocr": "杨", "label_ocr_conf": 0.99},
                {"idx": 1, "label_ocr": "桂", "label_ocr_conf": 0.94},
            ],
        )
        self.assertEqual([grid["label"] for grid in grids], ["", "桂"])
        self.assertEqual([grid["label_ocr"] for grid in grids], ["杨", "桂"])


if __name__ == "__main__":
    unittest.main()
