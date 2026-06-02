import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { startProbe } from './api.js';
import {
  COLUMN_GROUPS,
  ALL_COLUMNS,
  COLUMN_PRESETS,
  bundleContext,
  bundleComputedContext,
  bundlePolicyContext,
  bundleAnswers,
  CsvBuilder,
} from './csv.js';

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
const fmtNumber = (n) => (n ?? 0).toLocaleString();
const isoStamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const fileStamp = () => new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + 'Z';

export default function App() {
  // ── Server state (populated from the /api/probe SSE stream) ───────────────
  // The backend does all Domino calls and streams: projects, accessible
  // bundles + their compute-policy payloads, and live progress.
  const [projects, setProjects] = useState([]);
  const [bundles, setBundles] = useState([]); // accessible bundles only
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // ── Probe stream state ────────────────────────────────────────────────────
  const [probing, setProbing] = useState(false);
  const [probeStats, setProbeStats] = useState({ done: 0, total: 0, accessible: 0, denied: 0 });
  // Upstream totals from the meta event — used to surface "N hidden (no access)".
  const [streamCounts, setStreamCounts] = useState({ allBundles: 0, candidates: 0 });
  // bundleId -> computed-policy payload list (delivered with each bundle event).
  const probeCacheRef = useRef(new Map());

  // ── User selections ────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 150);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [columns, setColumns] = useState(() => new Set(COLUMN_PRESETS.audit));

  // ── Export state ───────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0, rows: 0 });
  const [exportError, setExportError] = useState(null);
  const [lastExport, setLastExport] = useState(null);

  // ── Load + probe: single SSE connection to the backend ────────────────────
  // The backend resolves projects, list-bundles, and probes compute-policy per
  // attached policy in parallel; we just listen and accumulate.
  useEffect(() => {
    setLoading(true);
    setProbing(false);
    setLoadError(null);
    setProjects([]);
    setBundles([]);
    setStreamCounts({ allBundles: 0, candidates: 0 });
    setProbeStats({ done: 0, total: 0, accessible: 0, denied: 0 });
    probeCacheRef.current = new Map();

    const handle = startProbe((event, data) => {
      if (event === 'meta') {
        setProjects(data.projects || []);
        setStreamCounts({ allBundles: data.all_bundles || 0, candidates: data.candidates || 0 });
        setProbeStats({ done: 0, total: data.candidates || 0, accessible: 0, denied: 0 });
        setLoading(false);
        setProbing((data.candidates || 0) > 0);
      } else if (event === 'bundle') {
        const b = data.bundle;
        if (!b) return;
        const id = b.id || b._id;
        probeCacheRef.current.set(id, data.computedList || []);
        setBundles((prev) => [...prev, b]);
      } else if (event === 'progress') {
        setProbeStats({
          done: data.done || 0,
          total: data.total || 0,
          accessible: data.accessible || 0,
          denied: data.denied || 0,
        });
      } else if (event === 'done') {
        setProbing(false);
      } else if (event === 'error') {
        setLoadError(`${data.stage || 'probe'}: ${data.detail || 'unknown error'}`);
        setLoading(false);
        setProbing(false);
      }
    });

    return () => handle.close();
  }, []);

  const projectFilteredOut = streamCounts.allBundles - streamCounts.candidates;

  // ── Derived data: per-project bundle counts ───────────────────────────────
  const { bundleCountByProject, totalBundles } = useMemo(() => {
    const byProj = new Map();
    for (const b of bundles) {
      const pid = b.projectId || (b.project && b.project.id) || '';
      byProj.set(pid, (byProj.get(pid) || 0) + 1);
    }
    return { bundleCountByProject: byProj, totalBundles: bundles.length };
  }, [bundles]);

  const enrichedProjects = useMemo(() =>
    projects.map((p) => ({
      ...p,
      bundle_count: bundleCountByProject.get(p.id) || 0,
    })).sort((a, b) => (b.bundle_count - a.bundle_count) || a.name.localeCompare(b.name)),
    [projects, bundleCountByProject]
  );

  const filteredProjects = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return enrichedProjects.filter((p) => {
      if (hideEmpty && p.bundle_count === 0) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || (p.owner_username || '').toLowerCase().includes(q);
    });
  }, [enrichedProjects, debouncedSearch, hideEmpty]);

  // ── Preflight ──────────────────────────────────────────────────────────────
  const exportable = useMemo(() => {
    if (selectedIds.size === 0) return bundles;
    return bundles.filter((b) => {
      const pid = b.projectId || (b.project && b.project.id) || '';
      return selectedIds.has(pid);
    });
  }, [bundles, selectedIds]);

  const exportableProjectCount = useMemo(() => {
    const seen = new Set();
    for (const b of exportable) {
      const pid = b.projectId || (b.project && b.project.id) || '';
      if (pid) seen.add(pid);
    }
    return seen.size;
  }, [exportable]);

  // ── Selection helpers ──────────────────────────────────────────────────────
  const toggleProject = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const selectAllVisible = () => setSelectedIds((prev) => {
    const next = new Set(prev);
    for (const p of filteredProjects) next.add(p.id);
    return next;
  });
  const clearSelection = () => setSelectedIds(new Set());
  const applyPreset = (name) => setColumns(new Set(COLUMN_PRESETS[name]));
  const toggleGroup = (groupId) => {
    const g = COLUMN_GROUPS.find((x) => x.id === groupId);
    if (!g) return;
    setColumns((prev) => {
      const next = new Set(prev);
      const allOn = g.cols.every((c) => next.has(c));
      for (const c of g.cols) allOn ? next.delete(c) : next.add(c);
      return next;
    });
  };

  // ── Project list virtualization ────────────────────────────────────────────
  const listRef = useRef(null);
  const rowVirtualizer = useVirtualizer({
    count: filteredProjects.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 36,
    overscan: 12,
  });

  // ── Export ─────────────────────────────────────────────────────────────────
  const handleExport = async () => {
    if (exportable.length === 0) return;
    setExporting(true);
    setExportError(null);
    setLastExport(null);
    setProgress({ done: 0, total: exportable.length, failed: 0, rows: 0 });

    const exportedAt = isoStamp();
    const cols = ALL_COLUMNS.filter((c) => columns.has(c));
    const projectsById = new Map(projects.map((p) => [p.id, p]));

    const csv = new CsvBuilder(cols);
    let rowCount = 0;
    let failedCount = 0;

    try {
      // The probe already delivered compute-policy for every accessible bundle
      // and cached it in probeCacheRef. CSV construction is fully local.
      let done = 0;
      for (const bundle of exportable) {
        const id = bundle.id || bundle._id;
        const ctx = bundleContext(bundle, projectsById);
        const computedList = probeCacheRef.current.get(id) || [];
        csv.addBundle({
          exported_at_utc: exportedAt,
          ...ctx,
          ...bundleComputedContext(computedList),
          ...bundlePolicyContext(computedList),
          export_error: '',
        }, bundleAnswers(computedList));
        rowCount++;
        done++;
        // Yield to the browser every 50 bundles so a large export doesn't
        // freeze the progress UI.
        if (done % 50 === 0) {
          setProgress({ done, total: exportable.length, failed: failedCount, rows: rowCount });
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      setProgress({ done, total: exportable.length, failed: failedCount, rows: rowCount });

      const blob = csv.finalize();
      const filename = `governance-evidence_${fileStamp()}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLastExport({
        filename,
        size: blob.size,
        rows: rowCount,
        failed: failedCount,
        at: new Date(),
      });
    } catch (e) {
      setExportError(e.message || String(e));
    } finally {
      setExporting(false);
    }
  };

  // ── Keyboard shortcut: Cmd/Ctrl + Enter ────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !exporting) {
        e.preventDefault();
        handleExport();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── Render ─────────────────────────────────────────────────────────────────
  const ready = !loading && !loadError;
  const exportDisabled = exporting || !ready || probing || exportable.length === 0;
  const projectsWithBundles = enrichedProjects.filter((p) => p.bundle_count > 0).length;

  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead-row">
          <div className="brand">
            <div className="brand-mark">●</div>
            <div className="brand-text">
              <div className="brand-title">Governance Evidence Exporter</div>
              <div className="brand-sub">One row per bundle · one column per question · every answer</div>
            </div>
          </div>
          <div className="masthead-stat">
            <span className="stat-n">{ready ? fmtNumber(projectsWithBundles) : '—'}</span>
            <span className="stat-l">projects</span>
            <span className="dot">·</span>
            <span className="stat-n">{ready ? fmtNumber(totalBundles) : '—'}</span>
            <span className="stat-l">accessible bundles</span>
            {probing && streamCounts.candidates > 0 && (
              <>
                <span className="dot">·</span>
                <span className="stat-l probing">
                  <span className="spin sm" /> checking access {fmtNumber(probeStats.done)}/{fmtNumber(probeStats.total)}
                </span>
              </>
            )}
            {!probing && ready && streamCounts.allBundles > totalBundles && (
              <>
                <span className="dot">·</span>
                <span className="stat-l muted-2" title={`${fmtNumber(projectFilteredOut)} in projects you don't have access to${streamCounts.candidates - totalBundles > 0 ? `, ${fmtNumber(streamCounts.candidates - totalBundles)} project-reader-only` : ''}`}>
                  {fmtNumber(streamCounts.allBundles - totalBundles)} hidden (no access)
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      {loadError && (
        <div className="banner banner-err">
          <strong>Failed to load governance data:</strong> {loadError}
          <div className="banner-sub">
            This app's backend talks to Domino's project and governance APIs on your behalf.
            Confirm the app has access to governance bundles.
          </div>
        </div>
      )}

      <main className="grid">
        <section className="card cell-projects">
          <div className="card-head">
            <div className="card-title">Projects</div>
            <div className="card-tools">
              <input
                className="search"
                placeholder="Filter by project or owner…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button className="ghost" onClick={selectAllVisible}>Select visible</button>
              <button className="ghost" onClick={clearSelection}>Clear</button>
              <label className="check">
                <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
                <span>Hide empty</span>
              </label>
            </div>
          </div>
          <div className="card-body proj-body">
            <div className="proj-hint">
              {selectedIds.size === 0
                ? `No specific projects selected — export will include all ${fmtNumber(projectsWithBundles)} project${projectsWithBundles === 1 ? '' : 's'} with accessible bundles.`
                : `${selectedIds.size} project${selectedIds.size === 1 ? '' : 's'} selected.`}
            </div>
            <div className="proj-list" ref={listRef}>
              {loading ? (
                <div className="muted center">Loading projects and bundles…</div>
              ) : probing && filteredProjects.length === 0 ? (
                <div className="muted center">Checking which bundles you can access…</div>
              ) : filteredProjects.length === 0 ? (
                <div className="muted center">No accessible bundles in any project.</div>
              ) : (
                <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
                  {rowVirtualizer.getVirtualItems().map((vi) => {
                    const p = filteredProjects[vi.index];
                    const explicitlyOn = selectedIds.has(p.id);
                    const implicitlyOn = selectedIds.size === 0;
                    return (
                      <div
                        key={p.id}
                        className={`proj-row${explicitlyOn ? ' on' : ''}${implicitlyOn ? ' implicit' : ''}${vi.index % 2 ? ' odd' : ''}`}
                        style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}
                        onClick={() => toggleProject(p.id)}
                      >
                        <input
                          type="checkbox"
                          checked={explicitlyOn}
                          onChange={() => toggleProject(p.id)}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="proj-name" title={p.name}>{p.name}</div>
                        <div className="proj-owner" title={p.owner_username}>{p.owner_username || p.owner_name || '—'}</div>
                        <div className="proj-count">{p.bundle_count} <span className="muted">bundles</span></div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>


        <section className="card cell-columns">
          <div className="card-head">
            <div className="card-title">Metadata columns</div>
            <div className="card-tools">
              <span className="muted">Preset:</span>
              <button className="ghost" onClick={() => applyPreset('audit')}>Audit essentials</button>
              <button className="ghost" onClick={() => applyPreset('full')}>Everything</button>
              <button className="ghost" onClick={() => applyPreset('minimal')}>Minimal</button>
            </div>
          </div>
          <div className="proj-hint">
            One row per bundle. After these columns, the CSV appends one column per unique evidence question (header = question label).
          </div>
          <div className="card-body col-grid">
            {COLUMN_GROUPS.map((g) => {
              const onCount = g.cols.filter((c) => columns.has(c)).length;
              return (
                <div className="col-group" key={g.id}>
                  <div className="col-group-head">
                    <button className="link" onClick={() => toggleGroup(g.id)}>
                      {onCount === g.cols.length ? '☑' : onCount === 0 ? '☐' : '◐'} {g.label}
                    </button>
                    <span className="muted small">{onCount}/{g.cols.length}</span>
                  </div>
                  <div className="col-list">
                    {g.cols.map((c) => (
                      <label className="check tight" key={c}>
                        <input
                          type="checkbox"
                          checked={columns.has(c)}
                          onChange={() => {
                            setColumns((prev) => {
                              const next = new Set(prev);
                              next.has(c) ? next.delete(c) : next.add(c);
                              return next;
                            });
                          }}
                        />
                        <code>{c}</code>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="actionbar">
        <div className="actionbar-left">
          {exporting ? (
            <div className="estimate">
              <strong>{fmtNumber(progress.done)}</strong> / {fmtNumber(progress.total)} bundles processed
              {progress.failed > 0 && <> · <span className="warn">{progress.failed} failed</span></>}
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
              </div>
            </div>
          ) : probing ? (
            <div className="estimate">
              <strong>{fmtNumber(probeStats.done)}</strong> / {fmtNumber(probeStats.total)} bundles checked
              {' '}·{' '}
              <strong>{fmtNumber(probeStats.accessible)}</strong> accessible
              {probeStats.denied > 0 && <> · <span className="muted-2">{fmtNumber(probeStats.denied)} denied</span></>}
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${(probeStats.done / Math.max(1, probeStats.total)) * 100}%` }} />
              </div>
            </div>
          ) : (
            <div className="estimate">
              Will export <strong>{fmtNumber(exportableProjectCount)}</strong> project{exportableProjectCount === 1 ? '' : 's'}
              {' '}·{' '}
              <strong>{fmtNumber(exportable.length)}</strong> bundle{exportable.length === 1 ? '' : 's'}
              {' '}·{' '}
              <strong>{[...columns].length}</strong> column{[...columns].length === 1 ? '' : 's'}
            </div>
          )}
          {lastExport && !exporting && (
            <div className="last-export muted">
              Saved <code>{lastExport.filename}</code> · {fmtNumber(lastExport.rows)} rows · {(lastExport.size / 1024).toFixed(1)} KB
              {lastExport.failed > 0 && <> · <span className="warn">{fmtNumber(lastExport.failed)} failed</span></>}
            </div>
          )}
          {exportError && <div className="banner-err small">{exportError}</div>}
        </div>
        <button className="primary" disabled={exportDisabled} onClick={handleExport}>
          {exporting ? (
            <><span className="spin" /> Generating CSV…</>
          ) : probing ? (
            <><span className="spin" /> Checking access…</>
          ) : (
            <>↓ Export governance evidence to CSV</>
          )}
          <span className="kbd">{(typeof navigator !== 'undefined' && navigator.platform.includes('Mac')) ? '⌘' : 'Ctrl'}↵</span>
        </button>
      </footer>
    </div>
  );
}
