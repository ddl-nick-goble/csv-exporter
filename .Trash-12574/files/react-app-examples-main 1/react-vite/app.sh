#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

export PORT="${PORT:-8888}"
export DB_PATH="${DB_PATH:-$(readlink -f ../shared-data/sec.db)}"

# ── Bootstrap the SEC database on first run (one-time ~1min download+build) ──
if [ ! -f "$DB_PATH" ]; then
    echo "SEC database not found - building it once (downloads ~114MB from SEC)..."
    (cd ../shared-data && python etl.py)
fi

# ── Build the React frontend when the build is missing, forced, or stale ──
# Stale = any frontend source is newer than the last build output, so editing
# source and re-running app.sh always serves the latest UI without FORCE_BUILD.
needs_build() {
    [ "${FORCE_BUILD:-0}" = "1" ] && return 0
    [ ! -f "frontend/dist/index.html" ] && return 0
    [ -n "$(find frontend/src frontend/index.html frontend/vite.config.js frontend/package.json \
            -newer frontend/dist/index.html 2>/dev/null)" ] && return 0
    return 1
}

if needs_build; then
    echo "Building React frontend..."
    cd frontend
    if [ ! -d "node_modules" ]; then
        npm install
    fi
    npm run build
    cd ..
fi

# ── Free the port if stale (skip prod 8888) ──
if [ "$PORT" != "8888" ]; then
    fuser -k "$PORT/tcp" 2>/dev/null || true
    for i in 1 2 3 4 5; do
        fuser "$PORT/tcp" >/dev/null 2>&1 || break
        echo "Waiting for port $PORT to free up... ($i/5)"
        sleep 1
    done
fi

# ── Resolve the public URL, working in any port-proxying Domino IDE ──
# Jupyter exposes its own non-/r/ mount via jupyter-server-proxy. VS Code
# workspaces only expose code-server's /r/ proxy (and its $VSCODE_PROXY_URI),
# which renders inside a sandboxed iframe — the page handles that by inlining
# its JS/CSS so there are no cross-origin subresource fetches.
if [ -n "${JUPYTER_SERVER_URL:-}" ]; then
    _HOST=$(curl -sf http://localhost:8899/cliSiteConfig \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['host'].rstrip('/'))" 2>/dev/null || true)
    _PATH=$(python3 -c "import os,urllib.parse as u; print(u.urlparse(os.environ['JUPYTER_SERVER_URL']).path.rstrip('/'))")
    _URL=""
    [ -n "${_HOST}${_PATH}" ] && _URL="${_HOST}${_PATH}/proxy/${PORT}/"
elif [ -n "${VSCODE_PROXY_URI:-}" ]; then
    _URL="${VSCODE_PROXY_URI//\{\{port\}\}/$PORT}"
else
    _URL=""
fi

if [ -n "$_URL" ]; then
    echo ""
    echo "  Open: ${_URL}"
    echo ""
fi

echo "Starting react-vite on port $PORT..."
exec python app.py
