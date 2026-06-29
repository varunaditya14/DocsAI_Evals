"""Evaluation routines for OCR markdown and extracted field quality."""

from __future__ import annotations

import difflib
import logging
from typing import Any

from azure.identity import DefaultAzureCredential, get_bearer_token_provider
from jiwer import cer, wer
from openai import AzureOpenAI
from rapidfuzz import fuzz

from backend.config import get_settings


logger = logging.getLogger(__name__)
AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"


def run_difflib(golden_md: str, ocr_md: str) -> dict[str, Any]:
    """Compare markdown line by line and return missing and added lines."""
    diff = difflib.unified_diff(
        golden_md.splitlines(),
        ocr_md.splitlines(),
        lineterm="",
    )
    missing_lines: list[str] = []
    added_lines: list[str] = []

    for line in diff:
        if line.startswith(("---", "+++", "@@")):
            continue
        if line.startswith("-"):
            missing_lines.append(line[1:])
        elif line.startswith("+"):
            added_lines.append(line[1:])

    return {
        "missing_lines": missing_lines,
        "added_lines": added_lines,
        "total_missing": len(missing_lines),
        "total_added": len(added_lines),
    }


def run_jiwer_per_field(
    golden_fields: dict[str, Any], ocr_fields: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    """Calculate per-field CER and WER between golden and extracted values."""
    results: dict[str, dict[str, Any]] = {}

    for field, golden_value in golden_fields.items():
        extracted_value = ocr_fields.get(field, "")
        golden_text = "" if golden_value is None else str(golden_value)
        extracted_text = "" if extracted_value is None else str(extracted_value)
        if golden_text == "" or extracted_text == "":
            cer_score = 1.0
            wer_score = 1.0
        else:
            cer_score = round(cer(golden_text, extracted_text), 4)
            wer_score = round(wer(golden_text, extracted_text), 4)
        results[field] = {
            "golden": golden_text,
            "extracted": extracted_text,
            "cer": cer_score,
            "wer": wer_score,
        }

    return results


def _as_float(value: Any) -> float | None:
    """Convert a value to float after whitespace stripping, or return None."""
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _field_type_for(field: str, field_types: dict[str, Any]) -> str:
    """Return normalized field type for a field."""
    return str(field_types.get(field, "text")).strip().lower()


def run_rapidfuzz_per_field(
    golden_fields: dict[str, Any],
    ocr_fields: dict[str, Any],
    field_types: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """Evaluate fields using type-aware exact and fuzzy matching."""
    results: dict[str, dict[str, Any]] = {}
    grey_zone: list[dict[str, Any]] = []

    for field, golden_value in golden_fields.items():
        extracted_value = ocr_fields.get(field)
        field_type = _field_type_for(field, field_types)
        golden_text = "" if golden_value is None else str(golden_value)
        extracted_text = "" if extracted_value is None else str(extracted_value)
        llm_judgde_status: bool = False

        if extracted_text == "" and golden_text != "":
            status = "FN"
            score: float | None = None
        elif extracted_text == "" and golden_text == "":
            status = "TP"
            score = 100.0
        elif field_type == "numeric":
            golden_float = _as_float(golden_value)
            extracted_float = _as_float(extracted_value)
            status = (
                "TP"
                if golden_float is not None
                and extracted_float is not None
                and golden_float == extracted_float
                else "FP"
            )
            score = 100.0 if status == "TP" else 0.0
        elif field_type == "date":
            status = "TP" if golden_text.strip() == extracted_text.strip() else "FP"
            score = 100.0 if status == "TP" else 0.0
        else:
            score = round(float(fuzz.ratio(golden_text, extracted_text)), 4)
            if score >= 90:
                status = "TP"
            elif score < 70:
                status = "FP"
            else:
                status = "GREY"
                llm_judgde_status = True
                grey_zone.append(
                    {
                        "field": field,
                        "golden": golden_text,
                        "extracted": extracted_text,
                        "score": score,
                    }
                )

        results[field] = {
            "golden": golden_text,
            "extracted": extracted_text,
            "field_type": field_type,
            "score": score,
            "status": status,
            "llm_judged": llm_judgde_status,
        }

    return results, grey_zone


def _safe_error_message(exc: Exception) -> str:
    """Return a short error message without credential-like detail."""
    message = str(exc).replace("\n", " ").strip()
    return message[:240] if message else exc.__class__.__name__


def _build_azure_openai_client() -> AzureOpenAI | None:
    """Build an Azure OpenAI client lazily using DefaultAzureCredential."""
    try:
        settings = get_settings()
    except Exception as exc:
        logger.error("Azure OpenAI settings could not be loaded: %s", _safe_error_message(exc))
        return None

    if not settings.azure_openai_configured:
        logger.warning("Azure OpenAI judge not configured.")
        return None

    try:
        credential = DefaultAzureCredential()
        token_provider = get_bearer_token_provider(credential, AZURE_COGNITIVE_SERVICES_SCOPE)
        return AzureOpenAI(
            azure_endpoint=settings.azure_openai_endpoint,
            api_version=settings.azure_openai_api_version,
            azure_ad_token_provider=token_provider,
        )
    except Exception as exc:
        logger.error("Azure OpenAI client creation failed: %s", _safe_error_message(exc))
        return None


def llm_grey_zone_judge(field: str, golden_val: Any, extracted_val: Any) -> tuple[str, str | None]:
    """Use Azure OpenAI to decide whether two grey-zone values match semantically."""
    try:
        settings = get_settings()
        if not settings.azure_openai_configured:
            return "UNRESOLVED", "Azure OpenAI judge not configured"

        client = _build_azure_openai_client()
        if client is None:
            return "UNRESOLVED", "Azure OpenAI judge not configured"

        prompt = (
            "Answer only YES or NO.\n"
            f"Field: {field}\n"
            f"Golden value: {golden_val}\n"
            f"Extracted value: {extracted_val}\n"
            "Do these refer to the same thing semantically?"
        )
        response = client.chat.completions.create(
            model=settings.azure_openai_deployment,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            timeout=10,
        )

        response_text = response.choices[0].message.content if response.choices else ""

        normalized = response_text.strip().upper()
        if normalized.startswith("YES"):
            return "TP", None
        if normalized.startswith("NO"):
            return "FP", None
        logger.error("Azure OpenAI returned an unexpected grey-zone answer for %s: %s", field, response_text)
        return "UNRESOLVED", "Azure OpenAI judge failed: unexpected response"
    except Exception as exc:
        reason = f"Azure OpenAI judge failed: {_safe_error_message(exc)}"
        logger.error("Azure OpenAI grey-zone judge failed for field %s: %s", field, _safe_error_message(exc))
        return "UNRESOLVED", reason


def resolve_grey_zone(
    results: dict[str, dict[str, Any]], grey_zone: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Resolve grey-zone field results using the LLM semantic judge."""
    for item in grey_zone:
        field = item["field"]
        status, reason = llm_grey_zone_judge(field, item["golden"], item["extracted"])
        if status == "UNRESOLVED":
            results[field]["status"] = "UNRESOLVED"
            results[field]["llm_judged"] = False
            results[field]["llm_error"] = True
            results[field]["llm_reason"] = reason
        else:
            results[field]["status"] = status
            results[field]["llm_judged"] = True
    return results


def calculate_f1(field_results: dict[str, dict[str, Any]]) -> dict[str, float | int]:
    """Calculate precision, recall, and F1 from field-level statuses."""
    tp = sum(1 for result in field_results.values() if result.get("status") == "TP")
    fp = sum(1 for result in field_results.values() if result.get("status") == "FP")
    fn = sum(1 for result in field_results.values() if result.get("status") == "FN")
    unresolved_count = sum(
        1 for result in field_results.values() if result.get("status") == "UNRESOLVED"
    )

    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0

    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "unresolved_count": unresolved_count,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }


def run_llm_field_comparison(
    golden_fields: dict[str, Any],
    llm_fields: dict[str, Any],
    field_types: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Compare expected GDS fields against DocsAI LLM extracted fields."""
    results: dict[str, dict[str, Any]] = {}

    for field, golden_value in golden_fields.items():
        extracted_value = llm_fields.get(field)
        field_type = _field_type_for(field, field_types)
        golden_text = "" if golden_value is None else str(golden_value)
        extracted_text = "" if extracted_value is None else str(extracted_value)
        score: float | None = None

        if field not in llm_fields or extracted_text.strip() == "":
            status = "FN"
        elif field_type == "date":
            status = "TP" if golden_text.strip() == extracted_text.strip() else "FP"
        elif field_type == "numeric":
            golden_float = _as_float(golden_text)
            extracted_float = _as_float(extracted_text)
            status = (
                "TP"
                if golden_float is not None
                and extracted_float is not None
                and golden_float == extracted_float
                else "FP"
            )
        else:
            score = round(float(fuzz.ratio(golden_text, extracted_text)), 4)
            if score >= 90:
                status = "TP"
            elif score < 70:
                status = "FP"
            else:
                # GREY zone LLM judge intentionally skipped.
                status = "GREY"

        results[field] = {
            "status": status,
            "golden_value": golden_text,
            "extracted_value": extracted_text,
            "score": score,
            "field_type": field_type,
        }

    for field, extracted_value in llm_fields.items():
        if field in golden_fields:
            continue
        field_type = _field_type_for(field, field_types)
        results[field] = {
            "status": "FP",
            "golden_value": "",
            "extracted_value": "" if extracted_value is None else str(extracted_value),
            "score": None,
            "field_type": field_type,
        }

    return results


def calculate_llm_f1(llm_field_results: dict[str, dict[str, Any]]) -> dict[str, float | int]:
    """Calculate LLM precision, recall, F1, and grey count from field statuses."""
    tp = sum(1 for result in llm_field_results.values() if result.get("status") == "TP")
    fp = sum(1 for result in llm_field_results.values() if result.get("status") == "FP")
    fn = sum(1 for result in llm_field_results.values() if result.get("status") == "FN")
    grey_count = sum(1 for result in llm_field_results.values() if result.get("status") == "GREY")

    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0

    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "grey_count": grey_count,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }
