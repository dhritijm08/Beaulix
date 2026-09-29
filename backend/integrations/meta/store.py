"""Server-side storage for Meta platform connections.

Reuses the existing `users/{uid}/platformConnections/{platform}` Firestore
location the Phase 1 data model (frontend/performance/model.js) already
defined. firestore.rules already denies ALL client read AND write on that
path — only the Admin SDK used here can touch it — so this module does not
need (and does not make) any change to firestore.rules.

The OAuth access token lives in the same document, under `credentials`.
`to_safe_dict()` is the ONLY function that turns a stored connection into
something an API response can return, and it always strips `credentials` —
so even though the whole document is already unreadable by any client per
the security rules, the token can never leak through this module by
accident (e.g. a future endpoint that forgets to filter fields).
"""
import json
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, Optional

_lock = threading.Lock()
_client = None

# Every field a client is allowed to see. `credentials` is deliberately
# absent — see module docstring.
_SAFE_FIELDS = (
    "connectionId", "brandId", "platform", "accountId", "accountName",
    "status", "lastSyncedAt", "createdAt", "updatedAt",
)


def _get_client():
    """Lazily create the Firestore Admin client on first use (not at import
    time — importing this module must never require credentials or touch
    the network, so server.py can import the whole integration safely even
    in environments where Meta/Firestore admin isn't configured yet)."""
    global _client
    if _client is not None:
        return _client
    with _lock:
        if _client is not None:
            return _client
        import firebase_admin
        from firebase_admin import credentials, firestore

        if not firebase_admin._apps:
            # Same GOOGLE_SERVICE_ACCOUNT_JSON convention backend/download_data.py
            # already uses (full JSON key in an env var — see .env.example).
            sa_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
            cred_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
            if sa_json:
                cred = credentials.Certificate(json.loads(sa_json))
                firebase_admin.initialize_app(cred)
            elif cred_path:
                cred = credentials.Certificate(cred_path)
                firebase_admin.initialize_app(cred)
            else:
                # Application Default Credentials — works unmodified on a
                # GCP-hosted runtime; fails loudly and clearly elsewhere.
                firebase_admin.initialize_app()
        _client = firestore.client()
        return _client


def _doc(uid: str):
    return (
        _get_client()
        .collection("users").document(uid)
        .collection("platformConnections").document("meta")
    )


def get_connection(uid: str) -> Optional[Dict[str, Any]]:
    snap = _doc(uid).get()
    return snap.to_dict() if snap.exists else None


def save_connection(uid: str, fields: Dict[str, Any]) -> None:
    """Merge-writes `fields` into the connection doc, stamping updatedAt
    (and createdAt on first write)."""
    now = datetime.now(timezone.utc).isoformat()
    payload = dict(fields)
    payload["updatedAt"] = now
    payload.setdefault("createdAt", now)
    _doc(uid).set(payload, merge=True)


def delete_connection(uid: str) -> None:
    _doc(uid).delete()


def to_safe_dict(doc: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The one place a stored connection is turned into API-response shape.
    Always call this rather than returning a stored doc directly."""
    if not doc:
        return {
            "connected": False, "platform": "meta", "connectionId": None,
            "brandId": None, "accountId": None, "accountName": None,
            "status": None, "lastSyncedAt": None, "createdAt": None, "updatedAt": None,
        }
    safe = {field: doc.get(field) for field in _SAFE_FIELDS}
    safe["connected"] = doc.get("status") == "active"
    return safe
