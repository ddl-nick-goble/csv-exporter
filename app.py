"""
Governance Evidence Exporter — static server + Domino-backed API.

The browser talks ONLY to this app's endpoints. All Domino API calls happen
server-side; the frontend has no knowledge of Domino's URL structure.

Endpoints:
    GET  /api/probe   Server-Sent Events. Emits, in order:
                        meta     — { projects, all_bundles, candidates }
                        bundle   — { bundle, computedList }  (per accessible bundle)
                        progress — { done, total, accessible, denied }
                        done     — {}            (terminal)
                        error    — { stage, detail }   (fatal)
    GET  /api/health  Liveness.

Auth + routing:
  The governance API (/api/governance/v1/*) is NOT part of Domino's Public API.
  Neither $DOMINO_API_PROXY (localhost:8899) nor the internal public-api host
  will serve it — both return 404 regardless of auth. The governance API *is*
  served by the public ingress host (from GET $DOMINO_API_PROXY/cliSiteConfig),
  the same host the Domino UI talks to. It accepts a short-lived bearer token
  from $DOMINO_API_PROXY/access-token. We resolve the host once, mint/refresh
  the token as needed, and call upstream as this run's identity (the
  workspace/app owner). Per-bundle 403s are how we detect lack of access.

Probe model:
  We pre-filter bundles to those whose project the user can see (/v4/projects
  only returns projects the user is a member of, while /bundles can return
  instance-wide bundles for GovernanceAdmins — calls on the latter will 403).
  We then probe the survivors in parallel: a bundle is "accessible" if at least
  one of its attached policies returns 200 from compute-policy. 404 on a single
  policy means the policy isn't computable on this bundle — skip it, keep the
  bundle. 403 on every attached policy means the user can't see the bundle.

Static serving: anything that isn't /api/* is served from frontend/dist/
(SPA fallback to index.html).
"""
import base64
import json
import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from flask import Flask, Response, send_from_directory

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "frontend", "dist")

API_PROXY = os.environ.get("DOMINO_API_PROXY", "http://localhost:8899").rstrip("/")
UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", "60"))
PROBE_CONCURRENCY = int(os.environ.get("PROBE_CONCURRENCY", "10"))

log = logging.getLogger("governance-exporter")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = Flask(__name__, static_folder=None)

# ── Upstream host + token resolution (process-wide, cached) ──────────────────
_lock = threading.Lock()
_host_cache = {"host": None}
_token_cache = {"token": None, "exp": 0.0}


def _ingress_host():
    """Resolve the public Domino host that actually serves the governance API."""
    if _host_cache["host"]:
        return _host_cache["host"]
    with _lock:
        if _host_cache["host"]:
            return _host_cache["host"]
        host = os.environ.get("GOVERNANCE_INGRESS_HOST", "").rstrip("/")
        if not host:
            r = requests.get(f"{API_PROXY}/cliSiteConfig", timeout=10)
            r.raise_for_status()
            host = str(r.json()["host"]).rstrip("/")
        _host_cache["host"] = host
        log.info("resolved Domino ingress host: %s", host)
        return host


def _jwt_ttl(token, default):
    """Seconds until the JWT expires (best-effort decode of the exp claim)."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
        if exp:
            return max(30.0, float(exp) - time.time())
    except Exception:
        pass
    return default


def _bearer(force=False):
    """Return a valid bearer token, refreshing from the API proxy as needed."""
    now = time.time()
    if not force and _token_cache["token"] and now < _token_cache["exp"] - 30:
        return _token_cache["token"]
    with _lock:
        now = time.time()
        if not force and _token_cache["token"] and now < _token_cache["exp"] - 30:
            return _token_cache["token"]
        r = requests.get(f"{API_PROXY}/access-token", timeout=10)
        r.raise_for_status()
        tok = r.text.strip()
        _token_cache["token"] = tok
        _token_cache["exp"] = now + _jwt_ttl(tok, default=240.0)
        return tok


def _domino(method, path, params=None, json_body=None):
    """One upstream call with bearer auth and a single 401 retry."""
    host = _ingress_host()
    url = f"{host}/{path.lstrip('/')}"

    def call(force):
        return requests.request(
            method, url,
            params=params,
            json=json_body,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {_bearer(force=force)}",
            },
            timeout=UPSTREAM_TIMEOUT,
        )

    resp = call(force=False)
    if resp.status_code == 401:
        # Token may have expired between mint and use — refresh once, retry.
        resp = call(force=True)
    return resp


def _unwrap_list(data, keys):
    if data is None:
        return []
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for k in keys:
            v = data.get(k)
            if isinstance(v, list):
                return v
    return []


def _fetch_projects():
    resp = _domino("GET", "v4/projects")
    resp.raise_for_status()
    out = []
    for p in _unwrap_list(resp.json(), ["projects", "data", "items"]):
        pid = p.get("id") or p.get("_id")
        if not pid:
            continue
        owner = p.get("owner") or {}
        out.append({
            "id": pid,
            "name": p.get("name") or "(unnamed)",
            "owner_username": p.get("ownerUsername") or owner.get("userName") or "",
            "owner_name": owner.get("fullName") or p.get("ownerUsername") or "",
        })
    return out


def _fetch_bundles():
    """Paginates the bundles endpoint. Some Domino versions reject limit/offset
    and return the full list in one shot; we handle both shapes."""
    out = []
    limit = 200
    offset = 0
    while True:
        resp = _domino("GET", "api/governance/v1/bundles",
                       params={"limit": limit, "offset": offset})
        if not resp.ok:
            if 400 <= resp.status_code < 500 and offset == 0:
                resp = _domino("GET", "api/governance/v1/bundles")
                resp.raise_for_status()
                return _unwrap_list(resp.json(), ["bundles", "data", "items"])
            resp.raise_for_status()
        page = _unwrap_list(resp.json(), ["bundles", "data", "items"])
        if not page:
            break
        out.extend(page)
        if len(page) < limit:
            break
        offset += limit
        if offset > 50000:
            break
    return out


def _bundle_policy_refs(bundle):
    """Every policy attached to a bundle needs its own compute-policy call. Older
    bundles only expose the primary policy via the legacy top-level field."""
    refs = []
    seen = set()
    for p in (bundle.get("policies") or []):
        if not isinstance(p, dict):
            continue
        pid = p.get("policyId")
        if not pid:
            continue
        vid = p.get("policyVersionId")
        k = (pid, vid or "")
        if k in seen:
            continue
        seen.add(k)
        refs.append({"policyId": pid, "policyVersionId": vid})
    if not refs and bundle.get("policyId"):
        refs.append({
            "policyId": bundle["policyId"],
            "policyVersionId": bundle.get("policyVersionId"),
        })
    return refs


def _probe_bundle(bundle):
    """Returns (computed_list, accessible). accessible=False means every attached
    policy 403'd → the user can't see the bundle."""
    bid = bundle.get("id") or bundle.get("_id")
    refs = _bundle_policy_refs(bundle)
    # Bundles with no attached policy contribute no answers but are still
    # accessible (so the UI can surface them).
    if not refs:
        return [], True
    out = []
    denials = 0
    for ref in refs:
        body = {"bundleId": bid, "policyId": ref["policyId"]}
        if ref.get("policyVersionId"):
            body["policyVersionId"] = ref["policyVersionId"]
        resp = _domino("POST", "api/governance/v1/rpc/compute-policy", json_body=body)
        if resp.status_code == 404:
            # Policy not computable on this bundle — skip the policy, keep the bundle.
            continue
        if resp.status_code == 403:
            denials += 1
            continue
        if not resp.ok:
            resp.raise_for_status()
        out.append(resp.json())
    if not out and denials > 0:
        return None, False
    return out, True


def _sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/healthz")
@app.get("/api/health")
def health():
    return {"ok": True, "dist": os.path.isdir(DIST)}


@app.get("/api/probe")
def probe():
    """Stream everything the UI needs in one connection."""
    def gen():
        try:
            projects = _fetch_projects()
        except Exception as e:
            log.exception("projects fetch failed")
            yield _sse("error", {"stage": "projects", "detail": str(e)})
            return

        try:
            all_bundles = _fetch_bundles()
        except Exception as e:
            log.exception("bundles fetch failed")
            yield _sse("error", {"stage": "bundles", "detail": str(e)})
            return

        # Pre-filter: only bundles whose owning project the user can see. The
        # rest will ALWAYS 403 on compute-policy — drop them without ever making
        # the call so the probe doesn't spend network time on guaranteed denials.
        accessible_pids = {p["id"] for p in projects}
        candidates = [
            b for b in all_bundles
            if (b.get("projectId") or (b.get("project") or {}).get("id") or "") in accessible_pids
        ]

        yield _sse("meta", {
            "projects": projects,
            "all_bundles": len(all_bundles),
            "candidates": len(candidates),
        })

        if not candidates:
            yield _sse("done", {})
            return

        done = 0
        accessible = 0
        denied = 0

        with ThreadPoolExecutor(max_workers=PROBE_CONCURRENCY) as ex:
            futures = {ex.submit(_probe_bundle, b): b for b in candidates}
            for f in as_completed(futures):
                bundle = futures[f]
                try:
                    computed_list, ok = f.result()
                except Exception as e:
                    log.warning("probe failed for bundle %s: %s", bundle.get("id"), e)
                    ok = False
                    computed_list = None
                done += 1
                if ok:
                    accessible += 1
                    yield _sse("bundle", {"bundle": bundle, "computedList": computed_list})
                else:
                    denied += 1
                yield _sse("progress", {
                    "done": done,
                    "total": len(candidates),
                    "accessible": accessible,
                    "denied": denied,
                })

        yield _sse("done", {})

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


# ── Static React bundle ──────────────────────────────────────────────────────
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
