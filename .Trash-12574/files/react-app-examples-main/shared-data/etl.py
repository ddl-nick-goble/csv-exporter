"""
ETL: SEC Financial Statement Data Sets -> SQLite.

Downloads one or more quarterly bulk financial-statement ZIPs from SEC, parses
num.txt (numeric facts) joined to sub.txt (filer/company metadata), enriches with
ticker symbols, and writes a single denormalized, indexed `facts` table.

Each row is one reported financial fact, e.g.:
    NVIDIA CORP | NVDA | Revenues | 60,922,000,000 USD | 2024-01-28 | FY2023 | 10-K

Idempotent: skips work if the target table already has rows (use --force to rebuild).

Usage:
    python etl.py                 # default quarter(s)
    python etl.py 2023q4 2023q3   # specific quarters
    python etl.py --force 2023q4
"""
import csv
import io
import os
import sqlite3
import sys
import zipfile
from urllib.request import Request, urlopen

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv("DB_PATH", os.path.join(HERE, "sec.db"))
CACHE_DIR = os.path.join(HERE, "cache")
UA = os.getenv("SEC_USER_AGENT", "react-demo nick.goble@dominodatalab.com")
BASE = "https://www.sec.gov/files/dera/data/financial-statement-data-sets"
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"

DEFAULT_QUARTERS = ["2023q4"]
# qtrs=0 (instant / balance-sheet) and qtrs=4 (annual) keep values meaningful & readable.
KEEP_QTRS = {"0", "4"}

csv.field_size_limit(10_000_000)


def _fetch(url):
    # No Accept-Encoding: let SEC return identity so we don't have to gunzip.
    # (The .zip files are already compressed payloads; transport gzip adds nothing.)
    req = Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
    with urlopen(req, timeout=120) as r:
        return r.read()


def download_quarter(q):
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, f"{q}.zip")
    if os.path.exists(path) and os.path.getsize(path) > 1_000_000:
        print(f"  [{q}] cached ({os.path.getsize(path)//1024//1024} MB)")
        return path
    url = f"{BASE}/{q}.zip"
    print(f"  [{q}] downloading {url} ...")
    data = _fetch(url)
    with open(path, "wb") as f:
        f.write(data)
    print(f"  [{q}] saved {len(data)//1024//1024} MB")
    return path


def load_tickers():
    """CIK (int) -> ticker symbol. Best-effort; demo still works without it."""
    try:
        import json
        raw = json.loads(_fetch(TICKERS_URL))
        out = {}
        for row in raw.values():
            out[int(row["cik_str"])] = row["ticker"]
        print(f"  tickers: {len(out)} CIK->symbol mappings")
        return out
    except Exception as e:
        print(f"  tickers: skipped ({e})")
        return {}


def read_tsv(zf, name):
    """Yield dict rows from a tab-delimited member of the zip."""
    with zf.open(name) as fh:
        reader = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace"), delimiter="\t")
        for row in reader:
            yield row


def parse_quarter(zip_path, tickers):
    """Return (facts_rows_iterable_materialized, count). Joins num -> sub."""
    with zipfile.ZipFile(zip_path) as zf:
        # sub.txt: adsh -> company metadata
        subs = {}
        for r in read_tsv(zf, "sub.txt"):
            subs[r["adsh"]] = (
                r.get("name", "").strip(),
                int(r["cik"]) if r.get("cik", "").isdigit() else None,
                r.get("sic", ""),
                r.get("form", ""),
                r.get("fy", ""),
                r.get("fp", ""),
            )
        print(f"    sub.txt: {len(subs)} filings")

        facts = []
        skipped = 0
        for r in read_tsv(zf, "num.txt"):
            if r.get("uom") != "USD":
                skipped += 1
                continue
            if r.get("qtrs") not in KEEP_QTRS:
                skipped += 1
                continue
            val = r.get("value", "")
            if val == "" or val is None:
                skipped += 1
                continue
            meta = subs.get(r["adsh"])
            if not meta:
                skipped += 1
                continue
            name, cik, sic, form, fy, fp = meta
            try:
                fval = float(val)
            except ValueError:
                continue
            facts.append((
                name,
                tickers.get(cik, ""),
                cik,
                r.get("tag", ""),
                fval,
                r.get("ddate", ""),     # period end YYYYMMDD
                fy, fp, form, sic,
            ))
        print(f"    num.txt: {len(facts)} USD facts kept, {skipped} skipped")
        return facts


def build_db(quarters, force):
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    if not force:
        exists = cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='facts'"
        ).fetchone()
        if exists:
            n = cur.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
            if n > 0:
                print(f"facts table already has {n:,} rows - skipping (use --force to rebuild)")
                conn.close()
                return

    print("Building SQLite (this is a one-time step)...")
    cur.executescript("""
        DROP TABLE IF EXISTS facts;
        CREATE TABLE facts (
            id INTEGER PRIMARY KEY,
            company TEXT, ticker TEXT, cik INTEGER,
            concept TEXT, value REAL,
            period_end TEXT, fy TEXT, fp TEXT, form TEXT, sic TEXT
        );
    """)

    tickers = load_tickers()
    total = 0
    for q in quarters:
        zp = download_quarter(q)
        print(f"  [{q}] parsing...")
        rows = parse_quarter(zp, tickers)
        cur.executemany(
            "INSERT INTO facts (company,ticker,cik,concept,value,period_end,fy,fp,form,sic) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)", rows,
        )
        conn.commit()
        total += len(rows)
        print(f"  [{q}] inserted {len(rows):,} (running total {total:,})")

    print("Creating indexes...")
    cur.executescript("""
        CREATE INDEX idx_company ON facts(company);
        CREATE INDEX idx_ticker  ON facts(ticker);
        CREATE INDEX idx_concept ON facts(concept);
        CREATE INDEX idx_value   ON facts(value);
    """)
    conn.commit()
    n = cur.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    print(f"Done. facts table: {n:,} rows at {DB_PATH}")
    conn.close()


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--force"]
    force = "--force" in sys.argv
    quarters = args or DEFAULT_QUARTERS
    print(f"Quarters: {quarters}  force={force}  db={DB_PATH}")
    build_db(quarters, force)
