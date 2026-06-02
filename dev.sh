#!/usr/bin/env bash
# Dev loop: Flask + Vite + a tiny prefixing proxy, so HMR works behind Domino's /proxy/$PORT/.
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

export API_PORT="${API_PORT:-8501}"
export VITE_PUBLIC="${VITE_PUBLIC:-5173}"
export VITE_INTERNAL="${VITE_INTERNAL:-5174}"

if [ ! -d "frontend/node_modules" ] || [ ! -d "frontend/node_modules/http-proxy" ]; then
    echo "Installing frontend dependencies..."
    (cd frontend && npm install)
fi

_URL=""
if [ -n "${VSCODE_PROXY_URI:-}" ]; then
    _URL="${VSCODE_PROXY_URI//\{\{port\}\}/$VITE_PUBLIC}"
    _noscheme="${_URL#*://}"
    VITE_BASE_PATH="/${_noscheme#*/}"
    VITE_BASE_PATH="${VITE_BASE_PATH%/}"
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

FLASK_PID=""; VITE_PID=""; PROXY_PID=""
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

for port in "$API_PORT" "$VITE_INTERNAL" "$VITE_PUBLIC"; do
    fuser -k "$port/tcp" 2>/dev/null || true
done
sleep 1

[ -n "$_URL" ] && echo "" && echo "  Open: ${_URL}" && echo ""

echo "Starting Flask API on :$API_PORT..."
PORT="$API_PORT" python app.py > /tmp/governance-exporter-flask.log 2>&1 &
FLASK_PID=$!

for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf "http://localhost:$API_PORT/api/health" > /dev/null 2>&1; then
        echo "Flask ready."
        break
    fi
    sleep 0.5
done

echo "Starting Vite on :$VITE_INTERNAL (base=$VITE_BASE_PATH/)..."
cd frontend
VITE_BASE="${VITE_BASE_PATH}/" \
VITE_INTERNAL_PORT="$VITE_INTERNAL" \
VITE_API_PORT="$API_PORT" \
    npx vite > /tmp/governance-exporter-vite.log 2>&1 &
VITE_PID=$!

for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf "http://localhost:$VITE_INTERNAL$VITE_BASE_PATH/" > /dev/null 2>&1; then
        echo "Vite ready."
        break
    fi
    sleep 0.5
done

echo "Starting proxy on :$VITE_PUBLIC (prefix=$VITE_BASE_PATH)..."
VITE_BASE_PATH="$VITE_BASE_PATH" \
VITE_INTERNAL_PORT="$VITE_INTERNAL" \
VITE_PUBLIC_PORT="$VITE_PUBLIC" \
    exec node proxy.mjs
