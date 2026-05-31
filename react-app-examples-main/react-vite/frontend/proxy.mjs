// Tiny HTTP+WebSocket proxy that sits between Domino's /proxy/$PORT/ and our
// two backends: Vite (frontend) and Flask (API).
//
// Domino strips the /nick_goble/.../proxy/$PORT prefix before forwarding, so
// this proxy receives requests at "/..." and "/api/...".
//   - /api/*  → Flask  (forwarded as-is)
//   - rest    → Vite   (prefix re-added, because Vite's `base` is the full
//                       Domino path so its emitted URLs round-trip correctly)
// HMR websocket upgrades go to Vite. Uses `http-proxy`, the same library Vite
// uses internally for server.proxy.
import httpProxy from 'http-proxy';
import http from 'http';

const PREFIX = (process.env.VITE_BASE_PATH || '').replace(/\/$/, '');
const VITE_TARGET = `http://localhost:${process.env.VITE_INTERNAL_PORT || 5174}`;
const FLASK_TARGET = `http://localhost:${process.env.VITE_API_PORT || 8501}`;
const PORT = parseInt(process.env.VITE_PUBLIC_PORT || 5173, 10);

if (!PREFIX) {
  console.error('proxy.mjs: VITE_BASE_PATH env var is required (the Domino /proxy/$PORT/ path)');
  process.exit(1);
}

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false });

proxy.on('error', (err, req, res) => {
  console.error('[proxy] error:', err.message, 'for', req?.url);
  if (res && !res.headersSent && res.writeHead) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('upstream error: ' + err.message);
  }
});

const isApi = (url) => url === '/api' || url.startsWith('/api/');
const prefixUrl = (url) => (url.startsWith(PREFIX + '/') || url === PREFIX ? url : PREFIX + url);

const server = http.createServer((req, res) => {
  if (isApi(req.url)) {
    proxy.web(req, res, { target: FLASK_TARGET }); // Flask sees /api/* as-is
  } else {
    req.url = prefixUrl(req.url); // Vite expects the full Domino base path
    proxy.web(req, res, { target: VITE_TARGET });
  }
});

server.on('upgrade', (req, socket, head) => {
  // HMR websocket → Vite
  req.url = prefixUrl(req.url);
  proxy.ws(req, socket, head, { target: VITE_TARGET });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] :${PORT}  /api/* → ${FLASK_TARGET}  rest → ${VITE_TARGET} (prefix "${PREFIX}")`);
});
