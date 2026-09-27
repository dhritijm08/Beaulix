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


def _matched_keywords_for(text: str):
    """Diagnostic-only helper: which (category, keyword) pairs matched, so a
    'no OCR match' failure can be told apart from 'no OCR text at all'. Not
    used for the actual classification decision — _match_category still owns
    that (first-hit-in-CATEGORY_KEYWORDS-order), this just enumerates every
    hit for the debug log."""
    t = re.sub(r"[._-]+", " ", (text or "").lower())
    hits = []
    for category, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if kw in t:
                hits.append((category, kw))
    return hits


def classify_category_from_image_bytes(image_bytes: bytes, _debug: bool = False):
    """OCRs the given image bytes and matches recognized text against the
    category keyword lists. Returns a recognized category string, or None
    (== unknown; caller must NOT default this to skincare or any category).

    _debug=True (temporary, for diagnosing a specific failed request) logs
    each stage separately — Tesseract availability, OCR text length/sample,
    keyword hits — so "OCR ran but found nothing" can be told apart from
    "Tesseract isn't even installed" instead of both collapsing into a single
    generic warning. Behavior/return value is unchanged either way: still
    None on any failure, never a guessed category."""
    try:
        from PIL import Image
        import pytesseract
    except ImportError as e:
        if _debug:
            logger.warning("[OCR DEBUG] tesseract_available=false (Pillow/pytesseract package not installed: %s)", e)
        else:
            logger.warning("image_category: Pillow/pytesseract not installed — cannot classify, returning unknown")
        return None

    if _debug:
        try:
            version = pytesseract.get_tesseract_version()
            logger.info("[OCR DEBUG] tesseract_available=true (version=%s)", version)
        except Exception as e:
            # This is the failure mode the pip-only requirements.txt comment
            # warns about: the pytesseract *package* imports fine (it's pure
            # Python), but the `tesseract` *system binary* it shells out to
            # isn't installed on this host. Every OCR call below will raise
            # the same way, and would otherwise be swallowed into the same
            # generic "returning unknown" as a genuinely blank/garbled image.
            logger.warning("[OCR DEBUG] tesseract_available=false (system binary not found/runnable: %s)", e)

    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception as e:
        if _debug:
            logger.warning("[OCR DEBUG] extracted_text_length=0 (image could not be opened/decoded: %s)", e)
            logger.warning("[OCR DEBUG] error=%s: %s", type(e).__name__, e)
        else:
            logger.warning("image_category: OCR/classification failed (%s) — returning unknown", e)
        return None

    # Real product photography (curved bottles, reflections, small printed/
    # embossed label text, arbitrary Cloudinary delivery size) is much harder
    # for OCR than a flat, high-contrast graphic. A few cheap, generic
    # preprocessing steps meaningfully improve text recognition without
    # needing anything product-specific: upscale small images so small label
    # text has enough pixels to be legible, convert to grayscale (color/
    # background noise doesn't help letter-shape recognition), and boost
    # contrast so light embossed text or low-contrast printing stands out
    # from the background. This does not change what counts as a match —
    # _match_category and CATEGORY_KEYWORDS are untouched.
    try:
        from PIL import ImageOps

        proc = ImageOps.grayscale(img)
        # Upscale if the shorter side is small — real Cloudinary thumbnails
        # can come back well under 1000px, which is often too small for
        # tesseract to resolve individual label characters reliably.
        min_side = min(proc.size)
        if min_side < 1200:
            scale = 1200 / max(min_side, 1)
            proc = proc.resize((int(proc.width * scale), int(proc.height * scale)), Image.LANCZOS)
        proc = ImageOps.autocontrast(proc, cutoff=1)
    except Exception as e:
        # Preprocessing is a best-effort improvement, not a requirement — if
        # anything here fails, fall back to OCRing the original image rather
        # than treating a preprocessing hiccup as a hard classification
        # failure.
        if _debug:
            logger.warning("[OCR DEBUG] preprocessing_failed=%s: %s (falling back to original image)", type(e).__name__, e)
        proc = img

    try:
        text = pytesseract.image_to_string(proc) or ""
        if _debug and not text.strip():
            # If the preprocessed image still yields nothing, one more try
            # against the untouched original — occasionally preprocessing
            # (especially aggressive upscaling of an already-large image)
            # can hurt rather than help a specific image, and this costs
            # nothing extra to attempt when we already know the first pass
            # found nothing.
            retry_text = pytesseract.image_to_string(img) or ""
            if retry_text.strip():
                text = retry_text
                logger.info("[OCR DEBUG] preprocessed_pass_empty=true, original_image_pass_recovered_text=true")
    except Exception as e:
        if _debug:
            logger.warning("[OCR DEBUG] extracted_text_length=0 (pytesseract.image_to_string raised: %s)", e)
            logger.warning("[OCR DEBUG] error=%s: %s", type(e).__name__, e)
        else:
            logger.warning("image_category: OCR/classification failed (%s) — returning unknown", e)
        return None

    category = _match_category(text)

    if _debug:
        stripped = text.strip()
        hits = _matched_keywords_for(text)
        logger.info("[OCR DEBUG] extracted_text_length=%d", len(stripped))
        logger.info("[OCR DEBUG] extracted_text_sample=%r", stripped[:300])
        logger.info("[OCR DEBUG] matched_keywords=%s", [kw for _, kw in hits])
        logger.info("[OCR DEBUG] candidate_categories=%s", sorted({c for c, _ in hits}))
        logger.info("[OCR DEBUG] final_category=%s", category)
    else:
        logger.info("image_category: OCR text=%r -> category=%r", text.strip()[:200], category)

    return category


def classify_category_from_image_url(image_url: str, timeout: float = 8.0, _debug: bool = False):
    """Downloads image_url (e.g. a Cloudinary URL) and classifies it. Returns
    a recognized category string, or None on any failure (bad URL, network
    error, no OCR match) — always unknown, never a guessed category.

    _debug=True adds the [OCR DEBUG] download-stage logs (status/content-type/
    byte count) on top of what classify_category_from_image_bytes logs, so a
    download failure is distinguishable from an OCR failure. Return value and
    fallback behavior are unchanged."""
    if _debug:
        logger.info("[OCR DEBUG] request_received=true")
        logger.info("[OCR DEBUG] image_url=%s", image_url)
    try:
        import requests
    except ImportError:
        if _debug:
            logger.warning("[OCR DEBUG] image_download_status=none (requests package not installed)")
        else:
            logger.warning("image_category: requests not installed — cannot classify, returning unknown")
        return None
    try:
        resp = requests.get(image_url, timeout=timeout)
        resp.raise_for_status()
        if _debug:
            logger.info("[OCR DEBUG] image_download_status=%d", resp.status_code)
            logger.info("[OCR DEBUG] image_content_type=%s", resp.headers.get("Content-Type"))
            logger.info("[OCR DEBUG] image_bytes=%d", len(resp.content))
        return classify_category_from_image_bytes(resp.content, _debug=_debug)
    except Exception as e:
        if _debug:
            logger.warning("[OCR DEBUG] image_download_status=failed (%s)", e)
            logger.warning("[OCR DEBUG] error=%s: %s", type(e).__name__, e)
        else:
            logger.warning("image_category: failed to fetch %r (%s) — returning unknown", image_url, e)
        return None
