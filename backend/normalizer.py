"""Shared key normalization helpers for DocsAI eval inputs."""

from __future__ import annotations

from typing import Any


def to_camel_case(key: str) -> str:
    """Convert snake_case or PascalCase keys to lower camelCase."""
    if "_" in key:
        parts = [part for part in key.strip("_").split("_") if part]
        if not parts:
            return key
        return parts[0].lower() + "".join(part[:1].upper() + part[1:] for part in parts[1:])
    return key[:1].lower() + key[1:] if key else key


def _should_replace(existing_value: Any, new_value: Any) -> bool:
    """Return True when a normalized key collision should keep the new value."""
    if existing_value in (None, "", [], {}):
        return new_value not in (None, "", [], {})
    return False


def _merge_normalized_dicts(existing: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """Merge normalized dictionaries without replacing useful values with empty ones."""
    merged = dict(existing)
    for key, value in new.items():
        if key not in merged:
            merged[key] = value
        elif isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _merge_normalized_dicts(merged[key], value)
        elif _should_replace(merged[key], value):
            merged[key] = value
    return merged


def normalize_keys_to_camel(value: Any) -> Any:
    """Recursively normalize dictionary keys to lower camelCase."""
    if isinstance(value, list):
        return [normalize_keys_to_camel(item) for item in value]
    if not isinstance(value, dict):
        return value

    normalized: dict[str, Any] = {}
    for raw_key, raw_value in value.items():
        normalized_key = to_camel_case(str(raw_key))
        normalized_value = normalize_keys_to_camel(raw_value)

        if normalized_key not in normalized:
            normalized[normalized_key] = normalized_value
            continue

        existing_value = normalized[normalized_key]
        if isinstance(existing_value, dict) and isinstance(normalized_value, dict):
            normalized[normalized_key] = _merge_normalized_dicts(existing_value, normalized_value)
        elif _should_replace(existing_value, normalized_value):
            normalized[normalized_key] = normalized_value

    return normalized
