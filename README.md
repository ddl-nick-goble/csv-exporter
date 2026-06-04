# Governance Evidence Exporter

A small Flask + React app that pulls policy evidence from a Domino governance
deployment and lets a user pick the questions they care about and download
everything as a single CSV (one row per bundle).

Built to be deployed as a Domino App so the running user's permissions are
the access-control layer — `/api/governance/v1/bundles` already filters
bundles by what the caller can see, including instance-wide bundles for
GovernanceAdmins.


## Architecture

```
┌────────────────────┐   1. /api/load (SSE)    ┌──────────────────────┐
│                    │ ──────────────────────▶ │                      │
│   React frontend   │   2. /api/evidence (SSE)│   Flask backend      │
│   (Vite, dist/)    │ ──────────────────────▶ │   (app.py)           │
│                    │                         │                      │
└────────────────────┘                         └──────────┬───────────┘
                                                          │ bearer token
                                                          │ from /access-token
                                                          ▼
                                          ┌──────────────────────────┐
                                          │  Domino public ingress   │
                                          │  /api/governance/v1/*    │
                                          └──────────────────────────┘
```

- **Backend** (`app.py`): authenticates via the local Domino API proxy
  (`/access-token`, `/cliSiteConfig`), exposes two streaming endpoints
  (`/api/load`, `/api/evidence`) plus `/api/health`, and serves the built
  React bundle from `frontend/dist/`.
- **Frontend** (`frontend/`): single-page React app. State is local; nothing
  is sent to a third party. Presets and theme choice persist to
  `localStorage` under versioned keys.


## Prerequisites

- Python **3.10+** with `pip`.
- Node **20+** with `npm`.
- The app is designed to run **inside a Domino Workspace or App**, where the
  Domino API proxy is available at `http://localhost:8899`. Running outside
  Domino requires setting `GOVERNANCE_INGRESS_HOST` and providing a token
  yourself (see env vars below).


## Quick start

```bash
# install deps
pip install -r requirements.txt
(cd frontend && npm ci)

# production-style: builds the React bundle if stale, then runs Flask on $PORT
bash app.sh

# development: Vite HMR + Flask, with a tiny prefixing proxy so HMR works
# behind Domino's /proxy/$PORT/ URL
bash dev.sh
```


## Authentication

The app talks to two Domino API surfaces, with two different auth schemes:

| Surface | Header | Source |
| --- | --- | --- |
| Governance (`/api/governance/v1/*`) | `X-Domino-Api-Key: <key>` | `DOMINO_USER_API_KEY` (or `DOMINO_API_KEY`) env var |
| Non-governance (e.g. `/v4/*`) | `Authorization: Bearer <jwt>` | `DOMINO_API_PROXY/access-token` |

Inside any Domino workspace or app, `DOMINO_USER_API_KEY` is set automatically.
For local development outside Domino, set one of `DOMINO_USER_API_KEY` /
`DOMINO_API_KEY` to a valid Domino API key. The app logs at startup
whether the key was found.


## Environment variables

### Runtime
| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8888` | Port Flask listens on. |
| `DOMINO_USER_API_KEY` | _required_ | Domino user API key. Used as `X-Domino-Api-Key` for all governance calls. Auto-populated inside Domino workloads. |
| `DOMINO_API_KEY` | _fallback_ | Used if `DOMINO_USER_API_KEY` is unset. |
| `DOMINO_API_PROXY` | `http://localhost:8899` | Local Domino API proxy. Used for `/access-token` (non-gov bearer) and `/cliSiteConfig` (ingress host resolution). |
| `GOVERNANCE_INGRESS_HOST` | _resolved_ | Override the public Domino host serving the governance API (auto-resolved from `/cliSiteConfig` when unset). |
| `UPSTREAM_TIMEOUT` | `60` | Seconds before an upstream call to Domino aborts. |
| `FETCH_CONCURRENCY` | `25` | Top-level worker pool for parallel upstream fetches (policies, evidence). |
| `INNER_FANOUT` | `4` | Per-bundle policy fan-out inside a worker. Multi-policy bundles spawn up to this many parallel `compute-policy` calls. |
| `EVIDENCE_BATCH_SIZE` | `10` | Number of bundle results bundled into one SSE `batch` event. Lower = smoother bar, higher = fewer renders. |
| `EVIDENCE_BATCH_MAX_WAIT` | `0.5` | Max seconds to hold a partial batch before flushing it. |

The connection pool is sized to `max(FETCH_CONCURRENCY * INNER_FANOUT, 64)`
to keep all parallel calls on the keep-alive fast path.

### Dev-only (used by `dev.sh` and `vite.config.js`)
| Var | Default | Purpose |
| --- | --- | --- |
| `API_PORT` | `8501` | Flask port in dev. |
| `VITE_PUBLIC` | `5173` | Externally-visible Vite port (behind the prefixing proxy). |
| `VITE_INTERNAL` | `5174` | Internal Vite port. |


## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET`  | `/api/load` | NDJSON: `meta {projects, bundles}` → `policies {policies}` → `done`. |
| `POST` | `/api/evidence` | SSE. Body: `{bundleIds: [...]}`. Emits `start`, repeated `batch`, `done`. |
| `GET`  | `/api/health` | Liveness. |
| `GET`  | `/*` | Serves `frontend/dist/` (SPA fallback to `index.html`). |


## Repository layout

```
app.py                    Flask backend (single file)
app.sh                    Production entrypoint
dev.sh                    Dev loop (Flask + Vite + prefixing proxy)
requirements.txt          Runtime Python deps
requirements-dev.txt      Test / lint Python deps
pyproject.toml            ruff + pytest config
tests/                    Backend unit tests
frontend/
  package.json            Frontend deps + scripts
  vite.config.js          Vite build + dev proxy config
  src/
    App.jsx               Top-level component (orchestration + render)
    api.js                Frontend HTTP client (SSE parser, JSON helpers)
    csv.js                Pure CSV row + outline builders
    presets.js            localStorage-backed selection presets
    theme.js              light/dark persistence
    main.jsx              Entrypoint
    styles.css            Global styles (CSS custom properties → light/dark)
    __tests__/            Frontend unit tests (vitest)
```


## Testing

```bash
# backend
pip install -r requirements-dev.txt
pytest

# frontend
(cd frontend && npm test)
```


## Limitations

- `/policies/{id}` returns the **latest** policy version. Bundles pinned to
  an older version may render against a slightly different question shape;
  evidence answers still resolve correctly because they're keyed by artifact
  id, but newly-added or removed questions can show up as gaps.
- Connection pool warnings ("Connection pool is full") indicate
  `FETCH_CONCURRENCY * INNER_FANOUT` exceeded the configured pool size. The
  defaults size correctly; only worry about this if you tune the env vars.
- Built for Domino's auth model. Other deployments will need to replace the
  `_bearer()` token source.
