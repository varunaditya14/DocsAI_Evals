"""DocsAI authentication helpers with in-memory token caching."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import time
from typing import Any

import requests

from backend.config import get_settings


_TOKEN: str | None = None
_TOKEN_EXPIRES_AT: datetime | None = None
_TOKEN_EXPIRY_BUFFER_SECONDS = 60
_TOKEN_FETCH_RETRY_DELAY_SECONDS = 2


def clear_cached_token() -> None:
    """Clear the cached DocsAI token so the next request fetches a fresh one."""
    global _TOKEN, _TOKEN_EXPIRES_AT

    _TOKEN = None
    _TOKEN_EXPIRES_AT = None


def _extract_token(payload: dict[str, Any]) -> str:
    """Extract a bearer token from common token response shapes."""
    token = (
        payload.get("token")
        or payload.get("access_token")
        or payload.get("bearer_token")
        or payload.get("data", {}).get("token")
        or payload.get("data", {}).get("access_token")
        or payload.get("data", {}).get("bearer_token")
    )
    if not isinstance(token, str) or not token.strip():
        raise RuntimeError("DocsAI auth response did not include a bearer token.")
    token = token.strip()
    if token.lower().startswith("bearer "):
        return token.split(" ", 1)[1].strip()
    return token.strip()


def _is_cached_token_valid() -> bool:
    """Return True when the cached token exists and is outside the expiry buffer."""
    return (
        _TOKEN is not None
        and _TOKEN_EXPIRES_AT is not None
        and datetime.now(timezone.utc) + timedelta(seconds=_TOKEN_EXPIRY_BUFFER_SECONDS)
        < _TOKEN_EXPIRES_AT
    )


def _fetch_token_once() -> tuple[str, int]:
    """Fetch one DocsAI token and return it with its configured expiry minutes."""
    settings = get_settings()
    url = f"{settings.docsai_base_url}/api/v1/auth/dev-token"
    body = {
        "email": settings.docsai_auth_email,
        "clientId": settings.docsai_client_id,
        "expires_in_minutes": settings.docsai_token_expiry_minutes,
    }

    try:
        response = requests.post(url, json=body, timeout=30)
        response.raise_for_status()
    except requests.RequestException as exc:
        status = getattr(exc.response, "status_code", "unknown")
        text = getattr(exc.response, "text", "")
        raise RuntimeError(f"Failed to fetch DocsAI auth token. Status: {status}. {text}") from exc

    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("DocsAI auth response was not valid JSON.") from exc

    return _extract_token(payload), settings.docsai_token_expiry_minutes


def get_bearer_token() -> str:
    """Return a valid DocsAI bearer token, refreshing it silently when needed."""
    global _TOKEN, _TOKEN_EXPIRES_AT

    if _is_cached_token_valid():
        return _TOKEN

    try:
        _TOKEN, expiry_minutes = _fetch_token_once()
    except RuntimeError as first_error:
        time.sleep(_TOKEN_FETCH_RETRY_DELAY_SECONDS)
        try:
            _TOKEN, expiry_minutes = _fetch_token_once()
        except RuntimeError as second_error:
            raise RuntimeError(f"DocsAI auth failed after retry: {second_error}") from first_error

    _TOKEN_EXPIRES_AT = datetime.now(timezone.utc) + timedelta(minutes=expiry_minutes)
    return _TOKEN
