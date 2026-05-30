"""
copy_engine.py
==============
Pure data-mapping functions for ad copy generation.

Extracted from model.py (was RecommendationModel.get_ad_copy).
No ML dependency — only reads from constants.py lookup tables.
Keeping these here makes them independently testable and readable.
"""

from copy_constants import (
    AD_COPY_OCCASION_HOOKS,
    AD_COPY_OCCASION_HEADLINES,
    AD_COPY_GENDER_HOOKS,
    AD_COPY_STYLE_TONE_SUFFIX,
    AD_COPY_AGE_TWEAKS,
    AD_COPY_BASE_HOOKS,
    AD_COPY_BASE_HEADLINES,
    AD_COPY_BASE_DESCRIPTIONS,
    AD_COPY_BASE_CTAS,
    AD_COPY_SKIN_TYPE_MODIFIERS,
    AD_COPY_FOCUS_MODIFIERS,
)


def get_ad_copy(features: dict, ctr: float, conv: float, eng: float) -> dict:
    """
    Generates ad copy varied across 8 dimensions:
      product_category, funnel_stage, occasion, age_range, gender,
      brand_style, decision_attribute_1 (skin type),
      decision_attribute_2 (product focus)

    Priority logic (highest specificity wins):
      1. Occasion-specific hook + headline override
      2. Gender-specific hook override (male / non-binary)
      3. Skin type modifier on description (attr1)
      4. Product focus modifier on description (attr2)
      5. Age group prefix + CTA + offer adjustments
      6. Brand style tone suffix on description
      7. Category + funnel base copy (fallback)

    All copy lookup tables are module-level constants (AD_COPY_*) so they
    are not re-allocated on every call.
    """
    category     = features.get("product_category", "beauty")
    funnel       = (features.get("funnel_stage",     "awareness") or "awareness").lower()
    occasion     = (features.get("occasion") or "daily").lower()
    age          = features.get("age_range",         "25-34")
    gender       = features.get("gender",            "female")
    brand_style  = (features.get("brand_style") or "").lower()
    attr1        = (features.get("decision_attribute_1") or "").lower()  # skin type
    attr2        = (features.get("decision_attribute_2") or "").lower()  # product focus
    category_cap = category.capitalize()

    def _fmt(template: str) -> str:
        """Substitute {category} and {category_cap} placeholders."""
        return template.replace("{category}", category).replace("{category_cap}", category_cap)

    # ── Assemble ──────────────────────────────────────────────────────────

    # Hook: occasion > gender > base
    base_hook_template = AD_COPY_BASE_HOOKS.get(funnel, AD_COPY_BASE_HOOKS["awareness"])
    if occasion in AD_COPY_OCCASION_HOOKS:
        hook_template = AD_COPY_OCCASION_HOOKS[occasion].get(funnel, base_hook_template)
    elif gender in AD_COPY_GENDER_HOOKS:
        hook_template = AD_COPY_GENDER_HOOKS[gender].get(funnel, base_hook_template)
    else:
        hook_template = base_hook_template
    hook = _fmt(hook_template)

    # Age prefix
    tweak = AD_COPY_AGE_TWEAKS.get(age, AD_COPY_AGE_TWEAKS["25-34"])
    hook  = tweak["prefix"] + hook

    # Headline: occasion-specific > base category
    if occasion in AD_COPY_OCCASION_HEADLINES and category in AD_COPY_OCCASION_HEADLINES[occasion]:
        headline = AD_COPY_OCCASION_HEADLINES[occasion][category]
    else:
        headline = AD_COPY_BASE_HEADLINES.get(category, "Beauty Redefined")

    # Description: base + skin type hint + product focus hint + brand style suffix
    base_desc = _fmt(AD_COPY_BASE_DESCRIPTIONS.get(funnel, AD_COPY_BASE_DESCRIPTIONS["awareness"]))
    skin_add  = AD_COPY_SKIN_TYPE_MODIFIERS.get(attr1, "")
    focus_add = AD_COPY_FOCUS_MODIFIERS.get(attr2, "")
    style_add = AD_COPY_STYLE_TONE_SUFFIX.get(brand_style, "")
    # Build description — base + most-specific modifier + optional brand style suffix.
    # Priority: product focus > skin type (focus is more campaign-specific).
    # Brand style suffix appended whenever present, regardless of other modifiers.
    modifier = focus_add or skin_add
    if modifier and style_add:
        description = f"{base_desc} {modifier} {style_add}".strip()
    elif modifier:
        description = f"{base_desc} {modifier}".strip()
    elif style_add:
        description = f"{base_desc} {style_add}".strip()
    else:
        description = base_desc

    # CTA: age override > funnel base
    cta = tweak["cta"] or AD_COPY_BASE_CTAS.get(funnel, AD_COPY_BASE_CTAS["conversion"])

    # Offer: age override > funnel default
    if tweak["offer"]:
        offer = tweak["offer"]
    elif funnel == "conversion":
        offer = "Free shipping on orders $50+"
    elif funnel == "retention":
        offer = "Join our community"
    else:
        offer = "Join our community"

    return {
        "hook":        hook,
        "headline":    headline,
        "description": description,
        "cta":         cta,
        "offer":       offer,
    }
