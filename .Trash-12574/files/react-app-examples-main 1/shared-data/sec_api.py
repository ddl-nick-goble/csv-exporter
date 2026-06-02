"""
Shared server-side query layer over the SEC facts SQLite db.

Both react-cdn and react-vite import register_sec_routes(app) so they serve
the IDENTICAL /api surface - the only difference between the two apps stays
the frontend build approach (CDN vs Vite), per the dual-track experiment.
"""
import os
import sqlite3
from flask import jsonify, request

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv("DB_PATH", os.path.join(HERE, "sec.db"))

# Whitelist of sortable/returnable columns - guards against SQL injection via sort param.
COLUMNS = ["company", "ticker", "cik", "concept", "value", "period_end", "fy", "fp", "form", "sic"]
SORTABLE = set(COLUMNS)
MAX_SIZE = 50_000  # client virtualizes; this is the per-request ceiling.

# Curated headline us-gaap concepts - sorting these by value surfaces recognizable
# mega-caps instead of XBRL data-entry outliers. Used as the default view.
HEADLINE_CONCEPTS = [
    "Assets", "Liabilities", "LiabilitiesAndStockholdersEquity", "StockholdersEquity",
    "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
    "NetIncomeLoss", "OperatingIncomeLoss", "GrossProfit", "CostOfRevenue",
    "CashAndCashEquivalentsAtCarryingValue", "ResearchAndDevelopmentExpense",
]


def _conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def register_sec_routes(app):
    @app.get("/api/health")
    def health():
        ok = os.path.exists(DB_PATH)
        n = 0
        if ok:
            try:
                with _conn() as c:
                    n = c.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
            except Exception:
                ok = False
        return jsonify(db=DB_PATH, ready=ok, rows=n)

    @app.get("/api/concepts")
    def concepts():
        # Curated headline concepts the frontend uses as its default filter.
        return jsonify(headline=HEADLINE_CONCEPTS)

    @app.get("/api/facts")
    def facts():
        if not os.path.exists(DB_PATH):
            return jsonify(error="SEC db not built - run shared-data/etl.py"), 503

        # ── params (server-side sorting / filtering; client virtualizes) ──
        try:
            page = max(int(request.args.get("page", 0)), 0)
            size = min(max(int(request.args.get("size", 50)), 1), MAX_SIZE)
        except ValueError:
            page, size = 0, 50

        sort = request.args.get("sort", "value")
        if sort not in SORTABLE:
            sort = "value"
        order = "ASC" if request.args.get("order", "desc").lower() == "asc" else "DESC"

        q = (request.args.get("q") or "").strip()
        # forms / concepts: comma-separated filters. Empty = no filter on that field.
        forms = [f.strip() for f in (request.args.get("forms") or "").split(",") if f.strip()]
        concepts = [c.strip() for c in (request.args.get("concepts") or "").split(",") if c.strip()]

        clauses, params = [], []
        if q:
            clauses.append("(company LIKE ? OR ticker LIKE ? OR concept LIKE ?)")
            like = f"%{q}%"
            params += [like, like, like]
        if forms:
            clauses.append(f"form IN ({','.join('?' * len(forms))})")
            params += forms
        if concepts:
            clauses.append(f"concept IN ({','.join('?' * len(concepts))})")
            params += concepts
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

        with _conn() as c:
            total = c.execute(f"SELECT COUNT(*) FROM facts {where}", params).fetchone()[0]
            rows = c.execute(
                f"SELECT {', '.join(COLUMNS)} FROM facts {where} "
                f"ORDER BY {sort} {order} LIMIT ? OFFSET ?",
                params + [size, page * size],
            ).fetchall()

        return jsonify(
            rows=[dict(r) for r in rows],
            total=total,
            page=page,
            size=size,
            pageCount=(total + size - 1) // size,
        )
