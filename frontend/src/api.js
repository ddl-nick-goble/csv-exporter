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

// Streaming evidence fetch over Server-Sent Events. SSE is special-cased by
// every reverse proxy I've ever met: no buffering, no compression rewrites.
// We use fetch() + manual SSE parsing (not EventSource) because the request
// body carries the bundle IDs and EventSource is GET-only.
//
//   handlers: {
//     onStart({ total })
//     onBundle({ id, name, computedList })          // one call per bundle
//     onBundleError({ id, name, error })            // one call per failed bundle
//     onDone({ ok, failed, elapsed })
//   }
export async function fetchEvidence(bundleIds, handlers = {}) {
  const r = await fetch(apiUrl('/api/evidence'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
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
  // Each SSE message is terminated by a blank line. Within a message,
  // multiple `event:` and `data:` lines may appear; comments start with ":".
  const dispatch = (event, data) => {
    let msg = null;
    try { msg = JSON.parse(data); } catch { return; }
    if (event === 'start' && handlers.onStart) handlers.onStart(msg);
    else if (event === 'batch') {
      for (const entry of (msg.bundles || [])) {
        if (entry && entry.error) handlers.onBundleError && handlers.onBundleError(entry);
        else if (entry) handlers.onBundle && handlers.onBundle(entry);
      }
    } else if (event === 'error') {
      throw new Error(msg.detail || 'evidence error');
    } else if (event === 'done' && handlers.onDone) handlers.onDone(msg);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const raw of block.split('\n')) {
        if (!raw || raw.startsWith(':')) continue;
        const colon = raw.indexOf(':');
        const field = colon < 0 ? raw : raw.slice(0, colon);
        const valueStart = colon < 0 ? raw.length : colon + 1;
        const value = raw.slice(valueStart).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data += (data ? '\n' : '') + value;
      }
      if (data) dispatch(event, data);
    }
  }
}
