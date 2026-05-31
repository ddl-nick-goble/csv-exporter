# react-app-testing-grounds

This project shows two ways to build the same React app and run it as a Domino
App. Both apps look the same in the browser and use the same data. The only
difference is how the frontend code gets to the browser. Use this repo to
compare the two styles side by side and pick the one you like.

## The two apps

| Folder | How the frontend works | Build step | Good for |
| --- | --- | --- | --- |
| `react-cdn` | React loads in the browser from a CDN. The whole app is one `index.html` file. | None | Quick prototypes and fast edits |
| `react-vite` | React is bundled ahead of time by Vite into static files. | `npm run build` | A polished app you plan to ship |

Both apps show the exact same screen: a searchable, sortable table of SEC
financial facts. The text, columns, and styling are identical. Only the
plumbing behind the page is different.

## What you see in the app

A table built on TanStack Table and TanStack Virtual. It lets you:

* Search by company, ticker, or accounting concept.
* Sort any column by clicking its header.
* Switch between a Headline view (12 well known metrics) and the full set of
  about 1.4 million facts.

The table stays fast on 1.4 million rows because the heavy work happens in two
places. The server does the searching and sorting. The browser only draws the
handful of rows that are currently on screen.

## The shared backend

Both apps share one data layer in `shared-data` so they always behave the same.

* `sec.db` is a SQLite database of about 1.4 million SEC financial facts.
* `etl.py` downloads the data from the SEC and builds `sec.db`. It runs once on
  first launch and takes about a minute.
* `sec_api.py` defines the API that both apps serve. The main route is
  `GET /api/facts`, which returns rows after applying your search, filters, and
  sort. There are also `GET /api/health` and `GET /api/concepts`.

## How to run

Pick one app and run its start script. The first run builds the database, which
is a one time step.

```
cd react-cdn   && ./app.sh     # CDN version
# or
cd react-vite  && ./app.sh     # Vite version
```

Each app serves on port 8888, the port Domino expects. `react-vite` also builds
the frontend the first time, and it rebuilds on its own whenever you change the
frontend source, so running `./app.sh` always shows your latest code.

For live editing of the Vite app with instant reload, use its dev script
instead:

```
cd react-vite && ./dev.sh
```

## Running on Domino

A few things make these apps work behind Domino's proxy:

* The apps bind to `0.0.0.0:8888`. Binding to `127.0.0.1` gives a 502 because
  the proxy cannot reach it.
* Asset and API URLs are worked out from the page address at runtime, so the
  apps run correctly even though Domino serves them under a long path prefix.
* The bundle and the API share one address, so there is no need for CORS.

See `react-vite/README.md` for more detail on the Vite setup.
