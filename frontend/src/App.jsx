import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
import * as presetStore from './presets.js';
import * as themeStore from './theme.js';

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function useColumnCount() {
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const mql2 = window.matchMedia('(max-width: 880px)');
    const mql1 = window.matchMedia('(max-width: 600px)');
    const update = () => {
      if (mql1.matches) setCols(1);
      else if (mql2.matches) setCols(2);
      else setCols(3);
    };
    update();
    mql2.addEventListener('change', update);
    mql1.addEventListener('change', update);
    return () => {
      mql2.removeEventListener('change', update);
      mql1.removeEventListener('change', update);
    };
  }, []);
  return cols;
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

function phaseLabel(phase) {
  if (phase === 'fetching') return 'Fetching evidence…';
  if (phase === 'building')  return 'Building CSV…';
  if (phase === 'downloading') return 'Downloading…';
  return 'Generating CSV…';
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

// Detailed export status panel. Three visual tricks make this feel alive
// even when the network is slow or the proxy buffers:
//   1. The progress bar always shows moving diagonal stripes (via CSS), so
//      the user gets motion regardless of width changes.
//   2. When done === 0 we show an "indeterminate" sweep instead of a 0%-
//      wide bar — a clear "working" signal before the first batch lands.
//   3. The elapsed clock ticks every animation frame, so even with no
//      server-side updates the user sees the time moving forward.
function ExportProgress({ progress }) {
  const { phase = 'fetching', done = 0, total = 0, failed = 0, currentName = '', startedAt = 0 } = progress;
  // Tick state at ~10fps so the elapsed clock and the indeterminate sweep
  // stay live even between server events.
  const [, setTick] = useState(0);
  useEffect(() => {
    let id;
    const loop = () => { setTick((n) => n + 1); id = setTimeout(loop, 100); };
    id = setTimeout(loop, 100);
    return () => clearTimeout(id);
  }, []);

  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const elapsed = startedAt ? Date.now() - startedAt : 0;
  const rate = elapsed > 250 && done > 0 ? done / (elapsed / 1000) : 0;
  const remaining = rate > 0 && total > done ? (total - done) / rate * 1000 : 0;
  const indeterminate = done === 0 && phase === 'fetching';
  return (
    <div className="estimate export-progress">
      <div className="export-progress-line">
        <span className="export-phase">{phaseLabel(phase)}</span>
        <span className="dot">·</span>
        <strong>{fmtNumber(done)}</strong>
        <span className="muted"> / {fmtNumber(total)}</span>
        <span className="muted"> ({pct}%)</span>
        {failed > 0 && <>
          <span className="dot">·</span>
          <span className="warn">{fmtNumber(failed)} failed</span>
        </>}
        <span className="dot">·</span>
        <span className="muted">{fmtDuration(elapsed)} elapsed</span>
        {rate > 0 && phase === 'fetching' && <>
          <span className="dot">·</span>
          <span className="muted">{rate.toFixed(1)}/s</span>
          {remaining > 0 && <>
            <span className="dot">·</span>
            <span className="muted">~{fmtDuration(remaining)} left</span>
          </>}
        </>}
      </div>
      <div className={`progress-bar${indeterminate ? ' indeterminate' : ''}`}>
        <div
          className={`progress-fill${phase === 'downloading' ? ' done' : ''}`}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
      {phase === 'fetching' && (
        <div className="export-current muted small" title={currentName || ''}>
          {currentName ? currentName : (indeterminate ? 'Waiting for server…' : ' ')}
        </div>
      )}
    </div>
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

// ── Memoized sub-components ───────────────────────────────────────────────────

// One checkbox row. `checked` is a plain boolean → React.memo bails out for
// every row whose checked state didn't change on a given toggle.
const QuestionRow = React.memo(function QuestionRow({ id, label, isStatus, checked, onToggleQuestion }) {
  const handleChange = useCallback(() => onToggleQuestion(id), [onToggleQuestion, id]);
  return (
    <li className={`policy-q${isStatus ? ' status-q' : ''}`}>
      <label>
        <input type="checkbox" checked={checked} onChange={handleChange} />
        <span className="policy-q-label" title={label}>{label}</span>
      </label>
    </li>
  );
});

// PolicyCard bails out when neither the selection state scalars nor the
// collapsed flag changed. selectedArtifactIds is intentionally excluded from
// the comparator: onCount already changes whenever a question in this policy
// is toggled, so it is a reliable proxy for "re-render needed".
function policyCardPropsEqual(prev, next) {
  return (
    prev.policy === next.policy &&
    prev.pState === next.pState &&
    prev.onCount === next.onCount &&
    prev.collapsed === next.collapsed &&
    prev.onToggleCollapsed === next.onToggleCollapsed &&
    prev.onSetPolicySelection === next.onSetPolicySelection &&
    prev.onSetSectionSelection === next.onSetSectionSelection &&
    prev.onToggleQuestion === next.onToggleQuestion
  );
}

const PolicyCard = React.memo(function PolicyCard({
  policy, pState, onCount, collapsed,
  onToggleCollapsed, onSetPolicySelection, onSetSectionSelection, onToggleQuestion,
  selectedArtifactIds,
}) {
  const totalQ = artifactIdsForPolicy(policy).length;
  const isSelected = (id) => selectedArtifactIds === null ? true : selectedArtifactIds.has(id);
  const sectionState = (sec) => {
    if (selectedArtifactIds === null) return 'all';
    let on = 0;
    for (const q of sec.questions) if (selectedArtifactIds.has(q.id)) on++;
    if (on === 0) return 'none';
    if (on === sec.questions.length) return 'all';
    return 'some';
  };
  return (
    <section className={`policy-card${pState === 'none' ? ' off' : ''}${collapsed ? ' collapsed' : ''}`}>
      <header className="policy-card-head">
        <Tristate
          state={pState}
          onChange={(target) => onSetPolicySelection(policy, target)}
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
          onClick={() => onToggleCollapsed(policy.id)}
          aria-label={collapsed ? `Expand ${policy.name}` : `Collapse ${policy.name}`}
          aria-expanded={!collapsed}
        >
          <span className="caret">▾</span>
        </button>
      </header>
      {!collapsed && (
        <div className="policy-card-body">
          {policy.stages.map((stage, stageIdx) => (
            <div className="stage-card" key={stage.id || stageIdx}>
              <div className="stage-head">
                <span className="stage-label">STAGE {stageIdx + 1}</span>
                <span className="stage-name" title={stage.name}>{stage.name}</span>
              </div>
              <div className="stage-body">
                {stage.sections.map((sec, secIdx) => {
                  const sState = sectionState(sec);
                  const total = sec.questions.length;
                  const sOn = selectedArtifactIds === null
                    ? total
                    : sec.questions.filter((q) => selectedArtifactIds.has(q.id)).length;
                  return (
                    <div
                      key={secIdx}
                      className={`section-card section-${sec.kind}${sState === 'none' ? ' off' : ''}`}
                    >
                      <div className="section-head">
                        <Tristate
                          state={sState}
                          onChange={(target) => onSetSectionSelection(sec, target)}
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
                          <QuestionRow
                            key={q.id}
                            id={q.id}
                            label={q.label}
                            isStatus={!!q.isStatus}
                            checked={isSelected(q.id)}
                            onToggleQuestion={onToggleQuestion}
                          />
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
        </div>
      )}
    </section>
  );
}, policyCardPropsEqual);

export default function App() {
  // ── Server state ──────────────────────────────────────────────────────────
  const numCols = useColumnCount();

  // metaReady flips first (projects + bundles arrive together, fast); then
  // policiesReady flips when policy definitions land. The picker uses both
  // signals to drive distinct loading visuals.
  const [projects, setProjects] = useState([]);
  const [bundles, setBundles] = useState([]);
  const [serverPolicies, setServerPolicies] = useState([]);
  const [metaReady, setMetaReady] = useState(false);
  const [policiesReady, setPoliciesReady] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // Evidence is fetched at export time only — see handleExport.
  const evidenceCacheRef = useRef(new Map());

  // ── User selections ────────────────────────────────────────────────────────
  const [selectedProjectIds, setSelectedProjectIds] = useState(() => new Set());
  // null = "every question selected" sentinel; first interaction materializes
  // to a real Set so we don't have to enumerate every question id up front.
  const [selectedArtifactIds, setSelectedArtifactIds] = useState(null);
  const [projectSearch, setProjectSearch] = useState('');
  const debouncedSearch = useDebounced(projectSearch, 120);
  const [collapsedPolicies, setCollapsedPolicies] = useState(() => new Set());
  const togglePolicyCollapsed = useCallback((id) => setCollapsedPolicies((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  }), []);
  const collapseAllPolicies = () => setCollapsedPolicies(new Set(policies.map((p) => p.id)));
  const expandAllPolicies = () => setCollapsedPolicies(new Set());

  // ── Export state ───────────────────────────────────────────────────────────
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState({
    phase: 'fetching', done: 0, total: 0, failed: 0, currentName: '', startedAt: 0,
  });
  const [exportError, setExportError] = useState(null);
  const [lastExport, setLastExport] = useState(null);

  // ── Theme ─────────────────────────────────────────────────────────────────
  const [theme, setTheme] = useState(() => themeStore.effective());
  const toggleTheme = () => setTheme(themeStore.toggle());

  // Click outside any open .proj-filter <details> closes it. Native <details>
  // doesn't do this on its own, and the two dropdowns share the same class
  // so one listener covers both (and any future ones).
  useEffect(() => {
    const onPointerDown = (e) => {
      if (e.target.closest && e.target.closest('.proj-filter')) return;
      document.querySelectorAll('.proj-filter[open]').forEach((d) => {
        d.removeAttribute('open');
      });
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  // ── Presets (localStorage) ────────────────────────────────────────────────
  const [presets, setPresets] = useState(() => presetStore.readAll());
  const [presetName, setPresetName] = useState('');
  const [presetMsg, setPresetMsg] = useState('');
  const saveCurrentPreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const payload = {
      name,
      projectIds: Array.from(selectedProjectIds),
      artifactIds: selectedArtifactIds === null ? null : Array.from(selectedArtifactIds),
    };
    const list = presetStore.save(payload);
    setPresets(list);
    setPresetName('');
    setPresetMsg(`Saved "${name}"`);
    setTimeout(() => setPresetMsg(''), 2000);
  };
  const applyPreset = (preset) => {
    if (!preset) return;
    setSelectedProjectIds(new Set(Array.isArray(preset.projectIds) ? preset.projectIds : []));
    setSelectedArtifactIds(preset.artifactIds === null ? null : new Set(preset.artifactIds || []));
    setPresetMsg(`Applied "${preset.name}"`);
    setTimeout(() => setPresetMsg(''), 2000);
  };
  const deletePreset = (name) => setPresets(presetStore.remove(name));
  const clearAllPresets = () => {
    if (!presets.length) return;
    if (typeof window !== 'undefined'
        && !window.confirm(`Remove all ${presets.length} saved preset${presets.length === 1 ? '' : 's'}?`)) {
      return;
    }
    presetStore.clearAll();
    setPresets([]);
    setPresetMsg('Cleared all presets');
    setTimeout(() => setPresetMsg(''), 2000);
  };

  // ── Load (progressive stream) ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setProjects([]);
    setBundles([]);
    setServerPolicies([]);
    setMetaReady(false);
    setPoliciesReady(false);
    evidenceCacheRef.current = new Map();
    load({
      onMeta: ({ projects, bundles }) => {
        if (cancelled) return;
        setProjects(projects || []);
        setBundles(bundles || []);
        setMetaReady(true);
      },
      onPolicies: ({ policies }) => {
        if (cancelled) return;
        setServerPolicies(policies || []);
        setPoliciesReady(true);
      },
      onError: ({ stage, detail }) => {
        if (cancelled) return;
        setLoadError(`${stage || 'load'}: ${detail || 'unknown error'}`);
      },
    });
    return () => { cancelled = true; };
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────────
  const policies = useMemo(
    () => buildPolicyOutlines(serverPolicies, bundles),
    [serverPolicies, bundles],
  );

  // Pre-computed flat list of all artifact ids — kept in a ref so the selection
  // state updaters can read it without closing over `policies`, which lets
  // toggleQuestion/set*Selection be stable useCallback([]) instances.
  const allArtifactIdsRef = useRef([]);
  useMemo(() => { allArtifactIdsRef.current = flattenArtifactIds(policies); }, [policies]);

  // Distribute policies into columns round-robin so cards never reorder when
  // a card is expanded — each card stays in its assigned column forever.
  const policyColumns = useMemo(() => {
    const cols = Array.from({ length: numCols }, () => []);
    policies.forEach((p, i) => cols[i % numCols].push(p));
    return cols;
  }, [policies, numCols]);

  // policyArtifactIds and effectiveBundles must be available to every other
  // bundle-derived memo below. Defined here so the bundle counts in the
  // masthead, project filter, and exportable scope all share one base set.
  const policyArtifactIds = useMemo(() => {
    const m = new Map();
    for (const p of policies) m.set(p.id, new Set(artifactIdsForPolicy(p)));
    return m;
  }, [policies]);

  const effectiveBundles = useMemo(() => {
    if (!policiesReady) return bundles;
    if (policyArtifactIds.size === 0) return [];
    return bundles.filter((b) => {
      const refs = (b.policies && b.policies.length)
        ? b.policies
        : (b.policyId ? [{ policyId: b.policyId }] : []);
      for (const r of refs) if (r && policyArtifactIds.has(r.policyId)) return true;
      return false;
    });
  }, [bundles, policyArtifactIds, policiesReady]);

  const { bundleCountByProject, projectsWithBundles } = useMemo(() => {
    const byProj = new Map();
    for (const b of effectiveBundles) {
      const pid = b.projectId || (b.project && b.project.id) || '';
      byProj.set(pid, (byProj.get(pid) || 0) + 1);
    }
    let withBundles = 0;
    for (const count of byProj.values()) if (count > 0) withBundles++;
    return { bundleCountByProject: byProj, projectsWithBundles: withBundles };
  }, [effectiveBundles]);

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
  // A policy "counts as selected" if at least one of its questions is selected.
  const selectedPolicyCount = useMemo(() => {
    if (selectedCount === 0) return 0;
    if (selectedArtifactIds === null) return policies.length;
    let n = 0;
    for (const p of policies) {
      for (const id of artifactIdsForPolicy(p)) {
        if (selectedArtifactIds.has(id)) { n++; break; }
      }
    }
    return n;
  }, [policies, selectedArtifactIds, selectedCount]);
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

  const toggleQuestion = useCallback((id) => {
    setSelectedArtifactIds((prev) => {
      const next = new Set(prev === null ? allArtifactIdsRef.current : prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);
  const setPolicySelection = useCallback((policy, target) => {
    setSelectedArtifactIds((prev) => {
      const next = new Set(prev === null ? allArtifactIdsRef.current : prev);
      const ids = artifactIdsForPolicy(policy);
      if (target === 'all') for (const id of ids) next.add(id);
      else for (const id of ids) next.delete(id);
      return next;
    });
  }, []);
  const setSectionSelection = useCallback((section, target) => {
    setSelectedArtifactIds((prev) => {
      const next = new Set(prev === null ? allArtifactIdsRef.current : prev);
      const ids = artifactIdsForSection(section);
      if (target === 'all') for (const id of ids) next.add(id);
      else for (const id of ids) next.delete(id);
      return next;
    });
  }, []);
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
    if (selectedProjectIds.size === 0) return effectiveBundles;
    return effectiveBundles.filter((b) => {
      const pid = b.projectId || (b.project && b.project.id) || '';
      return selectedProjectIds.has(pid);
    });
  }, [effectiveBundles, selectedProjectIds]);

  const bundlePolicyIds = useMemo(() => {
    // bundle.id -> Set<policyId> from the bundle's policies[] refs (or the
    // legacy top-level policyId).
    const m = new Map();
    for (const b of effectiveBundles) {
      const bid = b.id || b._id;
      if (!bid) continue;
      const set = new Set();
      const refs = (b.policies && b.policies.length) ? b.policies : (b.policyId ? [{ policyId: b.policyId }] : []);
      for (const r of refs) if (r && r.policyId) set.add(r.policyId);
      m.set(bid, set);
    }
    return m;
  }, [effectiveBundles]);

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
  // phase: 'fetching' | 'building' | 'downloading' — drives the action-bar UI.
  const handleExport = async () => {
    if (exportable.length === 0 || questionCols.length === 0) return;
    setExporting(true);
    setExportError(null);
    setLastExport(null);
    setProgress({
      phase: 'fetching',
      done: 0,
      total: exportable.length,
      failed: 0,
      currentName: '',
      startedAt: Date.now(),
    });

    const exportedAt = isoStamp();
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const accept = (id) => isQuestionSelected(id);
    const rows = [];
    const failures = new Map(); // bundleId -> error detail
    // Cap update frequency so we don't trigger a render per arrival on huge
    // exports — once every animation frame is enough for a smooth bar.
    let pendingProgress = null;
    let rafScheduled = false;
    const flushProgress = () => {
      rafScheduled = false;
      if (pendingProgress) {
        setProgress(pendingProgress);
        pendingProgress = null;
      }
    };
    const scheduleProgress = (next) => {
      pendingProgress = next;
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flushProgress);
      }
    };

    try {
      const exportableIds = exportable.map((b) => b.id || b._id).filter(Boolean);
      const idsToFetch = exportableIds.filter((id) => !evidenceCacheRef.current.has(id));

      if (idsToFetch.length) {
        let fetched = 0;
        let failed = 0;
        let total = idsToFetch.length;
        const t0 = Date.now();
        await fetchEvidence(idsToFetch, {
          onStart: ({ total: t }) => {
            total = t || idsToFetch.length;
            scheduleProgress({
              phase: 'fetching', done: 0, total, failed: 0, currentName: '', startedAt: t0,
            });
          },
          onBundle: ({ id, name, computedList }) => {
            evidenceCacheRef.current.set(id, computedList || []);
            fetched++;
            scheduleProgress({
              phase: 'fetching', done: fetched + failed, total, failed,
              currentName: name || '', startedAt: t0,
            });
          },
          onBundleError: ({ id, name, detail }) => {
            failed++;
            failures.set(id, detail || 'fetch failed');
            scheduleProgress({
              phase: 'fetching', done: fetched + failed, total, failed,
              currentName: name || '', startedAt: t0,
            });
          },
        });
        // Make sure the last in-flight render is applied before moving on.
        flushProgress();
      }

      // Phase 2: build CSV rows.
      setProgress({
        phase: 'building', done: 0, total: exportable.length, failed: failures.size,
        currentName: '', startedAt: Date.now(),
      });

      let done = 0;
      let lastTick = performance.now();
      for (const bundle of exportable) {
        const id = bundle.id || bundle._id;
        const computedList = evidenceCacheRef.current.get(id) || [];
        const failure = failures.get(id);
        const meta = {
          exported_at_utc: exportedAt,
          ...bundleContext(bundle, projectsById),
          ...bundleComputedContext(computedList),
          ...bundlePolicyContext(computedList),
          export_error: failure || '',
        };
        rows.push({ meta, answers: bundleAnswers(computedList, accept) });
        done++;
        // Yield to the browser every ~32ms so the spinner can paint, but no
        // more often than that — saves render cost on large exports.
        if (performance.now() - lastTick > 32) {
          setProgress((prev) => ({ ...prev, done, currentName: bundle.name || '' }));
          await new Promise((r) => setTimeout(r, 0));
          lastTick = performance.now();
        }
      }
      setProgress((prev) => ({ ...prev, done, currentName: '' }));

      // Phase 3: write blob + trigger download.
      setProgress((prev) => ({ ...prev, phase: 'downloading' }));
      await new Promise((r) => setTimeout(r, 0));
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
        failed: failures.size,
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
  const ready = metaReady && policiesReady && !loadError;
  // Stats become visible once meta arrives (~0.5s) — bundle count and policy
  // count populate at different times during the stream.
  const showStats = metaReady && !loadError;
  // Masthead bundle count must match the "in scope" denominator. Both use
  // effectiveBundles, which equals bundles before policiesReady (so the
  // "X bundles found" loading hint still shows the raw count) and the
  // policy-viable subset after.
  const totalBundles = effectiveBundles.length;
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
          <div className="masthead-right">
            <div className="masthead-stat">
              <span className="stat-n">{showStats ? fmtNumber(projectsWithBundles) : '—'}</span>
              <span className="stat-l">projects</span>
              <span className="dot">·</span>
              <span className="stat-n">{showStats ? fmtNumber(totalBundles) : '—'}</span>
              <span className="stat-l">bundles</span>
              <span className="dot">·</span>
              <span className="stat-n">{policiesReady ? fmtNumber(policies.length) : '—'}</span>
              <span className="stat-l">policies</span>
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
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
        <div className="filter-dropdowns">
        <details className="proj-filter preset-menu">
          <summary>
            <span className="muted">Presets:</span>
            <span className="filter-value">
              {presets.length === 0 ? 'None saved' : `${fmtNumber(presets.length)} saved`}
            </span>
            <span className="caret">▾</span>
          </summary>
          <div className="proj-filter-body preset-body">
            <div className="preset-save-row">
              <input
                className="search"
                placeholder="Name this preset…"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveCurrentPreset(); }}
              />
              <button className="ghost" onClick={saveCurrentPreset} disabled={!presetName.trim()}>
                Save current
              </button>
            </div>
            <div className="proj-filter-list">
              {presets.length === 0 ? (
                <div className="muted center small">No saved presets yet.</div>
              ) : presets.map((p) => (
                <div className="preset-line" key={p.name}>
                  <button
                    className="preset-apply"
                    onClick={() => applyPreset(p)}
                    title={`Apply preset — ${p.projectIds.length} project${p.projectIds.length === 1 ? '' : 's'}, ${p.artifactIds === null ? 'all' : p.artifactIds.length} question${p.artifactIds && p.artifactIds.length === 1 ? '' : 's'}`}
                  >
                    {p.name}
                  </button>
                  <span className="muted small">
                    {p.projectIds.length || 'all'} proj · {p.artifactIds === null ? 'all' : p.artifactIds.length} q
                  </span>
                  <button
                    className="ghost preset-delete"
                    onClick={() => deletePreset(p.name)}
                    title="Delete preset"
                    aria-label={`Delete preset ${p.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="preset-foot">
              {presetMsg && <span className="preset-msg muted small">{presetMsg}</span>}
              <button
                className="ghost"
                onClick={clearAllPresets}
                disabled={presets.length === 0}
              >
                Clear all
              </button>
            </div>
          </div>
        </details>

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
        </div>

        <div className="filter-summary">
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
        {!policiesReady && !loadError ? (
          <div className="policy-empty loading">
            <span className="spin lg" />
            <div className="loading-text">
              {metaReady
                ? `Loading policies… (${fmtNumber(totalBundles)} bundles found)`
                : 'Loading projects and bundles…'}
            </div>
            <div className="loading-sub muted">
              {metaReady ? 'Fetching policy definitions in parallel.' : ''}
            </div>
          </div>
        ) : policies.length === 0 ? (
          <div className="policy-empty">No accessible policies found.</div>
        ) : (
          policyColumns.map((col, colIdx) => (
            <div key={colIdx} className="policy-col">
              {col.map((policy) => {
                const pState = policyState(policy);
                const totalQ = artifactIdsForPolicy(policy).length;
                const onCount = selectedArtifactIds === null
                  ? totalQ
                  : artifactIdsForPolicy(policy).filter((id) => selectedArtifactIds.has(id)).length;
                const collapsed = collapsedPolicies.has(policy.id);
                return (
                  <PolicyCard
                    key={policy.id}
                    policy={policy}
                    pState={pState}
                    onCount={onCount}
                    collapsed={collapsed}
                    onToggleCollapsed={togglePolicyCollapsed}
                    onSetPolicySelection={setPolicySelection}
                    onSetSectionSelection={setSectionSelection}
                    onToggleQuestion={toggleQuestion}
                    selectedArtifactIds={selectedArtifactIds}
                  />
                );
              })}
            </div>
          ))
        )}
      </main>

      <footer className="actionbar">
        <div className="actionbar-left">
          {exporting ? (
            <ExportProgress progress={progress} />
          ) : (
            <div className="estimate">
              <span><strong>{fmtNumber(selectedCount)}</strong> / {fmtNumber(totalQuestions)} question{totalQuestions === 1 ? '' : 's'}</span>
              {' '}·{' '}
              <span><strong>{fmtNumber(selectedPolicyCount)}</strong> / {fmtNumber(policies.length)} polic{policies.length === 1 ? 'y' : 'ies'}</span>
              {' '}·{' '}
              <span><strong>{fmtNumber(exportable.length)}</strong> bundle{exportable.length === 1 ? '' : 's'} in scope</span>
            </div>
          )}
          {lastExport && !exporting && (
            <div className="last-export muted">
              Saved <code>{lastExport.filename}</code> · {fmtNumber(lastExport.rows)} rows · {fmtNumber(lastExport.questions)} questions · {(lastExport.size / 1024).toFixed(1)} KB
              {lastExport.failed > 0 && (
                <> · <span className="warn">{fmtNumber(lastExport.failed)} failed (see <code>export_error</code> column)</span></>
              )}
            </div>
          )}
          {exportError && <div className="banner-err small">{exportError}</div>}
        </div>
        <button className="primary" disabled={exportDisabled} onClick={handleExport}>
          {exporting ? (
            <><span className="spin" /> {phaseLabel(progress.phase)}</>
          ) : (
            <>↓ Export governance evidence to CSV</>
          )}
          <span className="kbd">{(typeof navigator !== 'undefined' && navigator.platform.includes('Mac')) ? '⌘' : 'Ctrl'}↵</span>
        </button>
      </footer>
    </div>
  );
}
