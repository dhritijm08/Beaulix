"""
visual_lookup.py
================
Visual brief and Step 2 recommendation lookups extracted from model.py.

Handles:
  • get_visual_recommendations() — looks up beaulix_visual_brief.xlsx
  • get_step2_recommendations()  — looks up beaulix_step2_recommendations.xlsx
  • _visual_brief_fallback()     — hardcoded fallback if xlsx is missing

DataFrames are sourced from excel_cache.load_visual_data() which loads them
once at startup (in the lifespan handler) and caches module-level.  Callers
should call excel_cache.load_visual_data(base_dir) at startup so that every
request hits the in-memory cache with zero disk I/O.
"""

import logging

import pandas as pd

import excel_cache as _excel_cache

logger = logging.getLogger(__name__)

OUTPUT_COLS = [
    "VISUAL_SHOT", "LIGHTING", "COMPOSITION", "PROPS",
    "MODEL_EXPRESSION", "CAMERA_ANGLE", "BACKGROUND", "COLOR_PALETTE",
]


def get_visual_recommendations(base_dir: str,
                                category: str, funnel: str,
                                age_range: str = "25-34",
                                gender: str = "female",
                                occasion: str = "daily",
                                brand_style: str = "",
                                aspect_ratio: str = "1:1",
                                output_type: str = "image") -> dict:
    """
    Looks up the visual creative brief from beaulix_visual_brief.xlsx using
    all 8 dimensions.  Falls back gracefully if the file is missing or no
    exact row is found (relaxes gender → female, then occasion → daily).

    DataFrames are read from excel_cache (loaded once at startup) — this
    function no longer calls _load_visual_data() on every invocation.
    """
    # Read the already-cached DataFrame from excel_cache module state.
    df, _ = _excel_cache.load_visual_data(base_dir)

    # Normalise inputs to match dataset values
    category     = (category     or "skincare").lower()
    funnel       = (funnel       or "awareness").lower()
    age_range    = (age_range    or "25-34")
    gender       = (gender       or "female").lower()
    occasion     = (occasion     or "daily").lower()
    brand_style  = (brand_style  or "luxury-elegant").lower()
    aspect_ratio = (aspect_ratio or "1:1")
    output_type  = (output_type  or "image").lower()

    if df.empty:
        return _visual_brief_fallback(category, funnel)

    def lookup(g, occ):
        mask = (
            (df["product_category"] == category) &
            (df["funnel_stage"]      == funnel) &
            (df["age_range"]         == age_range) &
            (df["gender"]            == g) &
            (df["occasion"]          == occ) &
            (df["brand_style"]       == brand_style) &
            (df["aspect_ratio"]      == aspect_ratio) &
            (df["output_type"]       == output_type)
        )
        return df[mask]

    for g, occ in [
        (gender,   occasion),
        ("female", occasion),
        (gender,   "daily"),
        ("female", "daily"),
    ]:
        rows = lookup(g, occ)
        if not rows.empty:
            row = rows.iloc[0]
            return {col: str(row[col]) for col in OUTPUT_COLS if col in row}

    logger.warning(
        "No visual brief row found for %s/%s/%s/%s/%s/%s",
        category, funnel, age_range, gender, occasion, brand_style,
    )
    return _visual_brief_fallback(category, funnel)


def get_step2_recommendations(base_dir: str, features: dict) -> dict:
    """
    Returns recommended Step 2 selections (brand style, aspect ratio,
    output type, creative approach, suggested scene) based on Step 1 inputs.
    Looked up from beaulix_step2_recommendations.xlsx (cached at startup).
    """
    _, df = _excel_cache.load_visual_data(base_dir)
    if df.empty:
        return {}

    category  = (features.get("product_category") or "skincare").lower()
    funnel    = (features.get("funnel_stage")      or "awareness").lower()
    age_range = (features.get("age_range")         or "25-34")
    gender    = (features.get("gender")            or "female").lower()
    occasion  = (features.get("occasion")          or "daily").lower()

    def lookup(g, occ):
        mask = (
            (df["product_category"] == category) &
            (df["funnel_stage"]      == funnel) &
            (df["age_range"]         == age_range) &
            (df["gender"]            == g) &
            (df["occasion"]          == occ)
        )
        return df[mask]

    for g, occ in [
        (gender,   occasion),
        ("female", occasion),
        (gender,   "daily"),
        ("female", "daily"),
    ]:
        rows = lookup(g, occ)
        if not rows.empty:
            row = rows.iloc[0]
            return {
                "recommended_brand_style":       str(row.get("recommended_brand_style",       "")),
                "recommended_aspect_ratio":      str(row.get("recommended_aspect_ratio",      "")),
                "recommended_output_type":       str(row.get("recommended_output_type",       "")),
                "recommended_creative_approach": str(row.get("recommended_creative_approach", "")),
                "suggested_scene":               str(row.get("suggested_scene",               "")),
                "include_human_face":            str(row.get("include_human_face",            "")),
                "brand_style_reason":            str(row.get("brand_style_reason",            "")),
                "aspect_ratio_reason":           str(row.get("aspect_ratio_reason",           "")),
                "output_type_reason":            str(row.get("output_type_reason",            "")),
            }
    return {}


def _visual_brief_fallback(category: str, funnel: str) -> dict:
    """Hardcoded fallback used only when the xlsx lookup fails entirely."""
    lighting_map = {
        "awareness":     "Soft natural daylight — open, welcoming, editorial",
        "consideration": "Bright clinical studio light — detailed, trustworthy",
        "conversion":    "Dramatic product spotlight — desire-driving contrast",
        "retention":     "Warm golden-hour lifestyle light — cosy, aspirational",
    }
    composition_map = {
        "awareness":     "Rule of thirds — product left, negative space right for text overlay",
        "consideration": "Split-screen before/after or ingredient close-up grid",
        "conversion":    "Hero centred shot — product dominant, price/offer overlay space",
        "retention":     "Lifestyle flatlay — product in daily-use context",
    }
    shot_map = {
        ("skincare",  "awareness"):     "Model applying serum, dewy skin close-up",
        ("skincare",  "consideration"): "Ingredient macro shot + skin texture comparison",
        ("skincare",  "conversion"):    "Product bottle hero with before/after skin strip",
        ("skincare",  "retention"):     "Morning skincare ritual flatlay on marble vanity",
        ("makeup",    "awareness"):     "Bold lip or eye look — expressive face, clean background",
        ("makeup",    "consideration"): "Shade range spread + swatches on diverse skin tones",
        ("makeup",    "conversion"):    "Product + finished look side by side, price badge",
        ("makeup",    "retention"):     "Get-ready-with-me lifestyle vignette",
        ("haircare",  "awareness"):     "Hair transformation — wind-blown healthy hair hero",
        ("haircare",  "consideration"): "Ingredient benefit infographic overlay on product",
        ("haircare",  "conversion"):    "Before/after hair texture close-up with CTA space",
        ("haircare",  "retention"):     "Morning haircare routine flatlay",
        ("fragrance", "awareness"):     "Mood editorial — misty bottle in luxury setting",
        ("fragrance", "consideration"): "Bottle detail macro + scent-note typography",
        ("fragrance", "conversion"):    "Gift-ready product shot — box, ribbon, limited-time badge",
        ("fragrance", "retention"):     "Lifestyle — person in aspirational scene, bottle in hand",
        ("bodycare",  "awareness"):     "Skin texture close-up — smooth, glowing body shot",
        ("bodycare",  "consideration"): "Ingredient story — natural source to product",
        ("bodycare",  "conversion"):    "Product hero + skin-feel result, CTA overlay space",
        ("bodycare",  "retention"):     "Spa self-care flatlay — towels, candles, product",
    }
    props_map = {
        "skincare":  "Dropper bottles, jade roller, white towel, botanical sprigs",
        "makeup":    "Brushes, palette, mirror, petals, tissue paper",
        "haircare":  "Wide-tooth comb, silk scrunchie, botanical oils, towel",
        "fragrance": "Candle, dried flowers, ribbon, velvet fabric, crystal",
        "bodycare":  "Loofah, bath salts, pebbles, eucalyptus, linen",
    }
    color_map = {
        "skincare":  "Ivory, sage green, warm blush, soft gold",
        "makeup":    "Rich berry, nude, charcoal, metallic rose",
        "haircare":  "Honey amber, cream, deep forest green",
        "fragrance": "Deep navy, champagne, midnight purple, gold",
        "bodycare":  "Warm terracotta, sand, soft white, eucalyptus",
    }
    return {
        "VISUAL_SHOT":      shot_map.get((category, funnel), f"{category.capitalize()} product showcase"),
        "LIGHTING":         lighting_map.get(funnel,   "Soft natural lighting"),
        "COMPOSITION":      composition_map.get(funnel, "Rule of thirds"),
        "PROPS":            props_map.get(category,    "Lifestyle props"),
        "MODEL_EXPRESSION": "Authentic, confident, relatable — no forced smiles",
        "CAMERA_ANGLE":     "Eye-level hero + 45 degree overhead detail shot",
        "BACKGROUND":       "Clean seamless or shallow-depth lifestyle blur",
        "COLOR_PALETTE":    color_map.get(category,   "Brand neutrals with one accent"),
    }
