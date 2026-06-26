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
    diff_result: dict[str, Any],
    jiwer_result: dict[str, Any],
    fuzz_result: dict[str, Any],
    f1_scores: dict[str, Any],
    document_type: str | None = None,
) -> str:
    """Save an OCR evaluation report JSON file and return its path."""
    settings = get_settings()
    os.makedirs(settings.results_path, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    report_path = os.path.join(settings.results_path, f"{run_id}_{timestamp}_ocr_eval.json")
    collision_count = 1
    while os.path.exists(report_path):
        report_path = os.path.join(
            settings.results_path,
            f"{run_id}_{timestamp}_{collision_count}_ocr_eval.json",
        )
        collision_count += 1
    payload = {
        "run_id": run_id,
        "filename": filename,
        "document_type": document_type,
        "report_filename": os.path.basename(report_path),
        "timestamp": timestamp,
        "diff_result": diff_result,
        "jiwer_result": jiwer_result,
        "fuzz_result": fuzz_result,
        "f1_scores": f1_scores,
    }

    try:
        with open(report_path, "x", encoding="utf-8") as handle:
            json.dump(_round_floats(payload), handle, ensure_ascii=False, indent=2)
    except OSError as exc:
        raise RuntimeError(f"Unable to save report file: {report_path}") from exc

    return report_path
