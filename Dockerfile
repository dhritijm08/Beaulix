# Beaulix ML backend — Docker build.
#
# WHY THIS EXISTS: Render's native "Python 3" runtime only runs `pip install`;
# it has no mechanism to install OS-level (apt) packages. pytesseract is a
# pure-Python wrapper around the `tesseract` command-line binary — pip
# installs the wrapper fine, but the actual OCR binary was never present on
# the deploy image, which is exactly what backend/requirements.txt's own
# comment already warned about. This Dockerfile's only job beyond the
# existing pip install is `apt-get install tesseract-ocr`.
#
# WHAT DID NOT CHANGE: application code, OCR classifier logic, keyword
# matching, copy templates, V4 renderer, creative directions, compositing,
# fallback behavior, the build command's pip/steps ordering. Only the data
# download + training steps moved to the Pre-Deploy Command (see below) —
# `docker build` does not receive Render's Environment Variables, so
# GOOGLE_SERVICE_ACCOUNT_JSON wouldn't be available for download_data.py if
# it stayed inside this file.

FROM python:3.12.3-slim

# tesseract-ocr: the actual system binary pytesseract shells out to.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Root Directory was "backend" under the old Python-runtime service; with
# Docker, Render builds from the repo root, so we COPY backend/ explicitly
# and run everything from /app to match every existing relative path
# (server.py's own file reads, model paths, etc.) unchanged.
COPY backend/ /app/

RUN pip install --no-cache-dir -r requirements-build.txt \
    && pip install --no-cache-dir -r requirements.txt

# download_data.py / train_simple_model.py / build_visual_cache.py need
# GOOGLE_SERVICE_ACCOUNT_JSON and GDRIVE_* env vars, which `docker build`
# does not receive — so they can't run here. Render's Pre-Deploy Command
# would normally handle this, but it isn't available on the free tier, so
# entrypoint.sh runs them at container STARTUP instead (env vars ARE
# available then), before finally exec'ing uvicorn.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
