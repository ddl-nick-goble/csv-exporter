import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useReactTable, getCoreRowModel, flexRender } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

// API base derived from the document's *directory* so it works behind Domino's
// /proxy/$PORT/. Using new URL('.', document.baseURI) instead of
// window.location.pathname keeps this correct even if we later add client-side
// routing or a user refreshes on a sub-route (pathname would include the route
// and break the API base; the directory resolution does not).
const API_BASE = new URL('.', document.baseURI).pathname.replace(/\/$/, '');
const PAGE_SIZE = 10000; // loaded once per query, rendering virtualized

const HEADLINE = [
  'Assets', 'Liabilities', 'LiabilitiesAndStockholdersEquity', 'StockholdersEquity',
  'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax',
  'NetIncomeLoss', 'OperatingIncomeLoss', 'GrossProfit', 'CostOfRevenue',
  'CashAndCashEquivalentsAtCarryingValue', 'ResearchAndDevelopmentExpense',
].join(',');

function fmtUSD(n) {
  if (n == null) return '-';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e12) return `${s}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(0)}`;
}
const fmtDate = (s) => (!s || s.length !== 8 ? s || '-' : `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// TanStack Table column defs. meta carries layout (width / align / sticky-left).
const columnDefs = [
  { accessorKey: 'company', header: 'Company', meta: { w: 250, sticky: true }, cell: (c) => <span className="company">{c.getValue()}</span> },
  { accessorKey: 'ticker', header: 'Ticker', meta: { w: 84 }, cell: (c) => (c.getValue() ? <span className="ticker">{c.getValue()}</span> : <span className="muted">-</span>) },
  { accessorKey: 'cik', header: 'CIK', meta: { w: 90 }, cell: (c) => <span className="mono muted">{c.getValue()}</span> },
  { accessorKey: 'sic', header: 'SIC', meta: { w: 64 }, cell: (c) => <span className="mono muted">{c.getValue() || '-'}</span> },
  { accessorKey: 'concept', header: 'Concept (us-gaap)', meta: { w: 340 }, cell: (c) => <span className="concept">{c.getValue()}</span> },
  { accessorKey: 'value', header: 'Value (USD)', meta: { w: 140, align: 'right' }, cell: (c) => <span className={'num' + (c.getValue() < 0 ? ' neg' : '')}>{fmtUSD(c.getValue())}</span> },
  { accessorKey: 'period_end', header: 'Period End', meta: { w: 108 }, cell: (c) => fmtDate(c.getValue()) },
  { accessorKey: 'fy', header: 'FY', meta: { w: 60 }, cell: (c) => c.getValue() || '-' },
  { accessorKey: 'fp', header: 'FP', meta: { w: 52 }, cell: (c) => c.getValue() || '-' },
  { accessorKey: 'form', header: 'Form', meta: { w: 88 }, cell: (c) => <span className="badge">{c.getValue()}</span> },
];
const TEMPLATE = columnDefs.map((c) => `${c.meta.w}px`).join(' ');
const TOTAL_W = columnDefs.reduce((s, c) => s + c.meta.w, 0);

export default function App() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [sort, setSort] = useState('value');
  const [order, setOrder] = useState('desc');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('headline'); // 'headline' | 'all'
  const debouncedSearch = useDebounced(search, 300);

  const scrollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ size: PAGE_SIZE, sort, order, q: debouncedSearch });
    if (mode === 'headline') {
      params.set('concepts', HEADLINE);
      params.set('forms', '10-K,10-Q');
    }
    fetch(`${API_BASE}/api/facts?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((d) => {
        if (cancelled) return;
        setRows(d.rows); setTotal(d.total); setError(null);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [sort, order, debouncedSearch, mode]);

  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualFiltering: true,
  });
  const tableRows = table.getRowModel().rows;

  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 30,
    overscan: 18,
  });

  const toggleSort = (col) => {
    if (sort === col) setOrder((o) => (o === 'desc' ? 'asc' : 'desc'));
    else { setSort(col); setOrder('desc'); }
  };

  return (
    <div className="container">
      <header>
        <h1>SEC Financial Statement Explorer</h1>
        <p>
          Search and sort across <strong>1,401,409</strong> SEC financial facts on the server.{' '}
          {rows.length.toLocaleString()} rows loaded and virtualized.
        </p>
      </header>

      <div className="card">
        <div className="toolbar">
          <input
            placeholder="Search company, ticker, or concept (e.g. NVDA, JPMorgan, Revenues)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="seg">
            <button className={mode === 'headline' ? 'on' : ''} onClick={() => setMode('headline')}>Headline metrics</button>
            <button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>All 1.4M facts</button>
          </div>
          <span className="count">{loading ? 'loading…' : `${total.toLocaleString()} matching`}</span>
        </div>

        {error && <div className="error">Failed to load: {error}</div>}

        <div className="scroll" ref={scrollRef}>
          <div className="gridwrap" style={{ minWidth: TOTAL_W }}>
            {table.getHeaderGroups().map((hg) => (
              <div className="hrow" key={hg.id} style={{ gridTemplateColumns: TEMPLATE }}>
                {hg.headers.map((h) => {
                  const meta = h.column.columnDef.meta || {};
                  const active = sort === h.column.id;
                  return (
                    <div
                      key={h.id}
                      className={`hcell${meta.align === 'right' ? ' right' : ''}${meta.sticky ? ' stick' : ''}`}
                      onClick={() => toggleSort(h.column.id)}
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {active ? (order === 'asc' ? ' ▲' : ' ▼') : ''}
                    </div>
                  );
                })}
              </div>
            ))}

            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
              {rowVirtualizer.getVirtualItems().map((vi) => {
                const row = tableRows[vi.index];
                return (
                  <div
                    key={row.id}
                    className={`row${vi.index % 2 ? ' odd' : ''}`}
                    style={{ gridTemplateColumns: TEMPLATE, transform: `translateY(${vi.start}px)`, height: vi.size }}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const meta = cell.column.columnDef.meta || {};
                      return (
                        <div key={cell.id} className={`cell${meta.align === 'right' ? ' right' : ''}${meta.sticky ? ' stick' : ''}`}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
          {!loading && rows.length === 0 && <div className="empty">No facts match “{debouncedSearch}”.</div>}
        </div>
      </div>

      <div className="footer-note">
        {mode === 'headline'
          ? 'Headline view: 12 core us-gaap metrics from 10-K/10-Q filings. Toggle “All 1.4M facts” for the raw dataset (XBRL outliers included).'
          : 'Raw view: every USD fact in the dataset. Sort/search hit all 1.4M on the server.'}
        {' Scroll horizontally for more columns. The Company column stays pinned left.'}
      </div>
    </div>
  );
}
