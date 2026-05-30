#!/bin/bash
set -euo pipefail

echo "Starting Beaulix ML System..."

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "Python 3 is not installed. Please install Python 3.8 or higher."
    exit 1
fi

# ── Virtualenv ─────────────────────────────────────────────────────────
# Using a venv avoids re-installing packages on every cold start and isolates
# dependencies from the system Python.  The venv is created once and reused.
# Named "venv" (no dot) to match the committed backend/venv/ directory and
# avoid confusion between .venv/ and venv/ — both are in .gitignore but only
# one name should be used consistently.
VENV_DIR="$(dirname "$0")/venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# Install / sync dependencies (fast no-op when nothing has changed)
echo "Installing dependencies..."
pip install --quiet -r requirements.txt

# ── Log rotation ───────────────────────────────────────────────────────
# Rotate server.log before each start so the file never grows unbounded.
# Keeps the last 5 compressed archives (server.log.1.gz … server.log.5.gz).
LOG_FILE="$(dirname "$0")/server.log"
if command -v logrotate &> /dev/null; then
    # Use logrotate if available (preferred on systemd hosts)
    logrotate --state /tmp/beaulix-logrotate.state <(cat <<EOF
$LOG_FILE {
    rotate 5
    compress
    missingok
    notifempty
    copytruncate
}
EOF
    )
elif [ -f "$LOG_FILE" ] && [ "$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)" -gt $((10 * 1024 * 1024)) ]; then
    # Fallback: manual rotation when the file exceeds 10 MB
    for i in 4 3 2 1; do
        [ -f "${LOG_FILE}.${i}.gz" ] && mv "${LOG_FILE}.${i}.gz" "${LOG_FILE}.$((i+1)).gz"
    done
    gzip -c "$LOG_FILE" > "${LOG_FILE}.1.gz"
    > "$LOG_FILE"   # truncate (not remove) so the running process keeps its fd
fi

# ── Start the API server (supervised) ─────────────────────────────────
# A bare `python3 server.py &` silently dies with no restart.
# This loop restarts the server on non-zero exit and is killed when the
# script receives SIGINT/SIGTERM (e.g. Ctrl-C or systemd stop).
#
# MANAGED ENVIRONMENTS (Render, Railway, Fly.io, etc.):
# The platform is the process supervisor on these hosts — this loop is
# redundant and causes health checks to see the shell script as alive
# even when uvicorn has crashed.  Set MANAGED_DEPLOY=1 in your platform's
# environment variables to bypass the restart loop and exec the server
# directly (no shell wrapper, correct health-check behaviour).
#
# ⚠️  WARNING: Forgetting MANAGED_DEPLOY=1 on a managed platform means:
#   • The platform sees the shell script as the process (not uvicorn)
#   • Health checks pass even when the server is down
#   • Zero-downtime / rolling deploys behave unexpectedly
#   • The platform's restart policy conflicts with the loop here
# Always set MANAGED_DEPLOY=1 in your Render / Railway / Fly.io env vars.
#
# For VPS deployments, prefer systemd or supervisord over this script.
echo "Starting API server..."

if [ "${MANAGED_DEPLOY:-0}" = "1" ]; then
    echo "MANAGED_DEPLOY=1 detected — running server directly (no restart loop)."
    exec python3 server.py --host 0.0.0.0 --port "${PORT:-8000}"
fi

_server_restarts=0
_server_pid=""

# Trap so Ctrl-C kills the child before exiting
_cleanup() {
    echo ""
    echo "Stopping server (PID: ${_server_pid:-unknown})..."
    [ -n "$_server_pid" ] && kill "$_server_pid" 2>/dev/null
    wait "$_server_pid" 2>/dev/null
    echo "Server stopped."
    exit 0
}
trap _cleanup INT TERM

while true; do
    python3 server.py >> "$LOG_FILE" 2>&1 &
    _server_pid=$!

    if [ "$_server_restarts" -eq 0 ]; then
        sleep 3
        echo ""
        echo "✅ System ready!"
        echo "API running at: http://localhost:8000"
        echo ""
        echo "To test the API, open another terminal and run:"
        echo "curl http://localhost:8000/health"
        echo ""
        echo "Logs: $LOG_FILE"
        echo "To stop the server, press Ctrl+C"
        echo ""
    fi

    wait "$_server_pid"
    _exit_code=$?
    _server_pid=""

    if [ $_exit_code -eq 0 ]; then
        # Clean shutdown (e.g. SIGTERM from _cleanup above)
        break
    fi

    _server_restarts=$((_server_restarts + 1))
    echo "$(date '+%Y-%m-%dT%H:%M:%S') [start.sh] server exited with code $_exit_code, restart #$_server_restarts in 5s..." | tee -a "$LOG_FILE"
    sleep 5
done
