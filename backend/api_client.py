"""DocsAI API client functions."""

from __future__ import annotations

import json
import logging
from typing import Any

import requests

from backend.auth import clear_cached_token, get_bearer_token
from backend.cleaner import clean_ocr_markdown
from backend.config import get_settings
from backend.normalizer import normalize_keys_to_camel, to_camel_case


OCR_STEP_TYPE = "convert_text_from_document_using_mistral_ocr"
# Envelope/metadata keys that are never a document type. Document-type keys
# (taxInvoice, purchaseOrder, proformaInvoice, ...) are deliberately NOT listed
# here: extract_ocr_fields_by_doctype returns every one of them so each can be
# evaluated against its own golden fields.
SKIP_EXTRACTION_KEYS = {
    "extractionConfidence",
    "documentType",
    "success",
}
# Legacy single-doctype extraction (extract_ocr_fields) historically returned
# only the first document list and ignored these. Kept so that flat, un-grouped
# golden fields keep scoring exactly as they did before.
LEGACY_SINGLE_DOCTYPE_SKIP_KEYS = SKIP_EXTRACTION_KEYS | {
    "purchaseOrder",
    "proformaInvoice",
}
CLASSIFICATION_KEYS = {
    "fileId",
    "detectedFormType",
    "isValidCategory",
    "classificationTimestamp",
    "classificationDuration",
    "headerPattern",
    "validationReason",
    "confidence",
    "originalFilename",
    "fileType",
}

logger = logging.getLogger(__name__)


def _get_output_data(step: dict[str, Any]) -> dict[str, Any]:
    """Return outputData from a step, tolerating absent or malformed values."""
    output_data = step.get("outputData")
    return output_data if isinstance(output_data, dict) else {}


def _request_with_auth_retry(method: str, url: str, **kwargs: Any) -> requests.Response:
    """Make a DocsAI API request, refreshing auth and retrying once on HTTP 401."""
    token = get_bearer_token()
    headers = dict(kwargs.pop("headers", {}) or {})
    headers["Authorization"] = f"Bearer {token}"

    response = requests.request(method, url, headers=headers, **kwargs)
    if response.status_code != 401:
        return response

    clear_cached_token()
    token = get_bearer_token()
    headers["Authorization"] = f"Bearer {token}"
    retry_response = requests.request(method, url, headers=headers, **kwargs)
    if retry_response.status_code == 401:
        raise RuntimeError("DocsAI API returned HTTP 401 after refreshing the auth token.")
    return retry_response


def _coerce_mapping(value: Any) -> dict[str, Any]:
    """Convert supported mapping-like values to a dictionary."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _document_values_from_mapping(value: Any) -> dict[str, Any]:
    """Return a mapping that may directly contain document extraction keys."""
    mapping = normalize_keys_to_camel(_coerce_mapping(value))
    extracted_data = _coerce_mapping(mapping.get("extractedData"))
    return normalize_keys_to_camel(extracted_data) if extracted_data else mapping


def _is_classification_record(value: Any) -> bool:
    """Return True when a list item looks like classification metadata."""
    normalized_value = normalize_keys_to_camel(value)
    if not isinstance(normalized_value, dict):
        return False
    return bool(set(normalized_value) & CLASSIFICATION_KEYS)


def _first_non_empty_document_list(
    value: Any,
    skip_keys: set[str] | None = None,
) -> tuple[str, list[Any]]:
    """Return the first non-classification document list from a DocsAI payload."""
    skip = LEGACY_SINGLE_DOCTYPE_SKIP_KEYS if skip_keys is None else skip_keys
    mapping = _document_values_from_mapping(value)
    for key, item in mapping.items():
        if key in skip or key == "lineItems":
            continue
        if isinstance(item, list) and item:
            if _is_classification_record(item[0]):
                continue
            return str(key), item
        if isinstance(item, dict):
            nested_key, nested_items = _first_non_empty_document_list(item, skip)
            if nested_items:
                return nested_key, nested_items
    return "", []


def _all_document_lists(value: Any) -> dict[str, list[Any]]:
    """Return every document-type list in a DocsAI payload, keyed by doctype.

    Unlike _first_non_empty_document_list this does not stop at the first match
    and does not skip purchaseOrder/proformaInvoice, so each document type can
    be compared against its own golden fields.
    """
    mapping = _document_values_from_mapping(value)
    documents: dict[str, list[Any]] = {}
    for key, item in mapping.items():
        if key in SKIP_EXTRACTION_KEYS or key == "lineItems":
            continue
        if isinstance(item, list):
            if item and _is_classification_record(item[0]):
                continue
            documents[str(key)] = item
        elif isinstance(item, dict):
            for nested_key, nested_items in _all_document_lists(item).items():
                documents.setdefault(nested_key, nested_items)
    return documents


def _contains_extraction_document_key(value: Any) -> bool:
    """Return True when a value contains at least one document extraction list."""
    return bool(_first_non_empty_document_list(value)[1])


def _stringify_field_value(value: Any) -> str:
    """Convert a field value to a stable string without crashing on nested values."""
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def _flatten_field_name_value_list(items: list[Any]) -> dict[str, Any]:
    """Convert a fieldName/value list into a flat camelCase field dictionary."""
    fields: dict[str, Any] = {}
    for item in items:
        normalized_item = normalize_keys_to_camel(item)
        if not isinstance(normalized_item, dict) or "fieldName" not in normalized_item:
            continue
        field_name = str(normalized_item.get("fieldName") or "").strip()
        if not field_name:
            continue
        value = normalized_item.get("value", "")
        fields[to_camel_case(field_name)] = _stringify_field_value(value)
    return fields


def _fields_from_nested_extraction(extraction: dict[str, Any]) -> dict[str, Any]:
    """Return camelCase fields from a nested extraction.extractedFields payload."""
    extracted_fields = extraction.get("extractedFields")
    if not isinstance(extracted_fields, list) or not extracted_fields:
        return {}

    result: dict[str, Any] = {}
    for item in extracted_fields:
        if not isinstance(item, dict):
            continue
        field_key = item.get("fieldName") or item.get("field_name")
        if not field_key:
            normalized_item = normalize_keys_to_camel(item)
            field_key = normalized_item.get("fieldName")
            value = normalized_item.get("value")
        else:
            value = item.get("value")
        if not field_key:
            continue
        result[to_camel_case(str(field_key))] = _stringify_field_value(value)
    return result


def _has_nested_extraction_fields(llm_response: dict[str, Any]) -> bool:
    """Return True when a DocsAI response has extraction.extractedFields data."""
    normalized_response = normalize_keys_to_camel(llm_response)
    extraction = normalized_response.get("extraction")
    if not isinstance(extraction, dict):
        return False
    extracted_fields = extraction.get("extractedFields")
    return isinstance(extracted_fields, list) and bool(extracted_fields)


def _flat_fields_from_object(document_record: dict[str, Any]) -> dict[str, Any]:
    """Return stringified top-level fields from a document object."""
    return {
        key: _stringify_field_value(value)
        for key, value in document_record.items()
        if key != "lineItems"
    }


def _fields_from_document_records(document_key: str, records: list[Any]) -> dict[str, Any]:
    """Extract flat fields from a non-empty DocsAI document record list."""
    try:
        first_record = records[0]
    except (IndexError, TypeError) as exc:
        logger.warning("Unable to read first LLM record for document key %s: %s", document_key, exc)
        return {}

    if not isinstance(first_record, dict):
        logger.warning("LLM extracted_data first item was not an object for document key: %s", document_key)
        return {}

    normalized_record = normalize_keys_to_camel(first_record)
    if "fieldName" in normalized_record:
        logger.info("DocsAI field pattern: fieldName/value list")
        return _flatten_field_name_value_list(records)

    if len(records) > 1:
        logger.warning("Multiple LLM records found for document key %s; using the first.", document_key)

    logger.info("DocsAI field pattern: flat object")
    return _flat_fields_from_object(normalized_record)


def extract_ocr_fields(llm_output: Any, document_type: str) -> dict[str, Any]:
    """Extract LLM fields from nested extraction, flat objects, or fieldName/value lists."""
    del document_type
    if llm_output is None:
        logger.warning("LLM output is missing; OCR fields will be empty.")
        return {}

    normalized_output = normalize_keys_to_camel(_coerce_mapping(llm_output))
    extraction = normalized_output.get("extraction")
    if isinstance(extraction, dict):
        nested_fields = _fields_from_nested_extraction(extraction)
        if nested_fields:
            logger.info("DocsAI output pattern: nested extraction")
            return nested_fields

        document_key, records = _first_non_empty_document_list(extraction)
        if records:
            return _fields_from_document_records(document_key, records)

    logger.info("DocsAI output pattern: flat document list")
    document_key, records = _first_non_empty_document_list(normalized_output)
    if not records:
        logger.warning("No LLM document data found in DocsAI output.")
        return {}

    return _fields_from_document_records(document_key, records)


def _fields_from_document_record_with_tables(record: Any) -> dict[str, Any]:
    """Return one document record's fields, keeping nested row lists intact.

    _flat_fields_from_object drops lineItems because the legacy flat path
    compared scalars only. Per-doctype comparison needs the row lists too, so
    table-shaped values are passed through as lists of row dicts.
    """
    if not isinstance(record, dict):
        return {}
    normalized = normalize_keys_to_camel(record)
    fields: dict[str, Any] = {}
    for key, value in normalized.items():
        if isinstance(value, list) and value and all(isinstance(row, dict) for row in value):
            fields[key] = [
                {row_key: _stringify_field_value(row_value) for row_key, row_value in row.items()}
                for row in value
            ]
        elif isinstance(value, list):
            fields[key] = [_stringify_field_value(item) for item in value]
        else:
            fields[key] = _stringify_field_value(value)
    return fields


def extract_ocr_fields_by_doctype(llm_output: Any) -> dict[str, dict[str, Any]]:
    """Extract fields grouped by document type, e.g. {"taxInvoice": {...}, ...}.

    Each document type is returned separately so it can be scored against its
    own golden fields, instead of collapsing every doctype into one flat map
    where same-named fields (poNo, lineItems) would collide.
    """
    if llm_output is None:
        logger.warning("LLM output is missing; per-doctype OCR fields will be empty.")
        return {}

    normalized_output = normalize_keys_to_camel(_coerce_mapping(llm_output))
    search_root = normalized_output
    extraction = normalized_output.get("extraction")
    if isinstance(extraction, dict) and _all_document_lists(extraction):
        search_root = extraction

    documents = _all_document_lists(search_root)
    if not documents:
        logger.warning("No per-doctype LLM document data found in DocsAI output.")
        return {}

    grouped: dict[str, dict[str, Any]] = {}
    for doctype, records in documents.items():
        if not records:
            # Document type present but with no extracted record (e.g.
            # "proformaInvoice": []). Keep the key so a golden entry for it is
            # reported as missing rather than silently ignored.
            grouped[doctype] = {}
            continue
        if len(records) > 1:
            logger.warning("Multiple LLM records for document type %s; using the first.", doctype)
        grouped[doctype] = _fields_from_document_record_with_tables(records[0])
    return grouped


def extract_llm_line_items(llm_output: Any, document_type: str) -> list[dict[str, Any]]:
    """Extract line items dynamically from the first DocsAI LLM document record."""
    del document_type
    if llm_output is None:
        return []

    _document_key, records = _first_non_empty_document_list(llm_output)
    if not records or not isinstance(records[0], dict):
        return []

    # TODO: line items comparison next version.
    line_items = normalize_keys_to_camel(records[0]).get("lineItems")
    if not isinstance(line_items, list):
        return []
    return [item for item in line_items if isinstance(item, dict)]


def _find_ocr_step(steps: list[Any], run_id: str) -> dict[str, Any]:
    """Find the OCR step using stepType first, then markdown-content fallback."""
    for step in steps:
        if isinstance(step, dict) and step.get("stepType") == OCR_STEP_TYPE:
            return step
    for step in steps:
        if not isinstance(step, dict):
            continue
        output_data = _get_output_data(step)
        if "markdown_content" in output_data:
            return step
    raise RuntimeError(f"OCR step not found in run {run_id} steps")


def _extract_markdown_from_step(step: dict[str, Any], run_id: str) -> str:
    """Extract markdown text from an OCR step with raw text fallback."""
    output_data = _get_output_data(step)
    markdown = output_data.get("markdown_content")
    if not isinstance(markdown, str) or not markdown.strip():
        markdown = output_data.get("file_raw_text_content")
    if not isinstance(markdown, str) or not markdown.strip():
        raise RuntimeError(f"No markdown content found in OCR step for run {run_id}")
    return markdown


def _find_llm_output(steps: list[Any]) -> tuple[dict[str, Any] | None, str, str | None]:
    """Find the LLM extraction step output while avoiding classification steps.

    Priority 1: nested extraction.extractedFields structure (confidence: exact).
    Priority 2: extract step with flat document list, excluding classification
        metadata (confidence: heuristic).
    Priority 3: extract-fields step fallback with usable document data
        (confidence: heuristic).

    Returns a (llm_output, extraction_step_confidence, extraction_step_id) tuple.
    extraction_step_confidence is one of "exact", "heuristic", "not_found".
    """
    priority2: dict[str, Any] | None = None
    priority2_step_id: str | None = None
    priority3: dict[str, Any] | None = None
    priority3_step_id: str | None = None

    for step in steps:
        if not isinstance(step, dict) or step.get("stepType") != "call_llm":
            continue

        output_data = _get_output_data(step)
        llm_response = _coerce_mapping(output_data.get("llm_response"))
        if not llm_response:
            continue

        raw_step_id = str(step.get("stepId", ""))
        step_id = raw_step_id.lower()

        if _has_nested_extraction_fields(llm_response):
            return llm_response, "exact", raw_step_id

        if "extract" in step_id and priority2 is None and _contains_extraction_document_key(llm_response):
            priority2 = llm_response
            priority2_step_id = raw_step_id
        if "extract-fields" in step_id and priority3 is None and _contains_extraction_document_key(llm_response):
            priority3 = llm_response
            priority3_step_id = raw_step_id

    if priority2 is not None:
        logger.warning("LLM extraction step found via heuristic matching: %s", priority2_step_id)
        return priority2, "heuristic", priority2_step_id
    if priority3 is not None:
        logger.warning("LLM extraction step found via heuristic matching: %s", priority3_step_id)
        return priority3, "heuristic", priority3_step_id

    logger.warning("LLM extraction step not found; continuing without llm_output.")
    return None, "not_found", None


def _fetch_run_steps_payload(run_id: str) -> list[Any]:
    """Fetch DocsAI run steps payload using authenticated DocsAI API access."""
    settings = get_settings()
    url = (
        f"{settings.docsai_base_url}/api/v1/clients/"
        f"{settings.docsai_client_id}/runs/{run_id}/steps"
    )

    try:
        response = _request_with_auth_retry("GET", url, timeout=30)
        response.raise_for_status()
    except RuntimeError:
        raise
    except requests.RequestException as exc:
        status = getattr(exc.response, "status_code", "unknown")
        text = getattr(exc.response, "text", "")
        raise RuntimeError(f"fetch: Failed to fetch DocsAI run steps. Status: {status}. {text}") from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("DocsAI run steps response was not valid JSON.") from exc

    steps = payload.get("steps") if isinstance(payload, dict) else payload
    if not isinstance(steps, list):
        raise RuntimeError("DocsAI run steps response did not contain a steps list.")
    return steps


def _detected_document_key(llm_output: Any) -> str:
    """Return the first non-empty document key detected in LLM output."""
    return _first_non_empty_document_list(llm_output)[0]


def _trim_json_preview(value: Any, max_string_length: int = 160) -> Any:
    """Return a small JSON-safe preview by trimming long nested values."""
    if isinstance(value, dict):
        return {key: _trim_json_preview(nested, max_string_length) for key, nested in list(value.items())[:8]}
    if isinstance(value, list):
        return [_trim_json_preview(item, max_string_length) for item in value[:2]]
    if isinstance(value, str) and len(value) > max_string_length:
        return f"{value[:max_string_length]}..."
    return value


def get_run_steps(run_id: str) -> dict[str, Any]:
    """Fetch a run's steps and return OCR markdown, LLM output, and run ID."""
    steps = _fetch_run_steps_payload(run_id)

    ocr_step = _find_ocr_step(steps, run_id)
    ocr_markdown = _extract_markdown_from_step(ocr_step, run_id)
    llm_output, extraction_step_confidence, extraction_step_id = _find_llm_output(steps)

    return {
        "ocr_markdown": ocr_markdown,
        "llm_output": llm_output,
        "run_id": run_id,
        "extraction_step_confidence": extraction_step_confidence,
        "extraction_step_id": extraction_step_id,
    }


def get_run_steps_debug(
    run_id: str,
    include_markdown_preview: bool = False,
    include_json_preview: bool = False,
) -> dict[str, Any]:
    """Return a safe debug summary for DocsAI run step detection."""
    steps = _fetch_run_steps_payload(run_id)
    step_types = [
        str(step.get("stepType", "")) for step in steps if isinstance(step, dict) and step.get("stepType")
    ]
    ocr_step = _find_ocr_step(steps, run_id)
    ocr_markdown = _extract_markdown_from_step(ocr_step, run_id)
    llm_output, extraction_step_confidence, extraction_step_id = _find_llm_output(steps)
    detected_key = _detected_document_key(llm_output)

    result: dict[str, Any] = {
        "run_id": run_id,
        "docsai_fetch_ok": True,
        "total_steps": len(steps),
        "step_types": step_types,
        "ocr_step_found": True,
        "ocr_markdown_found": bool(ocr_markdown.strip()),
        "ocr_markdown_char_count": len(ocr_markdown),
        "llm_step_found": llm_output is not None,
        "llm_json_found": bool(detected_key),
        "detected_document_key": detected_key or None,
        "extraction_step_confidence": extraction_step_confidence,
        "extraction_step_id": extraction_step_id,
    }
    if include_markdown_preview:
        result["ocr_markdown_preview"] = clean_ocr_markdown(ocr_markdown)[:500]
    if include_json_preview and llm_output is not None:
        result["llm_json_preview"] = _trim_json_preview(_document_values_from_mapping(llm_output))
    return result
