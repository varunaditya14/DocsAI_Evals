"""Field-level evaluation routines for DocsAI extraction output."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import openai
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

# STEP 3 — values that mean "no real content" rather than an actual answer.
EMPTY_MARKERS = {"", "-", "—", "n/a", "nil", "none", "null", "-/-"}

# STEP 4 — currency symbols/codes stripped before parsing a value as a number.
CURRENCY_SYMBOLS = r"[£$€₹¥]|SGD|RM|USD|EUR|GBP"
_CURRENCY_PATTERN = re.compile(CURRENCY_SYMBOLS, re.IGNORECASE)

# STEP 8 — extraction metadata keys that are never real golden/extra fields.
SKIP_KEYS = {
    "extractionConfidence",
    "extraction_confidence",
    "success",
    "documentType",
    "document_type",
}

# OCR searcher — structural markers and section hints in Mistral OCR markdown.
PAGE_BREAK_MARKER = "<!-- PageBreak -->"
PAGE_NUMBER_PATTERN = r"<!--\s*PageNumber[^>]*-->"
HTML_TAG_PATTERN = r"<[^>]+>"
INVOICE_SECTION_KEYWORDS = [
    "INV NO",
    "INVOICE",
    "TAX INVOICE",
    "DATE",
    "BILL TO",
    "DELIVERY TO",
    "TERMS",
    "SALES",
    "PO NO",
    "RQ NO",
    "AMOUNT DUE",
    "GST",
    "TOTAL",
]
# A value found more times than this in the markdown is too common to diagnose.
OCR_SEARCH_COMMON_VALUE_LIMIT = 5


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


def _is_line_items_value(value: Any) -> bool:
    """Return True when a value is a non-empty list of row dictionaries."""
    return isinstance(value, list) and bool(value) and isinstance(value[0], dict)


def _is_scalar_list_value(value: Any) -> bool:
    """Return True when a value is a non-empty list of plain values (not row dicts)."""
    return isinstance(value, list) and bool(value) and not isinstance(value[0], dict)


# --------------------------------------------------------------------------
# STEP 1 — pre-comparison normalization
# --------------------------------------------------------------------------


def normalize_for_comparison(value: Any) -> Any:
    """
    Normalize a field value to a clean string for comparison.

    Handles None, numbers, booleans, and string edge cases. Lists are
    returned unchanged since line items and scalar lists are matched
    row-by-row / value-by-value elsewhere rather than as a single string.
    """
    if value is None:
        return ""
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True)
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        return str(value)
    return str(value).strip()


# --------------------------------------------------------------------------
# STEP 3 — empty value handling
# --------------------------------------------------------------------------


def is_effectively_empty(value: str) -> bool:
    """Returns True if a normalized string value represents an absent or placeholder value rather than real content."""
    return str(value).strip().lower() in EMPTY_MARKERS


def _handle_empty_values(golden_norm: str, extracted_norm: str) -> dict[str, Any] | None:
    """
    Apply the STEP 3 empty-marker rules to a normalized golden/extracted pair.

    Returns a comparison result dict when either side is effectively empty
    (both empty, golden empty only, or extracted empty only), or None when
    both sides have real content and a normal comparison should run instead.
    """
    golden_empty = is_effectively_empty(golden_norm)
    extracted_empty = is_effectively_empty(extracted_norm)

    if golden_empty and extracted_empty:
        return {"status": "TP", "score": 100, "note": "both_empty"}
    if golden_empty and not extracted_empty:
        return {"status": "PRESENT", "score": None, "note": "golden_empty_extracted_present"}
    if not golden_empty and extracted_empty:
        return {"status": "FN", "score": 0, "note": "extracted_empty"}
    return None


# --------------------------------------------------------------------------
# STEP 4/5/6 — typed value comparators
# --------------------------------------------------------------------------


def compare_numeric(golden: str, extracted: str) -> dict[str, Any]:
    """
    Compare two values as numbers after normalization.

    Strips currency symbols, commas, and whitespace before parsing. Falls
    back to text comparison when either side cannot be parsed as a float.
    """

    def parse_numeric(val: str) -> float | None:
        cleaned = _CURRENCY_PATTERN.sub("", val)
        cleaned = cleaned.replace(",", "").strip()
        try:
            return float(cleaned)
        except ValueError:
            return None

    g_num = parse_numeric(golden)
    e_num = parse_numeric(extracted)

    if g_num is None or e_num is None:
        result = compare_text(golden, extracted)
        result["note"] = "numeric_parse_failed_fell_back_to_text"
        return result

    if g_num == e_num:
        return {"status": "TP", "score": 100, "note": "exact_numeric_match"}
    return {
        "status": "FP",
        "score": 0,
        "note": "numeric_mismatch",
        "golden_parsed": g_num,
        "extracted_parsed": e_num,
    }


def compare_date(golden: str, extracted: str, field_name: str = "") -> dict[str, Any]:
    """
    Compare two date values. Uses exact string match after whitespace
    normalization; does not convert formats. When the exact match fails it
    falls back to fuzzy matching using the SAME length-adjusted thresholds
    as compare_text (never a flat 90% threshold): a golden value of <=8
    chars requires an exact match, <=15 chars uses a 97/90 pass/grey split,
    and longer uses 90/70. A fuzzy score below the grey threshold is FP;
    nothing here converts a low-confidence match into PASS.

    A normal date is 8-10 characters (e.g. "06/02/2026"). A golden value
    longer than 10 chars is flagged with note "golden_date_length_suspicious"
    and a WARNING, because it likely contains extra characters (e.g. the
    trailing "0" in "07/04/20260"), which fuzzy scoring alone can miss.
    """
    g_clean = golden.strip()
    e_clean = extracted.strip()

    suspicious_length = len(g_clean) > 10
    if suspicious_length:
        logger.warning(
            "Date field golden value is %s chars which exceeds normal date length of 10. "
            "Value: '%s'. Possible extra characters in golden.",
            len(g_clean),
            g_clean,
        )

    def _tag(result: dict[str, Any]) -> dict[str, Any]:
        """Append the suspicious-length note when the golden date is over-long."""
        if suspicious_length:
            result["note"] = f"{result['note']},golden_date_length_suspicious"
        return result

    if g_clean == e_clean:
        return _tag({"status": "TP", "score": 100, "note": "exact_date_match"})

    score = round(float(fuzz.ratio(g_clean, e_clean)), 2)

    g_len = len(g_clean)
    if g_len <= 8:
        pass_threshold = 100
        grey_threshold = 100
    elif g_len <= 15:
        pass_threshold = 97
        grey_threshold = 90
    else:
        pass_threshold = 90
        grey_threshold = 70

    if score >= pass_threshold:
        status = "TP"
        note = "fuzzy_date_near_match"
    elif score >= grey_threshold:
        status = "GREY"
        note = "date_grey_zone"
    else:
        status = "FP"
        note = "date_mismatch"

    logger.debug(
        "compare_date field len:%s score:%s threshold:%s result:%s",
        g_len,
        score,
        pass_threshold,
        status,
    )

    return _tag(
        {
            "status": status,
            "score": score,
            "note": note,
            "threshold_used": {"pass": pass_threshold, "grey": grey_threshold, "length": g_len},
        }
    )


def compare_text(golden: str, extracted: str) -> dict[str, Any]:
    """
    Compare two text values using RapidFuzz. Uses both ratio and
    token_sort_ratio and takes the higher score; token_sort_ratio handles
    word-order differences and multiline values collapsed to single-line text.

    Thresholds are length-adjusted on the golden value: short strings (<=8
    chars, e.g. short IDs) require an exact match — any difference is FAIL,
    with no grey zone, since a single missing character in a short ID is a
    real error rather than fuzzy noise. Medium strings (<=15 chars) use a
    97/90 pass/grey split; longer strings use the original 90/70 split.
    """
    g = golden.strip()
    e = extracted.strip()

    if g == e:
        return {"status": "TP", "score": 100, "note": "exact_text_match"}

    g_norm = re.sub(r"\s+", " ", g)
    e_norm = re.sub(r"\s+", " ", e)

    if g_norm == e_norm:
        return {"status": "TP", "score": 100, "note": "whitespace_normalized_match"}

    ratio = fuzz.ratio(g_norm, e_norm)
    token_sort = fuzz.token_sort_ratio(g_norm, e_norm)
    score = round(float(max(ratio, token_sort)), 2)

    g_len = len(g_norm)
    if g_len <= 8:
        pass_threshold = 100
        grey_threshold = 100
    elif g_len <= 15:
        pass_threshold = 97
        grey_threshold = 90
    else:
        pass_threshold = 90
        grey_threshold = 70

    if score >= pass_threshold:
        status = "TP"
        note = "fuzzy_text_match"
    elif score >= grey_threshold:
        status = "GREY"
        note = "grey_zone"
    else:
        status = "FP"
        note = "text_mismatch"

    logger.debug(
        "compare_text field len:%s score:%s threshold:%s result:%s",
        g_len,
        score,
        pass_threshold,
        status,
    )

    result: dict[str, Any] = {
        "status": status,
        "score": score,
        "note": note,
        "threshold_used": {"pass": pass_threshold, "grey": grey_threshold, "length": g_len},
    }

    # Trailing-character guard: one extra/dropped char at the end of a long
    # string is almost invisible to fuzzy scoring (e.g. a trailing "0" is
    # 1/84 of the value). If a PASS/GREY result has a different final
    # alphanumeric character, downgrade PASS to GREY so the LLM judge sees it.
    if status in ("TP", "GREY"):
        g_stripped = g_norm.rstrip()
        e_stripped = e_norm.rstrip()
        if g_stripped and g_stripped[-1].isalnum():
            last_g = g_stripped[-1]
            last_e = e_stripped[-1] if e_stripped else ""
            if last_g != last_e:
                if status == "TP":
                    result["status"] = "GREY"
                result["note"] = f"{note},trailing_char_mismatch"
                result["trailing_check"] = {"golden_last": last_g, "extracted_last": last_e}
                logger.warning(
                    "Trailing character mismatch on field — golden ends '%s' extracted ends '%s'. "
                    "Downgraded to GREY for LLM judge.",
                    last_g,
                    last_e,
                )

    return result


def _compare_field_values(field_name: str, golden_norm: str, extracted_norm: str) -> dict[str, Any]:
    """
    Compare one already-normalized golden/extracted string pair.

    Applies the STEP 3 empty-marker rules first, then dispatches to the
    numeric, date, or text comparator based on value-verified field type
    inference (STEP 2). Shared by simple fields, line-item cells, and
    scalar-list items so the same rules apply everywhere.
    """
    logger.debug("Comparing field=%s golden=%r extracted=%r", field_name, golden_norm, extracted_norm)

    empty_result = _handle_empty_values(golden_norm, extracted_norm)
    if empty_result is not None:
        result = dict(empty_result)
        result["golden_value"] = golden_norm
        result["extracted_value"] = extracted_norm
        result["field_type"] = infer_field_type(field_name, golden_norm)
        return result

    field_type = infer_field_type(field_name, golden_norm)
    if field_type == "numeric":
        cmp_result = compare_numeric(golden_norm, extracted_norm)
    elif field_type == "date":
        cmp_result = compare_date(golden_norm, extracted_norm, field_name)
    else:
        cmp_result = compare_text(golden_norm, extracted_norm)

    cmp_result["golden_value"] = golden_norm
    cmp_result["extracted_value"] = extracted_norm
    cmp_result["field_type"] = field_type
    return cmp_result


def _safe_compare_field_values(field_name: str, golden_norm: str, extracted_norm: str) -> dict[str, Any]:
    """Run _compare_field_values, converting any exception into an FP 'comparison_error' result."""
    try:
        return _compare_field_values(field_name, golden_norm, extracted_norm)
    except Exception:
        logger.exception("Comparison failed for field %s; marking as FP.", field_name)
        return {
            "status": "FP",
            "score": 0,
            "note": "comparison_error",
            "golden_value": golden_norm,
            "extracted_value": extracted_norm,
            "field_type": "text",
        }


# --------------------------------------------------------------------------
# STEP 7 — line items comparison
# --------------------------------------------------------------------------


def _line_item_row_status(column_results: dict[str, dict[str, Any]], has_grey: bool) -> str:
    """Return PASS/PARTIAL/FAIL/GREY_ROW for a matched line-item row from its cell statuses."""
    if has_grey:
        return "GREY_ROW"
    statuses = [cell["status"] for cell in column_results.values()]
    if statuses and all(status == "TP" for status in statuses):
        return "PASS"
    if any(status == "TP" for status in statuses):
        return "PARTIAL"
    return "FAIL"


def compare_line_items(golden_rows: list, extracted_rows: list) -> dict[str, Any]:
    """
    Compare line item tables by matching golden rows to extracted rows using
    description-based fuzzy matching. Each row is matched to the closest
    extracted row before per-cell comparison. Matching threshold: 60% minimum
    to count as a match. Each extracted row can only be matched once (greedy,
    highest score first).
    """
    normalized_golden_rows = [row for row in golden_rows if isinstance(row, dict)] if isinstance(golden_rows, list) else []
    normalized_extracted_rows = (
        [row for row in extracted_rows if isinstance(row, dict)] if isinstance(extracted_rows, list) else []
    )
    columns = list(normalized_golden_rows[0].keys()) if normalized_golden_rows else []
    primary_column = columns[0] if columns else ""

    if not normalized_extracted_rows:
        total_cells = len(normalized_golden_rows) * max(len(columns), 1)
        return {
            "status": "FN",
            "total_golden_rows": len(normalized_golden_rows),
            "total_extracted_rows": 0,
            "matched_count": 0,
            "missing_rows": len(normalized_golden_rows),
            "extra_rows": 0,
            "tp_count": 0,
            "fp_count": 0,
            "fn_count": total_cells,
            "grey_count": 0,
            "row_results": [],
            "extra_extracted": [],
            "unmatched_golden": normalized_golden_rows,
        }

    available_indexes = set(range(len(normalized_extracted_rows)))
    row_results: list[dict[str, Any]] = []
    unmatched_golden: list[dict[str, Any]] = []

    for golden_row in normalized_golden_rows:
        golden_primary = normalize_for_comparison(golden_row.get(primary_column, ""))
        best_score = 0.0
        best_index: int | None = None
        for extracted_index in available_indexes:
            extracted_row = normalized_extracted_rows[extracted_index]
            extracted_primary = normalize_for_comparison(extracted_row.get(primary_column, ""))
            match_score = (
                float(fuzz.ratio(golden_primary, extracted_primary)) if (golden_primary or extracted_primary) else 0.0
            )
            if match_score > best_score:
                best_score = match_score
                best_index = extracted_index

        if best_index is None or best_score < 60:
            unmatched_golden.append(golden_row)
            continue

        available_indexes.remove(best_index)
        extracted_row = normalized_extracted_rows[best_index]
        column_results: dict[str, dict[str, Any]] = {}
        has_grey = False
        for column in columns:
            golden_cell = normalize_for_comparison(golden_row.get(column, ""))
            extracted_cell = normalize_for_comparison(extracted_row.get(column, ""))
            cell_result = _safe_compare_field_values(column, golden_cell, extracted_cell)
            if cell_result["status"] == "GREY":
                has_grey = True
            cell_result["llm_judge"] = None
            column_results[column] = cell_result

        row_results.append(
            {
                "column_results": column_results,
                "row_status": _line_item_row_status(column_results, has_grey),
                "match_score": round(best_score, 2),
            }
        )

    extra_extracted = [normalized_extracted_rows[index] for index in sorted(available_indexes)]

    tp_count = 0
    fp_count = 0
    fn_count = 0
    grey_count = 0
    for row_result in row_results:
        for cell in row_result["column_results"].values():
            if cell["status"] == "TP":
                tp_count += 1
            elif cell["status"] == "FN":
                fn_count += 1
            elif cell["status"] == "GREY":
                grey_count += 1
            else:
                fp_count += 1
    fn_count += len(unmatched_golden) * max(len(columns), 1)

    if fn_count == 0 and fp_count == 0 and grey_count == 0:
        status = "PASS"
    elif normalized_golden_rows and len(unmatched_golden) == len(normalized_golden_rows):
        status = "FN"
    elif tp_count > 0 or grey_count > 0:
        status = "PARTIAL"
    else:
        status = "FAIL"

    return {
        "status": status,
        "total_golden_rows": len(normalized_golden_rows),
        "total_extracted_rows": len(normalized_extracted_rows),
        "matched_count": len(row_results),
        "missing_rows": len(unmatched_golden),
        "extra_rows": len(extra_extracted),
        "tp_count": tp_count,
        "fp_count": fp_count,
        "fn_count": fn_count,
        "grey_count": grey_count,
        "row_results": row_results,
        "extra_extracted": extra_extracted,
        "unmatched_golden": unmatched_golden,
    }


def resolve_line_item_grey_cells(
    field_results: dict[str, Any],
    aggregate: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Runs LLM judge on GREY cells inside line items table results.

    Only processes line_items type fields. Same PASS/FAIL/unresolved logic
    as resolve_grey_and_failed_with_judge, applied per cell: PASS becomes
    TP, FAIL becomes FP, anything else becomes GREY_UNRESOLVED. Updates
    aggregate tp/fp/grey counts and each row's row_status in place.
    """
    for field_name, field_result in field_results.items():
        if field_result.get("field_type") != "line_items":
            continue
        if "row_results" not in field_result:
            continue

        for row_result in field_result["row_results"]:
            if "column_results" not in row_result:
                continue

            for col_name, cell_result in row_result["column_results"].items():
                if cell_result.get("status") != "GREY":
                    continue

                golden_cell = cell_result.get("golden_value", "")
                extracted_cell = cell_result.get("extracted_value", "")
                fuzzy = cell_result.get("score", 0) or 0

                judge = llm_semantic_judge(
                    f"{field_name}.{col_name}",
                    golden_cell,
                    extracted_cell,
                    cell_result.get("field_type", "text"),
                    fuzzy,
                )
                cell_result["llm_judge"] = judge

                if judge["verdict"] == "PASS":
                    cell_result["status"] = "TP"
                    aggregate["grey"] = max(0, aggregate.get("grey", 0) - 1)
                    aggregate["tp"] = aggregate.get("tp", 0) + 1
                    field_result["tp_count"] = field_result.get("tp_count", 0) + 1
                    field_result["grey_count"] = max(0, field_result.get("grey_count", 0) - 1)
                elif judge["verdict"] == "FAIL":
                    cell_result["status"] = "FP"
                    aggregate["grey"] = max(0, aggregate.get("grey", 0) - 1)
                    aggregate["fp"] = aggregate.get("fp", 0) + 1
                    field_result["fp_count"] = field_result.get("fp_count", 0) + 1
                    field_result["grey_count"] = max(0, field_result.get("grey_count", 0) - 1)
                else:
                    cell_result["status"] = "GREY_UNRESOLVED"

                row_result["column_results"][col_name] = cell_result

            cell_statuses = [cell["status"] for cell in row_result["column_results"].values()]
            if cell_statuses and all(status == "TP" for status in cell_statuses):
                row_result["row_status"] = "PASS"
            elif all(status in ("FP", "FN", "GREY_UNRESOLVED") for status in cell_statuses):
                row_result["row_status"] = "FAIL"
            else:
                row_result["row_status"] = "PARTIAL"

    return field_results, aggregate


# --------------------------------------------------------------------------
# Scalar list comparison (list golden values that are not row tables)
# --------------------------------------------------------------------------


def compare_scalar_list(golden_values: list, extracted_values: Any, field_name: str = "") -> dict[str, Any]:
    """
    Compare a golden list of plain values against an extracted list by
    matching each golden value to the closest extracted value (whole-value
    similarity), mirroring compare_line_items but for scalars instead of
    row/column dicts.
    """
    normalized_golden = [
        normalize_for_comparison(value) for value in golden_values if not isinstance(value, (dict, list))
    ]

    if not isinstance(extracted_values, list) or not extracted_values:
        return {
            "status": "FN",
            "total_golden_values": len(normalized_golden),
            "total_extracted_values": 0,
            "matched_count": 0,
            "missing_values": len(normalized_golden),
            "extra_values": 0,
            "tp_count": 0,
            "fp_count": 0,
            "fn_count": len(normalized_golden),
            "grey_count": 0,
            "item_results": [],
            "unmatched_golden": normalized_golden,
            "extra_extracted": [],
        }

    normalized_extracted = [
        normalize_for_comparison(value) for value in extracted_values if not isinstance(value, (dict, list))
    ]
    available_indexes = set(range(len(normalized_extracted)))
    item_results: list[dict[str, Any]] = []
    unmatched_golden: list[str] = []

    for golden_val in normalized_golden:
        best_index: int | None = None
        best_score = 0.0
        for extracted_index in available_indexes:
            extracted_val = normalized_extracted[extracted_index]
            match_score = float(fuzz.ratio(golden_val, extracted_val)) if (golden_val or extracted_val) else 0.0
            if match_score > best_score:
                best_score = match_score
                best_index = extracted_index

        if best_index is None or best_score < 60:
            unmatched_golden.append(golden_val)
            continue

        available_indexes.remove(best_index)
        extracted_val = normalized_extracted[best_index]
        item_result = _safe_compare_field_values(field_name, golden_val, extracted_val)
        item_result["match_score"] = round(best_score, 2)
        item_result["llm_judge"] = None
        item_results.append(item_result)

    extra_extracted = [normalized_extracted[index] for index in sorted(available_indexes)]

    tp_count = sum(1 for item in item_results if item["status"] == "TP")
    fn_count = sum(1 for item in item_results if item["status"] == "FN") + len(unmatched_golden)
    grey_count = sum(1 for item in item_results if item["status"] == "GREY")
    fp_count = sum(1 for item in item_results if item["status"] not in {"TP", "FN", "GREY"}) + len(extra_extracted)

    if fn_count == 0 and fp_count == 0 and grey_count == 0:
        status = "PASS"
    elif normalized_golden and len(unmatched_golden) == len(normalized_golden):
        status = "FN"
    elif tp_count > 0 or grey_count > 0:
        status = "PARTIAL"
    else:
        status = "FAIL"

    return {
        "status": status,
        "total_golden_values": len(normalized_golden),
        "total_extracted_values": len(normalized_extracted),
        "matched_count": len(item_results),
        "missing_values": len(unmatched_golden),
        "extra_values": len(extra_extracted),
        "tp_count": tp_count,
        "fp_count": fp_count,
        "fn_count": fn_count,
        "grey_count": grey_count,
        "item_results": item_results,
        "unmatched_golden": unmatched_golden,
        "extra_extracted": extra_extracted,
    }


def resolve_scalar_list_grey_items(
    field_results: dict[str, Any],
    aggregate: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Runs LLM judge on GREY items inside scalar-list field results, mirroring
    resolve_line_item_grey_cells for plain-value lists instead of row/column
    tables. Only processes scalar_list type fields. Updates aggregate
    tp/fp/grey counts in place.
    """
    for field_name, field_result in field_results.items():
        if field_result.get("field_type") != "scalar_list":
            continue
        if "item_results" not in field_result:
            continue

        for item_result in field_result["item_results"]:
            if item_result.get("status") != "GREY":
                continue

            golden_value = item_result.get("golden_value", "")
            extracted_value = item_result.get("extracted_value", "")
            fuzzy_score = item_result.get("score", 0) or 0

            judge = llm_semantic_judge(
                field_name,
                golden_value,
                extracted_value,
                item_result.get("field_type", "text"),
                fuzzy_score,
            )
            item_result["llm_judge"] = judge

            if judge["verdict"] == "PASS":
                item_result["status"] = "TP"
                aggregate["grey"] = max(0, aggregate.get("grey", 0) - 1)
                aggregate["tp"] = aggregate.get("tp", 0) + 1
                field_result["tp_count"] = field_result.get("tp_count", 0) + 1
                field_result["grey_count"] = max(0, field_result.get("grey_count", 0) - 1)
            elif judge["verdict"] == "FAIL":
                item_result["status"] = "FP"
                aggregate["grey"] = max(0, aggregate.get("grey", 0) - 1)
                aggregate["fp"] = aggregate.get("fp", 0) + 1
                field_result["fp_count"] = field_result.get("fp_count", 0) + 1
                field_result["grey_count"] = max(0, field_result.get("grey_count", 0) - 1)
            else:
                item_result["status"] = "GREY_UNRESOLVED"

    return field_results, aggregate


# --------------------------------------------------------------------------
# STEP 8 — main comparison orchestrator
# --------------------------------------------------------------------------


def run_field_comparison(
    golden_fields: dict[str, Any],
    extracted_fields: dict[str, Any],
    field_types: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Compare all fields between golden and extracted dicts.

    Returns per-field results and aggregate TP/FP/FN/GREY counts. Line item
    (list-of-dict) golden values are compared row by row via
    compare_line_items; scalar-list golden values are compared value by
    value via compare_scalar_list; everything else is compared as a single
    scalar value. field_types may optionally override the inferred type for
    specific field names.
    """
    results: dict[str, Any] = {}
    aggregate = {"tp": 0, "fp": 0, "fn": 0, "grey": 0, "extra": 0, "informational": 0}
    grey_fields: list[str] = []

    if not golden_fields:
        return {
            "field_results": {},
            "aggregate": aggregate,
            "grey_fields": [],
            "total_golden_fields": 0,
            "total_extracted_fields": len(extracted_fields or {}),
            "note": "no_golden_fields_provided",
        }

    if not extracted_fields:
        logger.warning("extracted_fields is empty; every golden field will be marked FN or missing.")

    field_type_overrides = field_types or {}

    for field_name, golden_value in golden_fields.items():
        if isinstance(golden_value, list) and len(golden_value) == 0:
            logger.debug("Skipping field '%s' — empty list in golden", field_name)
            continue

        try:
            if isinstance(golden_value, list):
                extracted_value = extracted_fields.get(field_name)
                if not isinstance(extracted_value, list):
                    if extracted_value is not None:
                        logger.warning(
                            "Golden field %s is a list but extracted value is %s; treating as empty.",
                            field_name,
                            type(extracted_value).__name__,
                        )
                    extracted_value = []

                if _is_scalar_list_value(golden_value):
                    container_result = compare_scalar_list(golden_value, extracted_value, field_name)
                    container_result["field_type"] = "scalar_list"
                else:
                    container_result = compare_line_items(golden_value, extracted_value)
                    container_result["field_type"] = "line_items"

                container_result["golden_value"] = golden_value
                container_result["extracted_value"] = extracted_value
                container_result["llm_judge"] = None
                container_result["ocr_search"] = None
                results[field_name] = container_result
                aggregate["tp"] += container_result["tp_count"]
                aggregate["fp"] += container_result["fp_count"]
                aggregate["fn"] += container_result["fn_count"]
                aggregate["grey"] += container_result["grey_count"]
                continue

            golden_norm = normalize_for_comparison(golden_value)

            if field_name not in extracted_fields:
                field_type = field_type_overrides.get(field_name) or infer_field_type(field_name, golden_norm)
                results[field_name] = {
                    "status": "FN",
                    "golden_value": golden_norm,
                    "extracted_value": "",
                    "score": 0,
                    "field_type": field_type,
                    "note": "field_missing_from_extraction",
                    "llm_judge": None,
                    "ocr_search": None,
                }
                aggregate["fn"] += 1
                continue

            extracted_norm = normalize_for_comparison(extracted_fields.get(field_name))
            logger.debug("Comparing field=%s golden=%r extracted=%r", field_name, golden_norm, extracted_norm)

            empty_result = _handle_empty_values(golden_norm, extracted_norm)
            if empty_result is not None:
                field_type = field_type_overrides.get(field_name) or infer_field_type(field_name, golden_norm)
                result = dict(empty_result)
                result.update(
                    {
                        "golden_value": golden_norm,
                        "extracted_value": extracted_norm,
                        "field_type": field_type,
                        "llm_judge": None,
                        "ocr_search": None,
                    }
                )
                results[field_name] = result
                if result["status"] == "TP":
                    aggregate["tp"] += 1
                elif result["status"] == "FN":
                    aggregate["fn"] += 1
                elif result["status"] == "PRESENT":
                    aggregate["informational"] += 1
                continue

            field_type = field_type_overrides.get(field_name) or infer_field_type(field_name, golden_norm)
            if field_type == "numeric":
                cmp_result = compare_numeric(golden_norm, extracted_norm)
            elif field_type == "date":
                cmp_result = compare_date(golden_norm, extracted_norm, field_name)
            else:
                cmp_result = compare_text(golden_norm, extracted_norm)

            cmp_result["field_name"] = field_name
            cmp_result["golden_value"] = golden_norm
            cmp_result["extracted_value"] = extracted_norm
            cmp_result["field_type"] = field_type
            cmp_result["llm_judge"] = None
            cmp_result["ocr_search"] = None
            results[field_name] = cmp_result

            if cmp_result["status"] == "TP":
                aggregate["tp"] += 1
            elif cmp_result["status"] == "FP":
                aggregate["fp"] += 1
            elif cmp_result["status"] == "FN":
                aggregate["fn"] += 1
            elif cmp_result["status"] == "GREY":
                aggregate["grey"] += 1
                grey_fields.append(field_name)
        except Exception:
            logger.exception("Comparison failed for field %s; marking as FP.", field_name)
            results[field_name] = {
                "status": "FP",
                "golden_value": golden_value if isinstance(golden_value, list) else normalize_for_comparison(golden_value),
                "extracted_value": normalize_for_comparison(extracted_fields.get(field_name)),
                "score": 0,
                "field_type": "text",
                "note": "comparison_error",
                "llm_judge": None,
                "ocr_search": None,
            }
            aggregate["fp"] += 1

    for field_name, extracted_value in extracted_fields.items():
        if field_name in golden_fields:
            continue
        if field_name in SKIP_KEYS:
            logger.warning("Skipping metadata key found in extracted fields: %s", field_name)
            continue
        if isinstance(extracted_value, dict):
            continue
        results[field_name] = {
            "status": "EXTRA",
            "golden_value": "",
            "extracted_value": extracted_value if isinstance(extracted_value, list) else normalize_for_comparison(extracted_value),
            "score": None,
            "field_type": "line_items" if isinstance(extracted_value, list) else "text",
            "note": "not_in_golden_fields",
            "llm_judge": None,
            "ocr_search": None,
        }
        aggregate["extra"] += 1

    logger.info(
        "Comparison complete — TP:%s FP:%s FN:%s GREY:%s",
        aggregate["tp"],
        aggregate["fp"],
        aggregate["fn"],
        aggregate["grey"],
    )

    return {
        "field_results": results,
        "aggregate": aggregate,
        "grey_fields": grey_fields,
        "total_golden_fields": len(golden_fields),
        "total_extracted_fields": len(extracted_fields),
    }


def recalculate_aggregate(field_results: dict[str, Any]) -> dict[str, int]:
    """
    Recompute aggregate TP/FP/FN/GREY/EXTRA/informational counts from
    per-field results. Used after GREY fields are resolved by the LLM judge
    so precision/recall/F1 reflect the final statuses.
    """
    aggregate = {"tp": 0, "fp": 0, "fn": 0, "grey": 0, "extra": 0, "informational": 0}
    for result in field_results.values():
        if not isinstance(result, dict):
            continue
        if result.get("field_type") in ("line_items", "scalar_list"):
            aggregate["tp"] += int(result.get("tp_count", 0) or 0)
            aggregate["fp"] += int(result.get("fp_count", 0) or 0)
            aggregate["fn"] += int(result.get("fn_count", 0) or 0)
            aggregate["grey"] += int(result.get("grey_count", 0) or 0)
            continue
        status = result.get("status")
        if status == "TP":
            aggregate["tp"] += 1
        elif status == "FP":
            aggregate["fp"] += 1
        elif status == "FN":
            aggregate["fn"] += 1
        elif status == "GREY":
            aggregate["grey"] += 1
        elif status == "EXTRA":
            aggregate["extra"] += 1
        elif status == "PRESENT":
            aggregate["informational"] += 1
    return aggregate


# --------------------------------------------------------------------------
# STEP 9 — F1 calculation
# --------------------------------------------------------------------------


def calculate_f1(aggregate: dict[str, Any]) -> dict[str, Any]:
    """
    Calculate precision, recall, and F1 from TP/FP/FN counts.

    GREY and informational (PRESENT) fields are excluded from F1. EXTRA
    fields count toward false positives for precision. All values rounded
    to 4 decimal places.
    """
    tp = aggregate.get("tp", 0)
    fp = aggregate.get("fp", 0)
    fn = aggregate.get("fn", 0)
    grey = aggregate.get("grey", 0)
    extra = aggregate.get("extra", 0)

    fp_total = fp + extra
    precision = tp / (tp + fp_total) if (tp + fp_total) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0

    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "grey_count": grey,
        "extra_count": extra,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }


# --------------------------------------------------------------------------
# LLM judge — Azure OpenAI (API key) with public-OpenAI fallback,
# run only for GREY and FP fields
# --------------------------------------------------------------------------

_openai_client: AzureOpenAI | openai.OpenAI | None = None


def _judge_provider_config() -> tuple[str, str, str]:
    """
    Decide which OpenAI provider the LLM judge should use.

    Returns a (provider, model, key) tuple where provider is "azure",
    "openai", or "none". Prefers Azure OpenAI authenticated with
    AZURE_OPENAI_API_KEY (the provider the rest of the app targets), then
    falls back to public OpenAI with OPENAI_API_KEY. model is the Azure
    deployment name for Azure, or the configured public model otherwise.
    """
    try:
        settings = get_settings()
    except RuntimeError:
        return "none", "gpt-4-1106-preview", ""
    if settings.azure_openai_key_configured:
        return "azure", settings.azure_openai_deployment, settings.azure_openai_api_key
    if settings.openai_api_key:
        return "openai", settings.openai_model, settings.openai_api_key
    return "none", settings.openai_model, ""


def _get_openai_client() -> AzureOpenAI | openai.OpenAI | None:
    """
    Returns a cached OpenAI client for the LLM judge.

    Builds an Azure OpenAI client (API-key auth) when Azure is
    key-configured, otherwise a public OpenAI client when OPENAI_API_KEY is
    set. Returns None if neither is configured (or settings fail to load),
    so callers can skip the judge instead of crashing.
    """
    global _openai_client
    if _openai_client is not None:
        return _openai_client
    try:
        settings = get_settings()
    except RuntimeError:
        return None
    if settings.azure_openai_key_configured:
        _openai_client = AzureOpenAI(
            azure_endpoint=settings.azure_openai_endpoint,
            api_version=settings.azure_openai_api_version,
            api_key=settings.azure_openai_api_key,
        )
        return _openai_client
    if settings.openai_api_key:
        _openai_client = openai.OpenAI(api_key=settings.openai_api_key)
        return _openai_client
    return None


def llm_semantic_judge(
    field_name: str,
    golden_value: str,
    extracted_value: str,
    field_type: str,
    fuzzy_score: float,
) -> dict[str, Any]:
    """
    Uses OpenAI GPT to determine whether an uncertain or failed field
    extraction is semantically correct.

    Called only for fields with status GREY (score 70-89) or FP (score
    below 70). Never called for TP, FN, EXTRA, or PRESENT.

    Returns a dict with verdict (PASS, FAIL, or GREY_UNRESOLVED), reason,
    and metadata. If OpenAI is unavailable or the call fails, returns
    GREY_UNRESOLVED so the eval can continue without crashing.
    """
    client = _get_openai_client()
    provider, model_name, api_key = _judge_provider_config()

    if client is None:
        logger.warning(
            "LLM judge skipped for field '%s' — no OpenAI provider configured "
            "(set AZURE_OPENAI_API_KEY + endpoint/deployment/version, or OPENAI_API_KEY)",
            field_name,
        )
        return {
            "verdict": "GREY_UNRESOLVED",
            "reason": "No OpenAI provider configured for the LLM judge",
            "llm_called": False,
            "llm_error": False,
            "model": None,
            "fuzzy_score_at_judge": fuzzy_score,
        }

    system_prompt = (
        "You are evaluating a document extraction system.\n"
        "Your job is to decide if an extracted field value is\n"
        "correct compared to the expected value.\n\n"
        "Rules:\n"
        "- Reply with exactly PASS or FAIL on the first line\n"
        "- On the second line write one sentence explaining why\n"
        "- Do not write anything else\n\n"
        "PASS if the values mean the same thing, for example:\n"
        "- Same content with different formatting or spacing\n"
        "- Same number written differently (1,250.00 vs 1250)\n"
        "- Same address with minor abbreviation differences\n"
        "- Same name with or without punctuation\n\n"
        "FAIL if the values are genuinely different, for example:\n"
        "- Different numbers\n"
        "- Different dates\n"
        "- Different names or companies\n"
        "- One is clearly wrong or irrelevant"
    )
    user_prompt = (
        f"Field name: {field_name}\n"
        f"Field type: {field_type}\n"
        f"Expected value: {golden_value}\n"
        f"Extracted value: {extracted_value}\n"
        f"Fuzzy similarity score: {fuzzy_score}%\n\n"
        "Are these the same?"
    )

    logger.debug(
        "LLM judge calling OpenAI — field:'%s' provider:'%s' model:'%s' key_set:%s key_prefix:'%s'",
        field_name,
        provider,
        model_name,
        bool(api_key),
        api_key[:8] if api_key else "EMPTY",
    )

    try:
        # Newer models (e.g. gpt-5.x / o-series on Azure) require
        # max_completion_tokens and reject the legacy max_tokens parameter.
        # The budget covers internal reasoning tokens plus the short
        # PASS/FAIL + one-sentence answer, so it is set well above the
        # visible output length.
        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_completion_tokens=512,
            temperature=0,
        )

        raw_response = (response.choices[0].message.content or "").strip()
        logger.debug("LLM judge raw response: '%s'", raw_response)
        lines = raw_response.split("\n", 1)
        first_line = lines[0].strip().upper()
        reason = lines[1].strip() if len(lines) > 1 else "No reason provided"

        if "PASS" in first_line:
            verdict = "PASS"
        elif "FAIL" in first_line:
            verdict = "FAIL"
        else:
            verdict = "GREY_UNRESOLVED"
            reason = f"Unexpected LLM response: {raw_response}"

        logger.info(
            "LLM judge — field:'%s' score:%s%% verdict:%s reason:%s",
            field_name,
            fuzzy_score,
            verdict,
            reason,
        )

        return {
            "verdict": verdict,
            "reason": reason,
            "llm_called": True,
            "llm_error": False,
            "model": model_name,
            "fuzzy_score_at_judge": fuzzy_score,
            "raw_response": raw_response,
        }

    except openai.AuthenticationError:
        logger.error("LLM judge auth failed — check OPENAI_API_KEY")
        return {
            "verdict": "GREY_UNRESOLVED",
            "reason": "OpenAI authentication failed — check API key",
            "llm_called": True,
            "llm_error": True,
            "model": model_name,
            "fuzzy_score_at_judge": fuzzy_score,
        }
    except openai.RateLimitError:
        logger.warning("LLM judge rate limited for field '%s'", field_name)
        return {
            "verdict": "GREY_UNRESOLVED",
            "reason": "OpenAI rate limit reached",
            "llm_called": True,
            "llm_error": True,
            "model": model_name,
            "fuzzy_score_at_judge": fuzzy_score,
        }
    except Exception as exc:
        logger.error(
            "LLM judge FAILED for field '%s': exception type: %s message: %s",
            field_name,
            type(exc).__name__,
            str(exc),
        )
        return {
            "verdict": "GREY_UNRESOLVED",
            "reason": f"LLM judge failed: {exc}",
            "llm_called": True,
            "llm_error": True,
            "model": model_name,
            "fuzzy_score_at_judge": fuzzy_score,
        }


def resolve_grey_and_failed_with_judge(
    field_results: dict[str, Any],
    aggregate: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """
    Runs the LLM semantic judge on all GREY and FP fields.

    Updates field_results in place with judge verdicts and updates
    aggregate counts to reflect resolved verdicts. Returns the updated
    (field_results, aggregate).

    Fields that go to judge: GREY and FP only. Fields that do NOT go to
    judge: TP, FN, EXTRA, PRESENT (skipped via the status check below),
    and line_items containers (their cells are resolved separately by
    resolve_line_item_grey_cells).

    After judge:
      GREY with PASS verdict -> becomes TP
      GREY with FAIL verdict -> becomes FP
      GREY with GREY_UNRESOLVED -> becomes GREY_UNRESOLVED
      FP with PASS verdict -> becomes TP (judge overrides fuzzy match)
      FP with FAIL verdict -> stays FP
      FP with GREY_UNRESOLVED -> becomes GREY_UNRESOLVED (flagged for review)
    """
    judge_stats = {
        "fields_sent_to_judge": 0,
        "resolved_as_pass": 0,
        "resolved_as_fail": 0,
        "unresolved": 0,
    }

    for field_name, field_result in field_results.items():
        current_status = field_result.get("status")

        if current_status not in ("GREY", "FP"):
            continue  # skip TP, FN, EXTRA, PRESENT — already decided
        if field_result.get("field_type") == "line_items":
            continue  # line item cells are handled separately

        golden_value = field_result.get("golden_value", "")
        extracted_value = field_result.get("extracted_value", "")
        field_type = field_result.get("field_type", "text")
        fuzzy_score = field_result.get("score", 0) or 0

        if golden_value == "" and extracted_value == "":
            continue  # both empty — nothing for judge to decide

        judge_stats["fields_sent_to_judge"] += 1

        judge_result = llm_semantic_judge(field_name, golden_value, extracted_value, field_type, fuzzy_score)
        field_results[field_name]["llm_judge"] = judge_result

        verdict = judge_result["verdict"]

        if verdict == "PASS":
            old_status = field_results[field_name]["status"]
            field_results[field_name]["status"] = "TP"

            if old_status == "GREY":
                aggregate["grey"] = max(0, aggregate.get("grey", 0) - 1)
            elif old_status == "FP":
                aggregate["fp"] = max(0, aggregate.get("fp", 0) - 1)

            aggregate["tp"] = aggregate.get("tp", 0) + 1
            judge_stats["resolved_as_pass"] += 1

        elif verdict == "FAIL":
            if current_status == "GREY":
                field_results[field_name]["status"] = "FP"
                aggregate["grey"] = max(0, aggregate.get("grey", 0) - 1)
                aggregate["fp"] = aggregate.get("fp", 0) + 1
            # FP stays FP, no count change needed
            judge_stats["resolved_as_fail"] += 1

        else:  # GREY_UNRESOLVED
            field_results[field_name]["status"] = "GREY_UNRESOLVED"
            judge_stats["unresolved"] += 1

    logger.info(
        "LLM judge complete — sent:%s pass:%s fail:%s unresolved:%s",
        judge_stats["fields_sent_to_judge"],
        judge_stats["resolved_as_pass"],
        judge_stats["resolved_as_fail"],
        judge_stats["unresolved"],
    )

    return field_results, aggregate


def _split_markdown_pages(ocr_markdown: str) -> list[str]:
    """
    Split OCR markdown into pages using PageBreak markers.

    Returns a list of page strings. If no PageBreak is found, returns a list
    with the single full markdown string. Strips PageNumber comments from
    each page and drops pages that are empty after cleaning.
    """
    pages = ocr_markdown.split(PAGE_BREAK_MARKER)
    cleaned: list[str] = []
    for page in pages:
        page = re.sub(PAGE_NUMBER_PATTERN, "", page, flags=re.IGNORECASE)
        page = page.strip()
        if page:
            cleaned.append(page)
    return cleaned if cleaned else [ocr_markdown]


def _extract_plain_text(markdown_snippet: str) -> str:
    """
    Strip HTML tags from a markdown snippet to get plain text.

    Replaces tags with spaces to preserve word boundaries, then collapses
    runs of whitespace into a single space. Used for fuzzy matching where
    HTML table markup (e.g. "<td>: L2529646</td>") would otherwise interfere.
    """
    plain = re.sub(HTML_TAG_PATTERN, " ", markdown_snippet)
    plain = re.sub(r"\s+", " ", plain)
    return plain.strip()


def _get_context_window(
    text: str,
    match_start: int,
    match_end: int,
    context_chars: int = 300,
) -> str:
    """
    Extract a context window around a match position in text.

    Returns up to context_chars characters before and after the match,
    clipped safely to the text boundaries, with ellipses added when the
    window does not reach the start or end of the text. Gives the LLM the
    surrounding context for each occurrence.
    """
    start = max(0, match_start - context_chars)
    end = min(len(text), match_end + context_chars)
    snippet = text[start:end]

    prefix = "..." if start > 0 else ""
    suffix = "..." if end < len(text) else ""
    return prefix + snippet + suffix


def _is_invoice_context(context: str) -> bool:
    """Return True when a context window contains any invoice-section keyword."""
    lowered = context.lower()
    return any(keyword.lower() in lowered for keyword in INVOICE_SECTION_KEYWORDS)


def _find_value_in_markdown(golden_value: str, ocr_markdown: str) -> dict[str, Any]:
    """
    Search for a golden value in OCR markdown using a three-pass approach.

    Pass 1: exact case-insensitive search in the tag-stripped plain text.
    Pass 2: fuzzy token search — split the value into significant tokens and
        flag lines containing most of them (skipped for values <= 4 chars).
    Pass 3: rapidfuzz partial_ratio per line as a last resort when nothing
        was found by passes 1 and 2 (skipped for values < 5 chars).

    The golden value is always matched with str.find / token membership,
    never as a regex, so special characters (e.g. "PO130226-0077(BAR)") are
    safe. Unicode is handled natively. Near-duplicate occurrences (context
    similarity > 80%) are collapsed, keeping the higher-scoring one.

    Returns a dict with exact_count, fuzzy_count, total_occurrences, the list
    of occurrences (page, match_type, score, context, is_invoice_section),
    the search_value, and pages_searched.
    """
    search_val = (golden_value or "").strip()
    if len(search_val) < 2:
        return {
            "exact_count": 0,
            "fuzzy_count": 0,
            "total_occurrences": 0,
            "occurrences": [],
            "search_value": search_val,
            "pages_searched": 0,
            "note": "value_too_short_to_search",
        }

    pages = _split_markdown_pages(ocr_markdown)
    all_occurrences: list[dict[str, Any]] = []
    exact_count = 0
    fuzzy_count = 0
    search_val_lower = search_val.lower()

    for page_num, page_text in enumerate(pages, start=1):
        plain_text = _extract_plain_text(page_text)
        plain_lower = plain_text.lower()

        # PASS 1 — exact, case-insensitive (str.find, never regex).
        page_exact = 0
        pos = 0
        while True:
            idx = plain_lower.find(search_val_lower, pos)
            if idx == -1:
                break
            context = _get_context_window(plain_text, idx, idx + len(search_val))
            all_occurrences.append(
                {
                    "page": page_num,
                    "match_type": "exact",
                    "score": 100.0,
                    "context": context,
                    "is_invoice_section": _is_invoice_context(context),
                }
            )
            exact_count += 1
            page_exact += 1
            pos = idx + 1

        # Skip fuzzy passes on a page that already has an exact hit.
        if page_exact > 0:
            continue

        raw_lines = page_text.split("\n")

        # PASS 2 — fuzzy token search (only for values longer than 4 chars).
        if len(search_val) > 4:
            significant_tokens = [token for token in search_val.split() if len(token) >= 3]
            if significant_tokens:
                required = max(1, len(significant_tokens) * 0.7)
                for raw_line in raw_lines:
                    line_plain = _extract_plain_text(raw_line)
                    if not line_plain:
                        continue
                    line_lower = line_plain.lower()
                    tokens_found = sum(1 for token in significant_tokens if token.lower() in line_lower)
                    if tokens_found >= required:
                        score = (tokens_found / len(significant_tokens)) * 100
                        line_pos = plain_lower.find(line_lower)
                        if line_pos >= 0:
                            context = _get_context_window(plain_text, line_pos, line_pos + len(line_plain))
                        else:
                            context = line_plain
                        all_occurrences.append(
                            {
                                "page": page_num,
                                "match_type": "fuzzy",
                                "score": round(score, 2),
                                "context": context,
                                "is_invoice_section": _is_invoice_context(context),
                            }
                        )
                        fuzzy_count += 1

        # PASS 3 — rapidfuzz partial ratio per line (last resort, nothing found yet).
        if exact_count == 0 and fuzzy_count == 0 and len(search_val) >= 5:
            for raw_line in raw_lines:
                line_plain = _extract_plain_text(raw_line)
                if len(line_plain) < 3:
                    continue
                score = fuzz.partial_ratio(search_val_lower, line_plain.lower())
                if score >= 85:
                    line_pos = plain_lower.find(line_plain.lower())
                    if line_pos >= 0:
                        context = _get_context_window(plain_text, line_pos, line_pos + len(line_plain))
                    else:
                        context = line_plain
                    if not any(existing["context"] == context for existing in all_occurrences):
                        all_occurrences.append(
                            {
                                "page": page_num,
                                "match_type": "fuzzy",
                                "score": round(float(score), 2),
                                "context": context,
                                "is_invoice_section": _is_invoice_context(context),
                            }
                        )
                        fuzzy_count += 1

    # Collapse near-duplicate contexts, keeping the higher-scoring occurrence.
    deduplicated: list[dict[str, Any]] = []
    for occ in all_occurrences:
        is_dup = False
        for existing in deduplicated:
            if fuzz.ratio(occ["context"], existing["context"]) > 80:
                if occ["score"] > existing["score"]:
                    deduplicated.remove(existing)
                else:
                    is_dup = True
                break
        if not is_dup:
            deduplicated.append(occ)

    return {
        "exact_count": exact_count,
        "fuzzy_count": fuzzy_count,
        "total_occurrences": len(deduplicated),
        "occurrences": deduplicated,
        "search_value": search_val,
        "pages_searched": len(pages),
    }


def llm_ocr_searcher(
    field_name: str,
    golden_value: str,
    ocr_markdown: str,
    field_type: str = "text",
) -> dict[str, Any]:
    """
    Diagnose why a field failed by searching the OCR markdown for its value.

    Returns one of three verdicts: PROMPT_PROBLEM (value present in OCR but
    the extraction system missed it), OCR_LIMITATION (value absent from OCR,
    not fixable by prompt tuning), or UNCERTAIN (cannot decide). Uses the
    three-pass search then LLM judgment on the surrounding contexts. Never
    crashes — always returns a dict, even on error.
    """
    default_return = {
        "verdict": "UNCERTAIN",
        "reason": "Search could not be completed",
        "occurrence_count": 0,
        "search_results": None,
        "llm_called": False,
        "llm_error": False,
    }

    if is_effectively_empty(golden_value):
        return {
            "verdict": "UNCERTAIN",
            "reason": "Golden value is empty — cannot search",
            "occurrence_count": 0,
            "llm_called": False,
            "llm_error": False,
        }

    if not ocr_markdown or len(ocr_markdown.strip()) < 10:
        return {
            "verdict": "UNCERTAIN",
            "reason": "OCR markdown is empty or too short to search",
            "occurrence_count": 0,
            "llm_called": False,
            "llm_error": False,
        }

    try:
        search_results = _find_value_in_markdown(golden_value, ocr_markdown)
    except Exception as exc:
        logger.error("OCR search failed for field '%s': %s", field_name, exc)
        return {**default_return, "reason": f"Search error: {exc}"}

    total = search_results["total_occurrences"]
    exact = search_results["exact_count"]
    occurrences = search_results["occurrences"]

    for occ in occurrences:
        logger.debug(
            "OCR occurrence — field:'%s' page:%s match:%s score:%s invoice:%s",
            field_name,
            occ["page"],
            occ["match_type"],
            occ["score"],
            occ["is_invoice_section"],
        )

    # Value too short to search meaningfully (e.g. single-character gender code).
    if search_results.get("note") == "value_too_short_to_search":
        logger.info("OCR searcher — field:'%s' occurrences:0 verdict:UNCERTAIN (value too short)", field_name)
        return {
            "verdict": "UNCERTAIN",
            "reason": "Value is too short to search reliably in the OCR markdown.",
            "occurrence_count": 0,
            "search_results": search_results,
            "llm_called": False,
            "llm_error": False,
        }

    # FAST PATH — value not found anywhere: OCR limitation, no LLM needed.
    if total == 0:
        logger.info("OCR searcher — field:'%s' occurrences:0 verdict:OCR_LIMITATION", field_name)
        return {
            "verdict": "OCR_LIMITATION",
            "reason": (
                f"The value '{golden_value}' was not found in the OCR markdown after exact and "
                f"fuzzy search across {search_results['pages_searched']} page(s). "
                "The OCR engine likely did not extract this value."
            ),
            "occurrence_count": 0,
            "search_results": search_results,
            "llm_called": False,
            "llm_error": False,
        }

    # FAST PATH — value appears too many times to diagnose (common numbers, codes).
    # Uses the raw find count (pre-dedup) so values repeated across a document,
    # e.g. "6.48" in several totals rows, are caught even when deduplication
    # collapses same-context hits.
    raw_count = exact + search_results["fuzzy_count"]
    if raw_count > OCR_SEARCH_COMMON_VALUE_LIMIT:
        logger.info(
            "OCR searcher — field:'%s' occurrences:%s verdict:UNCERTAIN (too common)", field_name, raw_count
        )
        return {
            "verdict": "UNCERTAIN",
            "reason": (
                f"The value appears {raw_count} times across the OCR markdown, which is too common "
                "to attribute to a specific field."
            ),
            "occurrence_count": raw_count,
            "search_results": search_results,
            "note": "value_too_common_for_diagnosis",
            "llm_called": False,
            "llm_error": False,
        }

    client = _get_openai_client()

    if client is None:
        invoice_occurrences = [o for o in occurrences if o["is_invoice_section"]]
        if invoice_occurrences:
            verdict = "PROMPT_PROBLEM"
            reason = (
                f"Value found {total} time(s) in OCR markdown, in invoice section context. "
                "LLM judge unavailable for confirmation."
            )
        else:
            verdict = "UNCERTAIN"
            reason = (
                f"Value found {total} time(s) but LLM judge unavailable to determine if the "
                "context is correct."
            )
        logger.info("OCR searcher — field:'%s' occurrences:%s verdict:%s (no LLM)", field_name, total, verdict)
        return {
            "verdict": verdict,
            "reason": reason,
            "occurrence_count": total,
            "search_results": search_results,
            "llm_called": False,
            "llm_error": False,
        }

    top_occurrences = sorted(
        occurrences,
        key=lambda x: (x["is_invoice_section"], x["score"]),
        reverse=True,
    )[:3]

    contexts_text = ""
    for index, occ in enumerate(top_occurrences, start=1):
        page_label = f"Page {occ['page']}"
        match_label = f"{occ['match_type']} match ({occ['score']}%)"
        invoice_label = "invoice section" if occ["is_invoice_section"] else "other section"
        contexts_text += (
            f"\nOccurrence {index} — {page_label}, {match_label}, {invoice_label}:\n"
            f"{occ['context']}\n"
            f"{'—' * 40}"
        )

    field_desc = FIELD_DESCRIPTIONS.get(field_name, f"a field named {field_name} in the document")

    system_prompt = (
        "You are evaluating a document extraction system.\n"
        "Your job: determine if a field value was present in\n"
        "the OCR-extracted document text.\n\n"
        "Reply with exactly one of these verdicts on the first line:\n"
        "PROMPT_PROBLEM — the value is present in correct context,\n"
        "  the extraction system failed to capture it\n"
        "OCR_LIMITATION — the value is not present in correct context,\n"
        "  OCR did not extract it from the document\n"
        "UNCERTAIN — cannot determine with confidence\n\n"
        "On the second line: one sentence explaining why.\n"
        "Write nothing else."
    )
    user_prompt = (
        f"Field: {field_name}\n"
        f"Description: {field_desc}\n"
        f"Expected value: {golden_value}\n"
        f"Total occurrences found in OCR text: {total} (exact: {exact})\n\n"
        f"Contexts where the value was found:\n{contexts_text}\n\n"
        "Is the expected value present in the OCR text in the correct "
        "context for this field?"
    )

    model_name = _judge_provider_config()[1]

    try:
        response = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            max_completion_tokens=150,
            temperature=0,
        )

        raw = (response.choices[0].message.content or "").strip()
        lines = raw.split("\n", 1)
        first_line = lines[0].strip().upper()
        reason = lines[1].strip() if len(lines) > 1 else "No reason provided"

        if "PROMPT_PROBLEM" in first_line:
            verdict = "PROMPT_PROBLEM"
        elif "OCR_LIMITATION" in first_line:
            verdict = "OCR_LIMITATION"
        else:
            verdict = "UNCERTAIN"
            reason = f"Unexpected LLM response: {raw}"

        logger.info(
            "OCR searcher — field:'%s' occurrences:%s verdict:%s reason:%s",
            field_name,
            total,
            verdict,
            reason,
        )

        return {
            "verdict": verdict,
            "reason": reason,
            "occurrence_count": total,
            "exact_count": exact,
            "search_results": {
                "pages_searched": search_results["pages_searched"],
                "total_occurrences": total,
                "occurrences_summary": [
                    {
                        "page": o["page"],
                        "match_type": o["match_type"],
                        "score": o["score"],
                        "is_invoice_section": o["is_invoice_section"],
                    }
                    for o in occurrences
                ],
            },
            "llm_called": True,
            "llm_error": False,
        }

    except Exception as exc:
        logger.error(
            "OCR searcher LLM call failed for '%s': %s: %s",
            field_name,
            type(exc).__name__,
            str(exc),
        )
        invoice_hits = sum(1 for o in occurrences if o["is_invoice_section"])
        if exact >= 1 and invoice_hits >= 1:
            fallback_verdict = "PROMPT_PROBLEM"
            fallback_reason = (
                f"Value found exactly {exact} time(s) in invoice section. LLM confirmation failed."
            )
        elif total >= 1:
            fallback_verdict = "UNCERTAIN"
            fallback_reason = f"Value found {total} time(s) but LLM confirmation failed: {exc}"
        else:
            fallback_verdict = "OCR_LIMITATION"
            fallback_reason = f"Value not found in OCR. LLM confirmation also failed: {exc}"

        return {
            "verdict": fallback_verdict,
            "reason": fallback_reason,
            "occurrence_count": total,
            "search_results": search_results,
            "llm_called": True,
            "llm_error": True,
        }
