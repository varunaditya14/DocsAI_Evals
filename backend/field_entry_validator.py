"""Validation and type inference helpers for UI-entered golden fields."""

from __future__ import annotations

import re
from typing import Any


FIELD_NAME_PATTERN = re.compile(r"^[a-z][a-zA-Z0-9]*$")
FIELD_NAME_ERROR = (
    "Field names must be camelCase "
    "(e.g. invoiceNo, dateOfBirth, totalAmount)"
)


def validate_field_name(name: str) -> dict[str, bool | str | None]:
    """Validate that a field name is lower camelCase without separators or symbols."""
    candidate = "" if name is None else str(name).strip()
    if FIELD_NAME_PATTERN.fullmatch(candidate):
        return {"valid": True, "error": None}
    return {"valid": False, "error": FIELD_NAME_ERROR}


def infer_field_type(field_name: str) -> str:
    """Infer a comparison type from a field name using stable keyword rules."""
    normalized = str(field_name or "").lower()
    date_markers = ("date", "dob", "expiry", "expiration", "issued", "birth", "issue")
    numeric_markers = (
        "amount",
        "total",
        "price",
        "fee",
        "cost",
        "gst",
        "tax",
        "quantity",
        "weight",
        "rate",
        "score",
        "confidence",
        "count",
    )
    if any(marker in normalized for marker in date_markers):
        return "date"
    if any(marker in normalized for marker in numeric_markers):
        return "numeric"
    return "text"


def sanitize_field_value(value: Any) -> str:
    """Return a string value with leading and trailing whitespace removed."""
    if value is None:
        return ""
    return str(value).strip()
