#!/usr/bin/env bash
# Production entry: build the React bundle if stale, then run Flask on :8888.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

export PORT="${PORT:-8888}"

# Build the frontend if dist is missing or any source is newer than the last build.
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

if [ "$PORT" != "8888" ]; then
    fuser -k "$PORT/tcp" 2>/dev/null || true
fi

# Print the public URL when we can resolve it from the host IDE.
if [ -n "${JUPYTER_SERVER_URL:-}" ]; then
    _HOST=$(curl -sf http://localhost:8899/cliSiteConfig \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['host'].rstrip('/'))" 2>/dev/null || true)
    _PATH=$(python3 -c "import os,urllib.parse as u; print(u.urlparse(os.environ['JUPYTER_SERVER_URL']).path.rstrip('/'))")
    [ -n "${_HOST}${_PATH}" ] && echo "" && echo "  Open: ${_HOST}${_PATH}/proxy/${PORT}/" && echo ""
elif [ -n "${VSCODE_PROXY_URI:-}" ]; then
    echo "" && echo "  Open: ${VSCODE_PROXY_URI//\{\{port\}\}/$PORT}" && echo ""
fi

echo "Starting governance-exporter on port $PORT..."
exec python app.py
