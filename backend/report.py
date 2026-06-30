"""Report persistence for DocsAI OCR evaluations."""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

from backend.config import get_settings


def _round_floats(value: Any) -> Any:
    """Recursively round float values to 4 decimal places for report output."""
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, dict):
        return {key: _round_floats(nested_value) for key, nested_value in value.items()}
    if isinstance(value, list):
        return [_round_floats(item) for item in value]
    return value


def save_report(
    run_id: str,
    filename: str,
    document_type: str | None = None,
    eval_type: str = "full",
    diff_result: dict[str, Any] | None = None,
    jiwer_result: dict[str, Any] | None = None,
    fuzz_result: dict[str, Any] | None = None,
    ocr_score: dict[str, Any] | None = None,
    llm_comparison_result: dict[str, Any] | None = None,
    llm_f1: dict[str, Any] | None = None,
    combined_scores: dict[str, Any] | None = None,
    evals_report: dict[str, Any] | None = None,
) -> str:
    """Save an evaluation report JSON file and return its path."""
    settings = get_settings()
    os.makedirs(settings.results_path, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    suffix_by_type = {
        "ocr": "ocr_eval",
        "llm": "llm_eval",
        "full": "evals_report",
    }
    report_suffix = suffix_by_type.get(eval_type, "evals_report")
    report_path = os.path.join(settings.results_path, f"{run_id}_{timestamp}_{report_suffix}.json")
    collision_count = 1
    while os.path.exists(report_path):
        report_path = os.path.join(
            settings.results_path,
            f"{run_id}_{timestamp}_{collision_count}_{report_suffix}.json",
        )
        collision_count += 1
    overall_scores = evals_report or combined_scores or ocr_score or llm_f1 or {}
    payload = {
        "run_id": run_id,
        "filename": filename,
        "document_type": document_type,
        "eval_type": eval_type,
        "report_filename": os.path.basename(report_path),
        "timestamp": timestamp,
        "ocr_eval": {
            "diff_result": diff_result or {},
            "jiwer_result": jiwer_result or {},
            "fuzz_result": fuzz_result or {},
            "ocr_score": ocr_score or {},
        },
        "llm_eval": {
            "field_comparison": llm_comparison_result or {},
            "f1_scores": llm_f1 or {},
        },
        "evals_report": overall_scores,
        "combined": combined_scores or {},
    }

    try:
        with open(report_path, "x", encoding="utf-8") as handle:
            json.dump(_round_floats(payload), handle, ensure_ascii=False, indent=2)
    except OSError as exc:
        raise RuntimeError(f"Unable to save report file: {report_path}") from exc

    return report_path
