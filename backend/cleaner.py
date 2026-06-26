"""OCR markdown cleanup utilities."""

from __future__ import annotations

import html
import logging
import re


logger = logging.getLogger(__name__)
_HORIZONTAL_RULE_RE = re.compile(r"^\s*(---|\*\*\*|___)\s*$")
_EMPTY_EMPHASIS_RE = re.compile(r"^\s*(\*\*\s*\*\*|__\s*__|\*\s*\*|_\s*_)\s*$")
_BLANK_LINES_RE = re.compile(r"\n{3,}")


def clean_ocr_markdown(md: str | None) -> str:
    """Clean OCR markdown while preserving meaningful line content."""
    if md is None:
        logger.warning("OCR markdown input was None; returning empty string.")
        return ""
    if md == "":
        return ""

    cleaned = html.unescape(md).replace("\\n", "\n")
    kept_lines: list[str] = []

    for line in cleaned.splitlines():
        stripped_trailing = line.rstrip()
        if _HORIZONTAL_RULE_RE.match(stripped_trailing):
            continue
        if _EMPTY_EMPHASIS_RE.match(stripped_trailing):
            continue
        kept_lines.append(stripped_trailing)

    cleaned = "\n".join(kept_lines)
    cleaned = _BLANK_LINES_RE.sub("\n\n", cleaned)
    return cleaned.strip()
