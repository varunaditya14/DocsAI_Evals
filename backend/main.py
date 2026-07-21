"""API and command-line entrypoint for DocsAI field evaluations."""

from __future__ import annotations

import argparse
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.api_client import extract_ocr_fields, get_run_steps, get_run_steps_debug
from backend.auth import get_bearer_token
from backend.cleaner import clean_ocr_markdown
from backend.config import get_settings
from backend.evaluator import llm_ocr_searcher, llm_semantic_judge, run_field_comparison
from backend.field_entry_validator import infer_field_type, sanitize_field_value, validate_field_name
from backend.normalizer import normalize_keys_to_camel
from backend.report import save_report


logger = logging.getLogger(__name__)


class EvalRequest(BaseModel):
    """Request body for starting a UI-driven field evaluation."""

    run_id: str
    golden_fields: dict[str, Any]


tags_metadata = [
    {"name": "health", "description": "Server health and connectivity checks"},
    {"name": "debug", "description": "Debug endpoints for testing DocsAI connectivity"},
    {"name": "evaluations", "description": "Run field evaluations and retrieve reports"},
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
    """Run non-fatal startup checks for result storage and Azure OpenAI config."""
    logging.basicConfig(level=logging.INFO)
    results_path = os.getenv("RESULTS_PATH")
    if results_path:
        os.makedirs(results_path, exist_ok=True)
    try:
        settings = get_settings()
        if not settings.azure_openai_configured:
            logger.warning("Azure OpenAI judge is not fully configured.")
    except RuntimeError as exc:
        logger.warning("Startup configuration check failed: %s", exc)
    for env_name in ("AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_VERSION"):
        if not os.getenv(env_name):
            logger.warning("Azure OpenAI environment variable is missing: %s", env_name)


def _fetch_run_data(run_id: str) -> dict[str, Any]:
    """Fetch DocsAI run output and translate common failures to API errors."""
    try:
        return get_run_steps(run_id)
    except RuntimeError as exc:
        message = str(exc)
        if "DocsAI auth failed after retry" in message or "401" in message:
            raise HTTPException(status_code=401, detail=message) from exc
        if "Status: 404" in message:
            raise HTTPException(status_code=404, detail=f"Run ID not found: {run_id}") from exc
        if "OCR step not found" in message or "No markdown content found" in message:
            raise HTTPException(
                status_code=422,
                detail="Run does not have a completed OCR step. Check the run status in DocsAI.",
            ) from exc
        raise HTTPException(status_code=500, detail=message) from exc


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


def _multiple_document_warning(llm_output: Any) -> str | None:
    """Return a warning when extraction output contains multiple document objects."""
    output = normalize_keys_to_camel(llm_output) if isinstance(llm_output, dict) else {}
    extracted_data = output.get("extractedData")
    if isinstance(extracted_data, dict):
        output = normalize_keys_to_camel(extracted_data)
    skip_keys = {
        "success",
        "extractionConfidence",
        "documentType",
        "classifiedFiles",
        "lineItems",
        "extractedFields",
    }
    stack = [output]
    while stack:
        current = stack.pop()
        if not isinstance(current, dict):
            continue
        for key, value in current.items():
            if key in skip_keys:
                continue
            if isinstance(value, list) and len(value) > 1 and all(isinstance(item, dict) for item in value):
                logger.warning("Multiple document objects found for %s; using first object only.", key)
                return "Multiple document objects found. Evaluated first object only."
            if isinstance(value, dict):
                stack.append(value)
    return None


def _is_scalar_row_table(value: Any) -> bool:
    """Return True when a value is a list of flat row dictionaries."""
    if not isinstance(value, list) or not value or not isinstance(value[0], dict):
        return False
    return all(not isinstance(nested, (dict, list)) for nested in value[0].values())


def _collect_table_fields(value: Any) -> dict[str, list[dict[str, Any]]]:
    """Collect nested list-of-dict table fields from a DocsAI LLM output."""
    tables: dict[str, list[dict[str, Any]]] = {}
    normalized = normalize_keys_to_camel(value) if isinstance(value, (dict, list)) else value
    if isinstance(normalized, list):
        for item in normalized[:1]:
            tables.update(_collect_table_fields(item))
        return tables
    if not isinstance(normalized, dict):
        return tables

    for key, nested_value in normalized.items():
        if key == "extractedFields":
            continue
        if _is_scalar_row_table(nested_value):
            tables[key] = [row for row in nested_value if isinstance(row, dict)]
            continue
        if isinstance(nested_value, (dict, list)):
            tables.update(_collect_table_fields(nested_value))
    return tables


def _merge_extracted_fields(llm_output: Any, document_type: str) -> dict[str, Any]:
    """Return scalar extracted fields plus table fields from the raw DocsAI payload."""
    extracted_fields = extract_ocr_fields(llm_output, document_type)
    table_fields = _collect_table_fields(llm_output)
    return {**extracted_fields, **table_fields}


def _extract_fields_from_run(run_data: dict[str, Any]) -> tuple[str, dict[str, Any], str | None]:
    """Return document type, extracted fields, and optional multi-object warning."""
    llm_output = run_data.get("llm_output")
    if llm_output is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "Run does not have a completed extraction step. "
                "Check that the DocsAI workflow includes an LLM extraction step."
            ),
        )
    document_type = _detect_document_type(llm_output)
    extracted_fields = _merge_extracted_fields(llm_output, document_type)
    if not extracted_fields:
        raise HTTPException(
            status_code=422,
            detail=(
                "Could not find extracted fields in this run. "
                "Check that the run completed and has an extraction step."
            ),
        )
    return document_type, extracted_fields, _multiple_document_warning(llm_output)


def _sanitize_table_rows(rows: list[Any]) -> list[dict[str, str]]:
    """Sanitize a table value while preserving row and column structure."""
    sanitized_rows: list[dict[str, str]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        sanitized_rows.append({str(column).strip(): sanitize_field_value(value) for column, value in row.items()})
    return sanitized_rows


def _validate_and_sanitize_golden_fields(golden_fields: dict[str, Any]) -> dict[str, Any]:
    """Validate user-entered fields and return sanitized scalar or table values."""
    if not isinstance(golden_fields, dict) or not golden_fields:
        raise HTTPException(
            status_code=400,
            detail="No fields entered. Add at least one expected field value to run evaluation.",
        )

    sanitized: dict[str, Any] = {}
    for field, value in golden_fields.items():
        validation = validate_field_name(field)
        if not validation["valid"]:
            raise HTTPException(
                status_code=400,
                detail={"field": field, "message": validation["error"]},
            )
        if isinstance(value, list):
            sanitized[str(field).strip()] = _sanitize_table_rows(value)
        else:
            sanitized[str(field).strip()] = sanitize_field_value(value)
    return sanitized


def _calculate_f1(results: dict[str, dict[str, Any]]) -> dict[str, float | int]:
    """Calculate precision, recall, and F1 from new field statuses."""
    tp = 0
    fp = 0
    fn = 0
    for result in results.values():
        line_items = result.get("line_items")
        if isinstance(line_items, dict) and isinstance(line_items.get("f1_counts"), dict):
            counts = line_items["f1_counts"]
            tp += int(counts.get("tp", 0) or 0)
            fp += int(counts.get("fp", 0) or 0)
            fn += int(counts.get("fn", 0) or 0)
            continue
        tp += 1 if result.get("status") == "TP" else 0
        fp += 1 if result.get("status") in ("FP", "EXTRA") else 0
        fn += 1 if result.get("status") == "FN" else 0
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }


def _recommended_actions(results: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    """Build recommended actions from OCR root-cause diagnoses."""
    actions: list[dict[str, str]] = []
    for field_name, result in results.items():
        ocr_search = result.get("ocr_search")
        verdict = ocr_search.get("verdict") if isinstance(ocr_search, dict) else None
        if verdict == "PROMPT_PROBLEM":
            actions.append(
                {
                    "field": field_name,
                    "action": (
                        f"Tune the extraction prompt or YAML schema to correctly pick up {field_name}. "
                        "The value exists in the OCR output."
                    ),
                }
            )
        elif verdict == "OCR_LIMITATION":
            actions.append(
                {
                    "field": field_name,
                    "action": (
                        f"OCR did not extract {field_name}. This cannot be fixed via prompt tuning. "
                        "Consider pre-processing or document quality improvements."
                    ),
                }
            )
        elif result.get("status") in {"FN", "PARTIAL"} and not ocr_search:
            actions.append(
                {
                    "field": field_name,
                    "action": f"{field_name} was missing from extraction output. Run OCR search to diagnose root cause.",
                }
            )
    return actions


def _summarize_report(results: dict[str, dict[str, Any]]) -> dict[str, int]:
    """Summarize field outcomes and diagnostic categories."""
    uncertain_resolved = sum(1 for result in results.values() if isinstance(result.get("llm_judge"), dict))
    prompt_problems = sum(
        1
        for result in results.values()
        if isinstance(result.get("ocr_search"), dict)
        and result["ocr_search"].get("verdict") == "PROMPT_PROBLEM"
    )
    ocr_limitations = sum(
        1
        for result in results.values()
        if isinstance(result.get("ocr_search"), dict)
        and result["ocr_search"].get("verdict") == "OCR_LIMITATION"
    )
    uncertain_unresolved = sum(1 for result in results.values() if result.get("status") == "GREY_UNRESOLVED")
    return {
        "total_fields": len(results),
        "passed": sum(1 for result in results.values() if result.get("status") == "TP"),
        "failed": sum(1 for result in results.values() if result.get("status") in ("FP", "EXTRA", "PARTIAL")),
        "missing": sum(1 for result in results.values() if result.get("status") == "FN"),
        "uncertain_resolved": uncertain_resolved,
        "uncertain_unresolved": uncertain_unresolved,
        "prompt_problems": prompt_problems,
        "ocr_limitations": ocr_limitations,
    }


def run_ocr_eval(run_id: str, golden_fields: dict[str, Any], eval_type: str = "full") -> dict[str, Any]:
    """Run the field-entry evaluation workflow for a DocsAI run."""
    try:
        run_data = _fetch_run_data(run_id)
        ocr_markdown = clean_ocr_markdown(run_data["ocr_markdown"])
        document_type, extracted_fields, warning = _extract_fields_from_run(run_data)
        sanitized_golden = _validate_and_sanitize_golden_fields(golden_fields)
        field_types = {field: infer_field_type(field) for field in sanitized_golden}
        results = run_field_comparison(sanitized_golden, extracted_fields, field_types)

        grey_fields = [field for field, result in results.items() if result["status"] == "GREY"]
        for field in grey_fields:
            judge_result = llm_semantic_judge(
                field,
                results[field]["golden_value"],
                results[field]["extracted_value"],
                results[field]["field_type"],
            )
            if judge_result["verdict"] == "PASS":
                results[field]["status"] = "TP"
            elif judge_result["verdict"] == "FAIL":
                results[field]["status"] = "FP"
            else:
                results[field]["status"] = "GREY_UNRESOLVED"
            results[field]["llm_judge"] = judge_result

        failed_fields = [
            field
            for field, result in results.items()
            if result["status"] in ("FP", "FN", "PARTIAL") and result["golden_value"] != ""
        ]
        for field in failed_fields:
            results[field]["ocr_search"] = llm_ocr_searcher(
                field,
                results[field]["golden_value"],
                ocr_markdown,
            )

        f1_scores = _calculate_f1(results)
        timestamp = datetime.now(timezone.utc).isoformat()
        report: dict[str, Any] = {
            "run_id": run_id,
            "filename": run_id,
            "document_type": document_type,
            "timestamp": timestamp,
            "eval_type": eval_type,
            "golden_fields_entered": sanitized_golden,
            "field_comparison": results,
            "f1_scores": f1_scores,
            "evals_report": f1_scores,
            "recommended_actions": _recommended_actions(results),
            "summary": _summarize_report(results),
        }
        if warning:
            report["warning"] = warning

        report_path = save_report(
            run_id=run_id,
            filename=run_id,
            document_type=document_type,
            eval_type=eval_type,
            field_report=report,
        )
        report["report_name"] = os.path.basename(report_path)
        report["report_filename"] = os.path.basename(report_path)
        report["status"] = "success"
        return report
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Unexpected evaluation error for run %s.", run_id)
        raise HTTPException(status_code=500, detail=f"Unexpected evaluation error: {exc}") from exc


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


def _report_evals_scores(report: dict[str, Any]) -> dict[str, Any]:
    """Return score data from new or legacy report shapes."""
    if isinstance(report.get("f1_scores"), dict) and report["f1_scores"]:
        return report["f1_scores"]
    evals_report = report.get("evals_report")
    if isinstance(evals_report, dict) and evals_report:
        return evals_report
    combined = report.get("combined")
    if isinstance(combined, dict) and combined:
        return combined
    llm_eval = report.get("llm_eval")
    if isinstance(llm_eval, dict) and isinstance(llm_eval.get("f1_scores"), dict):
        return llm_eval["f1_scores"]
    return {}


def _report_field_comparison(report: dict[str, Any]) -> dict[str, Any]:
    """Return field comparison data from new or legacy report shapes."""
    if isinstance(report.get("field_comparison"), dict):
        return report["field_comparison"]
    llm_eval = report.get("llm_eval")
    if isinstance(llm_eval, dict) and isinstance(llm_eval.get("field_comparison"), dict):
        return llm_eval["field_comparison"]
    return {}


def _field_value_metadata(value: Any) -> dict[str, Any]:
    """Return frontend entry-mode metadata for an extracted field value."""
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return {
            "field_value_type": "table",
            "field_schema": list(value[0].keys()),
            "row_count": len(value),
        }
    if isinstance(value, str) and "\n" in value:
        return {"field_value_type": "text_block"}
    return {"field_value_type": "simple"}


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
        "results_configured": bool(os.getenv("RESULTS_PATH", "").strip()),
        "azure_openai_configured": azure_openai_configured,
        "azure_auth_method": os.getenv("AZURE_AUTH_METHOD", "default_credential").strip() or "default_credential",
        "docsai_configured": docsai_configured,
        "azure_openai_region": os.getenv("AZURE_OPENAI_REGION", "").strip(),
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
            raise HTTPException(
                status_code=422,
                detail="Run does not have a completed OCR step. Check the run status in DocsAI.",
            ) from exc
        raise HTTPException(status_code=500, detail=f"DocsAI run debug failed: {message}") from exc


@app.get("/api/run/{run_id}/fields", tags=["evaluations"])
def get_run_fields(run_id: str) -> dict[str, Any]:
    """Fetch a DocsAI run and return extracted field names and values."""
    run_data = _fetch_run_data(run_id)
    llm_output = run_data.get("llm_output")
    if llm_output is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "Run does not have a completed extraction step. "
                "Check that the DocsAI workflow includes an LLM extraction step."
            ),
        )
    document_type = _detect_document_type(llm_output)
    extracted_fields = _merge_extracted_fields(llm_output, document_type)
    warning = _multiple_document_warning(llm_output)
    response = {
        "document_type": document_type,
        "extracted_fields": extracted_fields,
        "field_count": len(extracted_fields),
        "field_metadata": {
            field_name: _field_value_metadata(field_value)
            for field_name, field_value in extracted_fields.items()
        },
    }
    if warning:
        response["warning"] = warning
    return response


@app.post("/api/evaluations/llm", tags=["evaluations"], summary="Run Field Evaluation")
def run_llm_evaluation(request: EvalRequest) -> dict[str, Any]:
    """Run the new field-entry evaluation flow."""
    return run_ocr_eval(request.run_id, request.golden_fields, eval_type="llm")


@app.post("/api/evaluations/run/full", tags=["evaluations"], summary="Run Field Evaluation and Save Report")
def run_full_evaluation_verbose(request: EvalRequest) -> dict[str, Any]:
    """Run the new field-entry evaluation flow and return full report data."""
    return run_ocr_eval(request.run_id, request.golden_fields, eval_type="full")


@app.post("/api/evaluations/run", tags=["evaluations"])
def run_evaluation(request: EvalRequest) -> dict[str, Any]:
    """Run a field-entry evaluation from the browser UI."""
    return run_ocr_eval(request.run_id, request.golden_fields, eval_type="full")


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
            "total_prompt_problems": 0,
            "total_ocr_limitations": 0,
            "total_uncertain": 0,
            "reports_by_document_type": {},
            "worst_field": "",
            "best_field": "",
        }

    total_runs = len(reports)
    average_f1 = sum(float(_report_evals_scores(report).get("f1", 0) or 0) for report in reports) / total_runs
    average_recall = sum(float(_report_evals_scores(report).get("recall", 0) or 0) for report in reports) / total_runs
    average_precision = sum(float(_report_evals_scores(report).get("precision", 0) or 0) for report in reports) / total_runs
    reports_by_document_type: dict[str, int] = {}
    total_prompt_problems = 0
    total_ocr_limitations = 0
    total_uncertain = 0

    for report in reports:
        document_type = str(report.get("document_type") or "unknown")
        reports_by_document_type[document_type] = reports_by_document_type.get(document_type, 0) + 1
        for result in _report_field_comparison(report).values():
            if not isinstance(result, dict):
                continue
            ocr_search = result.get("ocr_search") if isinstance(result.get("ocr_search"), dict) else {}
            if ocr_search.get("verdict") == "PROMPT_PROBLEM":
                total_prompt_problems += 1
            if ocr_search.get("verdict") == "OCR_LIMITATION":
                total_ocr_limitations += 1
            if result.get("status") in {"GREY", "GREY_UNRESOLVED"} or ocr_search.get("verdict") == "UNCERTAIN":
                total_uncertain += 1

    return {
        "total_runs": total_runs,
        "average_f1": round(average_f1, 4),
        "average_recall": round(average_recall, 4),
        "average_precision": round(average_precision, 4),
        "total_prompt_problems": total_prompt_problems,
        "total_ocr_limitations": total_ocr_limitations,
        "total_uncertain": total_uncertain,
        "reports_by_document_type": reports_by_document_type,
        "worst_field": "",
        "best_field": "",
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


@app.delete("/api/evaluations/reports/{report_name}", tags=["evaluations"])
def delete_report(report_name: str) -> dict[str, Any]:
    """Delete a saved evaluation report by file name."""
    results_path = os.getenv("RESULTS_PATH", "").strip()
    if not results_path:
        raise HTTPException(status_code=400, detail="RESULTS_PATH is not configured.")
    report_path = os.path.join(results_path, report_name)
    results_root = os.path.abspath(results_path)
    requested_path = os.path.abspath(report_path)
    if os.path.commonpath([results_root, requested_path]) != results_root:
        raise HTTPException(status_code=400, detail="Invalid report name.")
    try:
        os.remove(requested_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Report not found.") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Unable to delete report.") from exc
    return {"success": True, "report_name": report_name}


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
    parser = argparse.ArgumentParser(description="Run DocsAI field evaluation.")
    parser.add_argument("run_id", help="DocsAI run ID to evaluate.")
    parser.add_argument(
        "golden_fields",
        help='JSON object of expected field values, e.g. {"invoiceNo":"L2528366"}',
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    run_ocr_eval(args.run_id, json.loads(args.golden_fields))
