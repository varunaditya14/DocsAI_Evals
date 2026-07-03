"""API and command-line entrypoint for DocsAI OCR evaluation."""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.api_client import extract_ocr_fields, get_run_steps, get_run_steps_debug
from backend.auth import get_bearer_token
from backend.cleaner import clean_ocr_markdown
from backend.config import get_settings
from backend.evaluator import (
    calculate_llm_f1,
    calculate_ocr_markdown_score,
    run_llm_field_comparison,
    run_difflib,
    run_jiwer_on_markdown,
    run_rapidfuzz_on_markdown,
)
from backend.golden_loader import (
    get_available_filenames,
    get_expected_fields_from_record,
    get_field_types_from_record,
    get_gds_storage_dir,
    get_gds_path,
    get_reference_markdown,
    load_all_golden,
    load_golden_by_filename,
    startup_check,
)
from backend.normalizer import normalize_keys_to_camel
from backend.report import save_report


logger = logging.getLogger(__name__)


class EvalRequest(BaseModel):
    """Request body for starting an OCR evaluation."""

    run_id: str
    filename: str


REQUIRED_GDS_KEYS = {
    "filename",
}

tags_metadata = [
    {
        "name": "health",
        "description": "Server health and connectivity checks",
    },
    {
        "name": "debug",
        "description": (
            "Debug endpoints for testing DocsAI connectivity and GDS loading. "
            "Use these to verify setup before running evaluations."
        ),
    },
    {
        "name": "golden",
        "description": "Upload and manage the golden dataset",
    },
    {
        "name": "evaluations",
        "description": (
            "Run evaluations and retrieve reports. Use /ocr to test OCR eval only, "
            "/llm to test LLM eval only, /run for compact evals report saving, "
            "and /run/full for verbose evals report saving."
        ),
    },
]

app = FastAPI(title="DocsAI Evals API", openapi_tags=tags_metadata)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_static_asset_cache_headers(request: Request, call_next):
    """Prevent stale frontend assets during local UI iteration."""
    response = await call_next(request)
    if request.url.path.startswith("/assets/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response


@app.on_event("startup")
def on_startup() -> None:
    """Run non-fatal startup checks for paths, GDS, and OpenAI configuration."""
    logging.basicConfig(level=logging.INFO)
    results_path = os.getenv("RESULTS_PATH")
    gds_path = os.getenv("GDS_PATH")
    if results_path:
        os.makedirs(results_path, exist_ok=True)
    if gds_path:
        gds_parent = os.path.dirname(gds_path)
        if gds_parent:
            os.makedirs(gds_parent, exist_ok=True)
    try:
        settings = get_settings()
        if not settings.azure_openai_configured:
            logger.warning("Azure OpenAI judge is not fully configured.")
    except RuntimeError as exc:
        logger.warning("Startup configuration check failed: %s", exc)
    startup_check()
    for env_name in ("AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_VERSION"):
        if not os.getenv(env_name):
            logger.warning("Azure OpenAI environment variable is missing: %s", env_name)


def _print_summary(
    diff_result: dict[str, Any],
    jiwer_result: dict[str, Any],
    fuzz_result: dict[str, Any],
    ocr_score: dict[str, Any],
    report_path: str,
) -> None:
    """Print a concise terminal summary of the evaluation."""
    print("DocsAI OCR Evaluation Summary")
    print(f"Missing lines: {diff_result['total_missing']}")
    print(f"Added lines: {diff_result['total_added']}")
    print(f"Overall CER: {jiwer_result.get('overall_cer')}")
    print(f"Overall WER: {jiwer_result.get('overall_wer')}")
    print(f"Fuzzy status: {fuzz_result.get('status')} score={fuzz_result.get('overall_score')}")
    print(
        "OCR composite: "
        f"structural={ocr_score['structural_score']} "
        f"text_accuracy={ocr_score['text_accuracy_score']} "
        f"similarity={ocr_score['similarity_score']} "
        f"composite={ocr_score['composite_score']}"
    )
    print(f"Report saved: {report_path}")


def _calculate_combined(ocr_score: dict[str, Any], llm_f1: dict[str, Any]) -> dict[str, float]:
    """Average OCR markdown score and LLM field F1 into evals report scores."""
    ocr_composite = float(ocr_score.get("composite_score", 0))
    llm_score = float(llm_f1.get("f1", 0))
    return {
        "f1": round((ocr_composite + llm_score) / 2, 4),
        "precision": round((ocr_composite + float(llm_f1.get("precision", 0))) / 2, 4),
        "recall": round((ocr_composite + float(llm_f1.get("recall", 0))) / 2, 4),
    }


def _scores_from_f1(f1_scores: dict[str, Any]) -> dict[str, float]:
    """Return precision, recall, and F1 scores rounded for an evals report."""
    return {
        "f1": round(float(f1_scores.get("f1", 0)), 4),
        "precision": round(float(f1_scores.get("precision", 0)), 4),
        "recall": round(float(f1_scores.get("recall", 0)), 4),
    }


def _scores_from_ocr_score(ocr_score: dict[str, Any]) -> dict[str, float]:
    """Return evals report score fields from OCR markdown composite score."""
    composite_score = round(float(ocr_score.get("composite_score", 0)), 4)
    return {
        "f1": composite_score,
        "precision": composite_score,
        "recall": composite_score,
    }


def _fetch_run_data(run_id: str) -> dict[str, Any]:
    """Fetch DocsAI run output and translate common failures to HTTP errors."""
    try:
        return get_run_steps(run_id)
    except RuntimeError as exc:
        message = str(exc)
        if "DocsAI auth failed after retry" in message or "401" in message:
            raise HTTPException(status_code=401, detail=message) from exc
        if "Status: 404" in message:
            raise HTTPException(status_code=404, detail=f"Run ID not found: {run_id}") from exc
        if "OCR step not found" in message or "No markdown content found" in message:
            raise HTTPException(status_code=404, detail=message) from exc
        raise HTTPException(status_code=500, detail=message) from exc


def _load_golden_record(filename: str) -> dict[str, Any]:
    """Load the GDS record for a filename or raise a 404 with available names."""
    golden_record = load_golden_by_filename(filename)
    if golden_record is not None:
        return golden_record

    available_files = get_available_filenames()
    if not available_files:
        raise HTTPException(
            status_code=404,
            detail="No golden dataset records found. Upload a golden dataset first using /api/golden/upload.",
        )
    raise HTTPException(
        status_code=404,
        detail={
            "message": "Filename not found in golden dataset.",
            "requested_filename": filename,
            "available_files": available_files,
        },
    )


def _detect_document_type(llm_output: dict[str, Any] | None) -> str:
    """Detect document type from extraction output while skipping metadata payloads."""
    output = normalize_keys_to_camel(llm_output) if isinstance(llm_output, dict) else {}
    extracted_data = output.get("extractedData")
    if isinstance(extracted_data, dict):
        output = normalize_keys_to_camel(extracted_data)

    extraction = output.get("extraction")
    if isinstance(extraction, dict):
        inner = normalize_keys_to_camel(extraction)
        document_type = inner.get("documentType")
        if isinstance(document_type, dict):
            document_type_value = document_type.get("value")
            if document_type_value:
                return str(document_type_value)
        if isinstance(inner.get("extractedFields"), list) and inner["extractedFields"]:
            return "passport"
        nested_type = _detect_document_type(inner)
        if nested_type != "unknown":
            return nested_type

    skip_keys = {
        "success",
        "extractionConfidence",
        "purchaseOrder",
        "proformaInvoice",
        "documentType",
        "classifiedFiles",
        "categoryValidationStatus",
        "categoryConfidence",
        "detectedFormType",
        "headerPattern",
        "lineItems",
    }
    for key, value in output.items():
        if key == "extractedFields" and isinstance(value, list) and value:
            return "passport"
        if key in skip_keys:
            continue
        if isinstance(value, list) and value:
            return str(key)
        if isinstance(value, dict):
            nested_type = _detect_document_type(value)
            if nested_type != "unknown":
                return nested_type

    logger.warning("Unable to detect document type from LLM output; returning unknown.")
    return "unknown"


def _run_ocr_eval_steps(
    run_data: dict[str, Any],
    record: dict[str, Any],
    document_type: str,
) -> dict[str, Any]:
    """Run OCR markdown-only evaluation steps without saving a report."""
    del document_type
    golden_markdown = get_reference_markdown(record)
    ocr_markdown = clean_ocr_markdown(run_data["ocr_markdown"])
    try:
        diff_result = run_difflib(golden_markdown, ocr_markdown)
        jiwer_result = run_jiwer_on_markdown(golden_markdown, ocr_markdown)
        fuzz_result = run_rapidfuzz_on_markdown(golden_markdown, ocr_markdown)
        ocr_score = calculate_ocr_markdown_score(diff_result, jiwer_result, fuzz_result)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Eval calculation error: {exc}") from exc

    return {
        "diff_result": diff_result,
        "jiwer_result": jiwer_result,
        "fuzz_result": fuzz_result,
        "ocr_score": ocr_score,
    }


def _run_llm_eval_steps(
    run_data: dict[str, Any],
    record: dict[str, Any],
    document_type: str,
) -> dict[str, Any]:
    """Run LLM field comparison steps without saving a report."""
    golden_fields = get_expected_fields_from_record(record, document_type)
    field_types = get_field_types_from_record(record, document_type, fields=golden_fields)
    ocr_fields = extract_ocr_fields(run_data.get("llm_output"), document_type)
    logger.info("LLM eval - document_type detected: %s", document_type)
    logger.info("LLM eval - golden_fields keys: %s", list(golden_fields.keys()))
    logger.info("LLM eval - ocr_fields keys: %s", list(ocr_fields.keys()))
    logger.info("LLM eval - field count: golden=%s, ocr=%s", len(golden_fields), len(ocr_fields))

    try:
        field_comparison = run_llm_field_comparison(golden_fields, ocr_fields, field_types)
        f1_scores = calculate_llm_f1(field_comparison)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"LLM eval calculation error: {exc}") from exc

    return {
        "field_comparison": field_comparison,
        "f1_scores": f1_scores,
    }


def _save_full_evaluation_report(
    run_id: str,
    filename: str,
    document_type: str,
    ocr_eval: dict[str, Any],
    llm_eval: dict[str, Any],
    combined: dict[str, Any],
) -> str:
    """Save the full OCR, LLM, and evals report."""
    try:
        return save_report(
            run_id=run_id,
            filename=filename,
            document_type=document_type,
            eval_type="full",
            diff_result=ocr_eval["diff_result"],
            jiwer_result=ocr_eval["jiwer_result"],
            fuzz_result=ocr_eval["fuzz_result"],
            ocr_score=ocr_eval["ocr_score"],
            llm_comparison_result=llm_eval["field_comparison"],
            llm_f1=llm_eval["f1_scores"],
            combined_scores=combined,
            evals_report=combined,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _save_single_evaluation_report(
    run_id: str,
    filename: str,
    document_type: str,
    eval_type: str,
    ocr_eval: dict[str, Any] | None = None,
    llm_eval: dict[str, Any] | None = None,
) -> str:
    """Save an OCR-only or LLM-only evaluation report."""
    if eval_type == "ocr":
        evals_report = _scores_from_ocr_score((ocr_eval or {}).get("ocr_score", {}))
    elif eval_type == "llm":
        evals_report = _scores_from_f1((llm_eval or {}).get("f1_scores", {}))
    else:
        raise HTTPException(status_code=422, detail=f"Unsupported eval type: {eval_type}")

    try:
        return save_report(
            run_id=run_id,
            filename=filename,
            document_type=document_type,
            eval_type=eval_type,
            diff_result=(ocr_eval or {}).get("diff_result", {}),
            jiwer_result=(ocr_eval or {}).get("jiwer_result", {}),
            fuzz_result=(ocr_eval or {}).get("fuzz_result", {}),
            ocr_score=(ocr_eval or {}).get("ocr_score", {}),
            llm_comparison_result=(llm_eval or {}).get("field_comparison", {}),
            llm_f1=(llm_eval or {}).get("f1_scores", {}),
            combined_scores=evals_report,
            evals_report=evals_report,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _report_ocr_eval(report: dict[str, Any]) -> dict[str, Any]:
    """Return OCR eval data from either new or legacy report shape."""
    if isinstance(report.get("ocr_eval"), dict):
        return report["ocr_eval"]
    return {
        "diff_result": report.get("diff_result", {}),
        "jiwer_result": report.get("jiwer_result", {}),
        "fuzz_result": report.get("fuzz_result", {}),
        "ocr_score": report.get("ocr_score", {}),
        "f1_scores": report.get("f1_scores", {}),
    }


def _report_evals_scores(report: dict[str, Any]) -> dict[str, Any]:
    """Return evals report scores, falling back to older report shapes."""
    evals_report = report.get("evals_report")
    if isinstance(evals_report, dict) and evals_report:
        return evals_report
    combined = report.get("combined")
    if isinstance(combined, dict) and combined:
        return combined
    llm_eval = report.get("llm_eval")
    if isinstance(llm_eval, dict) and isinstance(llm_eval.get("f1_scores"), dict) and llm_eval["f1_scores"]:
        return llm_eval["f1_scores"]
    ocr_eval = _report_ocr_eval(report)
    if isinstance(ocr_eval.get("ocr_score"), dict) and ocr_eval["ocr_score"]:
        return _scores_from_ocr_score(ocr_eval["ocr_score"])
    return ocr_eval.get("f1_scores", {})


def run_ocr_eval(run_id: str, filename: str) -> dict[str, Any]:
    """Run the full OCR evaluation workflow for a DocsAI run and filename."""
    try:
        run_data = _fetch_run_data(run_id)
        golden_record = _load_golden_record(filename)
        document_type = _detect_document_type(run_data.get("llm_output"))
        ocr_eval = _run_ocr_eval_steps(run_data, golden_record, document_type)
        llm_eval = _run_llm_eval_steps(run_data, golden_record, document_type)
        combined_scores = _calculate_combined(ocr_eval["ocr_score"], llm_eval["f1_scores"])
        report_path = _save_full_evaluation_report(
            run_id,
            filename,
            document_type,
            ocr_eval,
            llm_eval,
            combined_scores,
        )

        _print_summary(
            ocr_eval["diff_result"],
            ocr_eval["jiwer_result"],
            ocr_eval["fuzz_result"],
            ocr_eval["ocr_score"],
            report_path,
        )
        return {
            "status": "success",
            "run_id": run_id,
            "filename": filename,
            "report_name": os.path.basename(report_path),
            "ocr_eval": {
                "composite_score": ocr_eval["ocr_score"]["composite_score"],
                "structural_score": ocr_eval["ocr_score"]["structural_score"],
                "text_accuracy_score": ocr_eval["ocr_score"]["text_accuracy_score"],
                "similarity_score": ocr_eval["ocr_score"]["similarity_score"],
                "missing_lines": ocr_eval["diff_result"]["total_missing"],
                "line_count": len(ocr_eval["jiwer_result"].get("line_results", [])),
            },
            "llm_eval": {
                "f1": llm_eval["f1_scores"]["f1"],
                "precision": llm_eval["f1_scores"]["precision"],
                "recall": llm_eval["f1_scores"]["recall"],
                "tp": llm_eval["f1_scores"]["tp"],
                "fp": llm_eval["f1_scores"]["fp"],
                "fn": llm_eval["f1_scores"]["fn"],
                "grey_count": llm_eval["f1_scores"]["grey_count"],
            },
            "evals_report": combined_scores,
            "combined": combined_scores,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Unexpected evaluation error for run %s.", run_id)
        raise HTTPException(status_code=500, detail=f"Unexpected evaluation error: {exc}") from exc


def _validate_golden_record(record: Any, line_number: int) -> None:
    """Validate one uploaded golden dataset record."""
    if not isinstance(record, dict):
        raise HTTPException(status_code=400, detail=f"Line {line_number}: record must be a JSON object.")
    normalized_record = normalize_keys_to_camel(record)

    for key in REQUIRED_GDS_KEYS:
        if key not in record or str(record.get(key, "")).strip() == "":
            raise HTTPException(status_code=400, detail=f"Line {line_number}: missing key '{key}'.")

    has_reference = bool(
        normalized_record.get("referenceMarkdown")
        or normalized_record.get("ocrMarkdown")
    )
    json_output = normalized_record.get("jsonOutput")
    has_document_key = any(isinstance(value, list) and value for value in normalized_record.values())
    has_json_output_document_key = isinstance(json_output, dict) and any(
        isinstance(value, list) and value for value in json_output.values()
    )
    if not has_reference and not has_document_key and not has_json_output_document_key:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Line {line_number}: record must include reference_markdown "
                "or at least one non-empty document list."
            ),
        )


def _validate_golden_record_by_index(record: Any, index: int) -> None:
    """Validate one JSON-uploaded golden record by array index."""
    try:
        _validate_golden_record(record, index)
    except HTTPException as exc:
        raise HTTPException(
            status_code=exc.status_code,
            detail=str(exc.detail).replace(f"Line {index}:", f"Record {index}:"),
        ) from exc


def _parse_golden_upload(filename: str, content: bytes) -> list[dict[str, Any]]:
    """Parse .jsonl or .json golden uploads into validated records."""
    lower_name = filename.lower()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Golden dataset must be UTF-8 JSON.") from exc

    if lower_name.endswith(".jsonl"):
        records: list[dict[str, Any]] = []
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=400, detail=f"Line {line_number}: invalid JSON.") from exc
            _validate_golden_record(record, line_number)
            records.append(record)
        return records

    if lower_name.endswith(".json"):
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail="Golden dataset JSON is invalid.") from exc
        if isinstance(payload, dict):
            records = [payload]
        elif isinstance(payload, list):
            records = payload
        else:
            raise HTTPException(status_code=400, detail="Golden dataset JSON must be an object or array of objects.")
        for index, record in enumerate(records, start=1):
            _validate_golden_record_by_index(record, index)
        return records

    raise HTTPException(status_code=400, detail="Golden dataset must be .jsonl or .json")


def _safe_upload_filename(filename: str) -> str:
    """Return a filesystem-safe golden dataset upload filename."""
    base_name = os.path.basename(filename or "golden_dataset.json")
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", base_name).strip("._")
    return safe_name or "golden_dataset.json"


def _find_uploaded_golden_file(filename: str) -> str:
    """Return the newest retained upload path for an original upload filename."""
    storage_dir = get_gds_storage_dir()
    os.makedirs(storage_dir, exist_ok=True)
    safe_name = _safe_upload_filename(filename)
    matches = [
        os.path.join(storage_dir, name)
        for name in os.listdir(storage_dir)
        if name == safe_name or name.endswith(f"_{safe_name}")
    ]
    if not matches:
        return ""
    matches.sort(key=lambda path: os.path.getmtime(path), reverse=True)
    return matches[0]


def _save_uploaded_golden_file(filename: str, normalized_text: str, duplicate_action: str) -> tuple[str, str]:
    """Save an uploaded golden dataset using explicit duplicate handling."""
    storage_dir = get_gds_storage_dir()
    os.makedirs(storage_dir, exist_ok=True)
    safe_name = _safe_upload_filename(filename)
    existing_path = _find_uploaded_golden_file(filename)
    normalized_action = duplicate_action.strip().lower()

    if normalized_action not in {"reject", "overwrite", "save_new"}:
        raise HTTPException(status_code=400, detail="duplicate_action must be reject, overwrite, or save_new.")

    if existing_path and normalized_action == "reject":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_gds_filename",
                "message": "A golden dataset with this upload filename already exists.",
                "filename": safe_name,
                "existing_path": existing_path,
            },
        )

    if existing_path and normalized_action == "overwrite":
        try:
            with open(existing_path, "w", encoding="utf-8") as handle:
                handle.write(normalized_text)
        except OSError as exc:
            raise HTTPException(status_code=500, detail="Unable to overwrite golden dataset.") from exc
        return existing_path, "overwritten"

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    stored_path = os.path.join(storage_dir, f"{timestamp}_{safe_name}")
    collision_count = 1
    while os.path.exists(stored_path):
        stored_path = os.path.join(storage_dir, f"{timestamp}_{collision_count}_{safe_name}")
        collision_count += 1

    try:
        with open(stored_path, "x", encoding="utf-8") as handle:
            handle.write(normalized_text)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Unable to save golden dataset.") from exc

    return stored_path, "saved_new"


def _load_report_files() -> list[dict[str, Any]]:
    """Load saved evaluation report JSON files from the configured results path."""
    results_path = os.getenv("RESULTS_PATH", "").strip()
    if not results_path:
        logger.warning("RESULTS_PATH is not configured; report listing is empty.")
        return []
    os.makedirs(results_path, exist_ok=True)
    reports: list[dict[str, Any]] = []
    for name in os.listdir(results_path):
        if not name.endswith(".json"):
            continue
        path = os.path.join(results_path, name)
        try:
            with open(path, "r", encoding="utf-8") as handle:
                report = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(report, dict):
            report["name"] = name
            report["path"] = path
            report["size"] = os.path.getsize(path)
            report["modified"] = os.path.getmtime(path)
            reports.append(report)
    reports.sort(key=lambda report: float(report.get("modified", 0)), reverse=True)
    return reports


@app.get("/api/health", tags=["health"])
def health() -> dict[str, Any]:
    """Return API health status."""
    docsai_configured = all(
        os.getenv(name, "").strip()
        for name in (
            "DOCSAI_BASE_URL",
            "DOCSAI_CLIENT_ID",
            "DOCSAI_AUTH_EMAIL",
            "DOCSAI_TOKEN_EXPIRY_MINUTES",
        )
    )
    azure_openai_configured = all(
        os.getenv(name, "").strip()
        for name in (
            "AZURE_OPENAI_ENDPOINT",
            "AZURE_OPENAI_DEPLOYMENT",
            "AZURE_OPENAI_API_VERSION",
        )
    )
    return {
        "status": "ok",
        "gds_configured": bool(os.getenv("GDS_PATH", "").strip()),
        "results_configured": bool(os.getenv("RESULTS_PATH", "").strip()),
        "azure_openai_configured": azure_openai_configured,
        "azure_auth_method": os.getenv("AZURE_AUTH_METHOD", "default_credential").strip()
        or "default_credential",
        "docsai_configured": docsai_configured,
        "azure_openai_region": os.getenv("AZURE_OPENAI_REGION", "").strip(),
    }


@app.get("/api/debug/golden", tags=["debug"])
def debug_golden() -> dict[str, Any]:
    """Return safe debug information about the configured golden dataset."""
    try:
        gds_path = get_gds_path()
        storage_dir = get_gds_storage_dir()
    except RuntimeError:
        return {
            "gds_path": "",
            "storage_dir": "",
            "exists": False,
            "record_count": 0,
            "available_filenames": [],
            "message": "GDS_PATH is not configured.",
        }

    if not os.path.exists(gds_path) and not os.path.isdir(storage_dir):
        return {
            "gds_path": gds_path,
            "storage_dir": storage_dir,
            "exists": False,
            "record_count": 0,
            "available_filenames": [],
            "message": "No golden dataset uploaded yet.",
        }

    try:
        records = load_all_golden()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {
        "gds_path": gds_path,
        "storage_dir": storage_dir,
        "exists": True,
        "record_count": len(records),
        "available_filenames": [str(record.get("filename")) for record in records if record.get("filename")],
    }


@app.get("/api/debug/docsai/auth", tags=["debug"])
def debug_docsai_auth() -> dict[str, Any]:
    """Return a safe DocsAI auth debug result without exposing the full token."""
    try:
        token = get_bearer_token()
    except RuntimeError as exc:
        message = str(exc)
        status_code = 401 if "401" in message or "auth" in message.lower() else 500
        raise HTTPException(status_code=status_code, detail=f"DocsAI auth failed: {message}") from exc
    return {
        "docsai_auth_ok": True,
        "token_received": bool(token),
        "token_preview": f"{token[:12]}..." if token else "",
        "message": "DocsAI token fetched successfully",
    }


@app.get("/api/debug/docsai/run/{run_id}", tags=["debug"])
def debug_docsai_run(
    run_id: str,
    include_markdown_preview: bool = False,
    include_json_preview: bool = False,
) -> dict[str, Any]:
    """Return a safe debug summary for DocsAI run OCR and LLM detection."""
    try:
        return get_run_steps_debug(run_id, include_markdown_preview, include_json_preview)
    except RuntimeError as exc:
        message = str(exc)
        if "DocsAI auth failed after retry" in message or "401" in message:
            raise HTTPException(status_code=401, detail="DocsAI auth failed.") from exc
        if "Status: 404" in message:
            raise HTTPException(status_code=404, detail=f"Run ID not found: {run_id}") from exc
        if "OCR step not found" in message or "No markdown content found" in message:
            raise HTTPException(status_code=404, detail=message) from exc
        raise HTTPException(status_code=500, detail=f"DocsAI run debug failed: {message}") from exc


@app.post("/api/golden/upload", tags=["golden"])
async def upload_golden_dataset(
    file: UploadFile = File(...),
    duplicate_action: str = Query("reject"),
) -> dict[str, Any]:
    """Upload and retain a golden dataset file without replacing older uploads."""
    filename = file.filename or ""
    content = await file.read()
    records = _parse_golden_upload(filename, content)

    try:
        _ = get_gds_path()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        normalized_text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Golden dataset must be UTF-8 JSON.") from exc

    stored_path, stored_action = _save_uploaded_golden_file(filename, normalized_text, duplicate_action)
    available_filenames = get_available_filenames()

    return {
        "success": True,
        "filename": file.filename,
        "duplicate_action": duplicate_action,
        "stored_action": stored_action,
        "records": len(records),
        "uploaded_filenames": [str(record.get("filename")) for record in records if record.get("filename")],
        "available_filenames": available_filenames,
        "total_available_filenames": len(available_filenames),
        "stored_as": stored_path,
        "storage_dir": get_gds_storage_dir(),
    }


@app.post(
    "/api/evaluations/ocr",
    tags=["evaluations"],
    summary="Run OCR Evaluation Only",
)
def run_ocr_evaluation_only(request: EvalRequest) -> dict[str, Any]:
    """Run isolated OCR evaluation, save its report, and return full OCR output."""
    run_data = _fetch_run_data(request.run_id)
    golden_record = _load_golden_record(request.filename)
    document_type = _detect_document_type(run_data.get("llm_output"))
    ocr_eval = _run_ocr_eval_steps(run_data, golden_record, document_type)
    report_path = _save_single_evaluation_report(
        request.run_id,
        request.filename,
        document_type,
        "ocr",
        ocr_eval=ocr_eval,
    )
    return {
        "run_id": request.run_id,
        "filename": request.filename,
        "document_type": document_type,
        "eval_type": "ocr",
        "report_name": os.path.basename(report_path),
        "ocr_eval": ocr_eval,
        "evals_report": _scores_from_ocr_score(ocr_eval["ocr_score"]),
    }


@app.post(
    "/api/evaluations/llm",
    tags=["evaluations"],
    summary="Run LLM Evaluation Only",
)
def run_llm_evaluation_only(request: EvalRequest) -> dict[str, Any]:
    """Run isolated LLM field evaluation, save its report, and return full LLM output."""
    run_data = _fetch_run_data(request.run_id)
    golden_record = _load_golden_record(request.filename)
    document_type = _detect_document_type(run_data.get("llm_output"))
    llm_eval = _run_llm_eval_steps(run_data, golden_record, document_type)
    report_path = _save_single_evaluation_report(
        request.run_id,
        request.filename,
        document_type,
        "llm",
        llm_eval=llm_eval,
    )
    return {
        "run_id": request.run_id,
        "filename": request.filename,
        "document_type": document_type,
        "eval_type": "llm",
        "report_name": os.path.basename(report_path),
        "llm_eval": llm_eval,
        "evals_report": _scores_from_f1(llm_eval["f1_scores"]),
    }


@app.post(
    "/api/evaluations/run/full",
    tags=["evaluations"],
    summary="Run Full Evaluation and Save Report (verbose output)",
)
def run_full_evaluation_verbose(request: EvalRequest) -> dict[str, Any]:
    """Run OCR and LLM evals, save a report, and return the full output."""
    run_data = _fetch_run_data(request.run_id)
    golden_record = _load_golden_record(request.filename)
    document_type = _detect_document_type(run_data.get("llm_output"))
    ocr_eval = _run_ocr_eval_steps(run_data, golden_record, document_type)
    llm_eval = _run_llm_eval_steps(run_data, golden_record, document_type)
    combined = _calculate_combined(ocr_eval["ocr_score"], llm_eval["f1_scores"])
    report_path = _save_full_evaluation_report(
        request.run_id,
        request.filename,
        document_type,
        ocr_eval,
        llm_eval,
        combined,
    )
    return {
        "run_id": request.run_id,
        "filename": request.filename,
        "document_type": document_type,
        "eval_type": "full",
        "report_name": os.path.basename(report_path),
        "ocr_eval": ocr_eval,
        "llm_eval": llm_eval,
        "evals_report": combined,
        "combined": combined,
    }


@app.post("/api/evaluations/run", tags=["evaluations"])
def run_evaluation(request: EvalRequest) -> dict[str, Any]:
    """Run an OCR evaluation from the browser UI."""
    return run_ocr_eval(request.run_id, request.filename)


@app.get("/api/evaluations/reports", tags=["evaluations"])
def list_reports() -> dict[str, Any]:
    """List saved evaluation report files."""
    if not os.getenv("RESULTS_PATH", "").strip():
        return {"reports": [], "warning": "RESULTS_PATH is not configured."}
    return {"reports": _load_report_files()}


@app.get("/api/evaluations/summary", tags=["evaluations"])
def evaluation_summary() -> dict[str, Any]:
    """Return aggregate statistics across all saved evaluation reports."""
    reports = _load_report_files()
    if not reports:
        return {
            "total_runs": 0,
            "average_f1": 0,
            "average_recall": 0,
            "average_precision": 0,
            "worst_field": "",
            "best_field": "",
            "reports_by_document_type": {},
        }

    total_runs = len(reports)
    average_f1 = sum(_report_evals_scores(report).get("f1", 0) for report in reports) / total_runs
    average_recall = sum(_report_evals_scores(report).get("recall", 0) for report in reports) / total_runs
    average_precision = sum(
        _report_evals_scores(report).get("precision", 0) for report in reports
    ) / total_runs
    field_scores: dict[str, list[float]] = {}
    reports_by_document_type: dict[str, int] = {}

    for report in reports:
        document_type = str(report.get("document_type") or "unknown")
        reports_by_document_type[document_type] = reports_by_document_type.get(document_type, 0) + 1
        ocr_eval = _report_ocr_eval(report)
        for field, result in ocr_eval.get("fuzz_result", {}).items():
            if not isinstance(result, dict):
                continue
            score = 1.0 if result.get("status") == "TP" else 0.0
            field_scores.setdefault(field, []).append(score)

    field_averages = {
        field: sum(scores) / len(scores) for field, scores in field_scores.items() if scores
    }
    worst_field = min(field_averages, key=field_averages.get) if field_averages else ""
    best_field = max(field_averages, key=field_averages.get) if field_averages else ""

    return {
        "total_runs": total_runs,
        "average_f1": round(average_f1, 4),
        "average_recall": round(average_recall, 4),
        "average_precision": round(average_precision, 4),
        "worst_field": worst_field,
        "best_field": best_field,
        "reports_by_document_type": reports_by_document_type,
    }


@app.get("/api/evaluations/reports/{report_name}", tags=["evaluations"])
def get_report(report_name: str) -> dict[str, Any]:
    """Return a saved evaluation report by file name."""
    results_path = os.getenv("RESULTS_PATH", "").strip()
    if not results_path:
        raise HTTPException(status_code=400, detail="RESULTS_PATH is not configured.")
    report_path = os.path.join(results_path, report_name)
    results_root = os.path.abspath(results_path)
    requested_path = os.path.abspath(report_path)
    if os.path.commonpath([results_root, requested_path]) != results_root:
        raise HTTPException(status_code=400, detail="Invalid report name.")
    try:
        with open(requested_path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as exc:
        raise HTTPException(status_code=404, detail="Report not found.") from exc


FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
if os.path.isdir(FRONTEND_DIR):
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIR), name="frontend-assets")


@app.get("/")
def frontend_index() -> FileResponse:
    """Serve the DocsAI Evals frontend."""
    return FileResponse(
        os.path.join(FRONTEND_DIR, "index.html"),
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description="Run DocsAI OCR evaluation.")
    parser.add_argument("run_id", help="DocsAI run ID to evaluate.")
    parser.add_argument("filename", help="Golden dataset filename to match.")
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    run_ocr_eval(args.run_id, args.filename)
