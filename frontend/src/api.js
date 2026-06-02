// Governance API client — calls Domino's Nucleus APIs directly from the browser.
//
// Why this works: when this app is served via Domino's reverse proxy
// (e.g. https://your-domino/u/$user/$project/.../proxy/8888/), the page's
// origin is the Domino host. A fetch to "/api/governance/v1/bundles" is
// same-origin, so the user's Domino session cookie is sent automatically and
// the governance API responds the same way it does for the Domino UI.
//
// We deliberately do NOT route through the workspace's $DOMINO_API_PROXY at
// localhost:8899: that proxy only exposes Domino's Public API surface, which
// does not include governance bundles or evidence results.

const HEADERS = { Accept: 'application/json' };

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function jget(path, { params, signal } = {}) {
  let url = path;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  const r = await fetch(url, { headers: HEADERS, credentials: 'same-origin', signal });
  if (!r.ok) {
    let body = '';
    try { body = (await r.text()).slice(0, 400); } catch {}
    throw new ApiError(`${r.status} ${r.statusText} on ${path}${body ? ` — ${body}` : ''}`, r.status);
  }
  return r.json();
}

async function jpost(path, body, { signal } = {}) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    let text = '';
    try { text = (await r.text()).slice(0, 400); } catch {}
    throw new ApiError(`${r.status} ${r.statusText} on ${path}${text ? ` — ${text}` : ''}`, r.status);
  }
  return r.json();
}

function unwrapList(data, keys = ['data', 'items', 'bundles', 'results', 'projects']) {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object') {
    for (const k of keys) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}

export async function fetchProjects() {
  const data = await jget('/v4/projects');
  const list = unwrapList(data, ['projects', 'data', 'items']);
  return list.map((p) => ({
    id: p.id || p._id,
    name: p.name || '(unnamed)',
    owner_username: p.ownerUsername || (p.owner || {}).userName || '',
    owner_name: (p.owner || {}).fullName || p.ownerUsername || '',
  })).filter((p) => p.id);
}

export async function fetchAllBundles() {
  // Paginates the bundles endpoint defensively. Some Domino versions reject
  // limit/offset and return the full list in one shot; we handle both shapes.
  const tryPaginated = async () => {
    const out = [];
    const limit = 200;
    let offset = 0;
    while (true) {
      const data = await jget('/api/governance/v1/bundles', { params: { limit, offset } });
      const page = unwrapList(data, ['bundles', 'data', 'items']);
      if (!page.length) break;
      out.push(...page);
      if (page.length < limit) break;
      offset += limit;
      if (offset > 50000) break;
    }
    return out;
  };
  try {
    return await tryPaginated();
  } catch (e) {
    if (/^4\d\d/.test(String(e.message))) {
      const data = await jget('/api/governance/v1/bundles');
      return unwrapList(data, ['bundles', 'data', 'items']);
    }
    throw e;
  }
}

// Returns the fully-computed policy view for a bundle: bundle + policy
// (with stages → approvals.evidence.artifacts and evidenceSet.artifacts) + results.
// This is the same call MRM Portal uses, and it lets us emit a row per *policy
// question* — including unanswered ones — instead of only per recorded result.
// NB: the `results` array contains only the *latest* answer per artifact.
// To get historical edits, also fetch fetchAllResults() below.
export async function fetchComputedPolicy(bundleId, policyId, policyVersionId) {
  const body = { bundleId, policyId };
  if (policyVersionId) body.policyVersionId = policyVersionId;
  return jpost('/api/governance/v1/rpc/compute-policy', body);
}

// Returns ALL results for a bundle (every historical answer + the current
// latest), keyed by `isLatest`. compute-policy collapses to latest only, so
// scope=history requires this additional call.
export async function fetchAllResults(bundleId) {
  const data = await jget('/api/governance/v1/results', { params: { bundleID: bundleId } });
  return unwrapList(data, ['results', 'data', 'items']);
}

// Promise pool: runs `worker(item, i)` for each input with at most `n` in flight,
// reporting progress via `onProgress({done, total, failed, skipped})`.
// 403 errors are counted as `skipped` (per-bundle ACL — user doesn't own the
// bundle) and surfaced separately from other failures.
export async function pool(items, n, worker, onProgress) {
  const results = new Array(items.length);
  let i = 0;
  let done = 0;
  let failed = 0;
  let skipped = 0;
  const lanes = new Array(Math.min(n, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = { __error: e };
        if (e && e.status === 403) skipped++;
        else failed++;
      } finally {
        done++;
        if (onProgress) onProgress({ done, total: items.length, failed, skipped });
      }
    }
  });
  await Promise.all(lanes);
  return results;
}
