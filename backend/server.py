# server.py
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, field_validator
from typing import ClassVar, Optional
import uvicorn
import os
import logging
import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

logger = logging.getLogger(__name__)

from model import RecommendationModel, DATASET_PATH
from copy_engine import get_ad_copy as _get_ad_copy_standalone
from image_category import classify_category_from_image_url as _classify_category_from_image_url

# ── Rate limiter ───────────────────────────────────────────────────────
limiter = Limiter(key_func=get_remote_address)

# ── Environment flags (must be defined before any reference below) ─────
import sys as _sys

_frontend_url  = os.getenv("BEAULIX_FRONTEND_URL", "")
_raw_env       = os.getenv("BEAULIX_ENV", "")
_VALID_ENV_VALUES = {"", "production", "development", "staging", "test"}
if _raw_env.lower() not in _VALID_ENV_VALUES:
    _sys.stderr.write(
        f"FATAL: BEAULIX_ENV='{_raw_env}' is not a recognised value.\n"
        f"Valid values: {sorted(_VALID_ENV_VALUES)!r}\n"
        "Typos like 'Productoin' silently fall through to dev mode — refusing to start.\n"
    )
    _sys.exit(1)
_is_production = _raw_env.lower() == "production"

# ── API key auth ───────────────────────────────────────────────────────
_API_KEY_HEADER = APIKeyHeader(name="X-Beaulix-API-Key", auto_error=False)
_EXPECTED_KEY   = os.getenv("BEAULIX_API_KEY", "")   # set in environment

if not _EXPECTED_KEY and _is_production:
    _sys.stderr.write(
        "FATAL: BEAULIX_API_KEY is not set in production.\n"
        "All prediction endpoints would be publicly accessible without authentication.\n"
        "Set this environment variable before starting the server.\n"
    )
    _sys.exit(1)


def require_api_key(key: str = Depends(_API_KEY_HEADER)):
    """FastAPI dependency — rejects requests with a missing or wrong API key."""
    if not _EXPECTED_KEY:
        # Key not configured in env: skip check so dev/local runs work out-of-box.
        # ⚠️  WARNING: this means ALL prediction endpoints are publicly accessible.
        # In production this is prevented by the startup check above.
        return
    if key != _EXPECTED_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Beaulix-API-Key")

# ── Firebase ID-token auth (browser-facing routes) ─────────────────────
# The browser authenticates with its Firebase Auth ID token
# (Authorization: Bearer <token>). No shared secret ever reaches the browser.
# Verification uses the already-pinned google-auth package and Google's public
# signing certs — no service-account secret or firebase-admin needed.
_FIREBASE_PROJECT_ID = os.getenv("BEAULIX_FIREBASE_PROJECT_ID", "")


def _firebase_config_error(project_id: str, is_production: bool):
    """Return a fatal-config message, or None if the configuration is acceptable."""
    if not project_id and is_production:
        return (
            "FATAL: BEAULIX_FIREBASE_PROJECT_ID is not set in production.\n"
            "Browser-facing endpoints cannot verify Firebase ID tokens without it.\n"
            "Set it to your Firebase project id before starting the server.\n"
        )
    return None


_fb_cfg_err = _firebase_config_error(_FIREBASE_PROJECT_ID, _is_production)
if _fb_cfg_err:
    _sys.stderr.write(_fb_cfg_err)
    _sys.exit(1)


class _CachedCertRequest:
    """google-auth transport that caches successful GETs (Google's public certs)
    for a short TTL, so token verification doesn't hit Google on every request."""

    def __init__(self, ttl_seconds: float = 1800.0, timeout: float = 10.0):
        from google.auth.transport import requests as _g_requests
        self._inner = _g_requests.Request()
        self._ttl = ttl_seconds
        self._timeout = timeout
        self._cache = {}

    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs):
        now = time.monotonic()
        hit = self._cache.get(url) if method == "GET" else None
        if hit and now - hit[0] < self._ttl:
            return hit[1]
        resp = self._inner(url, method=method, body=body, headers=headers,
                           timeout=timeout or self._timeout, **kwargs)
        if method == "GET" and getattr(resp, "status", None) == 200:
            self._cache[url] = (now, resp)
        return resp


_cert_request = None


def _verify_firebase_id_token(token: str) -> dict:
    """Verify signature, expiry, audience and issuer; return the claims dict.
    Raises ValueError on any invalid token. Patched in unit tests."""
    global _cert_request
    from google.oauth2 import id_token as _g_id_token
    if _cert_request is None:
        _cert_request = _CachedCertRequest()
    # audience=<project id> is enforced by google-auth (signature/exp/iat/aud).
    claims = _g_id_token.verify_firebase_token(
        token, _cert_request, audience=_FIREBASE_PROJECT_ID
    )
    # google-auth does NOT check the issuer for Firebase tokens — do it here.
    if claims.get("iss") != f"https://securetoken.google.com/{_FIREBASE_PROJECT_ID}":
        raise ValueError("wrong issuer")
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub or len(sub) > 128:
        raise ValueError("missing subject")
    auth_time = claims.get("auth_time")
    if isinstance(auth_time, (int, float)) and auth_time > time.time() + 300:
        raise ValueError("auth_time in the future")
    return claims


def require_firebase_user(request: Request, authorization: Optional[str] = Header(default=None)) -> str:
    """FastAPI dependency — requires a valid Firebase ID token.

    Returns the authenticated Firebase UID (also stored on request.state.firebase_uid).
    The raw token is never logged, stored or returned. Fails closed.
    """
    if not _FIREBASE_PROJECT_ID:
        logger.error("BEAULIX_FIREBASE_PROJECT_ID is not configured — rejecting request.")
        raise HTTPException(status_code=503, detail="Authentication is not configured on the server.")
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header.")
    parts = authorization.split(" ")
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise HTTPException(status_code=401, detail="Malformed Authorization header.")
    try:
        claims = _verify_firebase_id_token(parts[1].strip())
    except Exception as e:  # noqa: BLE001 — any failure means reject
        from google.auth.exceptions import TransportError
        if isinstance(e, TransportError):
            logger.error("Firebase cert fetch failed: %s", type(e).__name__)
            raise HTTPException(status_code=503, detail="Authentication service temporarily unavailable.")
        # Log only the exception type — never the token or its contents.
        logger.info("Firebase ID token rejected: %s", type(e).__name__)
        raise HTTPException(status_code=401, detail="Invalid or expired Firebase ID token.")
    uid = claims["sub"]
    request.state.firebase_uid = uid
    return uid


# model is intentionally NOT initialized here — it's created inside lifespan()
# so the port binds first and Render detects the server before RAM-heavy loading.
model = None  # placeholder; assigned in lifespan before any request can arrive

# Thread pool for async operations — declared before lifespan so it is
# accessible both inside and outside the context manager.
#
# Two executors to prevent background retrains from blocking prediction requests:
#   • executor         — fast prediction tasks (RF inference ~1 ms)
#   • retrain_executor — CPU-bound background retrains (~10–30 s, max 1 concurrent)
#
# Previously a single pool of 4 workers was shared for both; a single retrain
# could occupy 3 of 4 slots, queuing prediction requests.  Separating them
# ensures the prediction path is never starved.
executor         = ThreadPoolExecutor(max_workers=4)
retrain_executor = ThreadPoolExecutor(max_workers=1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan: startup and graceful shutdown."""
    # ── Startup (runs AFTER port is bound — Render detects the port first) ──
    global model
    if not _EXPECTED_KEY:
        logger.warning(
            "⚠️  BEAULIX_API_KEY is not set — all prediction endpoints are publicly "
            "accessible without authentication. Set this variable for production deployments."
        )
    # Load the model in a background thread so uvicorn binds the port FIRST.
    # Render scans for an open port immediately after startup — if we block here
    # loading the pkl, Render times out and kills the process before the port opens.
    logger.info("⏳ Loading ML model in background...")

    import threading as _bg_thread_mod

    def _load_model_bg():
        global model
        model = RecommendationModel()
        model._executor = retrain_executor
        logger.info("✅ ML model ready.")

    bg = _bg_thread_mod.Thread(target=_load_model_bg, daemon=True)
    bg.start()
    # Don't join — let uvicorn bind the port now. Endpoints guard against model=None.
    yield
    # Shutdown — drain both thread pools so in-flight work finishes cleanly.
    executor.shutdown(wait=True)
    retrain_executor.shutdown(wait=True)


app = FastAPI(title="Beaulix ML API", version="2.0", lifespan=lifespan)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ── CORS allowed origins ───────────────────────────────────────────────
# Set BEAULIX_FRONTEND_URL in your environment before deploying.
# Example:  export BEAULIX_FRONTEND_URL=https://your-project.web.app
#
# In production (BEAULIX_ENV=production), the server refuses to start if the
# variable is missing, preventing silent CORS failures on every frontend request.
# In local dev (default), a warning is printed and localhost origins are used.
if not _frontend_url:
    if _is_production:
        _sys.stderr.write(
            "FATAL: BEAULIX_FRONTEND_URL is not set in production.\n"
            "Set it to your Firebase Hosting URL, e.g.:\n"
            "  export BEAULIX_FRONTEND_URL=https://your-project.web.app\n"
            "Refusing to start: every frontend request would fail with a CORS error.\n"
        )
        _sys.exit(1)
    else:
        _sys.stderr.write(
            "WARNING: BEAULIX_FRONTEND_URL is not set.\n"
            "Falling back to localhost-only CORS for local development.\n"
            "Set BEAULIX_ENV=production to enforce this check on deploy.\n"
        )

ALLOWED_ORIGINS = list(filter(None, [
    _frontend_url,
    "http://localhost:5000",    # local Firebase emulator
    "http://127.0.0.1:5000",
]))

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Beaulix-API-Key", "Authorization"],
    expose_headers=[],
)


class PredictionRequest(BaseModel):
    product_category:     str
    decision_attribute_1: str
    decision_attribute_2: str
    funnel_stage:         str
    age_range:            str
    gender:               str
    occasion:             Optional[str] = ""
    # brand_style is for the GPU generator only — not used for ML prediction.
    # Optional so any cached requests that still include it are accepted.
    brand_style:          Optional[str] = None
    # Which of the three creative concepts (Product Hero / Beauty Lifestyle /
    # Social Concept) this copy is for. Only consumed by copy_engine.get_ad_copy
    # (selects headline/body template set) — not used for ML prediction, so
    # it's optional/ignored on /predict and /predict-step2 requests that
    # don't care about it.
    creative_direction:   Optional[str] = "hero"

    # Allowlists prevent junk values from polluting dataset.csv and degrading
    # model quality over time.
    # Must be declared as ClassVar — pydantic v2 treats plain underscore-prefixed
    # names as ModelPrivateAttr, which makes `in cls._VALID_*` raise TypeError.
    _VALID_CATEGORIES: ClassVar[set] = {"skincare", "makeup", "haircare", "fragrance", "bodycare"}
    _VALID_FUNNEL:     ClassVar[set] = {"awareness", "consideration", "conversion", "retention"}
    _VALID_AGE:        ClassVar[set] = {"13-17", "18-24", "25-34", "35-44", "45-60", "60+"}
    _VALID_GENDER:     ClassVar[set] = {"female", "male", "non-binary", "all-genders"}
    _VALID_OCCASION:   ClassVar[set] = {"", "daily", "wedding", "party", "gym", "vacation", "work", "selfcare"}
    _VALID_DIRECTION:  ClassVar[set] = {"hero", "lifestyle", "social"}
    _VALID_ATTR1:      ClassVar[set] = {
        "", "oily", "dry", "combination", "normal", "sensitive", "mature",
        "moisturising", "anti-aging", "brightening", "acne-control",
    }
    _VALID_ATTR2:      ClassVar[set] = {
        "", "skincare", "coverage", "natural", "bold", "longwear", "clean",
        "fresh", "acne", "anti-age", "hydration", "sensitive",
        "volumizing", "strengthening", "smoothing", "colour-protecting",
        "eau-de-parfum", "eau-de-toilette", "long-lasting", "fresh-scent",
        "body-lotion", "body-scrub", "body-oil", "body-butter",
    }

    @field_validator("product_category")
    @classmethod
    def _check_category(cls, v: str) -> str:
        if v.lower() not in cls._VALID_CATEGORIES:
            raise ValueError(f"product_category must be one of {sorted(cls._VALID_CATEGORIES)}")
        return v.lower()

    @field_validator("funnel_stage")
    @classmethod
    def _check_funnel(cls, v: str) -> str:
        if v.lower() not in cls._VALID_FUNNEL:
            raise ValueError(f"funnel_stage must be one of {sorted(cls._VALID_FUNNEL)}")
        return v.lower()

    @field_validator("age_range")
    @classmethod
    def _check_age(cls, v: str) -> str:
        if v not in cls._VALID_AGE:
            raise ValueError(f"age_range must be one of {sorted(cls._VALID_AGE)}")
        return v

    @field_validator("gender")
    @classmethod
    def _check_gender(cls, v: str) -> str:
        if v.lower() not in cls._VALID_GENDER:
            raise ValueError(f"gender must be one of {sorted(cls._VALID_GENDER)}")
        return v.lower()

    @field_validator("occasion")
    @classmethod
    def _check_occasion(cls, v: Optional[str]) -> str:
        val = (v or "").lower()
        if val not in cls._VALID_OCCASION:
            raise ValueError(f"occasion must be one of {sorted(cls._VALID_OCCASION)}")
        return val

    @field_validator("creative_direction")
    @classmethod
    def _check_direction(cls, v: Optional[str]) -> str:
        val = (v or "hero").lower()
        if val not in cls._VALID_DIRECTION:
            raise ValueError(f"creative_direction must be one of {sorted(cls._VALID_DIRECTION)}")
        return val

    @field_validator("decision_attribute_1")
    @classmethod
    def _check_attr1(cls, v: str) -> str:
        if v.lower() not in cls._VALID_ATTR1:
            logger.warning("Unknown decision_attribute_1 value %r — encoding as unknown", v)
        return v

    @field_validator("decision_attribute_2")
    @classmethod
    def _check_attr2(cls, v: str) -> str:
        if v.lower() not in cls._VALID_ATTR2:
            logger.warning("Unknown decision_attribute_2 value %r — encoding as unknown", v)
        return v


@app.get("/")
def root():
    return {"message": "Beaulix ML API", "status": "running"}


@app.get("/health")
def health():
    if model is None:
        return {"status": "starting", "model_loaded": False, "dataset_rows": 0}
    ts = model.training_stats
    return {
        "status":       "healthy",
        "model_loaded": model.ctr_model is not None,
        "dataset_rows": sum(model._user_profile_counts.values()),
        "accuracy": {
            "note": "cv_r2 = 5-fold cross-validated R² (honest held-out accuracy). train_r2 = in-sample fit (inflated).",
            "cv_r2_ctr":        ts.get("cv_r2_ctr"),
            "cv_r2_conversion": ts.get("cv_r2_conversion"),
            "cv_r2_engagement": ts.get("cv_r2_engagement"),
            "cv_r2_ctr_std":    ts.get("cv_r2_ctr_std"),
            "cv_r2_conv_std":   ts.get("cv_r2_conv_std"),
            "cv_r2_eng_std":    ts.get("cv_r2_eng_std"),
            "train_r2_ctr":        ts.get("r2_ctr"),
            "train_r2_conversion": ts.get("r2_conversion"),
            "train_r2_engagement": ts.get("r2_engagement"),
        },
    }


@app.post("/predict", dependencies=[Depends(require_firebase_user)])
@limiter.limit("30/minute")
async def predict(request: Request, body: PredictionRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Server is starting up, please retry in a few seconds.")
    try:
        # Exclude brand_style — it's for the GPU generator, not ML prediction
        features = {k: v for k, v in body.model_dump().items() if k != "brand_style"}
        
        # Run prediction in thread pool to avoid blocking
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            executor, 
            model.predict, 
            features, 
            True  # save_to_dataset = True
        )
        
        # Ensure we have all required fields
        response = {
            'success': True,
            'ctr': float(result.get('ctr', 0)),
            'conversion_rate': float(result.get('conversion_rate', 0)),
            'engagement_rate': float(result.get('engagement_rate', 0)),
            'confidence_score': float(result.get('confidence_score') or 0),
            'similar_profiles': int(result.get('similar_profiles', 0)),
            'benchmarks': result.get('benchmarks', {}),
            'confidence_interval': result.get('confidence_interval', {
                'ctr': {'lower': 0, 'upper': 0},
                'conversion_rate': {'lower': 0, 'upper': 0},
                'engagement_rate': {'lower': 0, 'upper': 0},
            }),
            'ad_copy': result.get('ad_copy', {}),
            'targeting': result.get('targeting', {}),
            'visual_recommendations': result.get('visual_recommendations', {}),
            'step2_recommendations': result.get('step2_recommendations', {}),
        }
        
        return JSONResponse(content=response)
        
    except ValueError as e:
        logger.warning("Invalid input to /predict: %s", e)
        raise HTTPException(status_code=422, detail=str(e))
    except MemoryError:
        logger.error("OOM in /predict — server may be under memory pressure", exc_info=True)
        raise HTTPException(status_code=503, detail="Server is temporarily overloaded. Please retry shortly.")
    except Exception as e:
        logger.error("Error in /predict: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Prediction failed. Please try again.")


class CategoryClassifyRequest(BaseModel):
    image_url: str


@app.post("/classify-product-category", dependencies=[Depends(require_firebase_user)])
@limiter.limit("30/minute")
async def classify_product_category(request: Request, body: CategoryClassifyRequest):
    """Second-pass product-category resolution from the ACTUAL uploaded
    product image, used ONLY when the frontend's filename-based resolver
    found no keyword match (e.g. a generic upload filename like
    'shopping.webp'). Deterministic OCR match against the same category
    keyword lists — no ML model, see image_category.py. Returns
    {"category": null} (never a guessed category) when nothing recognizable
    was found, so the caller can safely fall back to category-neutral copy.
    """
    loop = asyncio.get_running_loop()
    try:
        category = await loop.run_in_executor(
            executor, _classify_category_from_image_url, body.image_url
        )
    except Exception as e:
        logger.warning("Error in /classify-product-category: %s", e)
        category = None
    return JSONResponse(content={"category": category})


@app.post("/ad-copy", dependencies=[Depends(require_firebase_user)])
@limiter.limit("60/minute")
async def ad_copy_endpoint(request: Request, body: PredictionRequest):
    """
    Lightweight, ML-independent ad-copy endpoint (Part 4 of the copy-pipeline
    fix). Calls copy_engine.get_ad_copy() directly — the SAME function
    /predict eventually delegates to via RecommendationModel.get_ad_copy —
    so the creative-generation flow can obtain real ad copy without waiting
    on (or depending on) the Random Forest prediction. This does NOT require
    `model` to be loaded, so it stays available even while /predict is
    warming up. No copy constants are duplicated here.
    """
    try:
        features = {k: v for k, v in body.model_dump().items() if k != "brand_style"}
        # ctr/conv/eng are accepted by get_ad_copy's signature for parity with
        # RecommendationModel.get_ad_copy, but copy_engine.get_ad_copy doesn't
        # actually use them (copy varies by feature dimensions, not by the ML
        # prediction) — no prediction is run to obtain them.
        print('[COPY DEBUG] copy_engine.get_ad_copy called')
        print(f"[BEAULIX COPY] request.product_category = {body.product_category!r} creative_direction = {body.creative_direction!r}")
        ad_copy = _get_ad_copy_standalone(features, 0.0, 0.0, 0.0)
        print('[COPY DEBUG] generated ad_copy:', ad_copy)
        print(f"[COPY TEST] /ad-copy endpoint generated: {ad_copy}")
        print(f"[BEAULIX COPY] returned headline = {ad_copy.get('headline')!r} body = {ad_copy.get('description')!r}")
        return JSONResponse(content={"success": True, "ad_copy": ad_copy})
    except ValueError as e:
        logger.warning("Invalid input to /ad-copy: %s", e)
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        logger.error("Error in /ad-copy: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Ad copy generation failed. Please try again.")


class Step2PredictionRequest(PredictionRequest):
    """
    Extends PredictionRequest with Step 2 creative-choice fields.
    Inherits all field_validators from PredictionRequest so Step 2 requests
    receive the same input validation as Step 1 (prevents silent validator drift).
    """
    brand_style:  Optional[str] = "luxury-elegant"
    aspect_ratio: Optional[str] = "1:1"
    output_type:  Optional[str] = "image"


@app.post("/predict-step2", dependencies=[Depends(require_api_key)])
@limiter.limit("30/minute")
async def predict_step2(request: Request, body: Step2PredictionRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Server is starting up, please retry in a few seconds.")
    """
    Re-predicts performance after the user has made Step 2 creative choices
    (brand_style, aspect_ratio, output_type). Returns step1 baseline,
    step2 updated scores, delta, and pct_change so the frontend can show
    a real before/after improvement banner.
    """
    try:
        features = body.model_dump()

        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            executor,
            model.predict_step2,
            features,
        )

        return JSONResponse(content=result)

    except ValueError as e:
        logger.warning("Invalid input to /predict-step2: %s", e)
        raise HTTPException(status_code=422, detail=str(e))
    except MemoryError:
        logger.error("OOM in /predict-step2", exc_info=True)
        raise HTTPException(status_code=503, detail="Server is temporarily overloaded. Please retry shortly.")
    except Exception as e:
        logger.error("Error in /predict-step2: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Step 2 prediction failed. Please try again.")


@app.get("/visual-recommendations", dependencies=[Depends(require_api_key)])
@limiter.limit("30/minute")
async def get_visual_recommendations(request: Request, category: str, funnel: str, age_range: str = "25-34"):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not yet loaded. Please retry in a moment.")
    try:
        vr = model.get_visual_recommendations(category, funnel, age_range)
        return JSONResponse(content=vr)
    except Exception as e:
        logger.error("Error in /visual-recommendations: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Visual recommendations failed. Please try again.")


@app.post("/step2-recommendations", dependencies=[Depends(require_api_key)])
@limiter.limit("30/minute")
async def get_step2_recommendations(request: Request, body: PredictionRequest):
    """
    Returns recommended Step 2 selections (brand style, aspect ratio,
    output type, creative approach) based on Step 1 inputs.
    Useful for pre-filling Step 2 before the user generates a visual.
    """
    try:
        features = {k: v for k, v in body.model_dump().items() if k != "brand_style"}
        recs = model.get_step2_recommendations(features)
        return JSONResponse(content=recs)
    except Exception as e:
        logger.error("Error in /step2-recommendations: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Step 2 recommendations failed. Please try again.")


@app.get("/dataset-stats", dependencies=[Depends(require_api_key)])
@limiter.limit("30/minute")
async def get_dataset_stats(request: Request):
    try:
        if os.path.exists(DATASET_PATH):
            import pandas as pd  # lazy import — pandas (~35 MB) not needed at startup
            df = pd.read_csv(DATASET_PATH)
            # dataset_path intentionally omitted — exposes server filesystem layout.
            # last_5_rows limited to non-sensitive columns only.
            safe_cols = [c for c in df.columns if c not in ("timestamp",)]
            return {
                'total_rows': len(df),
                'columns': safe_cols,
            }
        return {'total_rows': 0, 'columns': []}
    except Exception as e:
        logger.error("Error in /dataset-stats: %s", e, exc_info=True)
        raise HTTPException(status_code=500, detail="Dataset stats unavailable.")


# ── TEMPORARY startup diagnostic (remove after root cause is confirmed) ─
# Placed at module scope, not inside `if __name__ == "__main__"`, because
# Render's actual start command is `uvicorn server:app ...`, which imports
# this module directly and never executes the __main__ block below. A
# print placed only in __main__ would never show up in Render's logs.
print(f"[ROUTE DEBUG] server_file={__file__}", flush=True)
_classify_route = next((r for r in app.routes if getattr(r, "path", None) == "/classify-product-category"), None)
print(f"[ROUTE DEBUG] classify_route_present={_classify_route is not None}", flush=True)
print(f"[ROUTE DEBUG] classify_route_methods={getattr(_classify_route, 'methods', None)}", flush=True)
print("[ROUTE DEBUG] all_routes=" + str(sorted(r.path for r in app.routes if hasattr(r, 'path'))), flush=True)
# ── end TEMPORARY diagnostic ─────────────────────────────────────────────


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"🚀 Beaulix ML API starting on port {port}", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")