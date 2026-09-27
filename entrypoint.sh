#!/bin/sh
# Runs at container startup (not build time), so GOOGLE_SERVICE_ACCOUNT_JSON /
# GDRIVE_* env vars are available here — Pre-Deploy Command isn't available
# on Render's free tier, so this replaces it. Exits immediately if any step
# fails, rather than starting uvicorn against missing/stale data.
set -e

cd /app

echo "[entrypoint] downloading data files..."
python download_data.py

echo "[entrypoint] training model..."
python train_simple_model.py

echo "[entrypoint] building visual cache..."
python build_visual_cache.py

echo "[entrypoint] starting server..."
exec uvicorn server:app --host 0.0.0.0 --port "${PORT:-8000}"
