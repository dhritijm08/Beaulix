"""
image_category.py
==================
Product-category resolution from the ACTUAL uploaded product image, used
ONLY as a second-pass fallback when the frontend's filename-based resolver
(CATEGORY_KEYWORDS in generator-init.js) returns no match — e.g. a generic
upload filename like "shopping.webp" or "image.webp".

Deliberately NOT a new ML model. This project has no existing
image-understanding capability, so the lightest real option is OCR:
product packaging almost always has the product name/type printed on it
("TRESemme Keratin Smooth Shampoo", "Lumiere Vitamin C Serum", ...), so
reading that text with tesseract and matching it against the SAME category
keyword lists the frontend already uses is deterministic, has no model
weights, and needs no training data or GPU.

If OCR finds no recognizable text, or none of it matches a known category,
this returns None. Callers MUST treat None as "unknown" and use the
existing category-neutral fallback copy — never guess "skincare".
"""

import io
import re
import logging

logger = logging.getLogger(__name__)

# Kept in sync with CATEGORY_KEYWORDS in frontend/generator-init.js. Same
# categories, same keyword lists, same "haircare checked before skincare so
# 'shampoo' can never be misread as skincare" ordering.
CATEGORY_KEYWORDS = {
    "haircare":  ["shampoo", "conditioner", "hair mask", "hair serum", "hair oil", "hair care", "haircare", "hair"],
    "skincare":  ["serum", "moisturizer", "moisturiser", "cleanser", "face wash", "toner", "sunscreen", "skincare", "skin care"],
    "makeup":    ["lipstick", "lip gloss", "foundation", "concealer", "blush", "mascara", "eyeliner", "eyeshadow", "makeup"],
    "fragrance": ["perfume", "fragrance", "eau de parfum", "eau de toilette", "cologne"],
    "bodycare":  ["grooming", "beard", "shaving", "razor", "body lotion", "body wash", "body scrub", "bodycare", "body care"],
}


def _match_category(text: str):
    t = re.sub(r"[._-]+", " ", (text or "").lower())
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(kw in t for kw in keywords):
            return category
    return None


def classify_category_from_image_bytes(image_bytes: bytes):
    """OCRs the given image bytes and matches recognized text against the
    category keyword lists. Returns a recognized category string, or None
    (== unknown; caller must NOT default this to skincare or any category)."""
    try:
        from PIL import Image
        import pytesseract
    except ImportError:
        logger.warning("image_category: Pillow/pytesseract not installed — cannot classify, returning unknown")
        return None
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        text = pytesseract.image_to_string(img) or ""
        category = _match_category(text)
        logger.info("image_category: OCR text=%r -> category=%r", text.strip()[:200], category)
        return category
    except Exception as e:
        logger.warning("image_category: OCR/classification failed (%s) — returning unknown", e)
        return None


def classify_category_from_image_url(image_url: str, timeout: float = 8.0):
    """Downloads image_url (e.g. a Cloudinary URL) and classifies it. Returns
    a recognized category string, or None on any failure (bad URL, network
    error, no OCR match) — always unknown, never a guessed category."""
    try:
        import requests
    except ImportError:
        logger.warning("image_category: requests not installed — cannot classify, returning unknown")
        return None
    try:
        resp = requests.get(image_url, timeout=timeout)
        resp.raise_for_status()
        return classify_category_from_image_bytes(resp.content)
    except Exception as e:
        logger.warning("image_category: failed to fetch %r (%s) — returning unknown", image_url, e)
        return None
