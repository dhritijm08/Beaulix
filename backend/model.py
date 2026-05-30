"""
model.py
========
RecommendationModel — thin orchestrator for ML inference.

This file is intentionally lean.  All extracted sub-modules:
  • confidence.py      — CI helpers (brand-style CI, RF prediction interval, score calc)
  • step2_engine.py    — Step 2 multiplier logic and response builder
  • visual_lookup.py   — Visual brief and Step 2 recommendation lookups
  • excel_cache.py     — Excel loading/caching layer
  • copy_engine.py     — Ad copy generation
  • targeting.py       — Targeting recommendations
  • constants.py       — Shared constants and lookup tables
  • copy_constants.py  — Ad-copy lookup tables
  • step2_constants.py — Step 2 multipliers and fallback heuristics
  • retrain.py         — Background retraining (§5.1 split)
  • dataset.py         — Dataset I/O and user counter management (§5.1 split)

Every call to predict():
  1. Returns predictions instantly using the current loaded model
  2. Appends the new input + predictions to dataset.csv
  3. Fires a background thread that retrains all 3 RF models on:
       base Excel data (97,920 rows) + all accumulated user inputs
     then overwrites random_forest_models.pkl
  4. Hot-swaps the in-memory model once retraining completes —
     the next prediction automatically uses the updated model

§6.1 NOTE: Background retraining is intentionally guarded by _RETRAIN_MIN_INTERVAL
(300 s) and _RETRAIN_MIN_NEW_ROWS (5).  On a busy single-core instance, consider
moving to a scheduled cron (every 6 h) to avoid competing with prediction requests.
The model is seeded on 97,920 rows; per-prediction retraining provides marginal
accuracy gains at significant CPU cost.
"""

import math
import os
import threading
import time
import logging
import warnings
from datetime import datetime

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.preprocessing import LabelEncoder
from sklearn.model_selection import cross_val_score, KFold

warnings.filterwarnings("ignore")
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Shared constants (single source of truth) ─────────────────────────
from constants import (
    EXCEL_COL_MAP,
    FEATURE_COLS,
    LEAKAGE_COLS,
    VALUE_NORMALISATIONS,
    RF_PARAMS,
    CTR_TARGETS,
    CONV_TARGETS,
    ENG_TARGETS,
    CTR_MAX,
    CONV_MAX,
    ENG_MAX,
)
from step2_constants import (
    STEP2_BRAND_STYLE_MULT,
    STEP2_ASPECT_RATIO_MULT,
    STEP2_OUTPUT_TYPE_MULT,
    FALLBACK_FUNNEL_MULT,
)

# ── Extracted sub-modules ──────────────────────────────────────────────
from copy_engine  import get_ad_copy as _get_ad_copy
from targeting    import get_targeting_recommendations as _get_targeting_recommendations
import excel_cache    as _excel_cache
import confidence     as _confidence
import step2_engine   as _step2_engine
import visual_lookup  as _visual_lookup
import cache_manager  as _cache_manager
import retrain        as _retrain
import dataset        as _dataset

# ── Paths ──────────────────────────────────────────────────────────────
BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
EXCEL_PATH   = os.path.join(BASE_DIR, "beaulix_combinatorial_predictions.xlsx")
DATASET_PATH = os.path.join(BASE_DIR, "dataset.csv")
MODEL_PATH   = os.path.join(BASE_DIR, "models", "random_forest_models.pkl")

# Configure the Excel cache module with the resolved path.
_excel_cache.init(EXCEL_PATH)

DATASET_COLUMNS = _dataset.DATASET_COLUMNS

# ── Thread locks ───────────────────────────────────────────────────────
_dataset_lock = threading.Lock()
# _model_swap_lock lives in locks.py to avoid a circular import with step2_engine.
# step2_engine.py imports _model_swap_lock from locks.py directly.
from locks import model_swap_lock as _model_swap_lock


class RecommendationModel:

    # ── Retrain guard constants ────────────────────────────────────────
    # _RETRAIN_MIN_INTERVAL: minimum seconds between two consecutive retrains.
    #   300 s = 5 min.  Prevents CPU starvation on busy single-core instances.
    #   On a 2-core server with the separate retrain_executor, this can be lowered
    #   to 60 s safely.  On a 1-core shared host, raise to 3600 s or switch to
    #   a scheduled cron (see §6.1 note in module docstring).
    _RETRAIN_MIN_INTERVAL: float = 300.0

    # _RETRAIN_MIN_NEW_ROWS: minimum new dataset rows since the last retrain
    #   before an opportunistic retrain is triggered.  5 rows = 5 unique non-cached
    #   predictions.  Set to 1 for aggressive retraining (more accurate, more CPU);
    #   set to 50+ for lighter production servers.
    _RETRAIN_MIN_NEW_ROWS: int = 5

    def __init__(self):
        self.ctr_model        = None
        self.conversion_model = None
        self.engagement_model = None
        self.label_encoders   = {}
        self.feature_columns  = FEATURE_COLS
        self.feature_values   = {}
        self.training_stats   = {}
        self._excel_profile_counts: dict = {}
        self._excel_lookup: dict         = {}
        self._excel_ci_std: dict         = {}
        self._last_retrain_time: float   = 0.0
        self._dataset_rows_at_last_retrain: int = 0
        self._executor = None
        self._user_profile_counts: dict  = {}
        self._user_combo_counts: dict    = {}
        self._load_model()
        self._cache_excel_profile_counts()
        self._cache_excel_lookup()
        self._load_user_counters()

    # ── Load saved .pkl ────────────────────────────────────────────────
    def _load_model(self):
        if not os.path.exists(MODEL_PATH):
            logger.warning("Model not found. Run train_simple_model.py first.")
            return
        try:
            data = joblib.load(MODEL_PATH)
            self._apply_model_data(data)
            logger.info(
                "✅ Model loaded | seeded on %s rows",
                f"{self.training_stats.get('seeded_rows', '?'):,}",
            )
        except Exception as e:
            logger.error("Failed to load model: %s", e)

    def _apply_model_data(self, data: dict):
        """Hot-swap all model attributes atomically under a lock."""
        with _model_swap_lock:
            self.ctr_model        = data["ctr_model"]
            self.conversion_model = data["conversion_model"]
            self.engagement_model = data["engagement_model"]
            self.label_encoders   = data["label_encoders"]
            self.feature_columns  = data["feature_columns"]
            self.feature_values   = data.get("feature_values", {})
            self.training_stats   = data.get("training_stats", {})

    # ── Shared Excel base loader ───────────────────────────────────────
    @staticmethod
    def _load_excel_base_df() -> pd.DataFrame:
        return _excel_cache.load_base_df()

    # ── Normalise a raw frontend value ─────────────────────────────────
    @staticmethod
    def _normalise_value(col: str, value: str) -> str:
        """
        VALUE_NORMALISATIONS is intentionally empty — kept so future
        divergences can be patched in constants.py without changing call-sites.
        """
        return VALUE_NORMALISATIONS.get(col, {}).get(value, value)  # noqa: SIM401

    # ── Encode a single input row for prediction ───────────────────────
    def _encode_input(self, features_dict: dict) -> pd.DataFrame:
        row = {}
        for col in self.feature_columns:
            raw   = str(features_dict.get(col, ""))
            value = self._normalise_value(col, raw)
            le    = self.label_encoders.get(col)
            if le is not None and value in le.classes_:
                row[col] = le.transform([value])[0]
            else:
                if value:
                    logger.warning(
                        "Unknown value for '%s': '%s' (raw='%s') — encoding as 0",
                        col, value, raw,
                    )
                row[col] = 0
        return pd.DataFrame([row])

    # ── Append new input to dataset.csv ────────────────────────────────
    def _append_to_dataset(self, features_dict: dict, predictions: dict):
        _dataset.append_to_dataset(
            dataset_path=DATASET_PATH,
            dataset_lock=_dataset_lock,
            features_dict=features_dict,
            predictions=predictions,
            normalise_value_fn=self._normalise_value,
            user_profile_counts=self._user_profile_counts,
            user_combo_counts=self._user_combo_counts,
        )

    # ── Background retrain ─────────────────────────────────────────────
    def _retrain_background(self, skip_interval_check: bool = False, executor=None):
        """
        Retrains all 3 RF models on base Excel + accumulated user inputs.
        Submits work to ``executor`` when provided so graceful shutdown covers
        in-flight retrains.  Falls back to a daemon thread otherwise.

        §6.1: On a busy 1-2 core server, consider a scheduled cron instead of
        per-prediction retraining (see module docstring).

        §6.5: Cross-validation runs outside the retrain_lock acquisition path —
        only the final model swap touches shared state under the lock.  CV itself
        (10-30 s) runs freely and only blocks further retrains (via the lock) for
        the brief period needed to swap in the new model data.

        Args:
            skip_interval_check: Bypass _RETRAIN_MIN_INTERVAL but still enforce
                _RETRAIN_MIN_NEW_ROWS.  Used after non-cached predictions.
            executor: Optional Executor to submit the task to.
        """
        now = time.monotonic()
        if not skip_interval_check and (now - self._last_retrain_time) < self._RETRAIN_MIN_INTERVAL:
            logger.info(
                "Retrain skipped — last ran %ss ago (min %ss)",
                f"{now - self._last_retrain_time:.0f}",
                f"{self._RETRAIN_MIN_INTERVAL:.0f}",
            )
            return

        current_total_rows = sum(self._user_profile_counts.values())
        new_rows_since_last = current_total_rows - self._dataset_rows_at_last_retrain
        if skip_interval_check and new_rows_since_last < self._RETRAIN_MIN_NEW_ROWS:
            logger.info(
                "Retrain skipped — only %s new row(s) since last retrain (min %s)",
                new_rows_since_last, self._RETRAIN_MIN_NEW_ROWS,
            )
            return

        # Optimistic update to prevent N concurrent callers all queueing retrains.
        self._dataset_rows_at_last_retrain = current_total_rows

        def task():
            _retrain.run_retrain_task(
                model_path=MODEL_PATH,
                dataset_path=DATASET_PATH,
                load_excel_base_df=self._load_excel_base_df,
                apply_model_data_fn=self._apply_model_data,
                get_training_stats_fn=lambda: self.training_stats,
                set_last_retrain_time_fn=lambda: setattr(self, "_last_retrain_time", time.monotonic()),
                set_dataset_rows_fn=lambda counts: setattr(
                    self, "_dataset_rows_at_last_retrain", sum(counts.values())
                ),
                get_user_profile_counts_fn=lambda: self._user_profile_counts,
            )

        _retrain.submit_retrain(
            task_fn=task,
            executor=executor,
            shutdown_event=getattr(self, "_shutdown_event", None),
        )

    # ── Cache Excel profile counts at startup ──────────────────────────
    def _cache_excel_profile_counts(self):
        """Delegates to cache_manager.build_excel_profile_counts()."""
        self._excel_profile_counts = _cache_manager.build_excel_profile_counts(
            self._load_excel_base_df
        )

    def _load_user_counters(self):
        """Delegates to cache_manager.load_user_counters()."""
        self._user_profile_counts, self._user_combo_counts = (
            _cache_manager.load_user_counters(DATASET_PATH, _dataset_lock)
        )

    PROFILE_COLS = _dataset.PROFILE_COLS
    COMBO_COLS   = _dataset.COMBO_COLS

    def _similar_profile_count(self, features_dict: dict) -> int:
        """Delegates to cache_manager.similar_profile_count()."""
        return _cache_manager.similar_profile_count(
            features_dict,
            self._excel_profile_counts,
            self._user_profile_counts,
            self._normalise_value,
        )

    def _combo_submission_count(self, features_dict: dict) -> int:
        """Delegates to cache_manager.combo_submission_count()."""
        return _cache_manager.combo_submission_count(
            features_dict, self._user_combo_counts, self._normalise_value
        )

    # ── Excel exact-match lookup cache ────────────────────────────────
    EXCEL_LOOKUP_COLS = [
        "product_category", "decision_attribute_1", "decision_attribute_2",
        "funnel_stage", "age_range", "gender", "occasion",
    ]

    def _cache_excel_lookup(self):
        """Delegates to cache_manager.build_excel_lookup()."""
        self._excel_lookup, self._excel_ci_std = _cache_manager.build_excel_lookup(
            self._load_excel_base_df, self._normalise_value
        )

    def _excel_exact_match(self, features_dict: dict):
        """Returns (ctr, conv, eng) from Excel cache, else None."""
        return _cache_manager.excel_exact_match(
            features_dict, self._excel_lookup, self._normalise_value
        )

    # ── Visual data loader — called once at startup via lifespan ───────
    def _load_visual_data(self):
        """
        Delegates to excel_cache.load_visual_data().  Called once during the
        lifespan handler at startup; the result is cached module-level in
        excel_cache so every subsequent request hits the in-memory DataFrame
        with no lock acquisition or function dispatch overhead.
        """
        _excel_cache.load_visual_data(BASE_DIR)

    @staticmethod
    def _build_visual_pkl():
        """Pre-process both Excel files to models/visual_data.pkl."""
        _excel_cache.build_visual_pkl(BASE_DIR)

    # ── Main predict ───────────────────────────────────────────────────
    def predict(self, features_dict: dict, save_to_dataset: bool = True) -> dict:
        logger.info(
            "Predicting: %s - %s",
            features_dict.get("product_category"),
            features_dict.get("funnel_stage"),
        )

        if self.ctr_model is None:
            logger.warning("No model loaded — using rule-based fallback.")
            result = self._fallback(features_dict)
            if save_to_dataset:
                self._append_to_dataset(features_dict, result)
            result["similar_profiles"] = self._similar_profile_count(features_dict)
            return result

        try:
            X_input = self._encode_input(features_dict)

            exact = self._excel_exact_match(features_dict)
            exact_match = exact is not None
            if exact_match:
                ctr_pred, conv_pred, eng_pred = exact
                logger.info("✅ Excel exact match — CTR=%s Conv=%s Eng=%s", ctr_pred, conv_pred, eng_pred)
            else:
                ctr_pred  = float(self.ctr_model.predict(X_input)[0])
                conv_pred = float(self.conversion_model.predict(X_input)[0])
                eng_pred  = float(self.engagement_model.predict(X_input)[0])
                logger.info("🌲 RF prediction — CTR=%.3f Conv=%.3f Eng=%.3f", ctr_pred, conv_pred, eng_pred)

            ctr_pred  = max(0.0, min(20.0, ctr_pred))
            conv_pred = max(0.0, min(15.0, conv_pred))
            eng_pred  = max(0.0, min(30.0, eng_pred))

            category = features_dict.get("product_category", "skincare")
            funnel   = features_dict.get("funnel_stage",     "awareness")
            age      = self._normalise_value(
                "age_range", features_dict.get("age_range", "25-34")
            )

            if save_to_dataset:
                _cv_mean = (
                    (self.training_stats.get("cv_r2_ctr")         or 0) +
                    (self.training_stats.get("cv_r2_conversion")   or 0) +
                    (self.training_stats.get("cv_r2_engagement")   or 0)
                ) / 3.0
                self._append_to_dataset(features_dict, {
                    "ctr":              round(ctr_pred,  2),
                    "conversion_rate":  round(conv_pred, 2),
                    "engagement_rate":  round(eng_pred,  2),
                    "confidence_score": round(_cv_mean * 100, 2),
                })

            real_rows = sum(self._user_profile_counts.values())
            ctr_out, conv_out, eng_out = ctr_pred, conv_pred, eng_pred
            similar_profiles = self._similar_profile_count(features_dict)

            # ── 95% CI from brand-style variance (Step 1) ────────────────
            (ctr_lo, ctr_hi), (conv_lo, conv_hi), (eng_lo, eng_hi) = \
                _confidence.brand_style_ci(
                    ctr_out, conv_out, eng_out,
                    features_dict, category,
                    self._excel_ci_std, self.EXCEL_LOOKUP_COLS,
                    self._normalise_value,
                )

            ctr_lo, ctr_hi, conv_lo, conv_hi, eng_lo, eng_hi = \
                _confidence.clamp_ci_bounds(
                    ctr_lo, ctr_hi, conv_lo, conv_hi, eng_lo, eng_hi,
                    ctr_out, conv_out, eng_out, category,
                )

            # ── Confidence score ──────────────────────────────────────────
            combo_submissions = self._combo_submission_count(features_dict)
            confidence = _confidence.compute_confidence_score(
                self.training_stats, combo_submissions, similar_profiles, ctr_out
            )

            result = {
                "ctr":              round(ctr_out,    2),
                "conversion_rate":  round(conv_out,   2),
                "engagement_rate":  round(eng_out,    2),
                "confidence_score": round(confidence, 2),
                "similar_profiles": similar_profiles,
                "benchmarks": {
                    "ctr":        CTR_TARGETS.get(category,  1.20),
                    "conversion": CONV_TARGETS.get(category, 0.85),
                    "engagement": ENG_TARGETS.get(category,  3.00),
                },
                "confidence_interval": {
                    "ctr":             {"lower": ctr_lo,  "upper": ctr_hi},
                    "conversion_rate": {"lower": conv_lo, "upper": conv_hi},
                    "engagement_rate": {"lower": eng_lo,  "upper": eng_hi},
                },
                "ad_copy":                self.get_ad_copy(features_dict, ctr_out, conv_out, eng_out),
                "targeting":              self.get_targeting_recommendations(features_dict),
                "visual_recommendations": self.get_visual_recommendations(
                    category, funnel,
                    age_range   = age,
                    gender      = features_dict.get("gender",       "female"),
                    occasion    = features_dict.get("occasion",     "daily"),
                    brand_style = features_dict.get("brand_style",  ""),
                    aspect_ratio = features_dict.get("aspect_ratio", "1:1"),
                    output_type  = features_dict.get("output_type",  "image"),
                ),
                "step2_recommendations": self.get_step2_recommendations(features_dict),
            }

            if os.getenv("DEBUG", "").lower() in ("1", "true", "yes"):
                result["_calibration"] = {
                    "active":               False,
                    "raw_ctr":              round(ctr_pred,  3),
                    "raw_conv":             round(conv_pred, 3),
                    "raw_eng":              round(eng_pred,  3),
                    "real_rows_in_dataset": real_rows,
                    "cv_r2_ctr":            self.training_stats.get("cv_r2_ctr"),
                    "cv_r2_conversion":     self.training_stats.get("cv_r2_conversion"),
                    "cv_r2_engagement":     self.training_stats.get("cv_r2_engagement"),
                    "ci_method":            "brand_style_ci",
                }

            if not exact_match:
                self._retrain_background(skip_interval_check=True, executor=self._executor)

            return result

        except Exception as e:
            logger.error("Prediction error: %s", e, exc_info=True)
            result = self._fallback(features_dict)
            if save_to_dataset:
                self._append_to_dataset(features_dict, result)
            return result

    # ── Rule-based fallback ────────────────────────────────────────────
    def _fallback(self, features_dict: dict) -> dict:
        """
        Used when the model is not loaded.  Funnel-stage multipliers reference
        FALLBACK_FUNNEL_MULT from step2_constants (§10.6: no more hardcoded
        ranges here — single source of truth).  Category baselines come from
        CTR_TARGETS / CONV_TARGETS / ENG_TARGETS in constants.py.
        """
        category = features_dict.get("product_category", "skincare")
        funnel   = features_dict.get("funnel_stage",     "awareness")
        age      = self._normalise_value(
            "age_range", features_dict.get("age_range", "25-34")
        )

        _default_ctr  = sum(CTR_TARGETS.values())  / len(CTR_TARGETS)
        _default_conv = sum(CONV_TARGETS.values()) / len(CONV_TARGETS)
        _default_eng  = sum(ENG_TARGETS.values())  / len(ENG_TARGETS)

        base_ctr  = CTR_TARGETS.get(category,  _default_ctr)
        base_conv = CONV_TARGETS.get(category, _default_conv)
        base_eng  = ENG_TARGETS.get(category,  _default_eng)

        mult = FALLBACK_FUNNEL_MULT.get(funnel, {"ctr": 1.0, "conv": 1.0, "eng": 1.0})

        ctr  = base_ctr  * mult["ctr"]
        conv = base_conv * mult["conv"]
        eng  = base_eng  * mult["eng"]

        return {
            "ctr":              round(ctr,  2),
            "conversion_rate":  round(conv, 2),
            "engagement_rate":  round(eng,  2),
            "confidence_score": None,
            "model_unavailable": True,
            "similar_profiles": 0,
            "benchmarks": {
                "ctr":        CTR_TARGETS.get(category,  1.20),
                "conversion": CONV_TARGETS.get(category, 0.85),
                "engagement": ENG_TARGETS.get(category,  3.00),
            },
            "confidence_interval": {
                "ctr":             {"lower": round(ctr  * 0.85, 2), "upper": round(ctr  * 1.15, 2)},
                "conversion_rate": {"lower": round(conv * 0.85, 2), "upper": round(conv * 1.15, 2)},
                "engagement_rate": {"lower": round(eng  * 0.85, 2), "upper": round(eng  * 1.15, 2)},
            },
            "ad_copy":                self.get_ad_copy(features_dict, ctr, conv, eng),
            "targeting":              self.get_targeting_recommendations(features_dict),
            "visual_recommendations": self.get_visual_recommendations(
                category, funnel, age_range=age,
                gender      = features_dict.get("gender",      "female"),
                occasion    = features_dict.get("occasion",    "daily"),
                brand_style = features_dict.get("brand_style", ""),
                aspect_ratio = features_dict.get("aspect_ratio", "1:1"),
                output_type  = features_dict.get("output_type",  "image"),
            ),
            "step2_recommendations": self.get_step2_recommendations(features_dict),
        }

    # ── predict_step2 — delegates to step2_engine ─────────────────────
    def predict_step2(self, features_dict: dict) -> dict:
        """
        Re-predicts performance after the user has set Step 2 creative choices.
        Delegates multiplier logic and response building to step2_engine.py.
        Does NOT save to dataset.csv or trigger retraining.
        """
        step1 = self.predict(features_dict, save_to_dataset=False)

        def rf_interval(metric_key: str, X_input):
            model_map = {
                "ctr":  self.ctr_model,
                "conv": self.conversion_model,
                "eng":  self.engagement_model,
            }
            return _confidence.rf_prediction_interval(model_map[metric_key], X_input)

        return _step2_engine.build_step2_response(
            features_dict       = features_dict,
            step1               = step1,
            encode_input_fn     = self._encode_input,
            rf_interval_fn      = rf_interval,
            training_stats      = self.training_stats,
            get_ad_copy_fn      = self.get_ad_copy,
            get_targeting_fn    = self.get_targeting_recommendations,
        )

    # ── Visual / copy / targeting helpers ─────────────────────────────
    def get_visual_recommendations(self, category: str, funnel: str,
                                   age_range: str = "25-34",
                                   gender: str = "female",
                                   occasion: str = "daily",
                                   brand_style: str = "",
                                   aspect_ratio: str = "1:1",
                                   output_type: str = "image") -> dict:
        """Delegates to visual_lookup.get_visual_recommendations()."""
        return _visual_lookup.get_visual_recommendations(
            BASE_DIR, category, funnel,
            age_range=age_range, gender=gender, occasion=occasion,
            brand_style=brand_style, aspect_ratio=aspect_ratio,
            output_type=output_type,
        )

    def get_step2_recommendations(self, features: dict) -> dict:
        """Delegates to visual_lookup.get_step2_recommendations()."""
        return _visual_lookup.get_step2_recommendations(BASE_DIR, features)

    def get_ad_copy(self, features: dict, ctr: float, conv: float, eng: float) -> dict:
        """Delegates to copy_engine.get_ad_copy."""
        return _get_ad_copy(features, ctr, conv, eng)

    def get_targeting_recommendations(self, features: dict) -> dict:
        """Delegates to targeting.get_targeting_recommendations."""
        return _get_targeting_recommendations(features)


if __name__ == "__main__":
    # Quick smoke-test: run a single prediction and log the result.
    # For a full test suite use tests/ instead.
    logging.basicConfig(level=logging.INFO)
    _smoke_model = RecommendationModel()
    _test = {
        "product_category":     "skincare",
        "decision_attribute_1": "sensitive",
        "decision_attribute_2": "acne",
        "funnel_stage":         "awareness",
        "age_range":            "25-34",
        "gender":               "female",
        "brand_style":          "modern-minimalist",
        "occasion":             "daily",
    }
    _result = _smoke_model.predict(_test)
    logger.info(
        "Smoke test result — CTR=%.2f%%  Conv=%.2f%%  Eng=%.2f%%  similar_profiles=%s",
        _result["ctr"],
        _result["conversion_rate"],
        _result["engagement_rate"],
        _result["similar_profiles"],
    )
