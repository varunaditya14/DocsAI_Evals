# DEPRECATED — no longer used. Kept for reference only.
"""Golden dataset loader."""

from __future__ import annotations

import json
import logging
import os
from typing import Any

from backend.cleaner import clean_ocr_markdown
from backend.normalizer import normalize_keys_to_camel, to_camel_case


logger = logging.getLogger(__name__)


GDS_METADATA_KEYS = {
    "documentType",
    "extractionConfidence",
    "extractedData",
    "processingTimestamp",
    "processedBy",
    "service",
    "aiBackend",
    "modelUsed",
    "usageInfo",
    "confidenceScore",
    "source",
}


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
    """Infer a document type from the first non-empty GDS document array."""
    normalized_record = normalize_keys_to_camel(record)
    json_output = normalized_record.get("jsonOutput")
    if isinstance(json_output, dict):
        for key, value in json_output.items():
            if isinstance(value, list) and value:
                return str(key)

    return ""


def _first_document_value(record: dict[str, Any], document_type: str) -> Any:
    """Return document data from GDS jsonOutput while skipping metadata objects."""
    del document_type
    normalized_record = normalize_keys_to_camel(record)
    json_output = normalized_record.get("jsonOutput")
    if isinstance(json_output, dict):
        extracted_fields = json_output.get("extractedFields")
        if isinstance(extracted_fields, list) and extracted_fields:
            return normalize_keys_to_camel(extracted_fields)

        for document_key, value in json_output.items():
            if document_key in GDS_METADATA_KEYS or document_key == "extractedFields":
                continue
            if isinstance(value, list) and value:
                return normalize_keys_to_camel(value)

        for document_key, value in json_output.items():
            if document_key in GDS_METADATA_KEYS or document_key == "extractedFields":
                continue
            if isinstance(value, dict):
                return normalize_keys_to_camel(value)

        data_fields = {
            key: value
            for key, value in json_output.items()
            if key not in GDS_METADATA_KEYS and key != "extractedFields"
        }
        if data_fields:
            return normalize_keys_to_camel(data_fields)

    logger.warning(
        "No GDS document data found for filename: %s",
        normalized_record.get("filename", "<unknown>"),
    )
    return {}


def _first_document_record(record: dict[str, Any], document_type: str) -> dict[str, Any]:
    """Return the first flat document object from GDS data."""
    document_value = _first_document_value(record, document_type)
    if isinstance(document_value, list) and document_value:
        first_item = document_value[0]
        return first_item if isinstance(first_item, dict) else {}
    return document_value if isinstance(document_value, dict) else {}


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
        fields[to_camel_case(field_name)] = "" if value is None else str(value).strip()
    return fields


def _flat_fields_from_object(document_record: dict[str, Any]) -> dict[str, Any]:
    """Return flat top-level fields from a document object."""
    return {
        key: ("" if value is None else value)
        for key, value in document_record.items()
        if key != "lineItems" and key not in GDS_METADATA_KEYS
    }


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
    """Return expected GDS fields from extractedFields lists or flat document objects."""
    normalized_record = normalize_keys_to_camel(record)
    json_output = normalized_record.get("jsonOutput")
    if isinstance(json_output, dict):
        extracted_fields = json_output.get("extractedFields")
        if isinstance(extracted_fields, list) and extracted_fields:
            logger.info("GDS field pattern: extractedFields list")
            return _flatten_field_name_value_list(extracted_fields)

    document_value = _first_document_value(record, document_type)
    if not document_value:
        logger.warning(
            "No GDS expected fields found for filename: %s",
            normalized_record.get("filename", "<unknown>"),
        )
        return {}

    if isinstance(document_value, list) and document_value:
        first_item = normalize_keys_to_camel(document_value[0])
        if isinstance(first_item, dict) and "fieldName" in first_item:
            logger.info("GDS field pattern: extractedFields list")
            return _flatten_field_name_value_list(document_value)
        if isinstance(first_item, dict):
            logger.info("GDS field pattern: flat document list")
            return _flat_fields_from_object(first_item)

    if isinstance(document_value, dict):
        extracted_fields = document_value.get("extractedFields")
        if isinstance(extracted_fields, list) and extracted_fields:
            first_item = normalize_keys_to_camel(extracted_fields[0])
            if isinstance(first_item, dict) and "fieldName" in first_item:
                logger.info("GDS field pattern: extractedFields list")
                return _flatten_field_name_value_list(extracted_fields)
        logger.info("GDS field pattern: flat document list")
        return _flat_fields_from_object(document_value)

    logger.warning("No usable GDS field pattern found for document type: %s", document_type)
    return {}


def get_field_types_from_record(
    record: dict[str, Any],
    document_type: str,
    fields: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Infer field types from an already-flattened field dict when provided."""
    expected_fields = fields if fields is not None else get_expected_fields_from_record(record, document_type)
    date_terms = ("date", "dob", "expiry", "issued", "birth")
    numeric_terms = ("amount", "total", "price", "fee", "cost", "gst", "tax")
    field_types: dict[str, str] = {}
    for field_name in expected_fields:
        normalized_name = field_name.lower()
        if any(term in normalized_name for term in date_terms):
            field_types[field_name] = "date"
        elif any(term in normalized_name for term in numeric_terms):
            field_types[field_name] = "numeric"
        else:
            field_types[field_name] = "text"
    return field_types


def get_expected_line_items(record: dict[str, Any], document_type: str) -> list[dict[str, Any]]:
    """Return expected line items from the first non-empty GDS document list."""
    document_record = _first_document_record(record, document_type)
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
