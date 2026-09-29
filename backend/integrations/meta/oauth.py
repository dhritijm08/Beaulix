"""Phase 2A orchestration: connect / callback / disconnect for Meta Ads.

Deliberately thin — all Meta HTTP calls live in client.py, all storage in
store.py, all CSRF state handling in state.py. This module just wires them
together in the order the OAuth flow needs.
"""
import logging
import uuid
from datetime import datetime, timedelta, timezone

from . import client as meta_client
from . import state as meta_state
from . import store as meta_store

logger = logging.getLogger(__name__)

# Matches DEFAULT_BRAND_ID in frontend/performance/model.js — every existing
# account has exactly one implicit brand until multi-brand support exists.
DEFAULT_BRAND_ID = "default"


class MetaConnectError(Exception):
    """A user-facing OAuth failure (bad state, denied consent, no ad
    account, or a Meta API error). `reason` is a short machine-readable
    code safe to put in a redirect query string — never the raw Meta error
    text or anything token-derived."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def build_connect_url(uid: str) -> str:
    if not meta_client.is_configured():
        raise RuntimeError("Meta integration is not configured on this server.")
    state = meta_state.create_oauth_state(uid)
    return meta_client.build_authorize_url(state)


def handle_callback(query_params: dict) -> str:
    """Run the full code -> token -> ad-account exchange for an inbound
    Meta redirect and persist the resulting connection.

    Returns the Firebase uid the connection now belongs to (taken only from
    the verified `state`, never from anything else in the query string —
    this is what stops the callback from being used to attach a connection
    to the wrong Firebase user). Raises MetaConnectError on any failure.
    """
    if query_params.get("error"):
        raise MetaConnectError("denied", "User denied or cancelled the Meta authorization request.")

    code = query_params.get("code", "")
    state = query_params.get("state", "")
    if not code:
        raise MetaConnectError("missing_code", "Meta callback did not include an authorization code.")

    try:
        uid = meta_state.verify_oauth_state(state)
    except ValueError as exc:
        logger.info("Meta OAuth state rejected: %s", exc)
        raise MetaConnectError("invalid_state", "OAuth state validation failed.") from exc

    try:
        short_lived = meta_client.exchange_code_for_token(code)
        long_lived = meta_client.exchange_for_long_lived_token(short_lived["access_token"])
        accounts = meta_client.fetch_ad_accounts(long_lived["access_token"])
    except meta_client.MetaAPIError as exc:
        logger.warning("Meta API error during connect for uid=%s: %s", uid, exc)
        raise MetaConnectError("meta_api_error", str(exc)) from exc

    if not accounts:
        raise MetaConnectError("no_ad_account", "No Meta ad account is accessible to this user.")

    # Phase 2A auto-selects the first accessible ad account. A picker for
    # users with more than one is explicitly Phase 2B scope — see
    # docs/meta-integration.md "How Phase 2B will build on this".
    account = accounts[0]

    expires_at = None
    expires_in = long_lived.get("expires_in")
    if isinstance(expires_in, (int, float)):
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()

    existing = meta_store.get_connection(uid) or {}
    meta_store.save_connection(uid, {
        "connectionId": existing.get("connectionId") or f"conn_{uuid.uuid4().hex[:16]}",
        "brandId": existing.get("brandId") or DEFAULT_BRAND_ID,
        "platform": "meta",
        "accountId": str(account.get("account_id") or account.get("id")),
        "accountName": account.get("name"),
        "status": "active",
        "lastSyncedAt": None,
        "credentials": {
            "accessToken": long_lived["access_token"],
            "tokenType": long_lived.get("token_type", "bearer"),
            "expiresAt": expires_at,
        },
    })
    return uid


def disconnect(uid: str) -> None:
    """Best-effort revoke on Meta, then always remove the local record —
    the local delete is what actually stops Beaulix from using the token,
    so it must not be skipped just because the Meta-side revoke failed."""
    existing = meta_store.get_connection(uid)
    if existing:
        token = (existing.get("credentials") or {}).get("accessToken")
        if token:
            meta_client.revoke(token)
    meta_store.delete_connection(uid)
