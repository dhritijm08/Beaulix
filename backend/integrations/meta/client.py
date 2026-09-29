"""Thin synchronous wrapper around the Meta Graph API's OAuth and
ad-account-list endpoints.

Scope is deliberately narrow (Phase 2A): authorize-URL construction, the
code -> short-lived -> long-lived token exchange, reading which ad accounts
the connected user can access, and best-effort permission revocation on
disconnect. No campaign, ad set, ad, or insights endpoint is called from
here — that is Phase 2B.

All calls are blocking (`requests`, already a Beaulix dependency) — callers
run them in a thread pool (see routers/routes.py) rather than the event
loop, the same pattern server.py already uses for the ML prediction calls.
"""
import os
from urllib.parse import urlencode

import requests

# Pin explicitly rather than track Meta's "latest" — see docs/meta-integration.md
# for the upgrade policy. v26.0 was the current Graph API version as of
# September 2026; bump via META_GRAPH_API_VERSION without a code change.
GRAPH_API_VERSION = os.getenv("META_GRAPH_API_VERSION", "v26.0")
GRAPH_BASE = f"https://graph.facebook.com/{GRAPH_API_VERSION}"
AUTHORIZE_URL = f"https://www.facebook.com/{GRAPH_API_VERSION}/dialog/oauth"

# Least-privilege: Phase 2A only ever reads which ad accounts a user can
# access. `ads_management` (needed to create/modify campaigns) is
# intentionally NOT requested — add it only when Phase 2B actually needs it.
OAUTH_SCOPES = "ads_read"

_TIMEOUT = 15  # seconds


class MetaAPIError(Exception):
    """Raised for any non-2xx, malformed, or Meta-error-shaped response."""

    def __init__(self, message, meta_error=None):
        super().__init__(message)
        self.meta_error = meta_error


def _app_id() -> str:
    v = os.getenv("META_APP_ID", "")
    if not v:
        raise RuntimeError("META_APP_ID is not configured.")
    return v


def _app_secret() -> str:
    v = os.getenv("META_APP_SECRET", "")
    if not v:
        raise RuntimeError("META_APP_SECRET is not configured.")
    return v


def _redirect_uri() -> str:
    v = os.getenv("META_REDIRECT_URI", "")
    if not v:
        raise RuntimeError("META_REDIRECT_URI is not configured.")
    return v


def is_configured() -> bool:
    """True once all three required Meta app credentials are set. Endpoints
    use this to fail with a clean 503 instead of a raw RuntimeError."""
    return bool(os.getenv("META_APP_ID") and os.getenv("META_APP_SECRET") and os.getenv("META_REDIRECT_URI"))


def build_authorize_url(state: str) -> str:
    params = {
        "client_id": _app_id(),
        "redirect_uri": _redirect_uri(),
        "state": state,
        "response_type": "code",
        "scope": OAUTH_SCOPES,
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def _get(path: str, params: dict) -> dict:
    resp = requests.get(f"{GRAPH_BASE}{path}", params=params, timeout=_TIMEOUT)
    try:
        data = resp.json()
    except ValueError as exc:
        raise MetaAPIError(f"Meta returned a non-JSON response ({resp.status_code}).") from exc
    if resp.status_code >= 400 or (isinstance(data, dict) and "error" in data):
        err = data.get("error") if isinstance(data, dict) else None
        raise MetaAPIError(
            (err or {}).get("message", f"Meta API error ({resp.status_code})"),
            meta_error=err,
        )
    return data


def exchange_code_for_token(code: str) -> dict:
    """Authorization code -> short-lived (~1-2h) user access token."""
    data = _get("/oauth/access_token", {
        "client_id": _app_id(),
        "redirect_uri": _redirect_uri(),
        "client_secret": _app_secret(),
        "code": code,
    })
    if "access_token" not in data:
        raise MetaAPIError("Meta response did not include an access_token.")
    return data


def exchange_for_long_lived_token(short_lived_token: str) -> dict:
    """Short-lived token -> long-lived (~60 day) token. Run immediately
    after exchange_code_for_token so nothing short-lived is ever persisted."""
    data = _get("/oauth/access_token", {
        "grant_type": "fb_exchange_token",
        "client_id": _app_id(),
        "client_secret": _app_secret(),
        "fb_exchange_token": short_lived_token,
    })
    if "access_token" not in data:
        raise MetaAPIError("Meta response did not include a long-lived access_token.")
    return data


def fetch_ad_accounts(access_token: str) -> list:
    """Ad accounts the connected user can access. Read-only — `ads_read` is
    sufficient; no write/management call is made here."""
    data = _get("/me/adaccounts", {
        "fields": "id,account_id,name",
        "access_token": access_token,
    })
    return data.get("data", []) or []


def revoke(access_token: str) -> bool:
    """Best-effort revocation of every permission the user granted this app.
    Returns True on a confirmed revoke, False if Meta couldn't be reached or
    already treats the token as invalid. Callers should delete the local
    connection record either way — that's what actually stops Beaulix from
    using the token, independent of whether Meta's revoke call succeeds."""
    try:
        resp = requests.delete(
            f"{GRAPH_BASE}/me/permissions",
            params={"access_token": access_token},
            timeout=_TIMEOUT,
        )
        data = resp.json()
        return bool(isinstance(data, dict) and data.get("success"))
    except Exception:
        return False
