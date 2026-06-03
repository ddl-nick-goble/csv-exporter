import React, { useEffect, useMemo, useRef, useState } from 'react';

import { load, fetchEvidence } from './api.js';
import {
  META_COLUMNS,
  bundleContext,
  bundleComputedContext,
  bundlePolicyContext,
  bundleAnswers,
  buildPolicyOutlines,
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

// Tri-state checkbox: 'all' (checked) | 'some' (indeterminate) | 'none' (unchecked).
function Tristate({ state, onChange, ariaLabel, className }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={className}
      checked={state === 'all'}
      onChange={() => onChange(state === 'all' ? 'none' : 'all')}
      aria-label={ariaLabel}
    />
  );
}

function flattenArtifactIds(policies) {
  const out = [];
  for (const p of policies) {
    for (const s of p.stages) {
      for (const sec of s.sections) {
        for (const q of sec.questions) out.push(q.id);
      }
    }
  }
  return out;
}

function artifactIdsForPolicy(policy) {
  const out = [];
  for (const s of policy.stages) {
    for (const sec of s.sections) {
      for (const q of sec.questions) out.push(q.id);
    }
  }
  return out;
}

function artifactIdsForSection(section) {
  return section.questions.map((q) => q.id);
}

export default function App() {
  // ── Server state (populated from one /api/load call) ──────────────────────
  const [projects, setProjects] = useState([]);
  const [bundles, setBundles] = useState([]);
  const [serverPolicies, setServerPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Evidence is fetched at export time only — see handleExport.
  const probeCacheRef = useRef(new Map());

  // ── User selections ────────────────────────────────────────────────────────
  const [selectedProjectIds, setSelectedProjectIds] = useState(() => new Set());
  // null = "every question selected" sentinel; first interaction materializes
  // to a real Set so we don't have to enumerate every question id up front.
  const [selectedArtifactIds, setSelectedArtifactIds] = useState(null);
  const [projectSearch, setProjectSearch] = useState('');
  const debouncedSearch = useDebounced(projectSearch, 120);
  const [collapsedPolicies, setCollapsedPolicies] = useState(() => new Set());
  const togglePolicyCollapsed = (id) => setCollapsedPolicies((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const collapseAllPolicies = () => setCollapsedPolicies(new Set(policies.map((p) => p.id)));
  const expandAllPolicies = () => setCollapsedPolicies(new Set());

  // ── Export state ───────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [exportError, setExportError] = useState(null);
  const [lastExport, setLastExport] = useState(null);

  // ── Load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setProjects([]);
    setBundles([]);
    setServerPolicies([]);
    probeCacheRef.current = new Map();
    (async () => {
      try {
        const payload = await load();
        if (cancelled) return;
        setProjects(payload.projects || []);
        setBundles(payload.bundles || []);
        setServerPolicies(payload.policies || []);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────────
  const policies = useMemo(
    () => buildPolicyOutlines(serverPolicies, bundles),
    [serverPolicies, bundles],
  );

  const { bundleCountByProject, projectsWithBundles } = useMemo(() => {
    const byProj = new Map();
    for (const b of bundles) {
      const pid = b.projectId || (b.project && b.project.id) || '';
      byProj.set(pid, (byProj.get(pid) || 0) + 1);
    }
    let withBundles = 0;
    for (const count of byProj.values()) if (count > 0) withBundles++;
    return { bundleCountByProject: byProj, projectsWithBundles: withBundles };
  }, [bundles]);

  const enrichedProjects = useMemo(() =>
    projects.map((p) => ({
      ...p,
      bundle_count: bundleCountByProject.get(p.id) || 0,
    })).sort((a, b) => (b.bundle_count - a.bundle_count) || a.name.localeCompare(b.name)),
    [projects, bundleCountByProject]
  );

  const filteredFilterProjects = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    return enrichedProjects.filter((p) => {
      if (p.bundle_count === 0) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || (p.owner_username || '').toLowerCase().includes(q);
    });
  }, [enrichedProjects, debouncedSearch]);

  // Question selection helpers — treat null as "all selected".
  const totalQuestions = useMemo(() => flattenArtifactIds(policies).length, [policies]);
  const selectedCount = selectedArtifactIds === null ? totalQuestions : selectedArtifactIds.size;
  const isQuestionSelected = (id) =>
    selectedArtifactIds === null ? true : selectedArtifactIds.has(id);

  const setStateFromIds = (ids) => {
    if (ids.length === 0) return 'none';
    if (selectedArtifactIds === null) return 'all';
    let on = 0;
    for (const id of ids) if (selectedArtifactIds.has(id)) on++;
    if (on === 0) return 'none';
    if (on === ids.length) return 'all';
    return 'some';
  };
  const policyState = (policy) => setStateFromIds(artifactIdsForPolicy(policy));
  const sectionStateOf = (section) => setStateFromIds(artifactIdsForSection(section));

  const toggleQuestion = (id) => {
    setSelectedArtifactIds((prev) => {
      const next = new Set(prev === null ? flattenArtifactIds(policies) : prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const setPolicySelection = (policy, target) => {
    setSelectedArtifactIds((prev) => {
      const next = new Set(prev === null ? flattenArtifactIds(policies) : prev);
      const ids = artifactIdsForPolicy(policy);
      if (target === 'all') for (const id of ids) next.add(id);
      else for (const id of ids) next.delete(id);
      return next;
    });
  };
  const setSectionSelection = (section, target) => {
    setSelectedArtifactIds((prev) => {
      const next = new Set(prev === null ? flattenArtifactIds(policies) : prev);
      const ids = artifactIdsForSection(section);
      if (target === 'all') for (const id of ids) next.add(id);
      else for (const id of ids) next.delete(id);
      return next;
    });
  };
  const setAllQuestions = (target) => {
    setSelectedArtifactIds(target === 'all' ? null : new Set());
  };

  // Project selection helpers — keep the existing "empty set = all" semantics.
  const toggleProject = (id) => setSelectedProjectIds((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const setAllProjects = () => setSelectedProjectIds(new Set());
  const selectVisibleProjects = () => setSelectedProjectIds(new Set(filteredFilterProjects.map((p) => p.id)));

  // ── Preflight ──────────────────────────────────────────────────────────────
  const projectMatchedBundles = useMemo(() => {
    if (selectedProjectIds.size === 0) return bundles;
    return bundles.filter((b) => {
      const pid = b.projectId || (b.project && b.project.id) || '';
      return selectedProjectIds.has(pid);
    });
  }, [bundles, selectedProjectIds]);

  // For each policy, the set of bundle ids that reference it, and the set of
  // its own artifact ids (questions + synthetic statuses). Used to compute
  // "exportable" without per-bundle evidence — purely from the bundle ↔ policy
  // references in the bundle list.
  const policyArtifactIds = useMemo(() => {
    const m = new Map();
    for (const p of policies) m.set(p.id, new Set(artifactIdsForPolicy(p)));
    return m;
  }, [policies]);

  const bundlePolicyIds = useMemo(() => {
    // bundle.id -> Set<policyId> from the bundle's policies[] refs (or the
    // legacy top-level policyId).
    const m = new Map();
    for (const b of bundles) {
      const bid = b.id || b._id;
      if (!bid) continue;
      const set = new Set();
      const refs = (b.policies && b.policies.length) ? b.policies : (b.policyId ? [{ policyId: b.policyId }] : []);
      for (const r of refs) if (r && r.policyId) set.add(r.policyId);
      m.set(bid, set);
    }
    return m;
  }, [bundles]);

  // A bundle is exportable if any of its attached policies has at least one
  // selected question. Computed from the bundle ↔ policy ↔ question graph the
  // server returns at load time — no per-bundle compute-policy needed.
  const exportable = useMemo(() => {
    if (selectedCount === 0) return [];
    if (selectedArtifactIds === null) {
      // Every question selected → every bundle attached to a known policy.
      return projectMatchedBundles.filter((b) => {
        const pids = bundlePolicyIds.get(b.id || b._id) || new Set();
        for (const pid of pids) if (policyArtifactIds.has(pid)) return true;
        return false;
      });
    }
    return projectMatchedBundles.filter((b) => {
      const pids = bundlePolicyIds.get(b.id || b._id) || new Set();
      for (const pid of pids) {
        const ids = policyArtifactIds.get(pid);
        if (!ids) continue;
        for (const aid of ids) if (selectedArtifactIds.has(aid)) return true;
      }
      return false;
    });
  }, [projectMatchedBundles, selectedArtifactIds, selectedCount, bundlePolicyIds, policyArtifactIds]);

  // Selected question columns, ordered by policy → stage → section.
  // CSV header prefixes the question with its policy name so the same question
  // label appearing under multiple policies (e.g. "Model Purpose Document")
  // stays disambiguated in the export.
  const questionCols = useMemo(() => {
    const out = [];
    for (const p of policies) {
      for (const s of p.stages) {
        for (const sec of s.sections) {
          for (const q of sec.questions) {
            if (isQuestionSelected(q.id)) {
              out.push({
                id: q.id,
                label: q.label,
                header: `${p.name}: ${q.label}`,
              });
            }
          }
        }
      }
    }
    return out;
  }, [policies, selectedArtifactIds]);

  // ── Export ─────────────────────────────────────────────────────────────────
  const handleExport = async () => {
    if (exportable.length === 0 || questionCols.length === 0) return;
    setExporting(true);
    setExportError(null);
    setLastExport(null);
    setProgress({ done: 0, total: exportable.length });

    const exportedAt = isoStamp();
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const accept = (id) => isQuestionSelected(id);
    const rows = [];

    try {
      // Fetch evidence (compute-policy payloads) for exactly the bundles being
      // exported. This is the expensive step that used to run at load time.
      const idsToFetch = exportable
        .map((b) => b.id || b._id)
        .filter((id) => id && !probeCacheRef.current.has(id));
      if (idsToFetch.length) {
        const results = await fetchEvidence(idsToFetch);
        for (const [bid, computedList] of Object.entries(results)) {
          probeCacheRef.current.set(bid, computedList);
        }
      }

      let done = 0;
      for (const bundle of exportable) {
        const id = bundle.id || bundle._id;
        const computedList = probeCacheRef.current.get(id) || [];
        const meta = {
          exported_at_utc: exportedAt,
          ...bundleContext(bundle, projectsById),
          ...bundleComputedContext(computedList),
          ...bundlePolicyContext(computedList),
          export_error: '',
        };
        rows.push({ meta, answers: bundleAnswers(computedList, accept) });
        done++;
        if (done % 50 === 0) {
          setProgress({ done, total: exportable.length });
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      setProgress({ done, total: exportable.length });

      const csv = new CsvBuilder(META_COLUMNS, questionCols);
      const blob = csv.build(rows);
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
        rows: rows.length,
        questions: questionCols.length,
        at: new Date(),
      });
    } catch (e) {
      setExportError(e.message || String(e));
    } finally {
      setExporting(false);
    }
  };

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
  const totalBundles = bundles.length;
  const exportDisabled = exporting || !ready
    || exportable.length === 0 || questionCols.length === 0;
  const projectFilterLabel = selectedProjectIds.size === 0
    ? `All (${fmtNumber(projectsWithBundles)})`
    : `${fmtNumber(selectedProjectIds.size)} of ${fmtNumber(projectsWithBundles)}`;

  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead-row">
          <div className="brand">
            <div className="brand-mark">●</div>
            <div className="brand-text">
              <div className="brand-title">Governance Evidence Exporter</div>
              <div className="brand-sub">Pick policies · pick questions · one row per bundle</div>
            </div>
          </div>
          <div className="masthead-stat">
            <span className="stat-n">{ready ? fmtNumber(projectsWithBundles) : '—'}</span>
            <span className="stat-l">projects</span>
            <span className="dot">·</span>
            <span className="stat-n">{ready ? fmtNumber(totalBundles) : '—'}</span>
            <span className="stat-l">bundles</span>
            <span className="dot">·</span>
            <span className="stat-n">{ready ? fmtNumber(policies.length) : '—'}</span>
            <span className="stat-l">policies</span>
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

      <div className="filter-row">
        <details className="proj-filter">
          <summary>
            <span className="muted">Projects:</span>
            <span className="filter-value">{projectFilterLabel}</span>
            <span className="caret">▾</span>
          </summary>
          <div className="proj-filter-body">
            <div className="proj-filter-tools">
              <input
                className="search"
                placeholder="Filter…"
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
              />
              <button className="ghost" onClick={setAllProjects} title="Include every project">All</button>
              <button className="ghost" onClick={selectVisibleProjects} title="Select all visible">Visible</button>
            </div>
            <div className="proj-filter-list">
              {filteredFilterProjects.length === 0 ? (
                <div className="muted center small">No matching projects.</div>
              ) : filteredFilterProjects.map((p) => (
                <label className="proj-filter-line" key={p.id}>
                  <input
                    type="checkbox"
                    checked={selectedProjectIds.has(p.id)}
                    onChange={() => toggleProject(p.id)}
                  />
                  <span className="proj-filter-name" title={p.name}>{p.name}</span>
                  <span className="proj-filter-count">{p.bundle_count}</span>
                </label>
              ))}
            </div>
          </div>
        </details>

        <div className="filter-summary">
          <span className="muted">Selected:</span>
          <span><strong>{fmtNumber(selectedCount)}</strong> / {fmtNumber(totalQuestions)} question{totalQuestions === 1 ? '' : 's'}</span>
          <span className="dot">·</span>
          <span><strong>{fmtNumber(exportable.length)}</strong> bundle{exportable.length === 1 ? '' : 's'} in scope</span>
          <span className="filter-actions">
            <button className="ghost" onClick={() => setAllQuestions('all')} disabled={selectedCount === totalQuestions}>Select all</button>
            <button className="ghost" onClick={() => setAllQuestions('none')} disabled={selectedCount === 0}>Clear</button>
            <span className="filter-actions-sep" aria-hidden="true" />
            <button className="ghost" onClick={expandAllPolicies} disabled={policies.length === 0 || collapsedPolicies.size === 0}>Expand all</button>
            <button className="ghost" onClick={collapseAllPolicies} disabled={policies.length === 0 || collapsedPolicies.size >= policies.length}>Collapse all</button>
          </span>
        </div>
      </div>

      <main className="policy-grid">
        {loading ? (
          <div className="policy-empty">Loading projects and bundles…</div>
        ) : policies.length === 0 ? (
          <div className="policy-empty">No accessible policies found.</div>
        ) : (
          policies.map((policy) => {
            const pState = policyState(policy);
            const totalQ = artifactIdsForPolicy(policy).length;
            const onCount = totalQ === 0
              ? 0
              : (selectedArtifactIds === null
                  ? totalQ
                  : artifactIdsForPolicy(policy).filter((id) => selectedArtifactIds.has(id)).length);
            const collapsed = collapsedPolicies.has(policy.id);
            return (
              <section key={policy.id} className={`policy-card${pState === 'none' ? ' off' : ''}${collapsed ? ' collapsed' : ''}`}>
                <header className="policy-card-head">
                  <Tristate
                    state={pState}
                    onChange={(target) => setPolicySelection(policy, target)}
                    ariaLabel={`Include policy ${policy.name}`}
                    className="policy-master"
                  />
                  <div className="policy-name" title={policy.name}>
                    {policy.name}
                    {policy.version && <span className="policy-version">v{policy.version}</span>}
                  </div>
                  <div className="policy-count">
                    <span className={pState === 'some' ? 'emph' : ''}>{onCount}</span>
                    <span>/{totalQ}</span>
                  </div>
                  <button
                    type="button"
                    className="policy-collapse"
                    onClick={() => togglePolicyCollapsed(policy.id)}
                    aria-label={collapsed ? `Expand ${policy.name}` : `Collapse ${policy.name}`}
                    aria-expanded={!collapsed}
                  >
                    <span className="caret">▾</span>
                  </button>
                </header>
                {!collapsed && <div className="policy-card-body">
                  {policy.stages.map((stage, stageIdx) => (
                    <div className="stage-card" key={stage.id || stageIdx}>
                      <div className="stage-head">
                        <span className="stage-label">STAGE {stageIdx + 1}</span>
                        <span className="stage-name" title={stage.name}>{stage.name}</span>
                      </div>
                      <div className="stage-body">
                        {stage.sections.map((sec, secIdx) => {
                          const sState = sectionStateOf(sec);
                          const total = sec.questions.length;
                          const sOn = sState === 'all'
                            ? total
                            : (selectedArtifactIds === null
                                ? total
                                : sec.questions.filter((q) => selectedArtifactIds.has(q.id)).length);
                          const cls = `section-card section-${sec.kind}${sState === 'none' ? ' off' : ''}`;
                          return (
                            <div className={cls} key={secIdx}>
                              <div className="section-head">
                                <Tristate
                                  state={sState}
                                  onChange={(target) => setSectionSelection(sec, target)}
                                  ariaLabel={`Include section ${sec.name}`}
                                  className="section-master"
                                />
                                {sec.kind === 'approval' && (
                                  <span className="sec-kind sec-approval">Approval</span>
                                )}
                                <span className="section-name" title={sec.name}>{sec.name}</span>
                                <span className="section-count">
                                  <span className={sState === 'some' ? 'emph' : ''}>{sOn}</span>
                                  <span>/{total}</span>
                                </span>
                              </div>
                              <ul className="policy-q-list">
                                {sec.questions.map((q) => (
                                  <li
                                    key={q.id}
                                    className={`policy-q${q.isStatus ? ' status-q' : ''}`}
                                  >
                                    <label>
                                      <input
                                        type="checkbox"
                                        checked={isQuestionSelected(q.id)}
                                        onChange={() => toggleQuestion(q.id)}
                                      />
                                      <span className="policy-q-label" title={q.label}>{q.label}</span>
                                    </label>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  <div className="policy-card-foot muted small">
                    {policy.bundleIds.size} bundle{policy.bundleIds.size === 1 ? '' : 's'}
                  </div>
                </div>}
              </section>
            );
          })
        )}
      </main>

      <footer className="actionbar">
        <div className="actionbar-left">
          {exporting ? (
            <div className="estimate">
              <strong>{fmtNumber(progress.done)}</strong> / {fmtNumber(progress.total)} bundles processed
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
              </div>
            </div>
          ) : (
            <div className="estimate">
              Will export <strong>{fmtNumber(exportable.length)}</strong> bundle{exportable.length === 1 ? '' : 's'}
              {' '}·{' '}
              <strong>{fmtNumber(questionCols.length)}</strong> question column{questionCols.length === 1 ? '' : 's'}
              {' '}·{' '}
              <strong>{META_COLUMNS.length}</strong> metadata columns
            </div>
          )}
          {lastExport && !exporting && (
            <div className="last-export muted">
              Saved <code>{lastExport.filename}</code> · {fmtNumber(lastExport.rows)} rows · {fmtNumber(lastExport.questions)} questions · {(lastExport.size / 1024).toFixed(1)} KB
            </div>
          )}
          {exportError && <div className="banner-err small">{exportError}</div>}
        </div>
        <button className="primary" disabled={exportDisabled} onClick={handleExport}>
          {exporting ? (
            <><span className="spin" /> Generating CSV…</>
          ) : (
            <>↓ Export governance evidence to CSV</>
          )}
          <span className="kbd">{(typeof navigator !== 'undefined' && navigator.platform.includes('Mac')) ? '⌘' : 'Ctrl'}↵</span>
        </button>
      </footer>
    </div>
  );
}
