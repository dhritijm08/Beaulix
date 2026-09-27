#!/bin/sh
# Runs at container startup (not build time), so GOOGLE_SERVICE_ACCOUNT_JSON /
# GDRIVE_* env vars are available here — Pre-Deploy Command isn't available
# on Render's free tier, so this replaces it.
#
# NOTE: data/model setup is best-effort, not required to start the server.
# /predict and /predict-step2 (marketing-analysis benchmarks) need the
# trained model and will simply return without benchmark data if it's
# missing — the frontend already treats /predict as best-effort and never
# blocks image generation on it. /classify-product-category, /ad-copy, and
# /generate (a separate GPU service entirely) do not depend on this model
# at all. So: try the data/train/cache steps, but don't let a missing
# credential (or any other failure here) prevent uvicorn from starting.
set -e

cd /app

echo "[entrypoint] downloading data files..."
if ! python download_data.py; then
  echo "[entrypoint] WARNING: data download failed — /predict and /predict-step2 benchmarks will be unavailable, but the server will still start (classifier, ad-copy, and generation are unaffected)."
elif ! python train_simple_model.py; then
  echo "[entrypoint] WARNING: model training failed — same as above, /predict benchmarks unavailable."
elif ! python build_visual_cache.py; then
  echo "[entrypoint] WARNING: visual cache build failed — same as above."
fi

echo "[entrypoint] starting server..."
exec uvicorn server:app --host 0.0.0.0 --port "${PORT:-8000}"
