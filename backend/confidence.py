"""
confidence.py
=============
Confidence interval and confidence score helpers extracted from model.py.

Handles:
  • Brand-style CI  (_brand_style_ci)         — Step 1 uncertainty
  • RF prediction interval (_rf_prediction_interval) — Step 2 uncertainty
  • Confidence score computation               — CV R² + popularity boost

Extracted so these concerns can be tested and evolved independently of the
ML inference pipeline.
"""

import math
import logging
from typing import Optional, Tuple

import numpy as np
import pandas as pd

from constants import (
    CONFIDENCE_COMBO_WEIGHT,
    CONFIDENCE_PROFILE_WEIGHT,
    CONFIDENCE_LOG_SCALE,
    CTR_MAX,
    CONV_MAX,
    ENG_MAX,
)

logger = logging.getLogger(__name__)


def brand_style_std(features_dict: dict, category: str, excel_ci_std: dict,
                    excel_lookup_cols: list, normalise_fn) -> Tuple[float, float, float]:
    """
    Returns (std_ctr, std_conv, std_eng) from the brand-style variance cache.
    Falls back to per-category defaults derived from the Excel dataset when the
    exact combo isn't found.
    """
    key = tuple(
        normalise_fn(col, str(features_dict.get(col, ""))).lower().strip()
        for col in excel_lookup_cols
    )
    cached = excel_ci_std.get(key)
    if cached:
        return cached
    fallback = {
        "makeup":    (0.414, 0.203, 0.490),
        "skincare":  (0.311, 0.197, 0.536),
        "haircare":  (0.290, 0.179, 0.463),
        "fragrance": (0.210, 0.127, 0.339),
        "bodycare":  (0.228, 0.128, 0.361),
    }
    return fallback.get(category, (0.300, 0.170, 0.460))


def brand_style_ci(mean_ctr: float, mean_conv: float, mean_eng: float,
                   features_dict: dict, category: str,
                   excel_ci_std: dict, excel_lookup_cols: list, normalise_fn,
                   z: float = 1.96) -> tuple:
    """
    Computes 95% CI from brand-style spread in the Excel training data.
    Used at Step 1 — reflects uncertainty across creative choices before the
    user has picked a brand style.

    Returns ((ctr_lo, ctr_hi), (conv_lo, conv_hi), (eng_lo, eng_hi))
    """
    std_ctr, std_conv, std_eng = brand_style_std(
        features_dict, category, excel_ci_std, excel_lookup_cols, normalise_fn
    )
    return (
        (round(max(0.0, mean_ctr  - z * std_ctr),  2), round(mean_ctr  + z * std_ctr,  2)),
        (round(max(0.0, mean_conv - z * std_conv), 2), round(mean_conv + z * std_conv, 2)),
        (round(max(0.0, mean_eng  - z * std_eng),  2), round(mean_eng  + z * std_eng,  2)),
    )


def rf_prediction_interval(model, X_input: pd.DataFrame,
                            z: float = 1.96) -> Tuple[float, float]:
    """
    Returns (lower, upper) prediction interval by collecting each decision
    tree's prediction and computing mean ± z*std.

    Used at Step 2 — after the user has fixed brand_style/aspect_ratio/
    output_type, the creative uncertainty collapses, so per-tree variance
    is the right signal.

    z=1.96 → 95% interval.
    Falls back to ±15% if the model has no estimators_ attribute.

    Performance note: iterates over 100 estimators in Python — ~3 ms per call.
    Called 3× per /predict-step2. Vectorisation via internal RF paths is
    possible but a minor optimisation unless Step 2 traffic is very high.
    """
    try:
        tree_preds = np.stack([
            tree.predict(X_input)[0]
            for tree in model.estimators_
        ])
        mean = tree_preds.mean()
        std  = tree_preds.std()
        return round(float(mean - z * std), 3), round(float(mean + z * std), 3)
    except Exception:
        val = float(model.predict(X_input)[0])
        return round(val * 0.85, 3), round(val * 1.15, 3)


def compute_confidence_score(training_stats: dict,
                              combo_submissions: int,
                              similar_profiles: int,
                              ctr_out: float) -> float:
    """
    Compute the confidence score:
      Base: average cross-validated R² across the 3 models (89–91%).
      Popularity boost: +8 * log(1+submissions) / log(1+500) for combo hits.
      Legacy fallback: demographic heuristic when CV scores aren't in the pkl.

    Returns a float in [65, 99].
    """
    cv_r2_ctr  = training_stats.get("cv_r2_ctr")
    cv_r2_conv = training_stats.get("cv_r2_conversion")
    cv_r2_eng  = training_stats.get("cv_r2_engagement")

    popularity_boost = (
        CONFIDENCE_COMBO_WEIGHT
        * math.log1p(combo_submissions)
        / math.log1p(CONFIDENCE_LOG_SCALE)
    )

    if cv_r2_ctr is not None and cv_r2_conv is not None and cv_r2_eng is not None:
        mean_cv_r2 = (cv_r2_ctr + cv_r2_conv + cv_r2_eng) / 3.0
        return round(min(99.0, max(65.0, mean_cv_r2 * 100.0 + popularity_boost)), 2)
    else:
        profile_boost = (
            CONFIDENCE_PROFILE_WEIGHT
            * math.log1p(similar_profiles)
            / math.log1p(CONFIDENCE_LOG_SCALE)
        )
        ctr_penalty = ctr_out * 0.3
        return round(min(99.0, max(65.0, 65.0 + profile_boost - ctr_penalty + popularity_boost)), 2)


def compute_step2_confidence(training_stats: dict, similar_profiles: int,
                             new_ctr: float) -> float:
    """
    Step 2 variant: same CV R² base, +1 point uplift for creative specificity.
    Capped at 97 (not 99) to signal that Step 2 is heuristic-adjusted.
    """
    cv_r2_ctr  = training_stats.get("cv_r2_ctr")
    cv_r2_conv = training_stats.get("cv_r2_conversion")
    cv_r2_eng  = training_stats.get("cv_r2_engagement")

    if cv_r2_ctr is not None and cv_r2_conv is not None and cv_r2_eng is not None:
        mean_cv_r2 = (cv_r2_ctr + cv_r2_conv + cv_r2_eng) / 3.0
        return round(min(97.0, max(66.0, mean_cv_r2 * 100.0 + 1.0)), 2)
    else:
        profile_boost = (
            CONFIDENCE_PROFILE_WEIGHT
            * math.log1p(similar_profiles)
            / math.log1p(CONFIDENCE_LOG_SCALE)
        )
        ctr_penalty = new_ctr * 0.3
        return round(min(97.0, max(66.0, 67.0 + profile_boost - ctr_penalty)), 2)


def clamp_ci_bounds(ctr_lo, ctr_hi, conv_lo, conv_hi, eng_lo, eng_hi,
                    ctr_out, conv_out, eng_out, category: str) -> tuple:
    """
    Apply category max clamping and guarantee lower ≤ point estimate ≤ upper.
    Returns (ctr_lo, ctr_hi, conv_lo, conv_hi, eng_lo, eng_hi).
    """
    ctr_lo  = round(max(0.05, min(CTR_MAX.get(category,  7.0), ctr_lo)),  2)
    ctr_hi  = round(max(0.05, min(CTR_MAX.get(category,  7.0), ctr_hi)),  2)
    conv_lo = round(max(0.05, min(CONV_MAX.get(category, 5.0), conv_lo)), 2)
    conv_hi = round(max(0.05, min(CONV_MAX.get(category, 5.0), conv_hi)), 2)
    eng_lo  = round(max(0.10, min(ENG_MAX.get(category, 13.0), eng_lo)),  2)
    eng_hi  = round(max(0.10, min(ENG_MAX.get(category, 13.0), eng_hi)),  2)

    # Guarantee lower ≤ point estimate ≤ upper
    ctr_lo,  ctr_hi  = min(ctr_lo,  ctr_out),  max(ctr_hi,  ctr_out)
    conv_lo, conv_hi = min(conv_lo, conv_out), max(conv_hi, conv_out)
    eng_lo,  eng_hi  = min(eng_lo,  eng_out),  max(eng_hi,  eng_out)

    return ctr_lo, ctr_hi, conv_lo, conv_hi, eng_lo, eng_hi
