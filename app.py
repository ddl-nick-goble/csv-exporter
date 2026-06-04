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
  the same host the Domino UI talks to.

  Two auth surfaces, two schemes:
    - governance: X-Domino-Api-Key, sourced from DOMINO_USER_API_KEY (set
      automatically inside any Domino workspace/app). Stable, no expiry.
    - non-governance (e.g. /v4/*): Authorization: Bearer <jwt> minted by
      $DOMINO_API_PROXY/access-token. Short-lived; refreshed on 401.

  /bundles already enforces per-user access — for GovernanceAdmins it
  returns instance-wide bundles, for others it returns only bundles whose
  project they can see.

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
from flask import Flask, Response, jsonify, request, send_from_directory
from requests.adapters import HTTPAdapter

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "frontend", "dist")

API_PROXY = os.environ.get("DOMINO_API_PROXY", "http://localhost:8899").rstrip("/")
UPSTREAM_TIMEOUT = float(os.environ.get("UPSTREAM_TIMEOUT", "60"))
FETCH_CONCURRENCY = int(os.environ.get("FETCH_CONCURRENCY", "25"))
# Multi-policy bundles fan out per-policy compute calls inside a worker
# (see _fetch_evidence_for_bundle), so the pool needs headroom beyond the
# top-level worker count or urllib3 will spam "pool is full" warnings and
# discard connections (each discarded conn = a fresh TLS handshake).
INNER_FANOUT = int(os.environ.get("INNER_FANOUT", "4"))
_POOL_SIZE = max(FETCH_CONCURRENCY * INNER_FANOUT, 64)

# Shared session: keep-alive + a connection pool sized to the worst-case
# concurrent in-flight upstream calls. Saves a TLS handshake per call (the
# single biggest win when fanning out hundreds of small GETs to one host).
_session = requests.Session()
_adapter = HTTPAdapter(
    pool_connections=4,        # number of distinct host pools we cache
    pool_maxsize=_POOL_SIZE,   # connections per host pool
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
            r = _session.get(f"{API_PROXY}/cliSiteConfig", timeout=10)
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
    """Return a valid bearer token, refreshing from the API proxy as needed.

    Only used for non-governance Domino endpoints (e.g. /v4/*). Governance
    calls authenticate with the user's API key — see _api_key() / _domino().
    """
    now = time.time()
    if not force and _token_cache["token"] and now < _token_cache["exp"] - 30:
        return _token_cache["token"]
    with _lock:
        now = time.time()
        if not force and _token_cache["token"] and now < _token_cache["exp"] - 30:
            return _token_cache["token"]
        r = _session.get(f"{API_PROXY}/access-token", timeout=10)
        r.raise_for_status()
        tok = r.text.strip()
        _token_cache["token"] = tok
        _token_cache["exp"] = now + _jwt_ttl(tok, default=240.0)
        return tok


def _api_key():
    """The user's Domino API key, used to authenticate governance calls.

    Populated automatically by Domino in every workspace/app (DOMINO_USER_API_KEY).
    Falls back to DOMINO_API_KEY for non-Domino environments. We don't cache:
    reading os.environ is free, and avoiding a cache means rotation works
    immediately on next request.
    """
    key = os.environ.get("DOMINO_USER_API_KEY") or os.environ.get("DOMINO_API_KEY") or ""
    return key.strip()


def _is_governance_path(path):
    """Governance endpoints use a different auth surface than the public API:
    X-Domino-Api-Key instead of the short-lived bearer from /access-token."""
    return path.lstrip("/").startswith("api/governance/")


def _domino(method, path, params=None, json_body=None):
    """One upstream call. Auth surface depends on the path:

      - governance (`api/governance/v1/*`): X-Domino-Api-Key, no retry on 401
        (a stale/missing key won't be fixed by retrying).
      - everything else: Authorization: Bearer …, with one 401 retry that
        force-refreshes the token (it may have expired between mint and use).
    """
    host = _ingress_host()
    url = f"{host}/{path.lstrip('/')}"
    is_gov = _is_governance_path(path)

    def call(force):
        if is_gov:
            headers = {
                "Accept": "application/json",
                "X-Domino-Api-Key": _api_key(),
            }
        else:
            headers = {
                "Accept": "application/json",
                "Authorization": f"Bearer {_bearer(force=force)}",
            }
        return _session.request(
            method, url,
            params=params,
            json=json_body,
            headers=headers,
            timeout=UPSTREAM_TIMEOUT,
        )

    resp = call(force=False)
    # Bearer can race against its own TTL; refresh-and-retry catches that.
    # API keys don't expire — a 401 there is a real config problem; surface it.
    if resp.status_code == 401 and not is_gov:
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


def _projects_from_bundles(bundles):
    """Derive the project list from the bundles response.

    We used to hit /v4/projects on the public API for this, but that surface
    has a 30-60s identity-propagation warmup after a workspace starts and
    returns 403 during that window even though the governance API is happy.
    The bundle list already carries projectId/projectName/projectOwner per
    bundle — that's all the UI needs (the filter only shows projects with
    at least one bundle anyway). One fewer call, zero warmup dependency.
    """
    by_id = {}
    for b in bundles:
        pid = b.get("projectId") or (b.get("project") or {}).get("id")
        if not pid:
            continue
        # First-seen wins on name/owner; bundles in the same project should
        # report the same values, and any mismatch isn't worth a re-fetch.
        if pid in by_id:
            continue
        by_id[pid] = {
            "id": pid,
            "name": b.get("projectName") or "(unnamed)",
            "owner_username": b.get("projectOwner") or "",
        }
    return list(by_id.values())


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


def _fetch_policy_overviews():
    """Page through api/governance/v1/policy-overviews to get every policy
    summary (id + status) visible to this user, including drafts with no bundles."""
    out = []
    limit = 200
    offset = 0
    while True:
        resp = _domino("GET", "api/governance/v1/policy-overviews",
                       params={"limit": limit, "offset": offset})
        if not resp.ok:
            if 400 <= resp.status_code < 500 and offset == 0:
                log.warning("policy-overviews returned %s; falling back to bundle-derived set",
                            resp.status_code)
                return []
            resp.raise_for_status()
        items = _unwrap_list(resp.json(), ["policies", "data", "items"])
        if not items:
            break
        out.extend(items)
        if len(items) < limit:
            break
        offset += limit
    return out


def _fetch_all_policies(bundles):
    """Union of bundle-referenced policies and the full policy-overviews list.
    Draft policies with no bundles only appear via policy-overviews.
    Status from the overview is injected into the full policy definition."""
    # Collect IDs from bundles.
    bundle_pids = set()
    for b in bundles:
        for ref in _bundle_policy_refs(b):
            bundle_pids.add(ref["policyId"])

    # Fetch overviews; build id→status map and union of IDs.
    try:
        overviews = _fetch_policy_overviews()
    except Exception as e:
        log.warning("fetch_policy_overviews failed: %s — using bundle-derived set", e)
        overviews = []
    status_by_id = {o["id"]: o.get("status", "") for o in overviews if o.get("id")}
    all_pids = bundle_pids | set(status_by_id.keys())

    if not all_pids:
        return []

    out = []
    with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY) as ex:
        futures = {ex.submit(_fetch_policy, pid): pid for pid in all_pids}
        for f in as_completed(futures):
            pid = futures[f]
            try:
                pol = f.result()
            except Exception as e:
                log.warning("policy fetch failed for %s: %s", pid, e)
                continue
            if pol:
                # Inject status from the overview if the full definition
                # doesn't already carry it.
                if not pol.get("status") and pid in status_by_id:
                    pol["status"] = status_by_id[pid]
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
        with ThreadPoolExecutor(max_workers=min(len(refs), INNER_FANOUT)) as ex:
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
    """NDJSON stream. Phase 1 ('meta') sends projects + bundles as soon as
    they're available so the UI can render stats and the project filter.
    Phase 2 ('policies') sends the full policy definitions once the dedup
    fan-out completes. Phase 3 ('done') terminates."""
    def line(obj):
        return json.dumps(obj, separators=(",", ":")) + "\n"

    def gen():
        t0 = time.monotonic()
        try:
            bundles = _fetch_bundles()
        except Exception as e:
            log.exception("load: bundles fetch failed")
            yield line({"type": "error", "stage": "meta", "detail": str(e)})
            return
        projects = _projects_from_bundles(bundles)
        yield line({"type": "meta", "projects": projects, "bundles": bundles})

        try:
            policies = _fetch_all_policies(bundles)
        except Exception as e:
            log.exception("load: policies fetch failed")
            yield line({"type": "error", "stage": "policies", "detail": str(e)})
            return
        yield line({"type": "policies", "policies": policies})

        log.info("load: %d projects, %d bundles, %d policies in %.2fs",
                 len(projects), len(bundles), len(policies), time.monotonic() - t0)
        yield line({"type": "done"})

    return Response(gen(), mimetype="application/x-ndjson", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


EVIDENCE_BATCH_SIZE = int(os.environ.get("EVIDENCE_BATCH_SIZE", "10"))
EVIDENCE_BATCH_MAX_WAIT = float(os.environ.get("EVIDENCE_BATCH_MAX_WAIT", "0.5"))


@app.post("/api/evidence")
def evidence():
    """NDJSON stream of compute-policy payloads for the given bundle IDs.

    Streams in *batches* so the UI sees real progress while still pushing
    large-enough chunks to defeat proxy/transport buffering. Without
    batching, a hundred ~1KB lines often get buffered into one chunk at
    the proxy and the UI sits at 0% until everything arrives at once.

    Lines emitted:
        { type: "start",   total }
        { type: "batch",   bundles: [{ id, name, computedList } | { id, name, error }, ...] }
        { type: "done",    ok, failed, elapsed }
        { type: "error",   stage, detail }   # fatal — whole stream aborts
    """
    body = request.get_json(silent=True) or {}
    ids = body.get("bundleIds") or []
    if not isinstance(ids, list):
        return jsonify({"error": "bundleIds must be a list"}), 400

    # SSE frames are `event: <type>\ndata: <json>\n\n`. Using text/event-stream
    # (not NDJSON) so proxies don't buffer — almost every proxy treats SSE as
    # streaming-by-default, even ones that ignore `X-Accel-Buffering`.
    def sse(event, data):
        return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"

    def gen():
        # Primer: SSE comment line (~2KB). Comments in SSE start with ":".
        # Some proxies buffer the first few KB; this forces an early flush.
        yield ": " + ("primer " * 256) + "\n\n"

        if not ids:
            yield sse("start", {"total": 0})
            yield sse("done", {"ok": 0, "failed": 0, "elapsed": 0.0})
            return

        try:
            all_bundles = _fetch_bundles()
        except Exception as e:
            log.exception("evidence: bundles fetch failed")
            yield sse("error", {"stage": "bundles", "detail": str(e)})
            return

        wanted = set(ids)
        targets = [b for b in all_bundles if (b.get("id") or b.get("_id")) in wanted]
        yield sse("start", {"total": len(targets)})

        ok = 0
        failed = 0
        t0 = time.monotonic()
        batch = []
        last_flush = time.monotonic()

        def flush_batch():
            nonlocal batch, last_flush
            if not batch:
                return None
            payload = sse("batch", {"bundles": batch})
            batch = []
            last_flush = time.monotonic()
            return payload

        with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY) as ex:
            futures = {ex.submit(_fetch_evidence_for_bundle, b): b for b in targets}
            for f in as_completed(futures):
                b = futures[f]
                bid = b.get("id") or b.get("_id") or ""
                name = b.get("name") or ""
                try:
                    rid, computed_list = f.result()
                    ok += 1
                    batch.append({"id": rid or bid, "name": name,
                                  "computedList": computed_list})
                except Exception as e:
                    failed += 1
                    log.warning("evidence fetch failed for bundle %s: %s", bid, e)
                    batch.append({"id": bid, "name": name, "error": str(e)})

                # Flush on size OR wall-clock so we keep the UI moving even
                # when individual bundles arrive slowly.
                if len(batch) >= EVIDENCE_BATCH_SIZE \
                   or (time.monotonic() - last_flush) >= EVIDENCE_BATCH_MAX_WAIT:
                    out = flush_batch()
                    if out:
                        yield out

        # Drain anything left in the in-flight batch.
        out = flush_batch()
        if out:
            yield out

        elapsed = time.monotonic() - t0
        log.info("evidence: ok=%d failed=%d of %d in %.2fs", ok, failed, len(targets), elapsed)
        yield sse("done", {"ok": ok, "failed": failed, "elapsed": elapsed})

    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Content-Encoding": "identity",
        "Connection": "keep-alive",
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
    log.info("serving on 0.0.0.0:%d (FETCH_CONCURRENCY=%d, INNER_FANOUT=%d, pool_maxsize=%d)",
             port, FETCH_CONCURRENCY, INNER_FANOUT, _POOL_SIZE)
    if _api_key():
        log.info("governance auth: X-Domino-Api-Key from env (length=%d)", len(_api_key()))
    else:
        log.error("governance auth: DOMINO_USER_API_KEY / DOMINO_API_KEY not set — "
                  "governance calls will 401")
    if not os.path.isdir(DIST):
        log.warning("frontend/dist/ not found — run `npm run build` in frontend/ first.")
    app.run(host="0.0.0.0", port=port, threaded=True)
