#!/usr/bin/env bash
# dev.sh - full HMR dev loop through Domino's reverse proxy.
#
# Architecture (3 processes):
#   1. Flask        :$API_PORT       - serves /api/* only
#   2. Vite dev     :$VITE_INTERNAL  - listens internally, base set to Domino prefix
#   3. proxy.mjs    :$VITE_PUBLIC    - what user opens; re-adds prefix and forwards to Vite
#
# Open the printed URL (uses $VITE_PUBLIC). Edit any frontend/src/* - HMR
# pushes the change in <100ms with React state preserved.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

export API_PORT="${API_PORT:-8501}"
export VITE_PUBLIC="${VITE_PUBLIC:-5173}"
export VITE_INTERNAL="${VITE_INTERNAL:-5174}"

# ── Install frontend deps on first run (now includes http-proxy) ──
if [ ! -d "frontend/node_modules" ] || [ ! -d "frontend/node_modules/http-proxy" ]; then
    echo "Installing frontend dependencies..."
    (cd frontend && npm install)
fi

# ── Resolve the public proxy path (sets Vite's base AND the printed URL) ──
# Works in any port-proxying Domino IDE; each declares its own base, differing
# on whether /r/ stays in the path. Trust the IDE's own var first; only guess
# from $DOMINO_RUN_HOST_PATH when neither is set:
#   * VS Code -> $VSCODE_PROXY_URI    (full URL, {{port}} placeholder, keeps /r/)
#   * Jupyter -> $JUPYTER_SERVER_URL  (its base path, drops /r/)
# VITE_BASE_PATH carries no trailing slash; Vite/proxy append the / themselves.
_URL=""
if [ -n "${VSCODE_PROXY_URI:-}" ]; then
    _URL="${VSCODE_PROXY_URI//\{\{port\}\}/$VITE_PUBLIC}"   # full public URL
    _noscheme="${_URL#*://}"                                 # host/path.../
    VITE_BASE_PATH="/${_noscheme#*/}"                        # /path.../
    VITE_BASE_PATH="${VITE_BASE_PATH%/}"                     # drop trailing slash
else
    _HOST=$(curl -sf http://localhost:8899/cliSiteConfig \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['host'].rstrip('/'))" 2>/dev/null || true)
    if [ -n "${JUPYTER_SERVER_URL:-}" ]; then
        _PATH=$(python3 -c "import os,urllib.parse as u; print(u.urlparse(os.environ['JUPYTER_SERVER_URL']).path.rstrip('/'))")
    else
        _PATH=$(echo "${DOMINO_RUN_HOST_PATH:-}" | sed 's|/r/|/|g' | sed 's|/$||')
    fi
    VITE_BASE_PATH="${_PATH}/proxy/${VITE_PUBLIC}"
    [ -n "$_HOST" ] && _URL="${_HOST}${VITE_BASE_PATH}/"
fi

# ── Cleanup on exit / Ctrl-C ──
FLASK_PID=""
VITE_PID=""
PROXY_PID=""
cleanup() {
    echo ""
    echo "Stopping dev servers..."
    for p in "$FLASK_PID" "$VITE_PID" "$PROXY_PID"; do
        [ -n "$p" ] && kill "$p" 2>/dev/null || true
    done
    for port in "$API_PORT" "$VITE_INTERNAL" "$VITE_PUBLIC"; do
        fuser -k "$port/tcp" 2>/dev/null || true
    done
}
trap cleanup EXIT INT TERM

# ── Free all three ports ──
for port in "$API_PORT" "$VITE_INTERNAL" "$VITE_PUBLIC"; do
    fuser -k "$port/tcp" 2>/dev/null || true
done
sleep 1

# ── Print the URL ──
if [ -n "$_URL" ]; then
    echo ""
    echo "  Open: ${_URL}"
    echo "  (HMR via Vite dev server, proxied to handle Domino's path stripping)"
    echo ""
fi

# ── Start Flask (API only) ──
echo "Starting Flask API on :$API_PORT..."
PORT="$API_PORT" python app.py > /tmp/react-vite-flask.log 2>&1 &
FLASK_PID=$!

# Wait for Flask
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf "http://localhost:$API_PORT/api/hello" > /dev/null 2>&1; then
        echo "Flask ready."
        break
    fi
    sleep 0.5
done

# ── Start Vite (internal port; base set to full Domino prefix) ──
echo "Starting Vite on :$VITE_INTERNAL (base=$VITE_BASE_PATH/)..."
cd frontend
VITE_BASE="${VITE_BASE_PATH}/" \
VITE_INTERNAL_PORT="$VITE_INTERNAL" \
VITE_API_PORT="$API_PORT" \
    npx vite > /tmp/react-vite-vite.log 2>&1 &
VITE_PID=$!

# Wait for Vite
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf "http://localhost:$VITE_INTERNAL$VITE_BASE_PATH/" > /dev/null 2>&1; then
        echo "Vite ready."
        break
    fi
    sleep 0.5
done

# ── Start the prefixing proxy on the user-facing port ──
echo "Starting proxy on :$VITE_PUBLIC (prefix=$VITE_BASE_PATH)..."
VITE_BASE_PATH="$VITE_BASE_PATH" \
VITE_INTERNAL_PORT="$VITE_INTERNAL" \
VITE_PUBLIC_PORT="$VITE_PUBLIC" \
    exec node proxy.mjs
