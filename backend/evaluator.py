"""Field-level evaluation routines for DocsAI extraction output."""

from __future__ import annotations

import logging
import re
from typing import Any

from azure.identity import DefaultAzureCredential, get_bearer_token_provider
from openai import AzureOpenAI
from rapidfuzz import fuzz

from backend.config import get_settings
from backend.field_entry_validator import sanitize_field_value


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


def run_field_comparison(
    golden_fields: dict[str, Any],
    extracted_fields: dict[str, Any],
    field_types: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Compare user-entered golden fields against DocsAI extracted fields."""
    results: dict[str, dict[str, Any]] = {}

    for field, golden_value in golden_fields.items():
        golden_val = sanitize_field_value(golden_value)
        extracted_val = sanitize_field_value(extracted_fields.get(field, ""))
        field_type = _field_type_for(field, field_types)
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

        results[field] = {
            "status": status,
            "golden_value": golden_val,
            "extracted_value": extracted_val,
            "score": score,
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
            "extracted_value": sanitize_field_value(extracted_value),
            "score": None,
            "field_type": _field_type_for(field, field_types),
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


def llm_ocr_searcher(field_name: str, golden_value: str, ocr_markdown: str) -> dict[str, Any]:
    """Diagnose whether a failed field is a prompt problem or OCR limitation."""
    try:
        normalized_markdown = sanitize_field_value(ocr_markdown)
        normalized_value = sanitize_field_value(golden_value)
        occurrence_count, contexts = _exact_occurrence_contexts(normalized_markdown, normalized_value)

        if occurrence_count == 0:
            fuzzy_count, fuzzy_contexts = _fuzzy_token_contexts(normalized_markdown, normalized_value)
            occurrence_count = fuzzy_count
            contexts = fuzzy_contexts

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
