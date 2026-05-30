"""
tests/test_targeting.py
=======================
Unit tests for targeting.get_targeting_recommendations().
No ML dependency — pure data-mapping function.
"""

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from targeting import get_targeting_recommendations


MINIMAL_FEATURES = {
    "product_category":     "skincare",
    "funnel_stage":         "awareness",
    "occasion":             "daily",
    "age_range":            "25-34",
    "gender":               "female",
    "decision_attribute_1": "oily",
    "decision_attribute_2": "acne",
}


def test_returns_all_required_keys():
    result = get_targeting_recommendations(MINIMAL_FEATURES)
    assert set(result.keys()) == {"targeting", "platforms", "tone"}


def test_targeting_is_non_empty_list():
    result = get_targeting_recommendations(MINIMAL_FEATURES)
    assert isinstance(result["targeting"], list)
    assert len(result["targeting"]) >= 2


def test_targeting_capped_at_five():
    result = get_targeting_recommendations(MINIMAL_FEATURES)
    assert len(result["targeting"]) <= 5


def test_platforms_is_non_empty_list():
    result = get_targeting_recommendations(MINIMAL_FEATURES)
    assert isinstance(result["platforms"], list)
    assert len(result["platforms"]) >= 1


def test_tone_is_string():
    result = get_targeting_recommendations(MINIMAL_FEATURES)
    assert isinstance(result["tone"], str)
    assert len(result["tone"]) > 0


def test_age_gender_always_first_tag():
    result = get_targeting_recommendations(MINIMAL_FEATURES)
    assert "25-34" in result["targeting"][0]
    assert "Female" in result["targeting"][0]


def test_all_age_ranges_produce_output():
    for age in ("13-17", "18-24", "25-34", "35-44", "45-60", "60+"):
        feats = {**MINIMAL_FEATURES, "age_range": age}
        result = get_targeting_recommendations(feats)
        assert result["platforms"], f"No platforms for age={age}"
        assert result["targeting"], f"No targeting for age={age}"


def test_all_funnel_stages_produce_output():
    for funnel in ("awareness", "consideration", "conversion", "retention"):
        feats = {**MINIMAL_FEATURES, "funnel_stage": funnel}
        result = get_targeting_recommendations(feats)
        assert result["targeting"], f"No targeting for funnel={funnel}"


def test_wedding_occasion_tag_included():
    """Wedding occasion should appear somewhere in targeting when slot allows it.
    When attr1/attr2 fill slots 4+5 the occasion tag may be absent — confirm no crash."""
    wedding_feats = {**MINIMAL_FEATURES, "occasion": "wedding"}
    result = get_targeting_recommendations(wedding_feats)
    # Must not crash and must have non-empty targeting list
    assert len(result["targeting"]) >= 2
    # When attr1/attr2 are empty, wedding should fill slot 4
    wedding_no_attrs = {**wedding_feats, "decision_attribute_1": "", "decision_attribute_2": ""}
    result2 = get_targeting_recommendations(wedding_no_attrs)
    all_tags = " ".join(result2["targeting"]).lower()
    assert "ridal" in all_tags or "wedding" in all_tags


def test_missing_optional_fields_do_not_crash():
    minimal = {"product_category": "makeup", "funnel_stage": "conversion"}
    result = get_targeting_recommendations(minimal)
    assert set(result.keys()) == {"targeting", "platforms", "tone"}
