# react-vite

A React + Vite frontend (bundled) with a Flask backend, packaged to run as a
Domino App. It serves the same SEC financial facts table as the sibling
`react-cdn` project, which uses a no-build CDN approach instead.

## Layout

```
app.py                  Flask: serves the built bundle and /api/*
app.sh                  Production entry: build the frontend, run Flask on 0.0.0.0:8888
dev.sh                  Local dev entry: Flask, the Vite dev server, and a proxy
frontend/
  vite.config.js        base path, HMR config, and the /api dev proxy
  proxy.mjs             restores the path prefix Domino strips before forwarding
  src/App.jsx           the table UI; the API base is computed at runtime
```

## Production

`app.sh` builds the frontend to `frontend/dist/` and starts Flask. Flask serves
both the static bundle and the `/api/*` endpoints from one process on
`0.0.0.0:8888`, the host and port Domino's proxy forwards to.

The bundle runs behind Domino's `/proxy/$PORT/` path without that path being
baked into the build:

* Vite is configured with `base: './'`, so the built `index.html` references
  assets with relative URLs that resolve under any mount path.
* `App.jsx` computes the API base from `new URL('.', document.baseURI)` at load
  time, so `fetch()` calls reach the right `/api/...` URL under any prefix. Using
  the document directory rather than `window.location.pathname` keeps it correct
  if routing is added later or the page is refreshed on a sub-route.

## Local development

`./dev.sh` runs three processes so the Vite dev server works behind Domino's
proxy with hot reload:

1. Flask on `$API_PORT` serves `/api/*`.
2. The Vite dev server runs on an internal port with `VITE_BASE` set to the live
   proxy path, so its module and HMR scripts resolve correctly.
3. `proxy.mjs` on the public port restores the prefix Domino strips, routes
   `/api/*` to Flask and everything else to Vite, and forwards the HMR
   WebSocket so hot reload works.

Use `./dev.sh` for development and `./app.sh` for the deployed App.

## Domino notes

* Bind to `0.0.0.0:8888`. Binding to `127.0.0.1` returns a 502 because the proxy
  runs in a separate network namespace.
* CORS is not needed. The bundle and the API share one origin.
* To get shareable deep links and drop Domino's outer iframe, enable
  "Enable deep linking" when publishing the App.
