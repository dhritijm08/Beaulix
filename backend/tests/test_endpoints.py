"""
tests/test_endpoints.py
=======================
Integration tests for the 5 FastAPI endpoints in server.py.

The heavy RecommendationModel is replaced with a lightweight stub so these
tests run without the 14 MB Excel file, trained .pkl, or GPU.  Each test
verifies:
  - the HTTP status code
  - the shape / keys of the JSON response
  - validation / auth behaviour

Run with:
    cd backend
    pytest tests/test_endpoints.py -v
"""

import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ── Build a minimal stub model before importing server ────────────────────────
# server.py instantiates RecommendationModel() at module level.  We patch both
# the class constructor AND excel_cache.init so that no file I/O happens.

from unittest.mock import MagicMock, patch

_PREDICT_RESP = {
    "ctr":             2.50,
    "conversion_rate": 1.20,
    "engagement_rate": 4.10,
    "confidence_score": 82.0,
    "similar_profiles": 450,
    "benchmarks":       {"ctr": 2.0, "conversion": 1.0, "engagement": 3.5},
    "confidence_interval": {
        "ctr":             {"lower": 1.80, "upper": 3.20},
        "conversion_rate": {"lower": 0.80, "upper": 1.60},
        "engagement_rate": {"lower": 3.00, "upper": 5.20},
    },
    "ad_copy": {
        "hook":        "Test hook",
        "headline":    "Test headline",
        "description": "Test description",
        "cta":         "Shop Now",
        "offer":       "Free shipping",
    },
    "targeting":              {"targeting": ["25-34 Female"], "platforms": ["Instagram"], "tone": "Professional"},
    "step2_recommendations":  None,
    "visual_recommendations": {},
}


class _StubModel:
    """Lightweight synchronous stand-in for RecommendationModel."""
    ctr_model             = MagicMock()       # truthy → model_loaded: True
    _user_profile_counts  = {"key": 5}
    training_stats        = {}

    def predict(self, features, save_to_dataset=False):
        return _PREDICT_RESP

    def predict_step2(self, features):
        return {**_PREDICT_RESP, "step2_score": 87.5}

    def get_visual_recommendations(self, *a, **kw):
        return {}

    def _cache_excel_profile_counts(self): pass
    def _cache_excel_lookup(self):         pass
    def _load_user_counters(self):         pass
    def _load_model(self):                 pass


_stub = _StubModel()

with (
    patch("model.RecommendationModel", return_value=_stub),
    patch("excel_cache.init"),
):
    from fastapi.testclient import TestClient
    import server
    server.model = _stub        # replace the module-level reference
    client = TestClient(server.app)


# ── Fixtures / helpers ────────────────────────────────────────────────────────

VALID_PAYLOAD = {
    "product_category":     "skincare",
    "decision_attribute_1": "oily",
    "decision_attribute_2": "acne",
    "funnel_stage":         "awareness",
    "age_range":            "25-34",
    "gender":               "female",
    "occasion":             "daily",
}

VALID_STEP2_PAYLOAD = {
    **VALID_PAYLOAD,
    "brand_style":  "modern-minimalist",
    "aspect_ratio": "1:1",
    "output_type":  "image",
}


# ── GET / ─────────────────────────────────────────────────────────────────────

class TestRoot:
    def test_returns_200(self):
        assert client.get("/").status_code == 200

    def test_response_shape(self):
        body = client.get("/").json()
        assert "message" in body and "status" in body


# ── GET /health ───────────────────────────────────────────────────────────────

class TestHealth:
    def test_returns_200(self):
        assert client.get("/health").status_code == 200

    def test_response_shape(self):
        body = client.get("/health").json()
        assert body["status"]    == "healthy"
        assert "model_loaded"    in body
        assert "dataset_rows"    in body

    def test_no_dataset_path_exposed(self):
        """dataset_path must NOT appear in /health — exposes server filesystem (§8.6)."""
        assert "dataset_path" not in client.get("/health").json()

    def test_model_loaded_true(self):
        assert client.get("/health").json()["model_loaded"] is True


# ── POST /predict ─────────────────────────────────────────────────────────────

class TestPredict:
    def test_valid_request_returns_200(self):
        assert client.post("/predict", json=VALID_PAYLOAD).status_code == 200

    def test_response_has_metric_keys(self):
        body = client.post("/predict", json=VALID_PAYLOAD).json()
        for key in ("ctr", "conversion_rate", "engagement_rate", "confidence_score"):
            assert key in body, f"Missing key: {key}"

    def test_response_has_ad_copy(self):
        body = client.post("/predict", json=VALID_PAYLOAD).json()
        assert "ad_copy" in body
        assert "hook" in body["ad_copy"]

    def test_response_has_targeting(self):
        assert "targeting" in client.post("/predict", json=VALID_PAYLOAD).json()

    def test_invalid_category_returns_422(self):
        bad = {**VALID_PAYLOAD, "product_category": "invalid_cat"}
        assert client.post("/predict", json=bad).status_code == 422

    def test_invalid_funnel_returns_422(self):
        bad = {**VALID_PAYLOAD, "funnel_stage": "not_a_funnel"}
        assert client.post("/predict", json=bad).status_code == 422

    def test_invalid_age_returns_422(self):
        bad = {**VALID_PAYLOAD, "age_range": "0-5"}
        assert client.post("/predict", json=bad).status_code == 422

    def test_invalid_gender_returns_422(self):
        bad = {**VALID_PAYLOAD, "gender": "unknown_gender"}
        assert client.post("/predict", json=bad).status_code == 422

    def test_missing_required_field_returns_422(self):
        incomplete = {k: v for k, v in VALID_PAYLOAD.items() if k != "product_category"}
        assert client.post("/predict", json=incomplete).status_code == 422


# ── POST /predict-step2 ───────────────────────────────────────────────────────

class TestPredictStep2:
    def test_valid_request_returns_200(self):
        assert client.post("/predict-step2", json=VALID_STEP2_PAYLOAD).status_code == 200

    def test_response_has_metric_keys(self):
        body = client.post("/predict-step2", json=VALID_STEP2_PAYLOAD).json()
        for key in ("ctr", "conversion_rate", "engagement_rate", "confidence_score"):
            assert key in body, f"Missing key: {key}"

    def test_invalid_category_returns_422(self):
        bad = {**VALID_STEP2_PAYLOAD, "product_category": "bad"}
        assert client.post("/predict-step2", json=bad).status_code == 422


# ── GET /dataset-stats ────────────────────────────────────────────────────────

class TestDatasetStats:
    def test_requires_auth_when_key_set(self):
        original_key = server._EXPECTED_KEY
        try:
            server._EXPECTED_KEY = "secret-test-key"
            r = client.get("/dataset-stats")
            assert r.status_code == 401
        finally:
            server._EXPECTED_KEY = original_key

    def test_no_dataset_path_in_response(self):
        """dataset_path must not be exposed (§8.6)."""
        r = client.get("/dataset-stats")
        if r.status_code == 200:
            assert "dataset_path" not in r.json()

    def test_no_last_5_rows_in_response(self):
        """Raw last_5_rows must not be exposed (§8.6)."""
        r = client.get("/dataset-stats")
        if r.status_code == 200:
            assert "last_5_rows" not in r.json()


# ── GET /visual-recommendations ───────────────────────────────────────────────

class TestVisualRecommendations:
    """Tests for the GET /visual-recommendations endpoint (§10.4)."""

    def test_returns_200_with_valid_params(self):
        r = client.get("/visual-recommendations", params={
            "category": "skincare",
            "funnel": "awareness",
            "age_range": "25-34",
        })
        assert r.status_code == 200

    def test_response_is_dict(self):
        r = client.get("/visual-recommendations", params={
            "category": "skincare",
            "funnel": "awareness",
        })
        assert r.status_code == 200
        body = r.json()
        assert isinstance(body, dict), "Expected a JSON object response"

    def test_missing_required_params_returns_422(self):
        """Both category and funnel are required query params."""
        r = client.get("/visual-recommendations", params={"category": "skincare"})
        assert r.status_code == 422

    def test_requires_auth_when_key_set(self):
        original_key = server._EXPECTED_KEY
        try:
            server._EXPECTED_KEY = "secret-test-key"
            r = client.get("/visual-recommendations", params={
                "category": "skincare",
                "funnel": "awareness",
            })
            assert r.status_code == 401
        finally:
            server._EXPECTED_KEY = original_key
