"""Phase 2A HTTP surface: Meta Ads account connection.

    GET  /integrations/meta/connect     -> {"authorizeUrl": "..."}
    GET  /integrations/meta/callback    -> 302 redirect back to the frontend
    GET  /integrations/meta/status      -> safe connection metadata
    POST /integrations/meta/disconnect  -> {"disconnected": true}

Every endpoint except the Meta-initiated callback requires the
authenticated Firebase user via require_firebase_user, imported from
server.py rather than duplicated — see docs/meta-integration.md for why
/connect returns JSON instead of a redirect (a plain browser navigation
can't carry the Authorization header this needs).
"""
import asyncio
import logging
import os
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from server import executor, limiter, require_firebase_user

from . import client as meta_client
from . import oauth as meta_oauth
from . import store as meta_store
from .models import MetaConnectionStatus

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/integrations/meta", tags=["meta-integration"])

# Where the frontend's Performance page lives, relative to BEAULIX_FRONTEND_URL.
_RETURN_PATH = os.getenv("META_FRONTEND_RETURN_PATH", "/performance.html")


def _frontend_return_url(**query) -> str:
    base = os.getenv("BEAULIX_FRONTEND_URL", "").rstrip("/")
    qs = urlencode(query)
    if not base:
        # Local-dev-only fallback — server.py already refuses to start in
        # production (BEAULIX_ENV=production) without BEAULIX_FRONTEND_URL.
        return f"{_RETURN_PATH}?{qs}"
    return f"{base}{_RETURN_PATH}?{qs}"


@router.get("/connect")
@limiter.limit("10/minute")
async def connect(request: Request, uid: str = Depends(require_firebase_user)):
    if not meta_client.is_configured():
        raise HTTPException(status_code=503, detail="Meta integration is not configured on this server.")
    try:
        url = meta_oauth.build_connect_url(uid)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"authorizeUrl": url}


@router.get("/callback")
@limiter.limit("20/minute")
async def callback(request: Request):
    params = dict(request.query_params)
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(executor, meta_oauth.handle_callback, params)
    except meta_oauth.MetaConnectError as exc:
        logger.info("Meta connect failed: reason=%s", exc.reason)
        return RedirectResponse(_frontend_return_url(meta="error", reason=exc.reason))
    except Exception:  # noqa: BLE001 — any unexpected failure must not leak details to the browser
        logger.error("Unexpected error in Meta callback", exc_info=True)
        return RedirectResponse(_frontend_return_url(meta="error", reason="server_error"))
    return RedirectResponse(_frontend_return_url(meta="connected"))


@router.get("/status", response_model=MetaConnectionStatus)
async def status(uid: str = Depends(require_firebase_user)):
    loop = asyncio.get_running_loop()
    doc = await loop.run_in_executor(executor, meta_store.get_connection, uid)
    return meta_store.to_safe_dict(doc)


@router.post("/disconnect")
@limiter.limit("10/minute")
async def disconnect(request: Request, uid: str = Depends(require_firebase_user)):
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(executor, meta_oauth.disconnect, uid)
    return {"disconnected": True}
