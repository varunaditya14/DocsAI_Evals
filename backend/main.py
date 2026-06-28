"""API and command-line entrypoint for DocsAI OCR evaluation."""

from __future__ import annotations

import argparse
import json
import logging
import os
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.api_client import extract_ocr_fields, get_run_steps, get_run_steps_debug
from backend.auth import get_bearer_token
from backend.cleaner import clean_ocr_markdown
from backend.config import get_settings
from backend.evaluator import (
    calculate_f1,
    resolve_grey_zone,
    run_difflib,
    run_jiwer_per_field,
    run_rapidfuzz_per_field,
)
from backend.golden_loader import (
    get_available_filenames,
    get_expected_fields_from_record,
    get_field_types_from_record,
    get_gds_path,
    get_reference_markdown,
    infer_document_type,
    load_all_golden,
    load_golden_by_filename,
    startup_check,
    SUPPORTED_DOCUMENT_KEYS,
)
from backend.report import save_report


logger = logging.getLogger(__name__)


class EvalRequest(BaseModel):
    """Request body for starting an OCR evaluation."""

    run_id: str
    filename: str


REQUIRED_GDS_KEYS = {
    "filename",
}


app = FastAPI(title="DocsAI Evals API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


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
    f1_scores: dict[str, Any],
    report_path: str,
) -> None:
    """Print a concise terminal summary of the evaluation."""
    print("DocsAI OCR Evaluation Summary")
    print(f"Missing lines: {diff_result['total_missing']}")
    print(f"Added lines: {diff_result['total_added']}")
    print("Per-field CER/WER:")
    for field, result in jiwer_result.items():
        print(f"  {field}: CER={result['cer']} WER={result['wer']}")
    print("Per-field status:")
    for field, result in fuzz_result.items():
        judged = " llm_judged=True" if result.get("llm_judged") else ""
        print(f"  {field}: {result['status']} score={result['score']}{judged}")
    print(
        "F1: "
        f"precision={f1_scores['precision']} "
        f"recall={f1_scores['recall']} "
        f"f1={f1_scores['f1']} "
        f"tp={f1_scores['tp']} fp={f1_scores['fp']} fn={f1_scores['fn']}"
    )
    print(f"Report saved: {report_path}")


def run_ocr_eval(run_id: str, filename: str) -> dict[str, Any]:
    """Run the full OCR evaluation workflow for a DocsAI run and filename."""
    try:
        try:
            run_data = get_run_steps(run_id)
        except RuntimeError as exc:
            message = str(exc)
            if "DocsAI auth failed after retry" in message or "401" in message:
                raise HTTPException(status_code=401, detail=message) from exc
            if "Status: 404" in message:
                raise HTTPException(status_code=404, detail=f"Run ID not found: {run_id}") from exc
            if "OCR step not found" in message or "No markdown content found" in message:
                raise HTTPException(status_code=404, detail=message) from exc
            raise HTTPException(status_code=500, detail=message) from exc

        cleaned_ocr_markdown = clean_ocr_markdown(run_data["ocr_markdown"])
        golden_record = load_golden_by_filename(filename)
        if golden_record is None:
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

        document_type = str(
            golden_record.get("documentType")
            or golden_record.get("document_type")
            or infer_document_type(golden_record)
            or ""
        )
        golden_md = get_reference_markdown(golden_record)
        golden_fields = get_expected_fields_from_record(golden_record, document_type)
        field_types = get_field_types_from_record(golden_record, document_type)

        if not golden_fields:
            json_output = (
                golden_record.get("jsonOutput")
                or golden_record.get("json_output")
                or {}
            )
            for candidate_type in SUPPORTED_DOCUMENT_KEYS:
                entries = json_output.get(candidate_type)
                if entries and isinstance(entries, list):
                    candidate_fields = get_expected_fields_from_record(golden_record, candidate_type)
                    if candidate_fields:
                        document_type = candidate_type
                        golden_fields = candidate_fields
                        field_types = get_field_types_from_record(golden_record, candidate_type)
                        logger.warning(
                            "document_type was empty for '%s'; fell back to '%s' from jsonOutput.",
                            filename,
                            document_type,
                        )
                        break
            else:
                logger.warning(
                    "No golden fields resolved for '%s' after fallback — field-level metrics will be empty.",
                    filename,
                )

        if not isinstance(golden_fields, dict):
            raise HTTPException(status_code=422, detail="Eval calculation error: golden fields must be an object.")
        if not isinstance(field_types, dict):
            raise HTTPException(status_code=422, detail="Eval calculation error: field types must be an object.")

        # TODO: Replace this placeholder with actual OCR field extraction in the next version.
        ocr_fields = extract_ocr_fields(run_data.get("llm_output"), document_type)
        if not ocr_fields:
            logger.warning("OCR fields were empty for run %s; continuing evaluation as missing fields.", run_id)

        try:
            diff_result = run_difflib(str(golden_md), cleaned_ocr_markdown)
            jiwer_result = run_jiwer_per_field(golden_fields, ocr_fields)
            fuzz_result, grey_zone = run_rapidfuzz_per_field(golden_fields, ocr_fields, field_types)
            resolved_fuzz_result = resolve_grey_zone(fuzz_result, grey_zone) if grey_zone else fuzz_result
            f1_scores = calculate_f1(resolved_fuzz_result)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Eval calculation error: {exc}") from exc

        try:
            report_path = save_report(
                run_id,
                filename,
                diff_result,
                jiwer_result,
                resolved_fuzz_result,
                f1_scores,
                document_type,
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        report = {
            "run_id": run_id,
            "filename": filename,
            "document_type": document_type,
            "ocr_markdown": cleaned_ocr_markdown,
            "llm_output": run_data.get("llm_output"),
            "diff_result": diff_result,
            "jiwer_result": jiwer_result,
            "fuzz_result": resolved_fuzz_result,
            "f1_scores": f1_scores,
            "report_path": report_path,
            "report_filename": os.path.basename(report_path),
        }
        _print_summary(diff_result, jiwer_result, resolved_fuzz_result, f1_scores, report_path)
        return report
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Unexpected evaluation error for run %s.", run_id)
        raise HTTPException(status_code=500, detail=f"Unexpected evaluation error: {exc}") from exc


def _validate_golden_record(record: Any, line_number: int) -> None:
    """Validate one uploaded golden dataset record."""
    if not isinstance(record, dict):
        raise HTTPException(status_code=400, detail=f"Line {line_number}: record must be a JSON object.")

    for key in REQUIRED_GDS_KEYS:
        if key not in record or str(record.get(key, "")).strip() == "":
            raise HTTPException(status_code=400, detail=f"Line {line_number}: missing key '{key}'.")

    has_reference = bool(
        record.get("reference_markdown")
        or record.get("referenceMarkdown")
        or record.get("ocr_markdown")
        or record.get("ocrMarkdown")
    )
    has_document_key = any(key in record for key in SUPPORTED_DOCUMENT_KEYS)
    if not has_reference and not has_document_key:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Line {line_number}: record must include reference_markdown "
                "or at least one supported document key."
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


def _load_report_files() -> list[dict[str, Any]]:
    """Load saved evaluation report JSON files from the configured results path."""
    results_path = os.getenv("RESULTS_PATH", "").strip()
    if not results_path:
        logger.warning("RESULTS_PATH is not configured; report listing is empty.")
        return []
    os.makedirs(results_path, exist_ok=True)
    reports: list[dict[str, Any]] = []
    for name in sorted(os.listdir(results_path), reverse=True):
        if not name.endswith("_ocr_eval.json"):
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
    return reports


@app.get("/api/health")
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


@app.get("/api/debug/golden")
def debug_golden() -> dict[str, Any]:
    """Return safe debug information about the configured golden dataset."""
    try:
        gds_path = get_gds_path()
    except RuntimeError:
        return {
            "gds_path": "",
            "exists": False,
            "record_count": 0,
            "available_filenames": [],
            "message": "GDS_PATH is not configured.",
        }

    if not os.path.exists(gds_path):
        return {
            "gds_path": gds_path,
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
        "exists": True,
        "record_count": len(records),
        "available_filenames": [str(record.get("filename")) for record in records if record.get("filename")],
    }


@app.get("/api/debug/docsai/auth")
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


@app.get("/api/debug/docsai/run/{run_id}")
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


@app.post("/api/golden/upload")
async def upload_golden_dataset(file: UploadFile = File(...)) -> dict[str, Any]:
    """Upload and store the golden dataset file at the configured GDS path."""
    filename = file.filename or ""
    content = await file.read()
    records = _parse_golden_upload(filename, content)

    try:
        gds_path = get_gds_path()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    parent_dir = os.path.dirname(gds_path)
    if parent_dir:
        os.makedirs(parent_dir, exist_ok=True)

    try:
        normalized_text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="Golden dataset must be UTF-8 JSON.") from exc

    try:
        with open(gds_path, "wb") as handle:
            handle.write(normalized_text.encode("utf-8"))
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Unable to save golden dataset.") from exc

    return {
        "success": True,
        "filename": file.filename,
        "records": len(records),
        "available_filenames": [str(record.get("filename")) for record in records if record.get("filename")],
        "stored_as": gds_path,
    }


@app.post("/api/evaluations/run")
def run_evaluation(request: EvalRequest) -> dict[str, Any]:
    """Run an OCR evaluation from the browser UI."""
    return run_ocr_eval(request.run_id, request.filename)


@app.get("/api/evaluations/reports")
def list_reports() -> dict[str, Any]:
    """List saved evaluation report files."""
    if not os.getenv("RESULTS_PATH", "").strip():
        return {"reports": [], "warning": "RESULTS_PATH is not configured."}
    return {"reports": _load_report_files()}


@app.get("/api/evaluations/summary")
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
    average_f1 = sum(report.get("f1_scores", {}).get("f1", 0) for report in reports) / total_runs
    average_recall = sum(report.get("f1_scores", {}).get("recall", 0) for report in reports) / total_runs
    average_precision = sum(
        report.get("f1_scores", {}).get("precision", 0) for report in reports
    ) / total_runs
    field_scores: dict[str, list[float]] = {}
    reports_by_document_type: dict[str, int] = {}

    for report in reports:
        document_type = str(report.get("document_type") or "unknown")
        reports_by_document_type[document_type] = reports_by_document_type.get(document_type, 0) + 1
        for field, result in report.get("fuzz_result", {}).items():
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


@app.get("/api/evaluations/reports/{report_name}")
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
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description="Run DocsAI OCR evaluation.")
    parser.add_argument("run_id", help="DocsAI run ID to evaluate.")
    parser.add_argument("filename", help="Golden dataset filename to match.")
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    run_ocr_eval(args.run_id, args.filename)
