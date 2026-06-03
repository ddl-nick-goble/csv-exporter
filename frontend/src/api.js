// Governance API client.
//
// The frontend talks ONLY to this app's own backend. All Domino API calls
// happen server-side (see app.py).
//
// Endpoints:
//   GET  /api/load      NDJSON stream. Each line is one of:
//                         { type: "meta", projects, bundles }
//                         { type: "policies", policies }
//                         { type: "done" }
//                         { type: "error", stage, detail }
//   POST /api/evidence  body { bundleIds }
//        → { results: { <bundleId>: [computedList...] } }     — export payload

function apiUrl(path) {
  return new URL(String(path).replace(/^\/+/, ''), document.baseURI).toString();
}

// Streams the picker payload. Handlers fire as each phase arrives so the UI
// can render projects/bundles immediately while policies are still being
// fetched server-side.
export async function load({ onMeta, onPolicies, onError } = {}) {
  let r;
  try {
    r = await fetch(apiUrl('/api/load'), { headers: { Accept: 'application/x-ndjson' } });
  } catch (e) {
    onError && onError({ stage: 'transport', detail: e.message || String(e) });
    return;
  }
  if (!r.ok || !r.body) {
    onError && onError({ stage: 'http', detail: `${r.status} ${r.statusText}` });
    return;
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'meta' && onMeta) onMeta(msg);
      else if (msg.type === 'policies' && onPolicies) onPolicies(msg);
      else if (msg.type === 'error' && onError) onError(msg);
    }
  }
}

// Streaming evidence fetch. Callbacks fire as the server completes each
// bundle, so the UI can show real per-bundle progress instead of a long
// blocking wait.
//
//   handlers: {
//     onStart({ total })
//     onBundle({ id, name, computedList })
//     onBundleError({ id, name, detail })
//     onDone({ ok, failed, elapsed })
//   }
export async function fetchEvidence(bundleIds, handlers = {}) {
  const r = await fetch(apiUrl('/api/evidence'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({ bundleIds }),
  });
  if (!r.ok || !r.body) {
    let detail = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body && body.detail) detail = body.detail;
    } catch {}
    throw new Error(detail);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'start' && handlers.onStart) handlers.onStart(msg);
      else if (msg.type === 'bundle' && handlers.onBundle) handlers.onBundle(msg);
      else if (msg.type === 'error' && msg.id && handlers.onBundleError) handlers.onBundleError(msg);
      else if (msg.type === 'error') throw new Error(msg.detail || 'evidence error');
      else if (msg.type === 'done' && handlers.onDone) handlers.onDone(msg);
    }
  }
}
