"""
copy_constants.py
=================
Ad-copy lookup tables extracted from constants.py.
All AD_COPY_* dictionaries live here; import directly from this module.
"""

# ── Ad-copy constants ─────────────────────────────────────────────────
AD_COPY_OCCASION_HOOKS: dict = {
    "wedding": {
        "awareness":     "Your big day deserves the best {category}.",
        "consideration": "Brides are choosing this {category} for a reason.",
        "conversion":    "Limited bridal edition — don't miss out.",
        "retention":     "Back for your bridal favourites? We kept them ready.",
    },
    "party": {
        "awareness":     "Turn heads at every party with the right {category}.",
        "consideration": "Going out? Here's what's trending in {category}.",
        "conversion":    "Party-ready {category} — get it before tonight.",
        "retention":     "Your go-to party {category} is back in stock.",
    },
    "gym": {
        "awareness":     "{category_cap} that works as hard as you do.",
        "consideration": "Sweat-proof, long-lasting {category} — see the proof.",
        "conversion":    "Performance {category} — shop before it sells out.",
        "retention":     "Refill your gym bag with the {category} you trust.",
    },
    "vacation": {
        "awareness":     "Holiday skin starts with the right {category}.",
        "consideration": "Travel-ready {category} — what to pack.",
        "conversion":    "Mini sets now live — perfect for your next trip.",
        "retention":     "Heading somewhere? Restock your travel {category}.",
    },
    "work": {
        "awareness":     "A {category} routine that fits your 9-to-5.",
        "consideration": "Long-wear {category} for the days that don't stop.",
        "conversion":    "Office-ready {category} — limited offer today.",
        "retention":     "Your work-week {category} staples are waiting.",
    },
    "selfcare": {
        "awareness":     "Because you deserve a {category} routine that's yours.",
        "consideration": "Self-care isn't extra — it's essential. Here's why.",
        "conversion":    "Treat yourself — your {category} ritual starts now.",
        "retention":     "Time for yourself. Your favourites are still here.",
    },
}

AD_COPY_OCCASION_HEADLINES: dict = {
    "wedding": {
        "skincare":  "Bridal Glow That Lasts All Day",
        "makeup":    "Say I Do to Flawless",
        "haircare":  "Veil-Ready Hair, Every Strand",
        "fragrance": "A Scent for the Day You'll Never Forget",
        "bodycare":  "Silky Skin for Your Special Day",
    },
    "party": {
        "skincare":  "Glow All Night, No Touch-Ups",
        "makeup":    "Bold Looks for Big Nights",
        "haircare":  "Party Hair That Stays Put",
        "fragrance": "The Scent They'll Remember",
        "bodycare":  "Smooth Skin, Night Lights, Go.",
    },
    "gym": {
        "skincare":  "Skin That Recovers as Fast as You Do",
        "makeup":    "Workout-Proof. Look-Worthy.",
        "haircare":  "Train Hard, Hair Intact",
        "fragrance": "Fresh After Every Rep",
        "bodycare":  "Post-Workout Skin, Sorted",
    },
    "vacation": {
        "skincare":  "Holiday Skin, Effortlessly",
        "makeup":    "Jet-Set Ready, All Day Fresh",
        "haircare":  "Beach Hair Done Right",
        "fragrance": "Every Destination Has a Scent",
        "bodycare":  "Glow From Every Timezone",
    },
    "work": {
        "skincare":  "Boardroom-Ready Skin",
        "makeup":    "Professional Finish, Zero Effort",
        "haircare":  "Polished Hair, Powerful Day",
        "fragrance": "The Scent That Means Business",
        "bodycare":  "Confident Skin, From 9 to 5",
    },
    "selfcare": {
        "skincare":  "Your Skin Ritual. Your Rules.",
        "makeup":    "Makeup That Feels Like You",
        "haircare":  "Hair Care Is Self Care",
        "fragrance": "Find Your Signature Scent",
        "bodycare":  "Slow Down. Glow Up.",
    },
}

AD_COPY_GENDER_HOOKS: dict = {
    "male": {
        "awareness":     "Level up your {category} game.",
        "consideration": "The {category} products men actually use.",
        "conversion":    "No-fuss {category} that delivers — get yours.",
        "retention":     "Running low? Your {category} essentials are waiting.",
    },
    "non-binary": {
        "awareness":     "Beauty without rules — explore our {category}.",
        "consideration": "{category_cap} for every expression, every day.",
        "conversion":    "Your {category}, your way — shop now.",
        "retention":     "Your favourite {category} is still here, still yours.",
    },
}

AD_COPY_STYLE_TONE_SUFFIX: dict = {
    "luxury-elegant":    "Crafted for those who expect nothing but the best.",
    "modern-minimalist": "Clean. Simple. Effective.",
    "bold-vibrant":      "Make a statement. Own the room.",
    "natural-organic":   "Pure ingredients. Real results. Kind to your skin and the planet.",
    "glam-dramatic":     "Because you're worth the drama.",
    "soft-romantic":     "Gentle on skin. Beautiful in feel.",
}

AD_COPY_AGE_TWEAKS: dict = {
    "13-17": {"prefix": "Trending now — ", "cta": "Explore the Vibe ->",       "offer": "Free gift with first order"},
    "18-24": {"prefix": "",                "cta": None,                         "offer": "Student discount inside"},
    "25-34": {"prefix": "",                "cta": None,                         "offer": None},
    "35-44": {"prefix": "",                "cta": "Shop the Collection ->",     "offer": None},
    "45-60": {"prefix": "",                "cta": "Find Your Perfect Match ->", "offer": "Loyalty points on every order"},
    "60+":   {"prefix": "",                "cta": "Shop Now — Easy Returns",    "offer": "Free delivery, always"},
}

AD_COPY_BASE_HOOKS: dict = {
    "awareness":     "Your {category} routine is about to change.",
    "consideration": "Here's why {category} lovers are switching.",
    "conversion":    "This offer won't last — shop now.",
    "retention":     "Welcome back — your favourites are waiting.",
}

AD_COPY_BASE_HEADLINES: dict = {
    "skincare":  "Radiant Skin Starts Here",
    "makeup":    "Flawless Finish, Every Time",
    "haircare":  "Healthy Hair. Beautiful Results.",
    "fragrance": "A Scent That Stays With You",
    "bodycare":  "Skin You'll Love to Touch",
}

AD_COPY_BASE_DESCRIPTIONS: dict = {
    "awareness":     "Explore our {category} collection — crafted for real results and real skin.",
    "consideration": "Join thousands who switched to our {category} range. See the science behind it.",
    "conversion":    "Limited offer on our best-selling {category}. Free shipping. Easy returns.",
    "retention":     "Your skin knows best. Restock your favourite {category} and keep glowing.",
}

AD_COPY_BASE_CTAS: dict = {
    "awareness":     "Discover More ->",
    "consideration": "See Why It Works ->",
    "conversion":    "Shop Now — Free Shipping",
    "retention":     "Shop Again ->",
}

AD_COPY_SKIN_TYPE_MODIFIERS: dict = {
    "oily":        "Formulated for oily skin — controls shine without drying out.",
    "dry":         "Rich, hydrating formula designed for dry skin types.",
    "combination": "Balances combination skin — targets both oily and dry zones.",
    "normal":      "Gentle enough for everyday use on normal skin.",
    "sensitive":   "Dermatologist-tested and gentle for sensitive skin.",
    "mature":      "Anti-ageing formula designed for mature skin.",
}

AD_COPY_FOCUS_MODIFIERS: dict = {
    "skincare":  "Skincare-infused formula that cares while it covers.",
    "coverage":  "Full-coverage finish for a flawless, even complexion.",
    "natural":   "Natural, effortless look that enhances your features.",
    "bold":      "Bold, dramatic results for a standout look.",
    "longwear":  "Long-wear formula that stays fresh all day.",
    "clean":     "Clean, minimalist formula — nothing you don't need.",
    "fresh":     "Fresh, lightweight feel with a natural radiant finish.",
    "acne":      "Clinically formulated to target blemishes and prevent breakouts.",
    "anti-age":  "Clinically tested to visibly reduce fine lines and wrinkles.",
    "hydration": "Deep hydration that lasts 24 hours.",
    "sensitive":  "Fragrance-free, hypoallergenic formula for sensitive skin.",
}
