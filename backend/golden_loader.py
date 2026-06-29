"""Golden dataset loader."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from backend.cleaner import clean_ocr_markdown
from backend.normalizer import normalize_keys_to_camel


logger = logging.getLogger(__name__)
DOCUMENT_TYPE_KEYS = {
    "tax_invoice": ("taxInvoice",),
    "purchase_order": ("purchaseOrder",),
    "proforma_invoice": ("proformaInvoice",),
}
SUPPORTED_DOCUMENT_KEYS = {
    key for keys in DOCUMENT_TYPE_KEYS.values() for key in keys
}
TAX_INVOICE_FIELD_TYPES = {
    "clientId": "text",
    "billTo": "text",
    "deliveryTo": "text",
    "invoiceNo": "text",
    "date": "date",
    "poNo": "text",
    "terms": "text",
    "sales": "text",
    "rqNo": "text",
}
EVAL_FIELD_KEYS = (
    "clientId",
    "billTo",
    "deliveryTo",
    "invoiceNo",
    "date",
    "poNo",
    "terms",
    "sales",
    "rqNo",
    "lineItems"
)


def _normalize_document_type(document_type: str) -> str:
    """Normalize a document type label to the GDS key lookup format."""
    normalized = document_type.strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "taxinvoice": "tax_invoice",
        "purchaseorder": "purchase_order",
        "proformainvoice": "proforma_invoice",
    }
    return aliases.get(normalized, normalized)


def _document_keys_for(document_type: str) -> tuple[str, ...]:
    """Return camelCase-first document keys for a document type."""
    return DOCUMENT_TYPE_KEYS.get(_normalize_document_type(document_type), ())


def get_gds_path() -> str:
    """Return the configured GDS path or raise a clear error."""
    gds_path = os.getenv("GDS_PATH", "").strip()
    if not gds_path:
        raise RuntimeError("GDS_PATH is not configured.")
    return gds_path


def get_gds_storage_dir() -> str:
    """Return the directory where uploaded golden dataset files are retained."""
    gds_path = os.path.abspath(get_gds_path())
    if os.path.isdir(gds_path):
        return gds_path
    parent_dir = os.path.dirname(gds_path) or os.getcwd()
    return os.path.join(parent_dir, "golden_datasets")


def _golden_file_paths() -> list[str]:
    """Return configured and uploaded golden dataset paths newest-first."""
    gds_path = os.path.abspath(get_gds_path())
    storage_dir = os.path.abspath(get_gds_storage_dir())
    paths: list[str] = []

    if os.path.isdir(storage_dir):
        uploaded_paths = [
            os.path.join(storage_dir, name)
            for name in os.listdir(storage_dir)
            if name.lower().endswith((".json", ".jsonl"))
        ]
        uploaded_paths.sort(key=lambda path: os.path.getmtime(path), reverse=True)
        paths.extend(uploaded_paths)

    if os.path.isfile(gds_path) and gds_path not in paths:
        paths.append(gds_path)

    return paths


def _load_golden_file(path: str) -> list[dict[str, Any]]:
    """Load records from a single golden dataset JSON or JSONL file."""
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            raw_text = handle.read()
    except OSError as exc:
        raise RuntimeError(f"Unable to read golden dataset file: {path}") from exc

    if not raw_text.strip():
        return []

    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError:
        records: list[dict[str, Any]] = []
        for line_number, line in enumerate(raw_text.splitlines(), start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    f"Invalid JSON in golden dataset {path} at line {line_number}."
                ) from exc
            if not isinstance(record, dict):
                raise RuntimeError(
                    f"Golden dataset {path} line {line_number} must be a JSON object."
                )
            records.append(record)
        return records

    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        raise RuntimeError(
            f"Golden dataset file must contain a JSON array of records: {path}"
        )

    records = []
    for index, record in enumerate(data):
        if not isinstance(record, dict):
            raise RuntimeError(
                f"Golden dataset {path} entry at index {index} must be a JSON object."
            )
        records.append(record)
    return records


def infer_document_type(record: dict[str, Any]) -> str:
    """Infer a document type from the first supported document key in a record.

    Checks the configured ``jsonOutput`` object for the first supported
    camelCase document array.
    """
    normalized_record = normalize_keys_to_camel(record)
    json_output = normalized_record.get("jsonOutput")
    if isinstance(json_output, dict):
        for normalized_type, keys in DOCUMENT_TYPE_KEYS.items():
            for key in keys:
                value = json_output.get(key)
                if isinstance(value, list) and value:
                    return normalized_type

    return ""


def _first_document_record(record: dict[str, Any], document_type: str) -> dict[str, Any]:
    """Return the first document object from a GDS record for a document type.

    Reads the configured camelCase ``jsonOutput`` object and returns the first
    document entry for the requested document type.
    """
    normalized_record = normalize_keys_to_camel(record)
    document_keys = _document_keys_for(document_type)
    if not document_keys:
        inferred_type = infer_document_type(normalized_record)
        document_keys = _document_keys_for(inferred_type)

    json_output = normalized_record.get("jsonOutput")
    if isinstance(json_output, dict):
        for document_key in document_keys:
            value = json_output.get(document_key)
            if isinstance(value, list) and value:
                first_item = value[0]
                return first_item if isinstance(first_item, dict) else {}
            if isinstance(value, dict):
                return value

    logger.warning("No GDS expected fields found for document type: %s", document_type)
    return {}


def _available_filenames(records: list[dict[str, Any]]) -> list[str]:
    """Return available filenames from loaded GDS records."""
    filenames: list[str] = []
    seen: set[str] = set()
    for record in records:
        filename = str(record.get("filename", "")).strip()
        normalized_filename = filename.lower()
        if not filename or normalized_filename in seen:
            continue
        filenames.append(filename)
        seen.add(normalized_filename)
    return filenames


def load_all_golden() -> list[dict[str, Any]]:
    """Load all golden records from every retained golden dataset file."""
    paths = _golden_file_paths()
    if not paths:
        return []

    records: list[dict[str, Any]] = []
    for path in paths:
        try:
            file_records = _load_golden_file(path)
        except RuntimeError as exc:
            logger.warning("Skipping golden dataset file %s: %s", path, exc)
            continue
        for record in file_records:
            record["_gds_source_file"] = path
            records.append(record)
    return records


def load_golden_by_filename(filename: str) -> dict[str, Any] | None:
    """Find and return the golden dataset record matching a normalized filename."""
    try:
        records = load_all_golden()
    except RuntimeError as exc:
        logger.warning("Unable to load golden dataset while finding filename %s: %s", filename, exc)
        return None

    normalized_filename = filename.strip().lower()
    for record in records:
        record_filename = str(record.get("filename", "")).strip().lower()
        if record_filename == normalized_filename:
            return record

    logger.warning(
        "Golden filename not found: %s. Available filenames: %s",
        filename,
        _available_filenames(records),
    )
    return None


def get_available_filenames() -> list[str]:
    """Return all filenames currently available in the GDS file."""
    try:
        return _available_filenames(load_all_golden())
    except RuntimeError as exc:
        logger.warning("Unable to list golden dataset filenames: %s", exc)
        return []


def get_reference_markdown(record: dict[str, Any]) -> str:
    """Return cleaned golden markdown from a GDS record."""
    normalized_record = normalize_keys_to_camel(record)
    markdown = normalized_record.get("ocrMarkdown", "")
    return clean_ocr_markdown(str(markdown) if markdown is not None else "")


def get_expected_fields_from_record(record: dict[str, Any], document_type: str) -> dict[str, Any]:
    """Return top-level expected GDS fields for a document type."""
    document_record = normalize_keys_to_camel(_first_document_record(record, document_type))
    if not document_record:
        logger.warning("No GDS expected fields found for document type: %s", document_type)
        return {}
    return {
        key: ("" if document_record.get(key) is None else document_record.get(key, ""))
        for key in EVAL_FIELD_KEYS
    }


def get_field_types_from_record(record: dict[str, Any], document_type: str) -> dict[str, str]:
    """Return camelCase field type mapping for the document type."""
    return TAX_INVOICE_FIELD_TYPES.copy()


def get_expected_line_items(record: dict[str, Any], document_type: str) -> list[dict[str, Any]]:
    """Return expected line items from the first GDS document record."""
    document_record = normalize_keys_to_camel(_first_document_record(record, document_type))
    line_items = document_record.get("lineItems") if document_record else None
    # TODO: line items eval not implemented yet.
    if not isinstance(line_items, list):
        return []
    return [item for item in line_items if isinstance(item, dict)]


def startup_check() -> None:
    """Log GDS availability and filenames during application startup."""
    try:
        records = load_all_golden()
    except RuntimeError as exc:
        logger.warning("Golden dataset startup check skipped: %s", exc)
        return
    logger.info("Golden dataset loaded successfully with %s records.", len(records))
    logger.info("Golden dataset filenames: %s", _available_filenames(records))
