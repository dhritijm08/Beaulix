"""
targeting.py
============
Pure data-mapping function for ad targeting recommendations.

Extracted from model.py (was RecommendationModel.get_targeting_recommendations).
No ML dependency — only maps feature inputs to platform/audience suggestions.
Keeping these here makes them independently testable and readable.
"""


def get_targeting_recommendations(features: dict) -> dict:
    age      = features.get("age_range",             "25-34")
    category = features.get("product_category",      "skincare")
    gender   = features.get("gender",                "female")
    funnel   = (features.get("funnel_stage") or      "awareness").lower()
    occasion = (features.get("occasion")     or      "daily").lower()
    attr1    = (features.get("decision_attribute_1") or "").lower()  # skin type
    attr2    = (features.get("decision_attribute_2") or "").lower()  # product focus

    gender_display_map = {
        "female":      "Female",
        "male":        "Male",
        "all-genders": "All Genders",
        "non-binary":  "Non-binary",
    }
    gender_label = gender_display_map.get(gender, gender.capitalize())

    # ── Age × funnel → platform priority ──────────────────────────────────
    # Awareness: lean discovery (TikTok, Reels, YouTube)
    # Consideration: lean social proof (YouTube, Pinterest, Instagram)
    # Conversion: lean retargeting (Facebook, Instagram)
    # Retention: lean CRM (Email, Facebook, push)
    age_funnel_platforms = {
        "13-17": {
            "awareness":     ["TikTok", "Instagram Reels"],
            "consideration": ["TikTok", "YouTube Shorts", "Instagram"],
            "conversion":    ["TikTok", "Instagram"],
            "retention":     ["TikTok", "Instagram"],
        },
        "18-24": {
            "awareness":     ["TikTok", "Instagram Reels", "YouTube Shorts"],
            "consideration": ["YouTube", "TikTok", "Instagram"],
            "conversion":    ["Instagram", "TikTok", "Facebook"],
            "retention":     ["Instagram", "Email", "TikTok"],
        },
        "25-34": {
            "awareness":     ["Instagram", "TikTok", "Facebook"],
            "consideration": ["Instagram", "YouTube", "Pinterest"],
            "conversion":    ["Facebook", "Instagram", "TikTok"],
            "retention":     ["Email", "Facebook", "Instagram"],
        },
        "35-44": {
            "awareness":     ["Facebook", "Instagram", "Pinterest"],
            "consideration": ["Facebook", "YouTube", "Pinterest"],
            "conversion":    ["Facebook", "Instagram", "Email"],
            "retention":     ["Email", "Facebook", "Instagram"],
        },
        "45-60": {
            "awareness":     ["Facebook", "Instagram", "YouTube"],
            "consideration": ["Facebook", "YouTube", "Email"],
            "conversion":    ["Facebook", "Email", "Instagram"],
            "retention":     ["Email", "Facebook"],
        },
        "60+": {
            "awareness":     ["Facebook", "YouTube"],
            "consideration": ["Facebook", "YouTube", "Email"],
            "conversion":    ["Facebook", "Email"],
            "retention":     ["Email", "Facebook"],
        },
    }

    # ── Funnel-specific targeting tags ─────────────────────────────────────
    funnel_targeting = {
        "awareness":     ["Beauty & lifestyle explorers", "Lookalike audiences"],
        "consideration": ["Product page visitors", "Comparison shoppers"],
        "conversion":    ["Cart abandoners", "Past website visitors"],
        "retention":     ["Existing customers", "Loyalty programme members"],
    }

    # ── Skin type targeting tag ────────────────────────────────────────────
    skin_tags = {
        "oily":        "Oily skin shoppers",
        "dry":         "Dry skin shoppers",
        "combination": "Combination skin shoppers",
        "sensitive":   "Sensitive skin shoppers",
        "mature":      "Mature skin shoppers",
        "normal":      "Normal skin shoppers",
    }

    # ── Product focus targeting tag ────────────────────────────────────────
    focus_tags = {
        "skincare":  "Skincare-makeup hybrid shoppers",
        "coverage":  "Full-coverage makeup shoppers",
        "natural":   "Natural beauty shoppers",
        "bold":      "Bold makeup shoppers",
        "longwear":  "Long-wear makeup shoppers",
        "clean":     "Clean beauty shoppers",
        "fresh":     "Lightweight makeup shoppers",
        "acne":      "Acne & blemish shoppers",
        "anti-age":  "Anti-ageing skincare shoppers",
        "hydration": "Hydration & moisture shoppers",
    }

    # ── Occasion targeting tag ─────────────────────────────────────────────
    occasion_tags = {
        "vacation":  "Holiday & travel beauty shoppers",
        "wedding":   "Bridal & wedding beauty shoppers",
        "party":     "Event & evening beauty shoppers",
        "gym":       "Active & sport beauty shoppers",
        "work":      "Professional beauty shoppers",
        "selfcare":  "Self-care & wellness shoppers",
    }

    # ── Assemble targeting list ────────────────────────────────────────────
    # Always: age+gender, category enthusiasts
    # Priority order: age+gender (always) > category (always) >
    # funnel intent (most actionable) > product focus > occasion/skin type
    # Cap at 5 — cleaner for media buying UI
    funnel_tags  = funnel_targeting.get(funnel, funnel_targeting["awareness"])
    focus_tag    = focus_tags.get(attr2)
    skin_tag     = skin_tags.get(attr1)
    occasion_tag = occasion_tags.get(occasion)  # None if daily

    # Slots 1+2: always included
    targeting = [
        f"{age} {gender_label}",
        f"{category.capitalize()} enthusiasts",
    ]
    # Slot 3: best funnel intent tag (most actionable for media buying)
    if funnel_tags:
        targeting.append(funnel_tags[0])
    # Slot 4: product focus > occasion > skin type (most specific available)
    slot4 = focus_tag or occasion_tag or skin_tag
    if slot4:
        targeting.append(slot4)
    # Slot 5: second funnel tag if available, else next best attribute
    if len(funnel_tags) > 1:
        targeting.append(funnel_tags[1])
    elif occasion_tag and occasion_tag not in targeting:
        targeting.append(occasion_tag)
    elif skin_tag and skin_tag not in targeting:
        targeting.append(skin_tag)

    # ── Platforms ─────────────────────────────────────────────────────────
    age_platforms = age_funnel_platforms.get(age, age_funnel_platforms["25-34"])
    platforms     = age_platforms.get(funnel, age_platforms["awareness"])

    # ── Tone ──────────────────────────────────────────────────────────────
    tone_map = {
        "13-17": "Trendy, fun, authentic",
        "18-24": "Authentic, relatable",
        "25-34": "Professional yet relatable",
        "35-44": "Trustworthy, results-focused",
        "45-60": "Quality-focused, trusted",
        "60+":   "Reliable, clear benefits",
    }

    return {
        "targeting": targeting,
        "platforms": platforms,
        "tone":      tone_map.get(age, "Professional yet relatable"),
    }
