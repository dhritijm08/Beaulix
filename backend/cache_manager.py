"""
cache_manager.py
================
Excel and user-counter caching logic extracted from model.py (§5.4 refactor).

Contains the methods responsible for building and querying the in-memory
lookup caches that make O(1) exact-match prediction possible at request time:

  • build_excel_profile_counts() — demographic combo → row count from Excel
  • build_excel_lookup()         — full 7-key combo → (ctr, conv, eng) means + stds
  • load_user_counters()         — read dataset.csv into profile/combo dicts
  • excel_exact_match()          — O(1) lookup into the Excel mean cache
  • similar_profile_count()      — Excel + user row counts for a demographic profile
  • combo_submission_count()     — exact-combo count from user dataset

These functions operate on plain dicts passed in by RecommendationModel so they
can be tested without instantiating the full model class.
"""

import logging
import os

import pandas as pd

from constants import FEATURE_COLS

logger = logging.getLogger(__name__)

PROFILE_COLS = ["age_range", "gender", "product_category", "funnel_stage"]
COMBO_COLS   = FEATURE_COLS

EXCEL_LOOKUP_COLS = [
    "product_category", "decision_attribute_1", "decision_attribute_2",
    "funnel_stage", "age_range", "gender", "occasion",
]


def build_excel_profile_counts(load_base_df_fn) -> dict:
    """
    Build a dict mapping (age_range, gender, product_category, funnel_stage)
    tuples to the count of Excel rows with that profile.

    Args:
        load_base_df_fn: Callable() -> pd.DataFrame.  Should be
            RecommendationModel._load_excel_base_df or equivalent.

    Returns:
        dict mapping profile tuple -> int count.  Empty dict on failure.
    """
    try:
        df = load_base_df_fn()
        grouped = df.groupby(PROFILE_COLS, dropna=False).size()
        result = {k: int(v) for k, v in grouped.items()}
        logger.info(
            "📊 Excel profile cache built — %s unique demographic combos",
            len(result),
        )
        return result
    except Exception as e:
        logger.warning("Excel profile cache failed: %s", e)
        return {}


def build_excel_lookup(load_base_df_fn, normalise_fn) -> tuple[dict, dict]:
    """
    Pre-build two dicts for O(1) exact-match lookups at request time.

    Args:
        load_base_df_fn: Callable() -> pd.DataFrame.
        normalise_fn: Callable(col, value) -> str.

    Returns:
        (excel_lookup, excel_ci_std) — both map 7-tuple keys to
        (ctr, conv, eng) float triples.
    """
    try:
        df = load_base_df_fn()
        for col in EXCEL_LOOKUP_COLS:
            df[col] = df[col].astype(str).str.lower().str.strip()
        df["_key"] = list(zip(*[df[col] for col in EXCEL_LOOKUP_COLS]))
        grouped = df.groupby("_key")[["ctr", "conversion_rate", "engagement_rate"]]
        means   = grouped.mean().round(3)
        stds    = grouped.std(ddof=0).round(4)
        excel_lookup = {
            k: (row["ctr"], row["conversion_rate"], row["engagement_rate"])
            for k, row in means.iterrows()
        }
        excel_ci_std = {
            k: (row["ctr"], row["conversion_rate"], row["engagement_rate"])
            for k, row in stds.iterrows()
        }
        logger.info(
            "📊 Excel exact-match cache built — %s unique input combinations",
            f"{len(excel_lookup):,}",
        )
        return excel_lookup, excel_ci_std
    except Exception as e:
        logger.warning("Excel lookup cache failed: %s", e)
        return {}, {}


def load_user_counters(dataset_path: str, dataset_lock) -> tuple[dict, dict]:
    """
    Read dataset.csv once at startup to populate in-memory profile/combo counters.

    Args:
        dataset_path: Absolute path to dataset.csv.
        dataset_lock: threading.Lock protecting dataset.csv reads/writes.

    Returns:
        (user_profile_counts, user_combo_counts) — both plain dicts.
    """
    user_profile_counts: dict = {}
    user_combo_counts:   dict = {}

    if not os.path.exists(dataset_path):
        return user_profile_counts, user_combo_counts

    try:
        with dataset_lock:
            df = pd.read_csv(
                dataset_path,
                usecols=list(set(PROFILE_COLS + COMBO_COLS)),
            )
        for tup, cnt in df.groupby(PROFILE_COLS, dropna=False).size().items():
            user_profile_counts[tup] = int(cnt)
        for tup, cnt in df.groupby(COMBO_COLS, dropna=False).size().items():
            user_combo_counts[tup] = int(cnt)
        logger.info(
            "📂 User counters loaded — %s profile combos, %s exact combos",
            len(user_profile_counts), len(user_combo_counts),
        )
    except Exception as e:
        logger.warning("load_user_counters failed: %s", e)

    return user_profile_counts, user_combo_counts


def excel_exact_match(features_dict: dict, excel_lookup: dict, normalise_fn):
    """
    Return (ctr, conv, eng) from the Excel mean cache for an exact input match,
    or None if the combination is not present.
    """
    key = tuple(
        normalise_fn(col, str(features_dict.get(col, ""))).lower().strip()
        for col in EXCEL_LOOKUP_COLS
    )
    return excel_lookup.get(key)


def similar_profile_count(
    features_dict: dict,
    excel_profile_counts: dict,
    user_profile_counts: dict,
    normalise_fn,
) -> int:
    """Return Excel + user row counts for the demographic profile of features_dict."""
    try:
        profile = tuple(
            normalise_fn(col, str(features_dict.get(col, "")))
            for col in PROFILE_COLS
        )
        return excel_profile_counts.get(profile, 0) + user_profile_counts.get(profile, 0)
    except Exception as e:
        logger.warning("similar_profile_count failed: %s", e)
        return 0


def combo_submission_count(
    features_dict: dict,
    user_combo_counts: dict,
    normalise_fn,
) -> int:
    """Return the number of times this exact feature combination appears in user data."""
    try:
        combo = tuple(
            normalise_fn(col, str(features_dict.get(col, "")))
            for col in COMBO_COLS
        )
        return user_combo_counts.get(combo, 0)
    except Exception as e:
        logger.warning("combo_submission_count failed: %s", e)
        return 0
