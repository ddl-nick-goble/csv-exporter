"""
Governance Evidence Exporter — static server only.

Why so thin: Domino's workspace API proxy at $DOMINO_API_PROXY exposes only the
*Public API* surface, which has no governance endpoints. The governance API lives
on Nucleus and is callable from the browser using the user's Domino session
cookie (the same way the Domino UI itself talks to it). So the React bundle does
all governance work directly from the client side, same-origin, with cookies.

This server just serves the built React bundle from frontend/dist/.
"""
import logging
import os

from flask import Flask, send_from_directory

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "frontend", "dist")

log = logging.getLogger("governance-exporter")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = Flask(__name__, static_folder=None)


@app.get("/healthz")
def healthz():
    return {"ok": True, "dist": os.path.isdir(DIST)}


@app.get("/")
def index():
    return send_from_directory(DIST, "index.html")


@app.get("/<path:path>")
def static_proxy(path):
    full = os.path.join(DIST, path)
    if os.path.isfile(full):
        return send_from_directory(DIST, path)
    return send_from_directory(DIST, "index.html")


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8888"))
    log.info("serving on 0.0.0.0:%d", port)
    if not os.path.isdir(DIST):
        log.warning("frontend/dist/ not found — run `npm run build` in frontend/ first.")
    app.run(host="0.0.0.0", port=port, threaded=True)
