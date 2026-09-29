"""Tests for the Phase 2A Meta Ads integration (backend/integrations/meta/).

No real Meta account or live Firestore is used anywhere here — Meta's HTTP
API is mocked via `requests`, Firestore via a small in-memory fake standing
in for `store._get_client()`, and Firebase ID-token verification via the
same google-auth patch test_firebase_auth.py uses. Run with:

    cd backend
    pytest test_meta_integration.py -v
"""
import os
import sys
import time
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

with patch("model.RecommendationModel", return_value=MagicMock()), patch("excel_cache.init"):
    from fastapi.testclient import TestClient
    import server

from integrations.meta import client as meta_client
from integrations.meta import oauth as meta_oauth
from integrations.meta import state as meta_state
from integrations.meta import store as meta_store

PROJECT = "test-project"
RAW_TOKEN = "SUPER-SECRET-RAW-TOKEN-VALUE"

client = TestClient(server.app)


# ── Shared fixtures ──────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _firebase_project(monkeypatch):
    monkeypatch.setattr(server, "_FIREBASE_PROJECT_ID", PROJECT)


@pytest.fixture(autouse=True)
def _meta_env(monkeypatch):
    monkeypatch.setenv("META_APP_ID", "123456")
    monkeypatch.setenv("META_APP_SECRET", "app-secret-value")
    monkeypatch.setenv("META_REDIRECT_URI", "https://backend.example.com/integrations/meta/callback")
    monkeypatch.setenv("META_OAUTH_STATE_SECRET", "state-signing-secret")
    monkeypatch.setenv("BEAULIX_FRONTEND_URL", "https://frontend.example.com")


class _FakeDoc:
    """Stands in for a Firestore DocumentReference, backed by a plain dict
    so tests never need a live Firestore project."""

    def __init__(self, store: dict, key: str):
        self._store = store
        self._key = key

    def get(self):
        snap = MagicMock()
        data = self._store.get(self._key)
        snap.exists = data is not None
        snap.to_dict.return_value = data
        return snap

    def set(self, payload, merge=False):
        current = self._store.get(self._key, {}) if merge else {}
        current = dict(current)
        current.update(payload)
        self._store[self._key] = current

    def delete(self):
        self._store.pop(self._key, None)


@pytest.fixture
def fake_firestore(monkeypatch):
    """Replaces store._get_client() with an in-memory fake — no firebase-admin
    initialisation, no network, no real Firestore project required."""
    backing = {}

    class _FakeCollection:
        def __init__(self, store):
            self._store = store

        def document(self, doc_id):
            return _FakeDocRef(self._store, doc_id)

    class _FakeDocRef:
        def __init__(self, store, uid):
            self._store = store
            self._uid = uid

        def collection(self, name):
            assert name == "platformConnections"
            return _FakeCollection2(self._store, self._uid)

    class _FakeCollection2:
        def __init__(self, store, uid):
            self._store = store
            self._uid = uid

        def document(self, doc_id):
            assert doc_id == "meta"
            return _FakeDoc(self._store, self._uid)

    fake_client = MagicMock()
    fake_client.collection.side_effect = lambda name: (
        _FakeCollection(backing) if name == "users" else MagicMock()
    )
    monkeypatch.setattr(meta_store, "_get_client", lambda: fake_client)
    return backing


def _claims(uid="uid-123", **over):
    c = {"sub": uid, "iss": f"https://securetoken.google.com/{PROJECT}",
         "aud": PROJECT, "exp": time.time() + 3600, "iat": time.time() - 10}
    c.update(over)
    return c


def _google_returns(claims):
    return patch("google.oauth2.id_token.verify_firebase_token", return_value=claims)


# ── state.py: signed CSRF state ──────────────────────────────────────────

def test_state_round_trips_uid():
    token = meta_state.create_oauth_state("uid-123")
    assert meta_state.verify_oauth_state(token) == "uid-123"


def test_state_rejects_tampered_uid():
    token = meta_state.create_oauth_state("uid-123")
    payload_b64, sig_b64 = token.split(".", 1)
    forged_payload = meta_state._b64encode(b"someone-elses-uid:nonce:9999999999")
    forged = f"{forged_payload}.{sig_b64}"
    with pytest.raises(ValueError):
        meta_state.verify_oauth_state(forged)


def test_state_rejects_expired():
    with patch("time.time", return_value=1_000_000):
        token = meta_state.create_oauth_state("uid-123")
    with patch("time.time", return_value=1_000_000 + 10_000):
        with pytest.raises(ValueError, match="expired"):
            meta_state.verify_oauth_state(token)


def test_state_rejects_garbage():
    with pytest.raises(ValueError):
        meta_state.verify_oauth_state("not-a-real-state")
    with pytest.raises(ValueError):
        meta_state.verify_oauth_state("")


# ── client.py: Meta Graph API wrapper (requests mocked) ──────────────────

def test_build_authorize_url_contains_expected_params():
    url = meta_client.build_authorize_url("some-state")
    assert url.startswith("https://www.facebook.com/")
    assert "client_id=123456" in url
    assert "state=some-state" in url
    assert "scope=ads_read" in url
    assert "ads_management" not in url  # least-privilege: never requested in Phase 2A


def test_exchange_code_for_token_success():
    with patch("requests.get") as mget:
        mget.return_value = MagicMock(status_code=200, json=lambda: {
            "access_token": "short-lived-abc", "token_type": "bearer", "expires_in": 5400,
        })
        result = meta_client.exchange_code_for_token("auth-code")
    assert result["access_token"] == "short-lived-abc"


def test_exchange_code_for_token_meta_error_raises():
    with patch("requests.get") as mget:
        mget.return_value = MagicMock(status_code=400, json=lambda: {
            "error": {"message": "Invalid verification code format.", "code": 100}
        })
        with pytest.raises(meta_client.MetaAPIError):
            meta_client.exchange_code_for_token("bad-code")


def test_fetch_ad_accounts_returns_list():
    with patch("requests.get") as mget:
        mget.return_value = MagicMock(status_code=200, json=lambda: {
            "data": [{"id": "act_1", "account_id": "1", "name": "Beaulix Ads"}]
        })
        accounts = meta_client.fetch_ad_accounts("token")
    assert accounts[0]["name"] == "Beaulix Ads"


def test_revoke_returns_false_on_network_error():
    with patch("requests.delete", side_effect=ConnectionError("boom")):
        assert meta_client.revoke("token") is False


# ── oauth.py: orchestration ───────────────────────────────────────────────

def test_handle_callback_denied():
    with pytest.raises(meta_oauth.MetaConnectError) as exc:
        meta_oauth.handle_callback({"error": "access_denied"})
    assert exc.value.reason == "denied"


def test_handle_callback_invalid_state():
    with pytest.raises(meta_oauth.MetaConnectError) as exc:
        meta_oauth.handle_callback({"code": "abc", "state": "garbage"})
    assert exc.value.reason == "invalid_state"


def test_handle_callback_cannot_associate_with_another_user(fake_firestore):
    """A state signed for uid A must never be redeemable to create/overwrite
    a connection for uid B, however the callback query string is built."""
    state = meta_state.create_oauth_state("uid-A")
    with patch.object(meta_client, "exchange_code_for_token",
                       return_value={"access_token": "short"}), \
         patch.object(meta_client, "exchange_for_long_lived_token",
                       return_value={"access_token": RAW_TOKEN, "expires_in": 5_184_000}), \
         patch.object(meta_client, "fetch_ad_accounts",
                       return_value=[{"id": "act_9", "account_id": "9", "name": "Acct"}]):
        uid = meta_oauth.handle_callback({"code": "abc", "state": state, "uid": "uid-B"})
    assert uid == "uid-A"
    assert meta_store.get_connection("uid-B") is None
    assert meta_store.get_connection("uid-A")["accountId"] == "9"


def test_handle_callback_no_ad_account():
    state = meta_state.create_oauth_state("uid-123")
    with patch.object(meta_client, "exchange_code_for_token", return_value={"access_token": "s"}), \
         patch.object(meta_client, "exchange_for_long_lived_token", return_value={"access_token": "l"}), \
         patch.object(meta_client, "fetch_ad_accounts", return_value=[]):
        with pytest.raises(meta_oauth.MetaConnectError) as exc:
            meta_oauth.handle_callback({"code": "abc", "state": state})
    assert exc.value.reason == "no_ad_account"


def test_disconnect_removes_connection_even_if_revoke_fails(fake_firestore):
    meta_store.save_connection("uid-123", {
        "connectionId": "c1", "brandId": "default", "platform": "meta",
        "accountId": "9", "accountName": "Acct", "status": "active",
        "credentials": {"accessToken": RAW_TOKEN},
    })
    with patch.object(meta_client, "revoke", return_value=False) as mrevoke:
        meta_oauth.disconnect("uid-123")
    mrevoke.assert_called_once_with(RAW_TOKEN)
    assert meta_store.get_connection("uid-123") is None


# ── routes.py: HTTP-level tests ───────────────────────────────────────────

def test_connect_unauthenticated_401():
    assert client.get("/integrations/meta/connect").status_code == 401


def test_connect_authenticated_returns_authorize_url():
    with _google_returns(_claims()):
        r = client.get("/integrations/meta/connect", headers={"Authorization": "Bearer tok"})
    assert r.status_code == 200
    assert r.json()["authorizeUrl"].startswith("https://www.facebook.com/")


def test_connect_not_configured_503(monkeypatch):
    monkeypatch.delenv("META_APP_ID", raising=False)
    with _google_returns(_claims()):
        r = client.get("/integrations/meta/connect", headers={"Authorization": "Bearer tok"})
    assert r.status_code == 503


def test_callback_invalid_state_redirects_with_error_reason():
    r = client.get(
        "/integrations/meta/callback", params={"code": "abc", "state": "garbage"},
        follow_redirects=False,
    )
    assert r.status_code in (302, 307)
    assert "meta=error" in r.headers["location"]
    assert "reason=invalid_state" in r.headers["location"]


def test_callback_cancellation_redirects_with_denied_reason():
    r = client.get(
        "/integrations/meta/callback", params={"error": "access_denied"}, follow_redirects=False,
    )
    assert "reason=denied" in r.headers["location"]


def test_callback_success_redirects_to_connected(fake_firestore):
    state = meta_state.create_oauth_state("uid-123")
    with patch.object(meta_client, "exchange_code_for_token", return_value={"access_token": "s"}), \
         patch.object(meta_client, "exchange_for_long_lived_token",
                       return_value={"access_token": RAW_TOKEN, "expires_in": 5_184_000}), \
         patch.object(meta_client, "fetch_ad_accounts",
                       return_value=[{"id": "act_9", "account_id": "9", "name": "Beaulix Ads"}]):
        r = client.get(
            "/integrations/meta/callback", params={"code": "abc", "state": state},
            follow_redirects=False,
        )
    assert "meta=connected" in r.headers["location"]


def test_status_unauthenticated_401():
    assert client.get("/integrations/meta/status").status_code == 401


def test_status_returns_safe_metadata_only(fake_firestore):
    meta_store.save_connection("uid-123", {
        "connectionId": "c1", "brandId": "default", "platform": "meta",
        "accountId": "9", "accountName": "Beaulix Ads", "status": "active",
        "lastSyncedAt": None,
        "credentials": {"accessToken": RAW_TOKEN, "tokenType": "bearer"},
    })
    with _google_returns(_claims()):
        r = client.get("/integrations/meta/status", headers={"Authorization": "Bearer tok"})
    body = r.json()
    assert body["connected"] is True
    assert body["accountName"] == "Beaulix Ads"
    assert "credentials" not in body
    assert RAW_TOKEN not in r.text


def test_status_no_connection_returns_disconnected(fake_firestore):
    with _google_returns(_claims()):
        r = client.get("/integrations/meta/status", headers={"Authorization": "Bearer tok"})
    assert r.json() == {
        "connected": False, "platform": "meta", "connectionId": None,
        "brandId": None, "accountId": None, "accountName": None,
        "status": None, "lastSyncedAt": None, "createdAt": None, "updatedAt": None,
    }


def test_disconnect_unauthenticated_401():
    assert client.post("/integrations/meta/disconnect").status_code == 401


def test_disconnect_removes_connection(fake_firestore):
    meta_store.save_connection("uid-123", {
        "connectionId": "c1", "brandId": "default", "platform": "meta",
        "accountId": "9", "accountName": "Beaulix Ads", "status": "active",
        "credentials": {"accessToken": RAW_TOKEN},
    })
    with patch.object(meta_client, "revoke", return_value=True):
        with _google_returns(_claims()):
            r = client.post("/integrations/meta/disconnect", headers={"Authorization": "Bearer tok"})
    assert r.status_code == 200
    assert r.json() == {"disconnected": True}
    assert meta_store.get_connection("uid-123") is None


def test_access_token_never_appears_in_any_frontend_response(fake_firestore):
    """Cross-cutting check across every route this phase adds."""
    meta_store.save_connection("uid-123", {
        "connectionId": "c1", "brandId": "default", "platform": "meta",
        "accountId": "9", "accountName": "Beaulix Ads", "status": "active",
        "credentials": {"accessToken": RAW_TOKEN},
    })
    with _google_returns(_claims()):
        r1 = client.get("/integrations/meta/connect", headers={"Authorization": "Bearer tok"})
        r2 = client.get("/integrations/meta/status", headers={"Authorization": "Bearer tok"})
    assert RAW_TOKEN not in r1.text
    assert RAW_TOKEN not in r2.text
