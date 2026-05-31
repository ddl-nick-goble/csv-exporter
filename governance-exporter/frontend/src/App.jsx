import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { fetchProjects, fetchAllBundles, fetchComputedPolicy, pool } from './api.js';
import {
  COLUMN_GROUPS,
  ALL_COLUMNS,
  COLUMN_PRESETS,
  bundleContext,
  CsvBuilder,
} from './csv.js';

const CONCURRENCY = 10;

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

// A single bundle can have multiple policies attached (see bundle.policies[]).
// Each one needs its own compute-policy call. Falls back to the bundle's
// primary policyId for older payloads that only expose the legacy field.
function bundlePolicyRefs(bundle) {
  const list = Array.isArray(bundle.policies) ? bundle.policies : [];
  const refs = list
    .filter((p) => p && p.policyId)
    .map((p) => ({ policyId: p.policyId, policyVersionId: p.policyVersionId }));
  if (refs.length === 0 && bundle.policyId) {
    refs.push({ policyId: bundle.policyId, policyVersionId: bundle.policyVersionId });
  }
  // De-dupe by policyId+versionId — bundle.policies can repeat the same policy.
  const seen = new Set();
  return refs.filter((r) => {
    const k = `${r.policyId}::${r.policyVersionId || ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Fetch compute-policy for every policy attached to a bundle. 404s are tolerated
// (treated as "policy not computable for this bundle" — empty payload). 403s
// propagate so the caller can decide whether the whole bundle is denied.
async function fetchAllComputedForBundle(bundle) {
  const id = bundle.id || bundle._id;
  const refs = bundlePolicyRefs(bundle);
  if (refs.length === 0) return [];
  const out = [];
  let denials = 0;
  for (const ref of refs) {
    try {
      out.push(await fetchComputedPolicy(id, ref.policyId, ref.policyVersionId));
    } catch (e) {
      if (e && e.status === 404) continue;
      if (e && e.status === 403) { denials++; continue; }
      throw e;
    }
  }
  // If every policy 403'd we surface that — the bundle is effectively denied.
  if (out.length === 0 && denials > 0) {
    const err = new Error(`compute-policy 403 for all ${denials} policies on bundle ${id}`);
    err.status = 403;
    throw err;
  }
  return out;
}

export default function App() {
  // ── Server state ────────────────────────────────────────────────────────────
  const [projects, setProjects] = useState([]);
  const [allBundles, setAllBundles] = useState([]); // every bundle the list endpoint returned
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // ── ACL probe state ────────────────────────────────────────────────────────
  // Probe each bundle by fetching its latest evidence. If 200, the user has
  // read access and we keep the results cached for the export. If 403, we hide
  // the bundle. This makes the UI show ONLY actionable bundles, and the
  // export reuses the probe payload — no second fetch at export time.
  const [probing, setProbing] = useState(false);
  const [probeStats, setProbeStats] = useState({ done: 0, total: 0, accessible: 0, denied: 0 });
  const [accessibleIds, setAccessibleIds] = useState(() => new Set());
  const probeCacheRef = useRef(new Map()); // bundleId -> computed-policy payload

  // ── User selections ────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 150);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [stateFilter, setStateFilter] = useState(() => new Set());
  const [scope, setScope] = useState('latest');
  const [columns, setColumns] = useState(() => new Set(COLUMN_PRESETS.audit));

  // ── Export state ───────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0, rows: 0 });
  const [exportError, setExportError] = useState(null);
  const [lastExport, setLastExport] = useState(null);

  // ── Initial load ───────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchProjects(), fetchAllBundles()])
      .then(([projs, buns]) => {
        if (cancelled) return;
        setProjects(projs);
        setAllBundles(buns);
        setLoadError(null);
      })
      .catch((e) => !cancelled && setLoadError(e.message || String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  // ── Pre-filter: only bundles whose owning project the user can see ────────
  // The governance /bundles endpoint returns instance-wide bundles for users
  // with the GovernanceAdmin role, but /v4/projects only returns projects the
  // user is a member of. Bundles whose projectId isn't in our project list will
  // ALWAYS 403 on /results — so we drop them client-side without ever making
  // the network call. This removes the bulk of the console noise.
  const probeCandidates = useMemo(() => {
    if (projects.length === 0) return [];
    const accessibleProjectIds = new Set(projects.map((p) => p.id));
    return allBundles.filter((b) => {
      const pid = b.projectId || (b.project && b.project.id) || '';
      return accessibleProjectIds.has(pid);
    });
  }, [allBundles, projects]);

  const projectFilteredOut = allBundles.length - probeCandidates.length;

  // ── ACL probe: runs once when bundles are loaded ──────────────────────────
  useEffect(() => {
    if (probeCandidates.length === 0) {
      setAccessibleIds(new Set());
      setProbing(false);
      return;
    }
    let cancelled = false;
    setProbing(true);
    setProbeStats({ done: 0, total: probeCandidates.length, accessible: 0, denied: 0 });
    probeCacheRef.current = new Map();
    const accessible = new Set();

    pool(
      probeCandidates,
      CONCURRENCY,
      async (bundle) => {
        const id = bundle.id || bundle._id;
        // Bundles with no attached policy contribute no rows but should still
        // count as accessible (so the UI surfaces them).
        if (bundlePolicyRefs(bundle).length === 0) {
          probeCacheRef.current.set(id, []);
          accessible.add(id);
          if (!cancelled) setAccessibleIds(new Set(accessible));
          return;
        }
        try {
          const computedList = await fetchAllComputedForBundle(bundle);
          probeCacheRef.current.set(id, computedList);
          accessible.add(id);
          // Stream updates: as soon as we learn a bundle is accessible, add it
          // so the project counts in the UI grow live.
          if (!cancelled) setAccessibleIds(new Set(accessible));
          return computedList;
        } catch (e) {
          throw e;
        }
      },
      (p) => {
        if (cancelled) return;
        setProbeStats({
          done: p.done,
          total: p.total,
          accessible: accessible.size,
          denied: p.skipped + p.failed,
        });
      },
    ).then(() => {
      if (cancelled) return;
      setAccessibleIds(new Set(accessible));
    }).finally(() => {
      if (cancelled) return;
      setProbing(false);
    });

    return () => { cancelled = true; };
  }, [probeCandidates]);

  // ── Bundles the user can actually act on ───────────────────────────────────
  const bundles = useMemo(
    () => allBundles.filter((b) => accessibleIds.has(b.id || b._id)),
    [allBundles, accessibleIds],
  );

  // ── Derived data: per-project bundle counts + state list (accessible only) ─
  const { bundleCountByProject, stateCountByProject, allStates, totalBundles } = useMemo(() => {
    const byProj = new Map();
    const stateByProj = new Map();
    const statesSet = new Set();
    for (const b of bundles) {
      const pid = b.projectId || (b.project && b.project.id) || '';
      byProj.set(pid, (byProj.get(pid) || 0) + 1);
      const state = ((b.state && b.state.name) || b.state || 'Unknown');
      statesSet.add(state);
      if (!stateByProj.has(pid)) stateByProj.set(pid, new Map());
      const sm = stateByProj.get(pid);
      sm.set(state, (sm.get(state) || 0) + 1);
    }
    return {
      bundleCountByProject: byProj,
      stateCountByProject: stateByProj,
      allStates: Array.from(statesSet).sort(),
      totalBundles: bundles.length,
    };
  }, [bundles]);

  const enrichedProjects = useMemo(() =>
    projects.map((p) => ({
      ...p,
      bundle_count: bundleCountByProject.get(p.id) || 0,
      states: stateCountByProject.get(p.id) || new Map(),
    })).sort((a, b) => (b.bundle_count - a.bundle_count) || a.name.localeCompare(b.name)),
    [projects, bundleCountByProject, stateCountByProject]
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
    const projectMatches = (b) => {
      if (selectedIds.size === 0) return true;
      const pid = b.projectId || (b.project && b.project.id) || '';
      return selectedIds.has(pid);
    };
    const stateMatches = (b) => {
      if (stateFilter.size === 0) return true;
      const state = ((b.state && b.state.name) || b.state || 'Unknown');
      return stateFilter.has(state);
    };
    return bundles.filter((b) => projectMatches(b) && stateMatches(b));
  }, [bundles, selectedIds, stateFilter]);

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
  const toggleState = (s) => setStateFilter((prev) => {
    const next = new Set(prev);
    next.has(s) ? next.delete(s) : next.add(s);
    return next;
  });
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
      await pool(exportable, CONCURRENCY, async (bundle) => {
        const id = bundle.id || bundle._id;
        const ctx = bundleContext(bundle, projectsById);
        try {
          // The probe already fetched compute-policy for every attached policy
          // on this bundle. Re-use that cache. (compute-policy returns latest
          // + historical results in one payload; scope filtering is client-side.)
          let computedList = probeCacheRef.current.get(id);
          if (!computedList) {
            computedList = await fetchAllComputedForBundle(bundle);
          }
          if (!computedList.length) {
            rowCount += csv.appendComputedPolicy({ policy: { stages: [] }, results: [] }, ctx, exportedAt, scope);
          } else {
            for (const computed of computedList) {
              rowCount += csv.appendComputedPolicy(computed, ctx, exportedAt, scope);
            }
          }
        } catch (e) {
          failedCount++;
          csv.appendRow({
            exported_at_utc: exportedAt,
            ...ctx,
            question_label: `(fetch error: ${e.status || 'network'} ${(e.message || '').slice(0, 80)})`,
          });
          rowCount++;
        }
      }, (p) => setProgress({ done: p.done, total: p.total, failed: failedCount, rows: rowCount }));

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
              <div className="brand-sub">One CSV · every bundle you can access · every answer</div>
            </div>
          </div>
          <div className="masthead-stat">
            <span className="stat-n">{ready ? fmtNumber(projectsWithBundles) : '—'}</span>
            <span className="stat-l">projects</span>
            <span className="dot">·</span>
            <span className="stat-n">{ready ? fmtNumber(totalBundles) : '—'}</span>
            <span className="stat-l">accessible bundles</span>
            {probing && probeCandidates.length > 0 && (
              <>
                <span className="dot">·</span>
                <span className="stat-l probing">
                  <span className="spin sm" /> checking access {fmtNumber(probeStats.done)}/{fmtNumber(probeStats.total)}
                </span>
              </>
            )}
            {!probing && ready && allBundles.length > totalBundles && (
              <>
                <span className="dot">·</span>
                <span className="stat-l muted-2" title={`${fmtNumber(projectFilteredOut)} in projects you don't have access to${probeCandidates.length - totalBundles > 0 ? `, ${fmtNumber(probeCandidates.length - totalBundles)} project-reader-only` : ''}`}>
                  {fmtNumber(allBundles.length - totalBundles)} hidden (no access)
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
            This app reads <code>/v4/projects</code> and <code>/api/governance/v1/*</code> directly from Domino using
            your session cookie. Confirm you have access to governance bundles.
          </div>
        </div>
      )}

      <main className="grid">
        <section className="card span-2">
          <div className="card-head">
            <div className="card-title">1 · Pick projects</div>
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

        <section className="card">
          <div className="card-head"><div className="card-title">2 · Scope</div></div>
          <div className="card-body stack">
            <label className="radio">
              <input type="radio" checked={scope === 'latest'} onChange={() => setScope('latest')} />
              <div>
                <div className="r-title">Latest answer only</div>
                <div className="r-sub">One row per evidence item, showing the current answer. Reuses the access probe — export is instant.</div>
              </div>
            </label>
            <label className="radio">
              <input type="radio" checked={scope === 'history'} onChange={() => setScope('history')} />
              <div>
                <div className="r-title">Full answer history</div>
                <div className="r-sub">Every revision becomes its own row. Larger files; one extra fetch per bundle.</div>
              </div>
            </label>

            <div className="divider" />
            <div className="sub-head">Bundle states</div>
            <div className="chip-row">
              {allStates.length === 0 && <span className="muted">No states loaded.</span>}
              {allStates.map((s) => {
                const on = stateFilter.has(s);
                return (
                  <button key={s} className={`chip${on ? ' on' : ''}`} onClick={() => toggleState(s)}>
                    {s}
                  </button>
                );
              })}
            </div>
            <div className="r-sub">{stateFilter.size === 0 ? 'All states included.' : `Only: ${Array.from(stateFilter).join(', ')}`}</div>
          </div>
        </section>

        <section className="card span-3">
          <div className="card-head">
            <div className="card-title">3 · Columns</div>
            <div className="card-tools">
              <span className="muted">Preset:</span>
              <button className="ghost" onClick={() => applyPreset('audit')}>Audit essentials</button>
              <button className="ghost" onClick={() => applyPreset('full')}>Everything</button>
              <button className="ghost" onClick={() => applyPreset('minimal')}>Minimal</button>
            </div>
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
              {' '}·{' '}
              <strong>{fmtNumber(progress.rows)}</strong> evidence rows
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
              {' '}· scope <strong>{scope}</strong>
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
