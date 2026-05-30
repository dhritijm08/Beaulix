"""
step2_constants.py
==================
Step 2 creative multipliers and fallback heuristics extracted from constants.py.
Import from this module directly, or from constants.py which re-exports everything.
"""

# ── Step 2 creative multipliers ───────────────────────────────────────
# Applied multiplicatively on top of Step 1 RF predictions.
# brand_style and output_type have the largest effect on CTR/engagement;
# aspect_ratio mostly affects CTR (feed placement efficiency).
# Will be replaced by trained coefficients once retrain data includes
# creative attributes from the Excel training sheets.
STEP2_BRAND_STYLE_MULT: dict = {
    "":                  {"ctr": 1.00, "conv": 1.00, "eng": 1.00},  # No selection — baseline
    "luxury-elegant":    {"ctr": 1.08, "conv": 1.10, "eng": 1.05},
    "modern-minimalist": {"ctr": 1.05, "conv": 1.08, "eng": 1.04},
    "bold-vibrant":      {"ctr": 1.15, "conv": 1.05, "eng": 1.18},
    "natural-organic":   {"ctr": 1.03, "conv": 1.06, "eng": 1.07},
    "glam-dramatic":     {"ctr": 1.12, "conv": 1.07, "eng": 1.14},
    "soft-romantic":     {"ctr": 1.04, "conv": 1.09, "eng": 1.09},
}
STEP2_ASPECT_RATIO_MULT: dict = {
    "9:16": {"ctr": 1.12, "conv": 1.05, "eng": 1.10},  # Stories/Reels format — higher CTR
    "1:1":  {"ctr": 1.00, "conv": 1.00, "eng": 1.00},  # Baseline feed format
    "4:5":  {"ctr": 1.06, "conv": 1.03, "eng": 1.05},  # Portrait feed — slight advantage
    "16:9": {"ctr": 0.95, "conv": 0.98, "eng": 0.97},  # Landscape — lower on mobile feeds
}
STEP2_OUTPUT_TYPE_MULT: dict = {
    "image": {"ctr": 1.00, "conv": 1.00, "eng": 1.00},  # Baseline
    "video": {"ctr": 1.20, "conv": 1.15, "eng": 1.30},  # Video consistently outperforms static
}

# ── Fallback heuristic multipliers (used by model._fallback()) ────────
# These adjust the category baseline when the ML model is unavailable.
# Separate from STEP2_*_MULT which are applied on top of live ML predictions.
FALLBACK_FUNNEL_MULT: dict = {
    "awareness":     {"ctr": 1.2, "conv": 0.6, "eng": 1.3},
    "consideration": {"ctr": 0.9, "conv": 0.9, "eng": 1.0},
    "conversion":    {"ctr": 0.8, "conv": 1.4, "eng": 0.7},
    "retention":     {"ctr": 0.7, "conv": 1.2, "eng": 0.8},
}
