"""
constants.py
============
Single source of truth for ML parameters, column maps, and target metrics.

Ad-copy lookup tables live in copy_constants.py — import from there directly.
Step 2 multipliers live in step2_constants.py — import from there directly.

All importers have been updated to use the correct source file, so no re-export
layer is needed here.  Previously re-exported names were removed as part of the
§7.4 cleanup: commit to the three-file split with direct imports.
"""

# ── Column renaming: Excel header → internal name ─────────────────────
EXCEL_COL_MAP = {
    "Product Category":    "product_category",
    "Attribute 1":         "decision_attribute_1",
    "Attribute 2":         "decision_attribute_2",
    "Funnel Stage":        "funnel_stage",
    "Age Range":           "age_range",
    "Gender":              "gender",
    "Occasion":            "occasion",
    "Pred CTR (%)":        "ctr",
    "Pred Conv Rate (%)":  "conversion_rate",
    "Pred Engagement (%)": "engagement_rate",
}

# ── Feature columns used for ML prediction ────────────────────────────
# brand_style is intentionally excluded — it's a visual/creative input
# for the image generator, not a marketing performance predictor.
FEATURE_COLS = [
    "product_category",
    "decision_attribute_1",
    "decision_attribute_2",
    "funnel_stage",
    "age_range",
    "gender",
    "occasion",
]

# ── Columns that must be dropped from Excel before training ───────────
# These are derived/leakage columns that should never be model features.
LEAKAGE_COLS = [
    "Performance Tier",
    "CTR vs Industry (%)",
    "Conv vs Industry (%)",
    "Eng vs Industry (%)",
    "Composite Score",
    "Brand Style",  # kept in CSV for records but not a prediction feature
]

# ── Age-range normalisation (single source of truth) ─────────────────
# Excel training data uses "45-54"; the frontend sends "45-60".
# Defined here so both excel_cache.py (load_base_df) and
# train_simple_model.py import from one place instead of each
# hardcoding the same literal dict.
EXCEL_AGE_NORMALISE: dict = {
    "45-54": "45-60",
}

VALUE_NORMALISATIONS: dict = {}
# ^ INTENTIONALLY EMPTY — do not add entries unless the frontend and Excel training
# data genuinely diverge.  Current status:
#   • age_range:  train_simple_model.py normalises "45-54" → "45-60" before fitting,
#                 so the encoder knows "45-60" and the frontend sends "45-60". No mapping needed.
#   • gender:     train_simple_model.py synthesises "non-binary" and "all-genders" rows
#                 so both are first-class encoder classes. No mapping needed.
# The _normalise_value() method in model.py still calls this dict on every request so
# that future divergences can be fixed here with one line — but it is effectively a
# no-op. Do NOT remove the dict or the method; add mappings here when needed.
#
# WARNING: Adding a mapping remaps ALL predictions for that (col, value) pair, including
# cached Excel lookups and background retrain data.  This can silently change model
# behaviour for existing users.  Add a test in tests/ asserting the dict stays empty
# until you explicitly intend to change it:
#   assert VALUE_NORMALISATIONS == {}, "Update this test if you intentionally added a mapping"

# ── RandomForest hyperparameters ──────────────────────────────────────
RF_PARAMS = dict(
    n_estimators=100,
    max_depth=10,
    min_samples_split=5,
    min_samples_leaf=2,
    random_state=42,
    n_jobs=-1,
)

# ── Benchmark display values (industry averages from Excel dataset) ───
CTR_TARGETS = {
    "skincare":  1.892,
    "makeup":    2.825,
    "haircare":  1.787,
    "fragrance": 1.232,
    "bodycare":  1.332,
}
CONV_TARGETS = {
    "skincare":  1.168,
    "makeup":    1.372,
    "haircare":  1.093,
    "fragrance": 0.653,
    "bodycare":  0.817,
}
ENG_TARGETS = {
    "skincare":  4.015,
    "makeup":    3.701,
    "haircare":  3.503,
    "fragrance": 2.491,
    "bodycare":  2.662,
}

# ── Per-category prediction ceilings (95th percentile from Excel) ─────
CTR_MAX  = {"skincare": 7.0, "makeup": 10.0, "haircare": 7.0, "fragrance": 5.5, "bodycare": 5.0}
CONV_MAX = {"skincare": 5.0, "makeup":  6.0, "haircare": 5.0, "fragrance": 3.5, "bodycare": 3.5}
ENG_MAX  = {"skincare": 13.0, "makeup": 13.0, "haircare": 11.0, "fragrance": 9.0, "bodycare": 8.0}

# ── Confidence score formula constants ────────────────────────────────
# Used in predict() and predict_step2() to compute the confidence score.
# Formula: score = cv_r2 * 100 + CONFIDENCE_COMBO_WEIGHT * log1p(combo_submissions) / log1p(CONFIDENCE_LOG_SCALE)
#                                + CONFIDENCE_PROFILE_WEIGHT * log1p(similar_profiles) / log1p(CONFIDENCE_LOG_SCALE)
# Rationale for weights:
#   COMBO   — max boost of +8 at 500 submissions (popularity signal, smaller weight)
#   PROFILE — max boost of +28 at 500 profiles (demographic fit, larger weight)
#   LOG_SCALE — normaliser so boost saturates at ~500 data points
CONFIDENCE_COMBO_WEIGHT: float   = 8.0
CONFIDENCE_PROFILE_WEIGHT: float = 28.0
CONFIDENCE_LOG_SCALE: float      = 500.0


