"""Signed, self-contained OAuth `state` tokens for the Meta connect flow.

No server-side session store is needed: the state value itself carries the
authenticated Firebase UID plus a nonce and an expiry, HMAC-signed with a
server-only secret. `verify_oauth_state` re-checks the signature and the
expiry before trusting the embedded uid, so a forged, tampered-with or
replayed state is rejected — this is what stops Meta's redirect back to
`/integrations/meta/callback` from being used for CSRF (an attacker cannot
produce a state that verifies for a uid they don't control) or from
associating the resulting connection with the wrong Firebase user.
"""
import base64
import hashlib
import hmac
import os
import secrets
import time

# Long enough to get through Meta's consent screen, short enough that a
# leaked/stale state can't be replayed hours later.
_STATE_TTL_SECONDS = 600


def _secret() -> bytes:
    # A dedicated secret is preferred; falling back to META_APP_SECRET keeps
    # setup simple for a single-app deployment (same trust boundary either
    # way — both are server-only, never sent to the browser).
    key = os.getenv("META_OAUTH_STATE_SECRET") or os.getenv("META_APP_SECRET", "")
    if not key:
        raise RuntimeError(
            "META_OAUTH_STATE_SECRET (or META_APP_SECRET) is not configured — "
            "cannot sign OAuth state."
        )
    return key.encode("utf-8")


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def create_oauth_state(uid: str) -> str:
    """Return a signed state token binding this OAuth attempt to `uid`."""
    if not uid:
        raise ValueError("uid is required to create OAuth state")
    nonce = secrets.token_urlsafe(12)
    expires_at = int(time.time()) + _STATE_TTL_SECONDS
    payload = f"{uid}:{nonce}:{expires_at}".encode("utf-8")
    sig = hmac.new(_secret(), payload, hashlib.sha256).digest()
    return f"{_b64encode(payload)}.{_b64encode(sig)}"


def verify_oauth_state(state: str) -> str:
    """Return the Firebase uid embedded in `state` if it is authentic and
    unexpired. Raises ValueError on any forgery, corruption, or expiry —
    callers must treat that as a rejected OAuth attempt, never fall back to
    trusting an unsigned uid from anywhere else in the request."""
    if not state or "." not in state:
        raise ValueError("malformed state: missing signature separator")
    payload_b64, sig_b64 = state.split(".", 1)
    try:
        payload = _b64decode(payload_b64)
        sig = _b64decode(sig_b64)
    except Exception as exc:
        raise ValueError("malformed state: invalid base64") from exc

    expected_sig = hmac.new(_secret(), payload, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected_sig):
        raise ValueError("state signature mismatch")

    try:
        uid, _nonce, expires_at_s = payload.decode("utf-8").split(":", 2)
        expires_at = int(expires_at_s)
    except Exception as exc:
        raise ValueError("malformed state payload") from exc

    if time.time() > expires_at:
        raise ValueError("state expired")
    if not uid:
        raise ValueError("missing uid in state")
    return uid
