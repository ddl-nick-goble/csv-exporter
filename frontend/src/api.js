// Governance API client.
//
// The frontend talks ONLY to this app's own backend. All Domino API calls
// happen server-side (see app.py). A single SSE connection delivers everything
// the UI needs: projects, accessible bundles, per-bundle compute-policy
// payloads, and live progress.

function apiUrl(path) {
  return new URL(String(path).replace(/^\/+/, ''), document.baseURI).toString();
}

// startProbe(onEvent) opens an SSE stream and dispatches each backend event to
// the caller. Events (in order):
//   meta     { projects, all_bundles, candidates }
//   bundle   { bundle, computedList }  — one per accessible bundle
//   progress { done, total, accessible, denied }
//   done     {}
//   error    { stage, detail }
// The EventSource is closed automatically on 'done' or 'error'.
// Returned EventSource lets callers close() it early (e.g. on unmount).
export function startProbe(onEvent) {
  const es = new EventSource(apiUrl('/api/probe'));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    es.close();
  };
  const dispatch = (name) => (e) => {
    if (closed) return;
    let payload = {};
    try { payload = JSON.parse(e.data); } catch {}
    onEvent(name, payload);
    if (name === 'done' || name === 'error') close();
  };
  for (const name of ['meta', 'bundle', 'progress', 'done', 'error']) {
    es.addEventListener(name, dispatch(name));
  }
  es.onerror = () => {
    if (closed || es.readyState === EventSource.CLOSED) return;
    onEvent('error', { stage: 'transport', detail: 'connection error' });
    close();
  };
  return { close };
}
