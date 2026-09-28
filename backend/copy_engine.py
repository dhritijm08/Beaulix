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
    AD_COPY_CATEGORY_NOUN,
    AD_COPY_LIFESTYLE_HEADLINES,
    AD_COPY_SOCIAL_HOOKS,
    AD_COPY_LIFESTYLE_DESCRIPTIONS,
    AD_COPY_SOCIAL_DESCRIPTIONS,
)

_VALID_DIRECTIONS = {"hero", "lifestyle", "social"}

# AD_COPY_FOCUS_MODIFIERS (decision_attribute_2) is applied to every
# category unconditionally, but several of its values hardcode
# skin/complexion wording ("full-coverage finish for a flawless, even
# complexion", "hypoallergenic formula for sensitive skin", etc.) that only
# makes sense for skin-adjacent categories. Unlike AD_COPY_SKIN_TYPE_MODIFIERS
# (decision_attribute_1), which is already guarded with
# `if category == "skincare"`, this dict had no equivalent guard, so a
# haircare or fragrance product whose attr2 happened to collide with one of
# these keys (e.g. "sensitive", "coverage") silently picked up skin/
# complexion language in its body copy. Scope those specific keys to the
# categories they were actually written for; every other AD_COPY_FOCUS_MODIFIERS
# key (natural/bold/longwear/clean/fresh/hydration) is category-neutral and
# keeps applying everywhere as before.
_SKIN_RELATED_FOCUS_KEYS = {"skincare", "coverage", "acne", "anti-age", "sensitive"}
_SKIN_APPROPRIATE_CATEGORIES = {"skincare", "makeup", "bodycare"}


def get_ad_copy(features: dict, ctr: float, conv: float, eng: float) -> dict:
    """
    Generates ad copy varied across 9 dimensions:
      product_category, creative_direction, funnel_stage, occasion,
      age_range, gender, brand_style, decision_attribute_1 (category-scoped
      primary attribute, e.g. skin type / hair type / fragrance mood),
      decision_attribute_2 (category-scoped secondary attribute)

    PRODUCT → CATEGORY → CREATIVE DIRECTION → COPY:
      the product/category decides WHAT the copy can talk about (see
      AD_COPY_BASE_HEADLINES / AD_COPY_CATEGORY_NOUN and the category-scoped
      decision_attribute modifiers below — a haircare product never pulls a
      skin-type modifier because attr1/attr2 values are category-scoped by
      the frontend). creative_direction decides only HOW that same product
      is talked about (Product Hero / Beauty Lifestyle / Social Concept),
      by selecting a different headline + body template set below.

    Priority logic (highest specificity wins):
      1. Occasion-specific hook override (all directions);
         occasion-specific headline override (Product Hero only — Beauty
         Lifestyle / Social Concept keep their own direction-specific
         headline so the three directions stay visibly different even for
         an occasion-targeted campaign)
      2. Gender-specific hook override (male / non-binary)
      3. Skin type modifier on description (attr1, skincare/makeup only)
      4. Product focus modifier on description (attr2)
      5. Age group prefix + CTA + offer adjustments
      6. Brand style tone suffix on description
      7. Category + funnel + creative_direction base copy (fallback)

    All copy lookup tables are module-level constants (AD_COPY_*) so they
    are not re-allocated on every call.
    """
    category     = features.get("product_category", "beauty")
    direction    = (features.get("creative_direction") or "hero").lower()
    if direction not in _VALID_DIRECTIONS:
        direction = "hero"
    funnel       = (features.get("funnel_stage",     "awareness") or "awareness").lower()
    occasion     = (features.get("occasion") or "daily").lower()
    age          = features.get("age_range",         "25-34")
    gender       = features.get("gender",            "female")
    brand_style  = (features.get("brand_style") or "").lower()
    attr1        = (features.get("decision_attribute_1") or "").lower()  # category-scoped primary attribute
    attr2        = (features.get("decision_attribute_2") or "").lower()  # category-scoped secondary attribute
    category_cap = category.capitalize()
    noun         = AD_COPY_CATEGORY_NOUN.get(category, "beauty")

    def _fmt(template: str) -> str:
        """Substitute {category}, {category_cap} and {noun} placeholders."""
        return (template
                .replace("{category}", category)
                .replace("{category_cap}", category_cap)
                .replace("{noun}", noun))

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

    # Headline: direction-specific table first, with an occasion override
    # that only applies to Product Hero (see priority-logic docstring above).
    if direction == "hero" and occasion in AD_COPY_OCCASION_HEADLINES and category in AD_COPY_OCCASION_HEADLINES[occasion]:
        headline = AD_COPY_OCCASION_HEADLINES[occasion][category]
    elif direction == "lifestyle":
        headline = AD_COPY_LIFESTYLE_HEADLINES.get(category, AD_COPY_BASE_HEADLINES.get(category, "Beauty Redefined"))
    elif direction == "social":
        headline = AD_COPY_SOCIAL_HOOKS.get(category, AD_COPY_BASE_HEADLINES.get(category, "Beauty Redefined"))
    else:
        headline = AD_COPY_BASE_HEADLINES.get(category, "Beauty Redefined")

    # Description: direction-specific base + skin type hint + product focus
    # hint + brand style suffix.
    if direction == "lifestyle":
        desc_table = AD_COPY_LIFESTYLE_DESCRIPTIONS
    elif direction == "social":
        desc_table = AD_COPY_SOCIAL_DESCRIPTIONS
    else:
        desc_table = AD_COPY_BASE_DESCRIPTIONS
    base_desc = _fmt(desc_table.get(funnel, desc_table["awareness"]))
    # AD_COPY_SKIN_TYPE_MODIFIERS is skincare-specific language ("formulated
    # for oily skin", "anti-ageing formula", etc.) — it must never be used as
    # a fallback for other categories. Previously this was applied whenever
    # attr1 happened to match a skin-type key, regardless of category: since
    # "makeup" shares the same Skin Type field as skincare in the Marketing
    # Intelligence form, a makeup request with no focus attribute (attr2) set
    # (e.g. via a direct API call, or any future caller that omits it) fell
    # through to skin-type copy — which reads fine for a foundation but is
    # wrong for a lipstick, mascara, or nail polish. Scoping this modifier to
    # skincare keeps the product-category boundary honest without touching
    # AD_COPY_FOCUS_MODIFIERS (attr2), which is already category-appropriate
    # and takes priority below whenever it's present.
    skin_add  = AD_COPY_SKIN_TYPE_MODIFIERS.get(attr1, "") if category == "skincare" else ""
    focus_add = AD_COPY_FOCUS_MODIFIERS.get(attr2, "")
    if attr2 in _SKIN_RELATED_FOCUS_KEYS and category not in _SKIN_APPROPRIATE_CATEGORIES:
        # This attr2 value only carries skin/complexion wording — not valid
        # for a category like haircare or fragrance. Drop it rather than
        # let it leak into the body copy.
        focus_add = ""
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

    result = {
        "hook":               hook,
        "headline":           headline,
        "description":        description,
        "cta":                cta,
        "offer":              offer,
        "creative_direction": direction,
    }

    # [COPY TEST] trace point 1/2 — where ad_copy is generated, and the exact
    # object (headline/hook/description/cta/offer) that gets returned to
    # /predict and eventually to the frontend.
    print(f"[BEAULIX COPY] copy_engine.category = {category!r} creative_direction = {direction!r}")
    print(f"[COPY TEST] generated copy: {result}")
    print(f"[COPY TEST] headline: {result.get('headline')!r}")
    print(f"[COPY TEST] body: {result.get('description')!r}")
    print(f"[COPY TEST] CTA: {result.get('cta')!r}")
    print(f"[COPY TEST] offer: {result.get('offer')!r}")

    print("[BEAULIX COPY ENGINE]")
    print(f"[BEAULIX COPY ENGINE] category={category!r}")
    print(f"[BEAULIX COPY ENGINE] direction={direction!r}")
    print(f"[BEAULIX COPY ENGINE] headline={headline!r}")
    print(f"[BEAULIX COPY ENGINE] description={description!r}")
    print(f"[BEAULIX COPY ENGINE] body={description!r}")  # description IS the body field the frontend reads
    print(f"[BEAULIX COPY ENGINE] hook={hook!r}")
    print(f"[BEAULIX COPY ENGINE] attr1={attr1!r} skin_add={skin_add!r}")
    print(f"[BEAULIX COPY ENGINE] attr2={attr2!r} focus_add={focus_add!r}")

    return result
