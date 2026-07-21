"""Field-level evaluation routines for DocsAI extraction output."""

from __future__ import annotations

import logging
import re
from typing import Any

from azure.identity import DefaultAzureCredential, get_bearer_token_provider
from openai import AzureOpenAI
from rapidfuzz import fuzz

from backend.config import get_settings
from backend.field_entry_validator import infer_field_type, sanitize_field_value


logger = logging.getLogger(__name__)
AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"

FIELD_DESCRIPTIONS = {
    "invoiceNo": "invoice number in the document header",
    "invoiceNumber": "invoice number in the document header",
    "date": "invoice or document date in the header",
    "invoiceDate": "invoice date in the document header",
    "poNo": "purchase order number in the document header",
    "billTo": "billing address block",
    "deliveryTo": "delivery address block",
    "clientId": "client identifier code",
    "terms": "payment terms in the header",
    "sales": "sales person name",
    "rqNo": "requisition number",
    "totalAmount": "total amount in the totals section",
    "gstAmount": "GST or tax amount in the totals section",
    "amountDue": "final amount due in the totals section",
    "fullName": "full name of the document holder",
    "documentNumber": "document identification number",
    "passportNo": "passport number",
    "dateOfBirth": "date of birth",
    "nationality": "nationality of the document holder",
    "gender": "gender of the document holder",
    "issueDate": "date of issue",
    "expiryDate": "date of expiry or expiration",
}


def _safe_error_message(exc: Exception) -> str:
    """Return a short error message without leaking credential-like detail."""
    message = str(exc).replace("\n", " ").strip()
    return message[:240] if message else exc.__class__.__name__


def _azure_client_and_deployment() -> tuple[AzureOpenAI, str]:
    """Build an Azure OpenAI client and return it with the configured deployment."""
    settings = get_settings()
    if not settings.azure_openai_configured:
        raise RuntimeError("Azure OpenAI is not configured.")

    credential = DefaultAzureCredential()
    token_provider = get_bearer_token_provider(credential, AZURE_COGNITIVE_SERVICES_SCOPE)
    client = AzureOpenAI(
        azure_endpoint=settings.azure_openai_endpoint,
        api_version=settings.azure_openai_api_version,
        azure_ad_token_provider=token_provider,
    )
    return client, settings.azure_openai_deployment


def _parse_numeric(value: Any) -> float:
    """Parse a numeric field after removing grouping separators and currency text."""
    text = sanitize_field_value(value)
    cleaned = re.sub(r"[^0-9.\-]", "", text.replace(",", ""))
    if cleaned in {"", "-", ".", "-."}:
        raise ValueError("not numeric")
    return float(cleaned)


def _field_type_for(field: str, field_types: dict[str, Any]) -> str:
    """Return the normalized comparison type for a field."""
    return str(field_types.get(field, "text")).strip().lower() or "text"


def _is_line_items_value(value: Any) -> bool:
    """Return True when a value is a non-empty list of row dictionaries."""
    return isinstance(value, list) and bool(value) and isinstance(value[0], dict)


def _coerce_row_dict(row: Any) -> dict[str, Any]:
    """Return a dictionary row or an empty row for unsupported values."""
    return row if isinstance(row, dict) else {}


def _compare_scalar_values(golden_value: Any, extracted_value: Any, field_type: str) -> dict[str, Any]:
    """Compare two scalar values using the field comparison status rules."""
    golden_val = sanitize_field_value(golden_value)
    extracted_val = sanitize_field_value(extracted_value)
    score: float | None

    if extracted_val == "":
        status = "FN"
        score = 0
    elif golden_val == "":
        status = "EXTRA_INFO"
        score = None
    elif field_type == "date":
        status = "TP" if golden_val == extracted_val else "FP"
        score = 100 if status == "TP" else 0
    elif field_type == "numeric":
        try:
            status = "TP" if _parse_numeric(golden_val) == _parse_numeric(extracted_val) else "FP"
        except ValueError:
            status = "FP"
        score = 100 if status == "TP" else 0
    else:
        score = round(float(fuzz.ratio(golden_val, extracted_val)), 2)
        if score >= 90:
            status = "TP"
        elif score < 70:
            status = "FP"
        else:
            status = "GREY"

    return {
        "status": status,
        "golden_value": golden_val,
        "extracted_value": extracted_val,
        "score": score,
    }


def _resolve_grey_line_item_cells(row_results: list[dict[str, Any]]) -> None:
    """Resolve GREY line-item cells to TP/FP using the LLM semantic judge in place."""
    for row_result in row_results:
        for column, cell_result in row_result["column_results"].items():
            if cell_result.get("status") != "GREY":
                continue
            judge_result = llm_semantic_judge(
                column,
                cell_result["golden_value"],
                cell_result["extracted_value"],
                "text",
            )
            cell_result["llm_judge"] = judge_result
            if judge_result["verdict"] == "PASS":
                cell_result["status"] = "TP"
            elif judge_result["verdict"] == "FAIL":
                cell_result["status"] = "FP"
            # else: leave status as GREY (uncertain/llm_error); counted as FP in f1_counts below.


def compare_line_items(golden_rows: list, extracted_rows: list, columns: list) -> dict[str, Any]:
    """
    Compare line items by matching each golden row to the closest extracted row by
    description similarity, then comparing each column individually. Returns
    per-row and per-cell comparison results.
    """
    normalized_columns = [str(column) for column in columns if str(column).strip()]
    normalized_golden_rows = [_coerce_row_dict(row) for row in golden_rows if isinstance(row, dict)]
    normalized_extracted_rows = [_coerce_row_dict(row) for row in extracted_rows if isinstance(row, dict)]
    total_cells = len(normalized_golden_rows) * len(normalized_columns)

    if not normalized_extracted_rows:
        return {
            "status": "FN",
            "total_golden_rows": len(normalized_golden_rows),
            "total_extracted_rows": 0,
            "matched_count": 0,
            "missing_rows": len(normalized_golden_rows),
            "extra_rows": 0,
            "row_results": [],
            "matched_rows": [],
            "unmatched_golden": normalized_golden_rows,
            "unmatched_golden_rows": normalized_golden_rows,
            "extra_extracted": [],
            "extra_extracted_rows": [],
            "f1_counts": {"tp": 0, "fp": 0, "fn": total_cells},
        }

    primary_column = normalized_columns[0] if normalized_columns else ""
    available_indexes = set(range(len(normalized_extracted_rows)))
    row_results: list[dict[str, Any]] = []
    unmatched_golden: list[dict[str, Any]] = []

    for golden_row in normalized_golden_rows:
        golden_key = sanitize_field_value(golden_row.get(primary_column, ""))
        best_index: int | None = None
        best_score = 0.0
        for extracted_index in available_indexes:
            extracted_row = normalized_extracted_rows[extracted_index]
            extracted_key = sanitize_field_value(extracted_row.get(primary_column, ""))
            match_score = float(fuzz.ratio(golden_key, extracted_key)) if golden_key or extracted_key else 0.0
            if match_score > best_score:
                best_score = match_score
                best_index = extracted_index

        if best_index is None or best_score < 60:
            unmatched_golden.append(golden_row)
            continue

        available_indexes.remove(best_index)
        extracted_row = normalized_extracted_rows[best_index]
        column_results: dict[str, dict[str, Any]] = {}
        for column in normalized_columns:
            field_type = infer_field_type(column)
            cell_result = _compare_scalar_values(
                golden_row.get(column, ""),
                extracted_row.get(column, ""),
                field_type,
            )
            cell_result["llm_judge"] = None
            column_results[column] = cell_result

        row_results.append(
            {
                "golden_row": golden_row,
                "extracted_row": extracted_row,
                "match_score": round(best_score, 2),
                "column_results": column_results,
                "row_status": "",
            }
        )

    _resolve_grey_line_item_cells(row_results)

    for row_result in row_results:
        statuses = [result["status"] for result in row_result["column_results"].values()]
        if statuses and all(status == "TP" for status in statuses):
            row_result["row_status"] = "PASS"
        elif any(status == "TP" for status in statuses):
            row_result["row_status"] = "PARTIAL"
        else:
            row_result["row_status"] = "FAIL"

    extra_extracted = [normalized_extracted_rows[index] for index in sorted(available_indexes)]
    tp = sum(
        1
        for row_result in row_results
        for column_result in row_result["column_results"].values()
        if column_result.get("status") == "TP"
    )
    fp = sum(
        1
        for row_result in row_results
        for column_result in row_result["column_results"].values()
        if column_result.get("status") in {"FP", "GREY", "EXTRA_INFO"}
    ) + (len(extra_extracted) * max(len(normalized_columns), 1))
    fn = sum(
        1
        for row_result in row_results
        for column_result in row_result["column_results"].values()
        if column_result.get("status") == "FN"
    ) + (len(unmatched_golden) * len(normalized_columns))

    if fn == 0 and fp == 0:
        status = "TP"
    elif row_results and tp > 0:
        status = "PARTIAL"
    elif len(unmatched_golden) == len(normalized_golden_rows):
        status = "FN"
    else:
        status = "FP"

    return {
        "status": status,
        "total_golden_rows": len(normalized_golden_rows),
        "total_extracted_rows": len(normalized_extracted_rows),
        "matched_count": len(row_results),
        "missing_rows": len(unmatched_golden),
        "extra_rows": len(extra_extracted),
        "row_results": row_results,
        "matched_rows": row_results,
        "unmatched_golden": unmatched_golden,
        "unmatched_golden_rows": unmatched_golden,
        "extra_extracted": extra_extracted,
        "extra_extracted_rows": extra_extracted,
        "f1_counts": {"tp": tp, "fp": fp, "fn": fn},
    }


def run_field_comparison(
    golden_fields: dict[str, Any],
    extracted_fields: dict[str, Any],
    field_types: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Compare user-entered golden fields against DocsAI extracted fields."""
    results: dict[str, dict[str, Any]] = {}

    for field, golden_value in golden_fields.items():
        field_type = _field_type_for(field, field_types)
        if isinstance(golden_value, list) and not golden_value:
            extracted_value = extracted_fields.get(field, [])
            status = "TP" if isinstance(extracted_value, list) else "FN"
            results[field] = {
                "status": status,
                "golden_value": [],
                "extracted_value": extracted_value,
                "score": None,
                "field_type": "line_items",
                "line_items": {
                    "status": status,
                    "note": "table existence check only",
                    "total_golden_rows": 0,
                    "total_extracted_rows": len(extracted_value) if isinstance(extracted_value, list) else 0,
                    "matched_count": 0,
                    "missing_rows": 0 if isinstance(extracted_value, list) else 1,
                    "extra_rows": len(extracted_value) if isinstance(extracted_value, list) else 0,
                    "row_results": [],
                    "unmatched_golden": [],
                    "extra_extracted": extracted_value if isinstance(extracted_value, list) else [],
                    "f1_counts": {"tp": 1 if status == "TP" else 0, "fp": 0, "fn": 1 if status == "FN" else 0},
                },
                "llm_judge": None,
                "ocr_search": None,
            }
            continue

        if _is_line_items_value(golden_value):
            extracted_value = extracted_fields.get(field, [])
            if not isinstance(extracted_value, list):
                results[field] = {
                    "status": "FN",
                    "golden_value": golden_value,
                    "extracted_value": extracted_value,
                    "score": None,
                    "field_type": "line_items",
                    "line_items": {
                        "status": "FN",
                        "note": "expected table, got single value",
                        "total_golden_rows": len(golden_value),
                        "total_extracted_rows": 0,
                        "matched_count": 0,
                        "missing_rows": len(golden_value),
                        "extra_rows": 0,
                        "row_results": [],
                        "unmatched_golden": golden_value,
                        "extra_extracted": [],
                        "f1_counts": {"tp": 0, "fp": 0, "fn": len(golden_value) * len(golden_value[0].keys())},
                    },
                    "llm_judge": None,
                    "ocr_search": None,
                }
                continue

            columns = list(golden_value[0].keys())
            line_item_result = compare_line_items(golden_value, extracted_value, columns)
            results[field] = {
                "status": line_item_result["status"],
                "golden_value": golden_value,
                "extracted_value": extracted_value,
                "score": None,
                "field_type": "line_items",
                "line_items": line_item_result,
                "llm_judge": None,
                "ocr_search": None,
            }
            continue

        if sanitize_field_value(golden_value) == "":
            field_exists = field in extracted_fields
            extracted_value = extracted_fields.get(field, "")
            results[field] = {
                "status": "PRESENT" if field_exists else "ABSENT",
                "golden_value": "",
                "extracted_value": extracted_value if isinstance(extracted_value, list) else sanitize_field_value(extracted_value),
                "score": None,
                "field_type": field_type,
                "informational": True,
                "llm_judge": None,
                "ocr_search": None,
            }
            continue

        scalar_result = _compare_scalar_values(golden_value, extracted_fields.get(field, ""), field_type)

        results[field] = {
            "status": scalar_result["status"],
            "golden_value": scalar_result["golden_value"],
            "extracted_value": scalar_result["extracted_value"],
            "score": scalar_result["score"],
            "field_type": field_type,
            "llm_judge": None,
            "ocr_search": None,
        }

    for field, extracted_value in extracted_fields.items():
        if field in golden_fields:
            continue
        results[field] = {
            "status": "EXTRA",
            "golden_value": "",
            "extracted_value": extracted_value if isinstance(extracted_value, list) else sanitize_field_value(extracted_value),
            "score": None,
            "field_type": "line_items" if isinstance(extracted_value, list) else _field_type_for(field, field_types),
            "llm_judge": None,
            "ocr_search": None,
        }

    return results


def llm_semantic_judge(
    field_name: str,
    golden_value: str,
    extracted_value: str,
    field_type: str,
) -> dict[str, Any]:
    """Ask Azure OpenAI whether two grey-zone field values match semantically."""
    try:
        client, deployment = _azure_client_and_deployment()
        prompt = (
            "You are evaluating a document extraction system.\n\n"
            f"Field: {field_name}\n"
            f"Field type: {field_type}\n"
            f"Expected value: {golden_value}\n"
            f"Extracted value: {extracted_value}\n\n"
            "Do these two values represent the same information?\n"
            "Consider: minor formatting differences, abbreviations,\n"
            "equivalent representations (e.g. same date in different\n"
            "formats, same name with/without punctuation).\n\n"
            "Reply with exactly:\n"
            "PASS if they match semantically\n"
            "FAIL if they are genuinely different\n\n"
            "Then on a new line, one sentence explaining why."
        )
        response = client.chat.completions.create(
            model=deployment,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            timeout=15,
        )
        response_text = response.choices[0].message.content if response.choices else ""
        lines = [line.strip() for line in response_text.splitlines() if line.strip()]
        verdict = lines[0].upper() if lines else "FAIL"
        if verdict not in {"PASS", "FAIL"}:
            verdict = "FAIL"
        reason = lines[1] if len(lines) > 1 else "The judge did not provide a separate reason."
        logger.info("LLM semantic judge called for field %s: verdict=%s", field_name, verdict)
        return {"verdict": verdict, "reason": reason, "llm_error": False}
    except Exception as exc:
        logger.error("LLM semantic judge failed for %s: %s", field_name, _safe_error_message(exc))
        return {"verdict": "UNCERTAIN", "reason": "LLM judge unavailable", "llm_error": True}


def _exact_occurrence_contexts(markdown: str, needle: str) -> tuple[int, list[str]]:
    """Find exact case-insensitive occurrences and return nearby line contexts."""
    if not needle:
        return 0, []
    lines = markdown.splitlines()
    lowered_needle = needle.lower()
    contexts: list[str] = []
    occurrence_count = 0
    for index, line in enumerate(lines):
        matches_in_line = line.lower().count(lowered_needle)
        if matches_in_line == 0:
            continue
        occurrence_count += matches_in_line
        start = max(0, index - 3)
        end = min(len(lines), index + 4)
        context = "\n".join(f"{line_number + 1}: {lines[line_number]}" for line_number in range(start, end))
        contexts.append(context)
    return occurrence_count, contexts


def _fuzzy_token_contexts(markdown: str, value: str) -> tuple[int, list[str]]:
    """Find line windows where all expected value tokens appear near each other."""
    tokens = [token.lower() for token in re.findall(r"[A-Za-z0-9]+", value)]
    if not tokens:
        return 0, []
    lines = markdown.splitlines()
    contexts: list[str] = []
    seen: set[tuple[int, int]] = set()
    for index in range(len(lines)):
        start = max(0, index - 3)
        end = min(len(lines), index + 4)
        window = "\n".join(lines[start:end]).lower()
        if all(token in window for token in tokens):
            key = (start, end)
            if key in seen:
                continue
            seen.add(key)
            contexts.append("\n".join(f"{line_number + 1}: {lines[line_number]}" for line_number in range(start, end)))
    return len(contexts), contexts


def _format_contexts(contexts: list[str]) -> str:
    """Format OCR search contexts for the LLM prompt."""
    return "\n\n".join(f"Context {index}:\n{context}" for index, context in enumerate(contexts, start=1))


def _search_value_in_markdown(value: Any, markdown: str) -> tuple[int, list[str]]:
    """Search a single expected value in OCR markdown with exact and token fallback."""
    normalized_value = sanitize_field_value(value)
    occurrence_count, contexts = _exact_occurrence_contexts(markdown, normalized_value)
    if occurrence_count == 0:
        occurrence_count, contexts = _fuzzy_token_contexts(markdown, normalized_value)
    return occurrence_count, contexts


def _line_items_ocr_search(field_name: str, golden_value: list, ocr_markdown: str) -> dict[str, Any]:
    """Search line item primary values in OCR markdown and aggregate the diagnosis."""
    normalized_markdown = sanitize_field_value(ocr_markdown)
    found_rows: list[dict[str, Any]] = []
    missing_rows: list[dict[str, Any]] = []
    total_occurrences = 0

    for index, row in enumerate(golden_value, start=1):
        if not isinstance(row, dict) or not row:
            continue
        primary_column = next(iter(row.keys()))
        primary_value = sanitize_field_value(row.get(primary_column, ""))
        occurrence_count, _contexts = _search_value_in_markdown(primary_value, normalized_markdown)
        total_occurrences += occurrence_count
        row_result = {
            "row_index": index,
            "primary_column": primary_column,
            "primary_value": primary_value,
            "occurrence_count": occurrence_count,
        }
        if occurrence_count > 0:
            found_rows.append(row_result)
        else:
            missing_rows.append(row_result)

    if found_rows and not missing_rows:
        verdict = "PROMPT_PROBLEM"
        reason = "All line item primary values were found in OCR markdown."
    elif missing_rows and not found_rows:
        verdict = "OCR_LIMITATION"
        reason = "No line item primary values were found in OCR markdown."
    else:
        verdict = "PARTIAL"
        reason = "Some line item primary values were found in OCR markdown and some were missing."

    return {
        "verdict": verdict,
        "reason": reason,
        "occurrence_count": total_occurrences,
        "preliminary": "line_items_aggregate",
        "llm_error": False,
        "found_rows": found_rows,
        "missing_rows": missing_rows,
    }


def llm_ocr_searcher(field_name: str, golden_value: Any, ocr_markdown: str) -> dict[str, Any]:
    """Diagnose whether a failed field is a prompt problem or OCR limitation."""
    try:
        normalized_markdown = sanitize_field_value(ocr_markdown)
        if _is_line_items_value(golden_value):
            return _line_items_ocr_search(field_name, golden_value, normalized_markdown)

        normalized_value = sanitize_field_value(golden_value)
        occurrence_count, contexts = _search_value_in_markdown(normalized_value, normalized_markdown)

        if occurrence_count == 0:
            preliminary = "likely_ocr_fail"
        elif occurrence_count == 1:
            preliminary = "likely_prompt_problem"
        else:
            preliminary = "ambiguous"

        client, deployment = _azure_client_and_deployment()
        field_desc = FIELD_DESCRIPTIONS.get(field_name, f"a field named {field_name} somewhere in the document")
        contexts_text = _format_contexts(contexts)
        prompt = (
            "You are evaluating a document extraction system.\n\n"
            f"Field: {field_name}\n"
            f"Description: {field_desc}\n"
            f"Expected value: {golden_value}\n\n"
            "The value was searched in the OCR markdown.\n"
            f"{occurrence_count} occurrence(s) found.\n\n"
            "Contexts found (each shows surrounding lines):\n"
            f"{contexts_text if contexts else 'No occurrences found.'}\n\n"
            "Task: Is the expected value present in the OCR markdown\n"
            "in the correct context for this field?\n\n"
            "Reply with exactly one of:\n"
            "PROMPT_PROBLEM - value is present in correct context,\n"
            "LLM extraction failed to pick it up\n"
            "OCR_LIMITATION - value is not in the markdown or not in\n"
            "any correct context, OCR did not extract it\n"
            "UNCERTAIN - cannot determine with confidence\n\n"
            "Then on a new line, one sentence explaining why."
        )
        response = client.chat.completions.create(
            model=deployment,
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            timeout=15,
        )
        response_text = response.choices[0].message.content if response.choices else ""
        lines = [line.strip() for line in response_text.splitlines() if line.strip()]
        verdict = lines[0].upper().replace("\u2014", "-").split()[0] if lines else "UNCERTAIN"
        if verdict not in {"PROMPT_PROBLEM", "OCR_LIMITATION", "UNCERTAIN"}:
            verdict = "UNCERTAIN"
        reason = lines[1] if len(lines) > 1 else "The searcher did not provide a separate reason."
        logger.info("LLM OCR searcher called for field %s: verdict=%s", field_name, verdict)
        return {
            "verdict": verdict,
            "reason": reason,
            "occurrence_count": occurrence_count,
            "preliminary": preliminary,
            "llm_error": False,
        }
    except Exception as exc:
        logger.error("LLM OCR searcher failed for %s: %s", field_name, _safe_error_message(exc))
        return {
            "verdict": "UNCERTAIN",
            "reason": "LLM searcher unavailable",
            "occurrence_count": 0,
            "preliminary": "unknown",
            "llm_error": True,
        }
