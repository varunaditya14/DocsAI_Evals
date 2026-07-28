"""Validation and type inference helpers for UI-entered golden fields."""

from __future__ import annotations

import logging
import re
from typing import Any


logger = logging.getLogger(__name__)

FIELD_NAME_PATTERN = re.compile(r"^[a-z][a-zA-Z0-9]*$")
FIELD_NAME_ERROR = (
    "Field names must be camelCase "
    "(e.g. invoiceNo, dateOfBirth, totalAmount)"
)

# Placeholder values that never count as a real number, regardless of field name.
_NUMERIC_TEXT_OVERRIDE_VALUES = {"-", "—", "n/a", "nil", "none"}
# Currency symbols/codes allowed to precede a number without disqualifying it.
_CURRENCY_TOKEN_PATTERN = re.compile(r"^([£$€₹¥]|SGD|RM|USD|EUR|GBP)", re.IGNORECASE)
_CURRENCY_STRIP_PATTERN = re.compile(r"[£$€₹¥]|SGD|RM|USD|EUR|GBP", re.IGNORECASE)
_MONTH_ABBREVIATIONS = (
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
)


def validate_field_name(name: str) -> dict[str, bool | str | None]:
    """Validate that a field name is lower camelCase without separators or symbols."""
    candidate = "" if name is None else str(name).strip()
    if FIELD_NAME_PATTERN.fullmatch(candidate):
        return {"valid": True, "error": None}
    return {"valid": False, "error": FIELD_NAME_ERROR}


def infer_field_type(field_name: str, value: str = "") -> str:
    """
    Infer a comparison type ("numeric", "date", or "text") for a field.

    The type is first guessed from the field name using stable keyword
    rules, then verified against the actual value: a name-based guess of
    "numeric" or "date" is downgraded to "text" when the value doesn't
    actually look like a number or a date (empty, a placeholder like
    "N/A", a long sentence, etc.), so comparisons don't try to parse
    values that were never going to be numbers or dates.
    """
    normalized_name = str(field_name or "").lower()
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

    if any(marker in normalized_name for marker in date_markers):
        inferred = "date"
    elif any(marker in normalized_name for marker in numeric_markers):
        inferred = "numeric"
    else:
        return "text"

    normalized_value = str(value or "").strip()

    if inferred == "numeric":
        if normalized_value == "" or normalized_value.lower() in _NUMERIC_TEXT_OVERRIDE_VALUES:
            return "text"
        if normalized_value[0].isalpha() and not _CURRENCY_TOKEN_PATTERN.match(normalized_value):
            logger.warning(
                "Field type override: %s inferred as numeric from name but value %r is not numeric; using text.",
                field_name,
                normalized_value,
            )
            return "text"
        cleaned = _CURRENCY_STRIP_PATTERN.sub("", normalized_value).replace(",", "").strip()
        try:
            float(cleaned)
        except ValueError:
            logger.warning(
                "Field type override: %s inferred as numeric from name but value %r could not be parsed; using text.",
                field_name,
                normalized_value,
            )
            return "text"
        return "numeric"

    # inferred == "date"
    if normalized_value == "" or len(normalized_value) > 30:
        if normalized_value:
            logger.warning(
                "Field type override: %s inferred as date from name but value %r is too long; using text.",
                field_name,
                normalized_value,
            )
        return "text"
    leading_letters = re.match(r"^[A-Za-z]+", normalized_value)
    if leading_letters:
        starts_with_month = leading_letters.group(0)[:3].lower() in _MONTH_ABBREVIATIONS
        has_separator = "/" in normalized_value or "-" in normalized_value
        if not starts_with_month and not has_separator:
            logger.warning(
                "Field type override: %s inferred as date from name but value %r doesn't look like a date; using text.",
                field_name,
                normalized_value,
            )
            return "text"
    return "date"


def sanitize_field_value(value: Any) -> str:
    """Return a string value with leading and trailing whitespace removed."""
    if value is None:
        return ""
    return str(value).strip()
