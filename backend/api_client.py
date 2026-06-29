"""DocsAI API client functions."""

from __future__ import annotations

import json
import logging
from typing import Any

import requests

from backend.auth import clear_cached_token, get_bearer_token
from backend.cleaner import clean_ocr_markdown
from backend.config import get_settings
from backend.normalizer import normalize_keys_to_camel


OCR_STEP_TYPE = "convert_text_from_document_using_mistral_ocr"
DOCUMENT_TYPE_KEYS = {
    "tax_invoice": ("taxInvoice",),
    "purchase_order": ("purchaseOrder",),
    "proforma_invoice": ("proformaInvoice",),
}
EXTRACTION_DOCUMENT_KEYS = (
    "taxInvoice",
    "purchaseOrder",
    "proformaInvoice",
)
LLM_EVAL_FIELD_KEYS = (
    "clientId",
    "billTo",
    "deliveryTo",
    "invoiceNo",
    "date",
    "poNo",
    "terms",
    "sales",
    "rqNo",
)

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


def _normalize_document_type(document_type: str) -> str:
    """Normalize a document type label to the DocsAI extracted-data key format."""
    normalized = document_type.strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "taxinvoice": "tax_invoice",
        "purchaseorder": "purchase_order",
        "proformainvoice": "proforma_invoice",
    }
    return aliases.get(normalized, normalized)


def _document_values_from_mapping(value: Any) -> dict[str, Any]:
    """Return a mapping that may directly contain document extraction keys."""
    mapping = normalize_keys_to_camel(_coerce_mapping(value))
    extracted_data = _coerce_mapping(mapping.get("extractedData"))
    return normalize_keys_to_camel(extracted_data) if extracted_data else mapping


def _contains_extraction_document_key(value: Any) -> bool:
    """Return True when a value contains any supported document extraction key."""
    mapping = _document_values_from_mapping(value)
    return any(key in mapping for key in EXTRACTION_DOCUMENT_KEYS)


def _stringify_field_value(value: Any) -> str:
    """Convert a field value to a stable string without crashing on nested values."""
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def extract_ocr_fields(llm_output: Any, document_type: str) -> dict[str, Any]:
    """Extract and flatten OCR fields for the requested document type."""
    if llm_output is None:
        logger.warning("LLM output is missing; OCR fields will be empty.")
        return {}

    extracted_data = _document_values_from_mapping(llm_output)
    document_keys = DOCUMENT_TYPE_KEYS.get(_normalize_document_type(document_type), ("taxInvoice",))
    invoices = None
    for document_key in document_keys:
        invoices = extracted_data.get(document_key)
        if invoices is not None:
            break

    if not isinstance(invoices, list) or not invoices:
        logger.warning("No OCR extracted_data found for document type: %s", document_type)
        return {}

    if len(invoices) > 1:
        logger.warning("Multiple OCR records found for document type %s; using the first.", document_type)

    try:
        first_invoice = invoices[0]
    except (IndexError, TypeError) as exc:
        logger.warning("Unable to read first OCR record for document type %s: %s", document_type, exc)
        return {}

    if not isinstance(first_invoice, dict):
        logger.warning("OCR extracted_data first item was not an object for document type: %s", document_type)
        return {}

    return {
        key: _stringify_field_value(first_invoice.get(key, ""))
        for key in LLM_EVAL_FIELD_KEYS
    }


def extract_llm_line_items(llm_output: Any, document_type: str) -> list[dict[str, Any]]:
    """Extract line items from the first DocsAI LLM document record."""
    if llm_output is None:
        return []

    extracted_data = _document_values_from_mapping(llm_output)
    document_keys = DOCUMENT_TYPE_KEYS.get(_normalize_document_type(document_type), ("taxInvoice",))
    invoices = None
    for document_key in document_keys:
        invoices = extracted_data.get(document_key)
        if invoices is not None:
            break

    if not isinstance(invoices, list) or not invoices or not isinstance(invoices[0], dict):
        return []

    # TODO: line items comparison next version.
    line_items = invoices[0].get("lineItems")
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


def _find_llm_output(steps: list[Any]) -> Any:
    """Find the first LLM extraction output that contains a supported document key."""
    for step in steps:
        if not isinstance(step, dict) or step.get("stepType") != "call_llm":
            continue
        step_id = str(step.get("stepId", ""))
        if "extract-fields" not in step_id:
            continue
        output_data = _get_output_data(step)
        llm_response = output_data.get("llm_response")
        if _contains_extraction_document_key(llm_response):
            return llm_response

    for step in steps:
        if not isinstance(step, dict) or step.get("stepType") != "call_llm":
            continue
        output_data = _get_output_data(step)
        llm_response = output_data.get("llm_response")
        if _contains_extraction_document_key(llm_response):
            return llm_response
    logger.warning("LLM extraction step not found; continuing without llm_output.")
    return None


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
    """Return the first supported document key detected in LLM output."""
    mapping = _document_values_from_mapping(llm_output)
    for key in EXTRACTION_DOCUMENT_KEYS:
        if key in mapping:
            return key
    return ""


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
    llm_output = _find_llm_output(steps)

    return {"ocr_markdown": ocr_markdown, "llm_output": llm_output, "run_id": run_id}


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
    llm_output = _find_llm_output(steps)
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
    }
    if include_markdown_preview:
        result["ocr_markdown_preview"] = clean_ocr_markdown(ocr_markdown)[:500]
    if include_json_preview and llm_output is not None:
        result["llm_json_preview"] = _trim_json_preview(_document_values_from_mapping(llm_output))
    return result
