"""
excel_cache.py
==============
Standalone Excel loading and caching layer extracted from model.py.

Provides three module-level functions that RecommendationModel delegates to:

    load_base_df()                     — load/cache the 97 920-row combinatorial
                                         Excel training dataset (thread-safe, once
                                         per process).
    load_visual_data(base_dir)         — load/cache visual_brief and step2_recs
                                         DataFrames (prefers a .pkl fast path).
    build_visual_pkl(base_dir)         — pre-process both Excel files into a
                                         models/visual_data.pkl cache.

All functions are stateless from the caller's perspective — internal state is
held in module-level variables protected by threading.Lock objects.

Extracting this layer from model.py:
  • Reduces model.py by ~400 lines.
  • Makes the caching logic independently testable.
  • Keeps the single-responsibility principle: model.py owns ML logic; this
    module owns Excel I/O and caching.
"""

import logging
import os
import threading

import pandas as pd

from constants import EXCEL_COL_MAP, LEAKAGE_COLS, EXCEL_AGE_NORMALISE

logger = logging.getLogger(__name__)

# ── Module-level cache state ───────────────────────────────────────────
# Mirrors the class-level variables previously on RecommendationModel.
# Protected by per-cache locks so concurrent first-access calls are safe.

_base_df: pd.DataFrame = None
_base_df_lock: threading.Lock = threading.Lock()

_visual_brief_df: pd.DataFrame = None
_step2_recs_df:   pd.DataFrame = None
_visual_data_lock: threading.Lock = threading.Lock()

# Path to the main combinatorial Excel file — resolved by the caller.
# Set via init() before first use, or pass excel_path directly to load_base_df().
_excel_path: str = ""


def init(excel_path: str) -> None:
    """
    Configure the module with the path to the combinatorial Excel file.
    Call once at application startup before any other function.

    Args:
        excel_path: Absolute path to beaulix_combinatorial_predictions.xlsx.
    """
    global _excel_path
    _excel_path = excel_path


def load_base_df(excel_path: str = "") -> pd.DataFrame:
    """
    Load, rename, and normalise the base Excel training data — once.

    The result is cached in the module-level ``_base_df`` variable so
    subsequent calls (retrain, profile-count cache, lookup cache) reuse the
    same in-memory DataFrame instead of re-reading the ~14 MB Excel file each
    time.

    Args:
        excel_path: Path to beaulix_combinatorial_predictions.xlsx.
                    Falls back to the path set via ``init()``.

    Returns:
        pd.DataFrame with renamed and normalised columns.
    """
    global _base_df
    path = excel_path or _excel_path
    with _base_df_lock:
        if _base_df is None:
            df = pd.read_excel(path, sheet_name="All Combinations", header=1)
            df.rename(columns=EXCEL_COL_MAP, inplace=True)
            df.drop(
                columns=[c for c in LEAKAGE_COLS if c in df.columns],
                inplace=True,
            )
            # Normalise age_range so the Excel label matches the frontend value.
            # EXCEL_AGE_NORMALISE is defined once in constants.py — the single
            # source of truth shared with train_simple_model.py.
            if "age_range" in df.columns:
                df["age_range"] = df["age_range"].replace(EXCEL_AGE_NORMALISE)
            # Ensure occasion column always exists (older Excel exports omit it).
            if "occasion" not in df.columns:
                df["occasion"] = ""
            _base_df = df
            logger.info("✅ Excel base DataFrame cached — %s rows", len(df))
        return _base_df


def load_visual_data(base_dir: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Load the visual-brief and step-2-recommendations DataFrames — once.

    Prefers a pre-processed ``models/visual_data.pkl`` fast path (eliminates
    the 1–3 s cold-start Excel parse).  Falls back to reading both Excel files
    directly and writes a fresh .pkl for subsequent startups.

    Args:
        base_dir: Directory that contains beaulix_visual_brief.xlsx,
                  beaulix_step2_recommendations.xlsx, and the models/ sub-dir.

    Returns:
        Tuple of (visual_brief_df, step2_recs_df).
    """
    global _visual_brief_df, _step2_recs_df

    with _visual_data_lock:
        if _visual_brief_df is not None:
            return _visual_brief_df, _step2_recs_df

        pkl_path   = os.path.join(base_dir, "models", "visual_data.pkl")
        brief_path = os.path.join(base_dir, "beaulix_visual_brief.xlsx")
        recs_path  = os.path.join(base_dir, "beaulix_step2_recommendations.xlsx")

        # ── Fast path: pre-built .pkl ──────────────────────────────────
        if os.path.exists(pkl_path):
            try:
                import joblib as _jl
                cached = _jl.load(pkl_path)
                _visual_brief_df = cached.get("visual_brief", pd.DataFrame())
                _step2_recs_df   = cached.get("step2_recs",   pd.DataFrame())
                logger.info(
                    "✅ Visual data loaded from cache — %s brief rows, %s step2 rows",
                    len(_visual_brief_df), len(_step2_recs_df),
                )
                return _visual_brief_df, _step2_recs_df
            except Exception as exc:
                logger.warning(
                    "⚠️  visual_data.pkl load failed (%s); falling back to Excel", exc
                )

        # ── Slow path: parse Excel directly ───────────────────────────
        if os.path.exists(brief_path):
            _visual_brief_df = pd.read_excel(brief_path, sheet_name="Visual Brief")
            logger.info(
                "✅ Visual brief loaded from Excel — %s rows", len(_visual_brief_df)
            )
        else:
            logger.warning("beaulix_visual_brief.xlsx not found at %s", brief_path)
            _visual_brief_df = pd.DataFrame()

        if os.path.exists(recs_path):
            _step2_recs_df = pd.read_excel(recs_path)
            logger.info(
                "✅ Step 2 recommendations loaded from Excel — %s rows",
                len(_step2_recs_df),
            )
        else:
            logger.warning(
                "beaulix_step2_recommendations.xlsx not found at %s", recs_path
            )
            _step2_recs_df = pd.DataFrame()

        # Write .pkl for subsequent startups
        try:
            import joblib as _jl
            os.makedirs(os.path.join(base_dir, "models"), exist_ok=True)
            _jl.dump(
                {"visual_brief": _visual_brief_df, "step2_recs": _step2_recs_df},
                pkl_path,
            )
            logger.info("💾 Visual data cache written to %s", pkl_path)
        except Exception as exc:
            logger.warning(
                "⚠️  Could not write visual_data.pkl (%s); will re-parse on next startup",
                exc,
            )

        return _visual_brief_df, _step2_recs_df


def build_visual_pkl(base_dir: str) -> None:
    """
    Pre-process both Excel files to ``models/visual_data.pkl``.

    Run once at build/deploy time to eliminate cold-start Excel parsing:

        python -c "import excel_cache; excel_cache.build_visual_pkl('/path/to/backend')"

    Args:
        base_dir: Directory containing the source Excel files and models/ sub-dir.
    """
    import joblib as _jl

    brief_path = os.path.join(base_dir, "beaulix_visual_brief.xlsx")
    recs_path  = os.path.join(base_dir, "beaulix_step2_recommendations.xlsx")
    pkl_path   = os.path.join(base_dir, "models", "visual_data.pkl")

    os.makedirs(os.path.join(base_dir, "models"), exist_ok=True)

    print(f"📂 Loading {brief_path} ...")
    brief_df = (
        pd.read_excel(brief_path, sheet_name="Visual Brief")
        if os.path.exists(brief_path)
        else pd.DataFrame()
    )
    print(f"📂 Loading {recs_path} ...")
    recs_df = (
        pd.read_excel(recs_path)
        if os.path.exists(recs_path)
        else pd.DataFrame()
    )
    _jl.dump({"visual_brief": brief_df, "step2_recs": recs_df}, pkl_path)
    print(
        f"✅ Saved {pkl_path} — {len(brief_df):,} brief rows, {len(recs_df):,} step2 rows"
    )
