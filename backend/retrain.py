"""
retrain.py
==========
Background retraining logic extracted from model.py (§5.1 split).

Contains:
  - _retrain_background_task() — the inner task() function logic
  - submit_retrain()           — schedules the task on executor or daemon thread

RecommendationModel delegates to submit_retrain() so model.py stays as a
thin orchestrator.  All retrain state (locks, counters, model swap) is passed
explicitly; no circular imports.
"""

import os
import threading
import time
import logging

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.preprocessing import LabelEncoder
from sklearn.model_selection import cross_val_score, KFold

from constants import FEATURE_COLS, RF_PARAMS

logger = logging.getLogger(__name__)

# Module-level retrain lock — prevents concurrent retrains regardless of which
# code path triggers them.
retrain_lock = threading.Lock()


def run_retrain_task(
    *,
    model_path: str,
    dataset_path: str,
    load_excel_base_df,
    apply_model_data_fn,
    get_training_stats_fn,
    set_last_retrain_time_fn,
    set_dataset_rows_fn,
    get_user_profile_counts_fn,
):
    """
    Core retrain logic.  Retrains all 3 RF models on base Excel + accumulated
    user inputs, then hot-swaps the in-memory model.

    All mutable state is accessed through callback functions so this module
    has no direct reference to RecommendationModel.
    """
    if not retrain_lock.acquire(blocking=False):
        logger.info("Retrain skipped (already running)")
        return
    try:
        logger.info("🔄 Background retrain started...")

        base_df = load_excel_base_df()

        if os.path.exists(dataset_path):
            user_df = pd.read_csv(dataset_path)
            # Schema validation: only use columns that exist in the CSV.
            # Logs a warning if expected columns are missing so schema drift
            # is visible in logs rather than silently degrading model quality.
            needed = FEATURE_COLS + ["ctr", "conversion_rate", "engagement_rate"]
            missing = [c for c in needed if c not in user_df.columns]
            if missing:
                logger.warning(
                    "dataset.csv is missing expected columns: %s — "
                    "retrain will proceed without them.  "
                    "Check for schema migration or manual edits.",
                    missing,
                )
            user_df = user_df[[c for c in needed if c in user_df.columns]]

            freq = user_df.groupby(FEATURE_COLS, dropna=False).size().reset_index(name="_freq")
            user_df = user_df.merge(freq, on=FEATURE_COLS, how="left")
            user_df["_freq"] = user_df["_freq"].clip(upper=500)
            user_weighted = user_df.loc[
                user_df.index.repeat(user_df["_freq"])
            ].drop(columns=["_freq"]).reset_index(drop=True)

            combined = pd.concat([base_df, user_weighted], ignore_index=True)
            unique_combos = len(freq)
            logger.info(
                "   Base: %s rows + User: %s raw rows (%s unique combos, "
                "weighted to %s rows) = %s total",
                f"{len(base_df):,}", f"{len(user_df):,}", unique_combos,
                f"{len(user_weighted):,}", f"{len(combined):,}",
            )
        else:
            combined = base_df
            logger.info("   Base only: %s rows", len(combined))

        label_encoders = {}
        X = pd.DataFrame()
        for col in FEATURE_COLS:
            le = LabelEncoder()
            X[col] = le.fit_transform(combined[col].astype(str))
            label_encoders[col] = le

        y_ctr  = combined["ctr"].astype(float)
        y_conv = combined["conversion_rate"].astype(float)
        y_eng  = combined["engagement_rate"].astype(float)

        _bg_fit_params = {**RF_PARAMS, "n_jobs": 2}
        ctr_model = RandomForestRegressor(**_bg_fit_params)
        ctr_model.fit(X, y_ctr)
        conv_model = RandomForestRegressor(**_bg_fit_params)
        conv_model.fit(X, y_conv)
        eng_model = RandomForestRegressor(**_bg_fit_params)
        eng_model.fit(X, y_eng)

        r2_ctr  = round(ctr_model.score(X, y_ctr),   4)
        r2_conv = round(conv_model.score(X, y_conv), 4)
        r2_eng  = round(eng_model.score(X, y_eng),   4)

        total_rows = len(combined)
        _CV_SAMPLE_SIZE = 10_000
        if total_rows > _CV_SAMPLE_SIZE:
            sample_idx = np.random.default_rng(seed=42).choice(
                total_rows, size=_CV_SAMPLE_SIZE, replace=False
            )
            X_cv = X.iloc[sample_idx]
            y_ctr_cv  = y_ctr.iloc[sample_idx]
            y_conv_cv = y_conv.iloc[sample_idx]
            y_eng_cv  = y_eng.iloc[sample_idx]
            logger.info(
                "CV running on %d-row sample (dataset has %d rows)",
                _CV_SAMPLE_SIZE, total_rows,
            )
        else:
            X_cv, y_ctr_cv, y_conv_cv, y_eng_cv = X, y_ctr, y_conv, y_eng

        if len(X_cv) >= 50:
            _bg_cv_params = {**RF_PARAMS, "n_jobs": 2}
            kf = KFold(n_splits=5, shuffle=True, random_state=42)
            cv_ctr  = cross_val_score(RandomForestRegressor(**_bg_cv_params), X_cv, y_ctr_cv,  cv=kf, scoring="r2", n_jobs=2)
            cv_conv = cross_val_score(RandomForestRegressor(**_bg_cv_params), X_cv, y_conv_cv, cv=kf, scoring="r2", n_jobs=2)
            cv_eng  = cross_val_score(RandomForestRegressor(**_bg_cv_params), X_cv, y_eng_cv,  cv=kf, scoring="r2", n_jobs=2)
            cv_r2_ctr  = round(float(cv_ctr.mean()),  4)
            cv_r2_conv = round(float(cv_conv.mean()), 4)
            cv_r2_eng  = round(float(cv_eng.mean()),  4)
            cv_r2_ctr_std  = round(float(cv_ctr.std()),  4)
            cv_r2_conv_std = round(float(cv_conv.std()), 4)
            cv_r2_eng_std  = round(float(cv_eng.std()),  4)
            logger.info(
                "   CV R²  CTR=%s±%s  Conv=%s±%s  Eng=%s±%s",
                cv_r2_ctr, cv_r2_ctr_std, cv_r2_conv, cv_r2_conv_std, cv_r2_eng, cv_r2_eng_std,
            )
        else:
            logger.warning(
                "CV skipped — fewer than 50 rows available (got %d)."
                " Reporting stale cv_r2 values from previous training run.",
                len(X_cv),
            )
            training_stats = get_training_stats_fn()
            cv_r2_ctr      = training_stats.get("cv_r2_ctr")
            cv_r2_conv     = training_stats.get("cv_r2_conversion")
            cv_r2_eng      = training_stats.get("cv_r2_engagement")
            cv_r2_ctr_std  = training_stats.get("cv_r2_ctr_std")
            cv_r2_conv_std = training_stats.get("cv_r2_conv_std")
            cv_r2_eng_std  = training_stats.get("cv_r2_eng_std")

        logger.info(
            "✅ Retrain done | R²  CTR=%s  Conv=%s  Eng=%s",
            r2_ctr, r2_conv, r2_eng,
        )

        feature_values = {
            col: list(label_encoders[col].classes_)
            for col in FEATURE_COLS
        }
        new_data = {
            "ctr_model":        ctr_model,
            "conversion_model": conv_model,
            "engagement_model": eng_model,
            "label_encoders":   label_encoders,
            "feature_columns":  FEATURE_COLS,
            "feature_values":   feature_values,
            "training_stats": {
                "seeded_rows":       len(combined),
                "r2_ctr":            r2_ctr,
                "r2_conversion":     r2_conv,
                "r2_engagement":     r2_eng,
                "cv_r2_ctr":         cv_r2_ctr,
                "cv_r2_conversion":  cv_r2_conv,
                "cv_r2_engagement":  cv_r2_eng,
                "cv_r2_ctr_std":     cv_r2_ctr_std,
                "cv_r2_conv_std":    cv_r2_conv_std,
                "cv_r2_eng_std":     cv_r2_eng_std,
            },
        }
        _tmp_path = model_path + ".tmp"
        joblib.dump(new_data, _tmp_path)
        os.replace(_tmp_path, model_path)
        apply_model_data_fn(new_data)
        set_last_retrain_time_fn()
        set_dataset_rows_fn(get_user_profile_counts_fn())
        logger.info("💾 Model overwritten -> %s", model_path)

    except Exception as e:
        logger.error("Retrain failed: %s", e, exc_info=True)
    finally:
        retrain_lock.release()


def submit_retrain(task_fn, executor=None, shutdown_event=None):
    """
    Schedule a retrain task on executor (preferred) or a daemon thread
    (fallback when no executor is available, e.g. during startup).
    """
    if executor is not None:
        executor.submit(task_fn)
    else:
        _shutdown_event = shutdown_event

        def _guarded_task():
            if _shutdown_event and _shutdown_event.is_set():
                return
            task_fn()

        threading.Thread(target=_guarded_task, daemon=True).start()
