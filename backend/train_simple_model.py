"""
train_simple_model.py
=====================
Initial training of 3 RandomForestRegressor models (CTR, Conversion Rate,
Engagement Rate) seeded from the full Beaulix combinatorial Excel dataset
(97,920 rows — every possible input combination).

After this runs once, model.py takes over — every new user input appends
to dataset.csv and triggers a full background retrain on top of the base
Excel data, so frequent combinations reinforce the model over time.

Run once before starting the server:
    python train_simple_model.py
"""

import logging
import os

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import KFold, cross_val_score
from sklearn.preprocessing import LabelEncoder

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ── Shared constants (single source of truth) ─────────────────────────
from constants import EXCEL_COL_MAP, EXCEL_AGE_NORMALISE, FEATURE_COLS, LEAKAGE_COLS, RF_PARAMS

logger.info("=" * 60)
logger.info("  BEAULIX — Initial RF Training from Excel Dataset")
logger.info("=" * 60)

# ── Paths ──────────────────────────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
EXCEL_PATH = os.path.join(BASE_DIR, "beaulix_combinatorial_predictions.xlsx")
MODEL_DIR  = os.path.join(BASE_DIR, "models")
MODEL_PATH = os.path.join(MODEL_DIR, "random_forest_models.pkl")

os.makedirs(MODEL_DIR, exist_ok=True)

# ── Skip if model already exists (saves RAM on Render redeploys) ────────
if os.path.exists(MODEL_PATH):
    logger.info("✅ Model already exists at %s — skipping training.", MODEL_PATH)
    raise SystemExit(0)

# ── Load Excel ─────────────────────────────────────────────────────────
logger.info("📂 Loading: %s", EXCEL_PATH)
df = pd.read_excel(EXCEL_PATH, sheet_name="All Combinations", header=1)
df.rename(columns=EXCEL_COL_MAP, inplace=True)
df.drop(columns=[c for c in LEAKAGE_COLS if c in df.columns], inplace=True)

# Normalise age_range to match what the frontend sends (single source: constants.py)
if "age_range" in df.columns:
    df["age_range"] = df["age_range"].replace(EXCEL_AGE_NORMALISE)

# Ensure occasion column exists (add empty string fallback if not in Excel)
if "occasion" not in df.columns:
    df["occasion"] = ""

logger.info("✅ Loaded %s rows | %s nulls", f"{len(df):,}", df.isnull().sum().sum())

# ── Synthesise non-binary / all-genders training rows ─────────────────
logger.info("🔄 Synthesising non-binary / all-genders training rows...")
TARGET_COLS = ["ctr", "conversion_rate", "engagement_rate"]
GROUP_KEYS  = [
    "product_category", "decision_attribute_1", "decision_attribute_2",
    "funnel_stage", "age_range", "occasion",
]

base_rows     = df[df["gender"].isin(["female", "male"])].copy()
stratum_means = base_rows.groupby(GROUP_KEYS)[TARGET_COLS].mean().reset_index()

synthetic_frames = []
for new_gender in ("non-binary", "all-genders"):
    synth = stratum_means.copy()
    synth["gender"] = new_gender
    synthetic_frames.append(synth)

df_synthetic = pd.concat(synthetic_frames, ignore_index=True)
df = pd.concat([df, df_synthetic], ignore_index=True)
logger.info(
    "   Added %s synthetic rows (%s per gender value).",
    f"{len(df_synthetic):,}", f"{len(df_synthetic) // 2:,}",
)
logger.info("   Total training rows: %s", f"{len(df):,}")
logger.info("   Gender classes now: %s", sorted(df["gender"].unique()))

# ── Encode categoricals ────────────────────────────────────────────────
logger.info("🔄 Encoding categorical features...")
label_encoders = {}
X = pd.DataFrame()

for col in FEATURE_COLS:
    le = LabelEncoder()
    X[col] = le.fit_transform(df[col].astype(str))
    label_encoders[col] = le
    logger.info("   %s: %s unique values -> %s", col, len(le.classes_), list(le.classes_))

y_ctr  = df["ctr"].astype(float)
y_conv = df["conversion_rate"].astype(float)
y_eng  = df["engagement_rate"].astype(float)

logger.info("📊 Target stats:")
logger.info("   CTR        — mean: %.3f%%  std: %.3f%%", y_ctr.mean(),  y_ctr.std())
logger.info("   Conversion — mean: %.3f%%  std: %.3f%%", y_conv.mean(), y_conv.std())
logger.info("   Engagement — mean: %.3f%%  std: %.3f%%", y_eng.mean(),  y_eng.std())

# ── Train ──────────────────────────────────────────────────────────────
logger.info("🌲 Training RandomForestRegressor models...")

kf = KFold(n_splits=5, shuffle=True, random_state=42)

logger.info("   [1/3] CTR model...")
ctr_model = RandomForestRegressor(**RF_PARAMS)
cv_ctr = cross_val_score(ctr_model, X, y_ctr, cv=kf, scoring="r2", n_jobs=-1)
ctr_model.fit(X, y_ctr)
logger.info("         Train R²  = %.4f", ctr_model.score(X, y_ctr))
logger.info("         CV R²     = %.4f ± %.4f  (folds: %s)", cv_ctr.mean(), cv_ctr.std(), np.round(cv_ctr, 4))

logger.info("   [2/3] Conversion model...")
conv_model = RandomForestRegressor(**RF_PARAMS)
cv_conv = cross_val_score(conv_model, X, y_conv, cv=kf, scoring="r2", n_jobs=-1)
conv_model.fit(X, y_conv)
logger.info("         Train R²  = %.4f", conv_model.score(X, y_conv))
logger.info("         CV R²     = %.4f ± %.4f  (folds: %s)", cv_conv.mean(), cv_conv.std(), np.round(cv_conv, 4))

logger.info("   [3/3] Engagement model...")
eng_model = RandomForestRegressor(**RF_PARAMS)
cv_eng = cross_val_score(eng_model, X, y_eng, cv=kf, scoring="r2", n_jobs=-1)
eng_model.fit(X, y_eng)
logger.info("         Train R²  = %.4f", eng_model.score(X, y_eng))
logger.info("         CV R²     = %.4f ± %.4f  (folds: %s)", cv_eng.mean(), cv_eng.std(), np.round(cv_eng, 4))

logger.info("📐 Cross-validated accuracy summary (5-fold CV R²):")
logger.info("   CTR        : %.4f ± %.4f", cv_ctr.mean(),  cv_ctr.std())
logger.info("   Conversion : %.4f ± %.4f", cv_conv.mean(), cv_conv.std())
logger.info("   Engagement : %.4f ± %.4f", cv_eng.mean(),  cv_eng.std())
logger.info("   (R² = 1.0 is perfect; 0.0 = no better than the mean; negative = worse than mean)")

# ── Save ───────────────────────────────────────────────────────────────
feature_values = {col: list(label_encoders[col].classes_) for col in FEATURE_COLS}

model_data = {
    "ctr_model":        ctr_model,
    "conversion_model": conv_model,
    "engagement_model": eng_model,
    "label_encoders":   label_encoders,
    "feature_columns":  FEATURE_COLS,
    "feature_values":   feature_values,
    "training_stats": {
        "seeded_rows":       len(df),
        # Training (in-sample) R² — inflated because model saw this data
        "r2_ctr":            round(ctr_model.score(X, y_ctr),   4),
        "r2_conversion":     round(conv_model.score(X, y_conv), 4),
        "r2_engagement":     round(eng_model.score(X, y_eng),   4),
        # Cross-validated R² — honest held-out accuracy, use these for reporting
        "cv_r2_ctr":         round(float(cv_ctr.mean()),  4),
        "cv_r2_conversion":  round(float(cv_conv.mean()), 4),
        "cv_r2_engagement":  round(float(cv_eng.mean()),  4),
        "cv_r2_ctr_std":     round(float(cv_ctr.std()),   4),
        "cv_r2_conv_std":    round(float(cv_conv.std()),  4),
        "cv_r2_eng_std":     round(float(cv_eng.std()),   4),
    },
}

joblib.dump(model_data, MODEL_PATH)
logger.info("💾 Saved -> %s", MODEL_PATH)
logger.info("=" * 60)
logger.info("  Done. Start your server — the model will now retrain")
logger.info("  automatically in the background on every new user input.")
logger.info("=" * 60)
