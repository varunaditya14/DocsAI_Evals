"""Application configuration loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv


load_dotenv()


@dataclass(frozen=True)
class Settings:
    """Runtime settings sourced exclusively from environment variables."""

    docsai_base_url: str
    docsai_client_id: str
    docsai_auth_email: str
    docsai_token_expiry_minutes: int
    azure_openai_endpoint: str
    azure_openai_region: str
    azure_openai_deployment: str
    azure_openai_api_version: str
    azure_openai_api_key: str
    """Optional. Lets the LLM judge authenticate to Azure OpenAI with an API key
    instead of Azure AD (DefaultAzureCredential)."""
    azure_auth_method: str
    openai_api_key: str
    """Optional. LLM judge falls back to public OpenAI with this key when Azure is not key-configured."""
    openai_model: str
    gds_path: str
    """Deprecated: only used by the unused golden_loader module. Optional, defaults to empty string."""
    results_path: str

    @property
    def azure_openai_configured(self) -> bool:
        """Return True when Azure OpenAI has the minimum config needed for judging."""
        return bool(
            self.azure_openai_endpoint
            and self.azure_openai_deployment
            and self.azure_openai_api_version
        )

    @property
    def azure_openai_key_configured(self) -> bool:
        """Return True when the LLM judge can reach Azure OpenAI via an API key."""
        return bool(self.azure_openai_api_key and self.azure_openai_configured)

    @property
    def llm_judge_configured(self) -> bool:
        """Return True when the LLM judge can authenticate via Azure OpenAI or public OpenAI."""
        return bool(self.azure_openai_key_configured or self.openai_api_key)


def _required_env(name: str) -> str:
    """Return a required environment value or raise a clear configuration error."""
    value = os.getenv(name)
    if value is None or value.strip() == "":
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def _optional_env(name: str) -> str:
    """Return an optional environment value or an empty string."""
    return os.getenv(name, "").strip()


def _required_int_env(name: str) -> int:
    """Return a required integer environment value or raise a clear error."""
    value = _required_env(name)
    try:
        return int(value)
    except ValueError as exc:
        raise RuntimeError(f"Environment variable {name} must be an integer.") from exc


def get_settings() -> Settings:
    """Build and return application settings from the current environment."""
    return Settings(
        docsai_base_url=_required_env("DOCSAI_BASE_URL").rstrip("/"),
        docsai_client_id=_required_env("DOCSAI_CLIENT_ID"),
        docsai_auth_email=_required_env("DOCSAI_AUTH_EMAIL"),
        docsai_token_expiry_minutes=_required_int_env("DOCSAI_TOKEN_EXPIRY_MINUTES"),
        azure_openai_endpoint=_optional_env("AZURE_OPENAI_ENDPOINT").rstrip("/"),
        azure_openai_region=_optional_env("AZURE_OPENAI_REGION"),
        azure_openai_deployment=_optional_env("AZURE_OPENAI_DEPLOYMENT"),
        azure_openai_api_version=_optional_env("AZURE_OPENAI_API_VERSION"),
        azure_openai_api_key=_optional_env("AZURE_OPENAI_API_KEY"),
        azure_auth_method=_optional_env("AZURE_AUTH_METHOD") or "default_credential",
        openai_api_key=_optional_env("OPENAI_API_KEY"),
        openai_model=_optional_env("OPENAI_MODEL") or "gpt-4-1106-preview",
        gds_path=_optional_env("GDS_PATH"),
        results_path=_required_env("RESULTS_PATH"),
    )
