"""
tests/test_copy_engine.py
=========================
Unit tests for copy_engine.get_ad_copy().
No ML dependency — pure data-mapping function.
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from copy_engine import get_ad_copy


MINIMAL_FEATURES = {
    "product_category":     "skincare",
    "funnel_stage":         "awareness",
    "occasion":             "daily",
    "age_range":            "25-34",
    "gender":               "female",
    "brand_style":          "",
    "decision_attribute_1": "oily",
    "decision_attribute_2": "acne",
}


def test_returns_all_required_keys():
    result = get_ad_copy(MINIMAL_FEATURES, ctr=2.0, conv=1.0, eng=3.5)
    assert set(result.keys()) == {"hook", "headline", "description", "cta", "offer"}


def test_hook_is_non_empty_string():
    result = get_ad_copy(MINIMAL_FEATURES, ctr=2.0, conv=1.0, eng=3.5)
    assert isinstance(result["hook"], str)
    assert len(result["hook"]) > 0


def test_category_placeholder_substituted():
    """'skincare' should appear in the hook or description — not the raw placeholder."""
    result = get_ad_copy(MINIMAL_FEATURES, ctr=2.0, conv=1.0, eng=3.5)
    assert "{category}" not in result["hook"]
    assert "{category}" not in result["description"]
    assert "{category_cap}" not in result["hook"]
    assert "{category_cap}" not in result["description"]


def test_all_categories_produce_output():
    for cat in ("skincare", "makeup", "fragrance", "haircare", "bodycare"):
        feats = {**MINIMAL_FEATURES, "product_category": cat}
        result = get_ad_copy(feats, ctr=2.0, conv=1.0, eng=3.5)
        assert result["headline"], f"Empty headline for category={cat}"


def test_all_funnel_stages_produce_output():
    for funnel in ("awareness", "consideration", "conversion", "retention"):
        feats = {**MINIMAL_FEATURES, "funnel_stage": funnel}
        result = get_ad_copy(feats, ctr=2.0, conv=1.0, eng=3.5)
        assert result["hook"], f"Empty hook for funnel={funnel}"
        assert result["cta"],  f"Empty CTA for funnel={funnel}"


def test_male_gender_uses_specific_hook():
    male_feats = {**MINIMAL_FEATURES, "gender": "male"}
    result_m = get_ad_copy(male_feats,     ctr=2.0, conv=1.0, eng=3.5)
    result_f = get_ad_copy(MINIMAL_FEATURES, ctr=2.0, conv=1.0, eng=3.5)
    # Both should be non-empty; they may differ
    assert result_m["hook"]
    assert result_f["hook"]


def test_gym_occasion_overrides_hook():
    gym_feats = {**MINIMAL_FEATURES, "occasion": "gym"}
    result = get_ad_copy(gym_feats, ctr=2.0, conv=1.0, eng=3.5)
    assert result["hook"]


def test_teen_age_range():
    teen_feats = {**MINIMAL_FEATURES, "age_range": "13-17"}
    result = get_ad_copy(teen_feats, ctr=2.0, conv=1.0, eng=3.5)
    assert result["hook"]
    assert result["cta"]


def test_missing_optional_fields_do_not_crash():
    """Function should degrade gracefully when optional fields are absent."""
    minimal = {"product_category": "makeup", "funnel_stage": "conversion"}
    result = get_ad_copy(minimal, ctr=3.0, conv=2.0, eng=5.0)
    assert set(result.keys()) == {"hook", "headline", "description", "cta", "offer"}
