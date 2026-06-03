"""
Governance Evidence Exporter — static server + Domino-backed API.

The browser talks ONLY to this app's endpoints. All Domino API calls happen
server-side; the frontend has no knowledge of Domino's URL structure.

Endpoints:
    GET  /api/load     One-shot JSON. Returns { projects, bundles, policies }.
                       Picker renders directly from this — no per-bundle work
                       on load. Policy definitions are deduped: 700 bundles
                       referencing 150 unique policies = 150 /policies/{id}
                       calls, not 700+ compute-policy calls.

    POST /api/evidence body: { bundleIds: [...] }
                       Returns { <bundleId>: [computedList...] }. Called at
                       export time, only for the bundles being exported.

    GET  /api/health   Liveness.

Auth + routing:
  The governance API (/api/governance/v1/*) is NOT part of Domino's Public API.
  Neither $DOMINO_API_PROXY (localhost:8899) nor the internal public-api host
  will serve it — both return 404 regardless of auth. The governance API *is*
  served by the public ingress host (from GET $DOMINO_API_PROXY/cliSiteConfig),
  the same host the Domino UI talks to. It accepts a short-lived bearer token
  from $DOMINO_API_PROXY/access-token. We resolve the host once, mint/refresh
  the token as needed, and call upstream as this run's identity (the
  workspace/app owner). /bundles already enforces per-user access — for
  GovernanceAdmins it returns instance-wide bundles, for others it returns
  only bundles whose project they can see.

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
from flask import Flask, jsonify, request, send_from_directory
from requests.adapters import HTTPAdapter

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "frontend", "dist")

API_PROXY = os.environ.get("DOMINO_API_PROXY", "http://localhost:8899").rstrip("/")
UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", "60"))
FETCH_CONCURRENCY = int(os.environ.get("FETCH_CONCURRENCY", "25"))

# Shared session: keep-alive + a connection pool sized to FETCH_CONCURRENCY
# saves a TLS handshake per upstream call (the single biggest win when
# fanning out hundreds of small GETs to the same host).
_session = requests.Session()
_adapter = HTTPAdapter(
    pool_connections=FETCH_CONCURRENCY,
    pool_maxsize=FETCH_CONCURRENCY,
    pool_block=False,
)
_session.mount("http://", _adapter)
_session.mount("https://", _adapter)

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
        return _session.request(
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
    """Every policy attached to a bundle. Older bundles only expose the primary
    policy via the legacy top-level field."""
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


def _fetch_policy(pid):
    """Full policy definition (stages → evidenceSet → artifacts → questions).
    Returns None if the user can't see this policy (403/404)."""
    resp = _domino("GET", f"api/governance/v1/policies/{pid}")
    if resp.status_code in (403, 404):
        return None
    resp.raise_for_status()
    return resp.json()


def _fetch_policies_for_bundles(bundles):
    """Fetch every unique policy referenced by any bundle, in parallel."""
    pids = set()
    for b in bundles:
        for ref in _bundle_policy_refs(b):
            pids.add(ref["policyId"])
    if not pids:
        return []
    out = []
    with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY) as ex:
        futures = {ex.submit(_fetch_policy, pid): pid for pid in pids}
        for f in as_completed(futures):
            pid = futures[f]
            try:
                pol = f.result()
            except Exception as e:
                log.warning("policy fetch failed for %s: %s", pid, e)
                continue
            if pol:
                out.append(pol)
    return out


def _compute_policy(bundle_id, policy_id, policy_version_id=None):
    """One compute-policy call for a (bundle, policy) pair. Returns the
    computed payload or None if the user can't compute it (403/404)."""
    body = {"bundleId": bundle_id, "policyId": policy_id}
    if policy_version_id:
        body["policyVersionId"] = policy_version_id
    resp = _domino("POST", "api/governance/v1/rpc/compute-policy", json_body=body)
    if resp.status_code in (403, 404):
        return None
    resp.raise_for_status()
    return resp.json()


def _fetch_evidence_for_bundle(bundle):
    """Returns computedList for one bundle by calling compute-policy for each
    of the bundle's attached policies in parallel."""
    bid = bundle.get("id") or bundle.get("_id")
    refs = _bundle_policy_refs(bundle)
    if not bid or not refs:
        return bid, []
    out = []
    # For multi-policy bundles, fan out the per-policy calls — most bundles
    # have one policy so this is a no-op for them.
    if len(refs) == 1:
        ref = refs[0]
        payload = _compute_policy(bid, ref["policyId"], ref.get("policyVersionId"))
        if payload:
            out.append(payload)
    else:
        with ThreadPoolExecutor(max_workers=min(len(refs), 4)) as ex:
            futs = [ex.submit(_compute_policy, bid, r["policyId"], r.get("policyVersionId")) for r in refs]
            for f in futs:
                try:
                    payload = f.result()
                except Exception as e:
                    log.warning("compute-policy failed for bundle %s: %s", bid, e)
                    continue
                if payload:
                    out.append(payload)
    return bid, out


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/healthz")
@app.get("/api/health")
def health():
    return {"ok": True, "dist": os.path.isdir(DIST)}


@app.get("/api/load")
def load():
    """One-shot picker payload. Parallel-fetches projects + bundles, then
    parallel-fetches every unique policy definition. No compute-policy on
    the hot path."""
    t0 = time.time()
    try:
        # projects + bundles in parallel — they're independent.
        with ThreadPoolExecutor(max_workers=2) as ex:
            fut_projects = ex.submit(_fetch_projects)
            fut_bundles = ex.submit(_fetch_bundles)
            projects = fut_projects.result()
            bundles = fut_bundles.result()
    except Exception as e:
        log.exception("load: projects/bundles fetch failed")
        return jsonify({"error": "load_failed", "detail": str(e)}), 502

    try:
        policies = _fetch_policies_for_bundles(bundles)
    except Exception as e:
        log.exception("load: policies fetch failed")
        return jsonify({"error": "policies_failed", "detail": str(e)}), 502

    log.info("load: %d projects, %d bundles, %d policies in %.2fs",
             len(projects), len(bundles), len(policies), time.time() - t0)
    return jsonify({
        "projects": projects,
        "bundles": bundles,
        "policies": policies,
    })


@app.post("/api/evidence")
def evidence():
    """Fetch compute-policy payloads for the given bundle IDs. Used at export
    time once the user has chosen which bundles to include."""
    body = request.get_json(silent=True) or {}
    ids = body.get("bundleIds") or []
    if not isinstance(ids, list):
        return jsonify({"error": "bundleIds must be a list"}), 400
    if not ids:
        return jsonify({"results": {}})

    # We need bundle objects to know their attached policies — re-list and
    # filter (cheap, one call), avoids needing the client to send back the
    # full bundle each time.
    try:
        all_bundles = _fetch_bundles()
    except Exception as e:
        log.exception("evidence: bundles fetch failed")
        return jsonify({"error": "bundles_failed", "detail": str(e)}), 502

    wanted = set(ids)
    targets = [b for b in all_bundles if (b.get("id") or b.get("_id")) in wanted]

    results = {}
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY) as ex:
        futures = {ex.submit(_fetch_evidence_for_bundle, b): b for b in targets}
        for f in as_completed(futures):
            b = futures[f]
            try:
                bid, computed_list = f.result()
            except Exception as e:
                log.warning("evidence fetch failed for bundle %s: %s", b.get("id"), e)
                continue
            if bid:
                results[bid] = computed_list
    log.info("evidence: %d/%d bundles in %.2fs", len(results), len(ids), time.time() - t0)
    return jsonify({"results": results})


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
