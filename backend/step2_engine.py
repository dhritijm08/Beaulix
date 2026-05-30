"""
step2_engine.py
===============
Step 2 creative-multiplier engine extracted from model.py.

Applies the hand-tuned brand_style / aspect_ratio / output_type multipliers
to Step 1 predictions to produce Step 2 estimates.

⚠️  PRODUCT INTEGRITY NOTE:
These multipliers are hand-tuned heuristics based on general creative
best-practice research for beauty brand ads.  They are NOT derived from the
training data or validated against real campaign outcomes.  The
``step2_scores_are_heuristic_estimates`` flag in the response signals this to
the frontend, which must label the delta as "creative estimates".

Extracted so the multiplier logic can be tested without instantiating
RecommendationModel.
"""

import logging
from typing import Callable

import pandas as pd

from step2_constants import (
    STEP2_BRAND_STYLE_MULT,
    STEP2_ASPECT_RATIO_MULT,
    STEP2_OUTPUT_TYPE_MULT,
)
from constants import (
    CTR_MAX,
    CONV_MAX,
    ENG_MAX,
)
import confidence as _conf

logger = logging.getLogger(__name__)


def apply_step2_multipliers(step1_ctr: float, step1_conv: float, step1_eng: float,
                             brand_style: str, aspect_ratio: str, output_type: str,
                             category: str) -> tuple:
    """
    Apply brand_style × aspect_ratio × output_type multipliers to Step 1 values.
    Returns (new_ctr, new_conv, new_eng) clamped to category maxes.
    """
    bm = STEP2_BRAND_STYLE_MULT.get(brand_style,  STEP2_BRAND_STYLE_MULT[""])
    am = STEP2_ASPECT_RATIO_MULT.get(aspect_ratio, STEP2_ASPECT_RATIO_MULT["1:1"])
    om = STEP2_OUTPUT_TYPE_MULT.get(output_type,   STEP2_OUTPUT_TYPE_MULT["image"])

    def _apply(base_val, key, cat_max):
        val = base_val * bm[key] * am[key] * om[key]
        return round(min(cat_max, max(0.1, val)), 2)

    new_ctr  = _apply(step1_ctr,  "ctr",  CTR_MAX.get(category,  7.0))
    new_conv = _apply(step1_conv, "conv", CONV_MAX.get(category, 5.0))
    new_eng  = _apply(step1_eng,  "eng",  ENG_MAX.get(category, 13.0))
    return new_ctr, new_conv, new_eng, bm, am, om


def build_step2_response(features_dict: dict, step1: dict,
                          encode_input_fn: Callable,
                          rf_interval_fn: Callable,
                          training_stats: dict,
                          get_ad_copy_fn: Callable,
                          get_targeting_fn: Callable) -> dict:
    """
    Build the full /predict-step2 response dict.

    Args:
        features_dict: Full Step 1 + Step 2 inputs from the request.
        step1: Result of predict(features_dict, save_to_dataset=False).
        encode_input_fn: Callable that encodes features_dict → pd.DataFrame.
        rf_interval_fn: Callable(model, X_input) → (lo, hi).
        training_stats: Model training_stats dict.
        get_ad_copy_fn: Callable(features, ctr, conv, eng) → dict.
        get_targeting_fn: Callable(features) → dict.
    """
    brand_style  = (features_dict.get("brand_style")  or "").lower()
    aspect_ratio = (features_dict.get("aspect_ratio") or "1:1")
    output_type  = (features_dict.get("output_type")  or "image").lower()
    category     = (features_dict.get("product_category") or "skincare").lower()

    step1_ctr  = step1["ctr"]
    step1_conv = step1["conversion_rate"]
    step1_eng  = step1["engagement_rate"]

    new_ctr, new_conv, new_eng, bm, am, om = apply_step2_multipliers(
        step1_ctr, step1_conv, step1_eng,
        brand_style, aspect_ratio, output_type, category
    )

    # Sanity-check: log a warning if Step 2 multipliers produce values that look
    # implausibly large relative to Step 1.  This catches buggy multiplier values
    # before they reach users (see code review note in step2_engine.py).
    _STEP2_SANITY_RATIO = 2.0
    if step1_ctr  and new_ctr  > _STEP2_SANITY_RATIO * step1_ctr:
        logger.warning(
            "step2 sanity: new_ctr=%.3f > %.1fx step1_ctr=%.3f — check multipliers "
            "(brand_style=%r, aspect_ratio=%r, output_type=%r)",
            new_ctr, _STEP2_SANITY_RATIO, step1_ctr, brand_style, aspect_ratio, output_type,
        )
    if step1_conv and new_conv > _STEP2_SANITY_RATIO * step1_conv:
        logger.warning(
            "step2 sanity: new_conv=%.3f > %.1fx step1_conv=%.3f — check multipliers",
            new_conv, _STEP2_SANITY_RATIO, step1_conv,
        )
    if step1_eng  and new_eng  > _STEP2_SANITY_RATIO * step1_eng:
        logger.warning(
            "step2 sanity: new_eng=%.3f > %.1fx step1_eng=%.3f — check multipliers",
            new_eng, _STEP2_SANITY_RATIO, step1_eng,
        )

    confidence = _conf.compute_step2_confidence(
        training_stats, step1["similar_profiles"], new_ctr
    )

    # RF prediction intervals on Step 2 inputs (per-tree variance is the right
    # signal once creative choices are fixed — brand-style CI would be too wide)
    X_input = encode_input_fn(features_dict)

    # We need the three models — passed in via rf_interval_fn closures
    ctr_lo_r,  ctr_hi_r  = rf_interval_fn("ctr",  X_input)
    conv_lo_r, conv_hi_r = rf_interval_fn("conv", X_input)
    eng_lo_r,  eng_hi_r  = rf_interval_fn("eng",  X_input)

    def _s2_apply(v, key):
        return v * bm[key] * am[key] * om[key]

    def _ci_clamp(v, floor, ceil_val):
        return round(max(floor, min(ceil_val, max(0.0, v))), 2)

    s2_ctr_lo  = _ci_clamp(_s2_apply(ctr_lo_r,  "ctr"),  0.05, CTR_MAX.get(category,  7.0))
    s2_ctr_hi  = _ci_clamp(_s2_apply(ctr_hi_r,  "ctr"),  0.05, CTR_MAX.get(category,  7.0))
    s2_conv_lo = _ci_clamp(_s2_apply(conv_lo_r, "conv"), 0.05, CONV_MAX.get(category, 5.0))
    s2_conv_hi = _ci_clamp(_s2_apply(conv_hi_r, "conv"), 0.05, CONV_MAX.get(category, 5.0))
    s2_eng_lo  = _ci_clamp(_s2_apply(eng_lo_r,  "eng"),  0.10, ENG_MAX.get(category, 13.0))
    s2_eng_hi  = _ci_clamp(_s2_apply(eng_hi_r,  "eng"),  0.10, ENG_MAX.get(category, 13.0))

    # Guarantee lower ≤ point estimate ≤ upper
    s2_ctr_lo,  s2_ctr_hi  = min(s2_ctr_lo,  new_ctr),  max(s2_ctr_hi,  new_ctr)
    s2_conv_lo, s2_conv_hi = min(s2_conv_lo, new_conv), max(s2_conv_hi, new_conv)
    s2_eng_lo,  s2_eng_hi  = min(s2_eng_lo,  new_eng),  max(s2_eng_hi,  new_eng)

    return {
        "success": True,
        # ⚠️  step2_scores_are_heuristic_estimates = True signals that the delta
        # between step1 and step2 scores is produced by hand-tuned multipliers,
        # NOT by the ML model. The frontend must present these as "creative estimates".
        "step2_scores_are_heuristic_estimates": True,
        "step1": {
            "ctr":             step1_ctr,
            "conversion_rate": step1_conv,
            "engagement_rate": step1_eng,
            "confidence_score": step1["confidence_score"],
        },
        "step2": {
            "ctr":             new_ctr,
            "conversion_rate": new_conv,
            "engagement_rate": new_eng,
            "confidence_score": round(confidence, 2),
        },
        "delta": {
            "ctr":             round(new_ctr  - step1_ctr,  2),
            "conversion_rate": round(new_conv - step1_conv, 2),
            "engagement_rate": round(new_eng  - step1_eng,  2),
            "confidence_score": round(confidence - step1["confidence_score"], 2),
        },
        "pct_change": {
            "ctr":             round((new_ctr  / step1_ctr  - 1) * 100, 1) if step1_ctr  else 0,
            "conversion_rate": round((new_conv / step1_conv - 1) * 100, 1) if step1_conv else 0,
            "engagement_rate": round((new_eng  / step1_eng  - 1) * 100, 1) if step1_eng  else 0,
        },
        "multipliers_applied": {
            "brand_style":  brand_style,
            "aspect_ratio": aspect_ratio,
            "output_type":  output_type,
        },
        "benchmarks":        step1.get("benchmarks", {}),
        "similar_profiles":  step1["similar_profiles"],
        "confidence_interval": {
            "ctr":             {"lower": s2_ctr_lo,  "upper": s2_ctr_hi},
            "conversion_rate": {"lower": s2_conv_lo, "upper": s2_conv_hi},
            "engagement_rate": {"lower": s2_eng_lo,  "upper": s2_eng_hi},
        },
        "ad_copy":   get_ad_copy_fn(features_dict, new_ctr, new_conv, new_eng),
        "targeting": get_targeting_fn(features_dict),
    }
