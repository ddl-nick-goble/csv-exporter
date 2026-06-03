// Governance API client.
//
// The frontend talks ONLY to this app's own backend. All Domino API calls
// happen server-side (see app.py).
//
// Two endpoints:
//   GET  /api/load             { projects, bundles, policies } — picker payload
//   POST /api/evidence  body { bundleIds }
//        → { results: { <bundleId>: [computedList...] } }     — export payload

function apiUrl(path) {
  return new URL(String(path).replace(/^\/+/, ''), document.baseURI).toString();
}

export async function load() {
  const r = await fetch(apiUrl('/api/load'), {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body && body.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  return r.json();
}

export async function fetchEvidence(bundleIds) {
  const r = await fetch(apiUrl('/api/evidence'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ bundleIds }),
  });
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body && body.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  const body = await r.json();
  return body.results || {};
}
