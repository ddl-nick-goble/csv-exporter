// Dev proxy: Domino strips the /proxy/$PORT prefix before forwarding here.
//   /api/*  → Flask (Flask makes all Domino calls server-side)
//   rest    → Vite (prefix re-added; Vite's base is the full Domino path)
// HMR websocket upgrades are forwarded to Vite.
import httpProxy from 'http-proxy';
import http from 'http';

const PREFIX = (process.env.VITE_BASE_PATH || '').replace(/\/$/, '');
const VITE_TARGET = `http://localhost:${process.env.VITE_INTERNAL_PORT || 5174}`;
const FLASK_TARGET = `http://localhost:${process.env.VITE_API_PORT || 8501}`;
const PORT = parseInt(process.env.VITE_PUBLIC_PORT || 5173, 10);

if (!PREFIX) {
  console.error('proxy.mjs: VITE_BASE_PATH env var is required');
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

const isBackend = (url) => url === '/api' || url.startsWith('/api/');
const prefixUrl = (url) => (url.startsWith(PREFIX + '/') || url === PREFIX ? url : PREFIX + url);

const server = http.createServer((req, res) => {
  if (isBackend(req.url)) {
    proxy.web(req, res, { target: FLASK_TARGET });
  } else {
    req.url = prefixUrl(req.url);
    proxy.web(req, res, { target: VITE_TARGET });
  }
});

server.on('upgrade', (req, socket, head) => {
  req.url = prefixUrl(req.url);
  proxy.ws(req, socket, head, { target: VITE_TARGET });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] :${PORT}  /api/*,/v4/* → ${FLASK_TARGET}  rest → ${VITE_TARGET} (prefix "${PREFIX}")`);
});
