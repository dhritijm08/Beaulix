"""
dataset.py
==========
Dataset I/O and user counter management extracted from model.py (§5.1 split).

Contains:
  - append_to_dataset()      — writes a new row to dataset.csv
  - load_user_counters()     — delegates to cache_manager (kept for compat)

These are the only dataset.csv write-path functions.  All reads (for retrain)
live in retrain.py.  This separation makes the write path independently
testable and keeps model.py as a thin orchestrator.
"""

import os
import logging
from datetime import datetime

import pandas as pd

from constants import FEATURE_COLS

logger = logging.getLogger(__name__)

DATASET_COLUMNS = [
    "product_category",
    "decision_attribute_1",
    "decision_attribute_2",
    "funnel_stage",
    "age_range",
    "gender",
    "occasion",
    "ctr",
    "conversion_rate",
    "engagement_rate",
    "confidence_score",
    "timestamp",
]

PROFILE_COLS = ["age_range", "gender", "product_category", "funnel_stage"]
COMBO_COLS   = FEATURE_COLS


def append_to_dataset(
    dataset_path: str,
    dataset_lock,
    features_dict: dict,
    predictions: dict,
    normalise_value_fn,
    user_profile_counts: dict,
    user_combo_counts: dict,
):
    """
    Append a single prediction row to dataset.csv and update in-memory counters.

    Args:
        dataset_path:        Absolute path to dataset.csv.
        dataset_lock:        threading.Lock guarding CSV writes.
        features_dict:       Raw input features from the prediction request.
        predictions:         Predicted metrics (ctr, conversion_rate, etc.).
        normalise_value_fn:  Callable(col, value) → normalised value string.
        user_profile_counts: Mutable dict {profile_key: count} updated in-place.
        user_combo_counts:   Mutable dict {combo_key: count} updated in-place.
    """
    try:
        def nv(col):
            return normalise_value_fn(col, str(features_dict.get(col, "")))

        row = {
            "product_category":     nv("product_category"),
            "decision_attribute_1": nv("decision_attribute_1"),
            "decision_attribute_2": nv("decision_attribute_2"),
            "funnel_stage":         nv("funnel_stage"),
            "age_range":            nv("age_range"),
            "gender":               nv("gender"),
            "occasion":             nv("occasion"),
            "ctr":                  round(float(predictions.get("ctr",             0)), 4),
            "conversion_rate":      round(float(predictions.get("conversion_rate", 0)), 4),
            "engagement_rate":      round(float(predictions.get("engagement_rate", 0)), 4),
            "confidence_score":     round(float(predictions.get("confidence_score",0)), 4),
            "timestamp":            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        with dataset_lock:
            file_exists = os.path.exists(dataset_path)
            pd.DataFrame([row], columns=DATASET_COLUMNS).to_csv(
                dataset_path, mode="a", header=not file_exists, index=False
            )
            profile_key = tuple(row[c] for c in PROFILE_COLS)
            user_profile_counts[profile_key] = (
                user_profile_counts.get(profile_key, 0) + 1
            )
            combo_key = tuple(row[c] for c in COMBO_COLS)
            user_combo_counts[combo_key] = (
                user_combo_counts.get(combo_key, 0) + 1
            )
    except Exception as e:
        logger.error("dataset.csv append failed: %s", e)
