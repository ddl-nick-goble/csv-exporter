// Streaming CSV builder + browser-side row construction.

export const COLUMN_GROUPS = [
  { id: 'project', label: 'Project', cols: ['project_id', 'project_name', 'project_owner', 'project_owner_username'] },
  { id: 'bundle', label: 'Bundle', cols: ['bundle_id', 'bundle_name', 'bundle_stage', 'bundle_state', 'bundle_classification', 'bundle_created_at', 'bundle_created_by'] },
  { id: 'policy', label: 'Policy', cols: ['policy_id', 'policy_name', 'policy_version', 'policy_stage'] },
  { id: 'evidence', label: 'Evidence', cols: ['evidence_id', 'evidence_name', 'artifact_id', 'artifact_type', 'question_label', 'answer_value', 'answer_type', 'is_required', 'is_visible', 'is_answered', 'is_latest'] },
  { id: 'provenance', label: 'Provenance', cols: ['evidence_created_at', 'evidence_created_by', 'evidence_created_by_id'] },
  { id: 'refs', label: 'Attachments & findings', cols: ['attachment_count', 'attachment_names', 'attachment_ids', 'findings_count', 'findings_open_count'] },
  { id: 'approvals', label: 'Latest approval', cols: ['latest_approval_action', 'latest_approval_stage', 'latest_approval_at', 'latest_approver'] },
];
export const ALL_COLUMNS = ['exported_at_utc', ...COLUMN_GROUPS.flatMap((g) => g.cols)];
export const COLUMN_PRESETS = {
  audit: ['exported_at_utc', ...COLUMN_GROUPS.filter((g) => g.id !== 'refs').flatMap((g) => g.cols)],
  full: ALL_COLUMNS,
  minimal: ['exported_at_utc', 'project_name', 'bundle_name', 'bundle_stage', 'question_label', 'answer_value', 'evidence_created_at'],
};

// CSV field escaping: wrap in quotes if the value contains a comma/quote/newline,
// and double any embedded quotes.
function escapeCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function row(cells) {
  return cells.map(escapeCell).join(',') + '\n';
}

function stringify(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(stringify).join('|');
  if (typeof v === 'object') return v.name || v.label || v.value || JSON.stringify(v);
  return String(v);
}

function attr(obj, ...path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = cur[k];
  }
  return cur == null ? '' : cur;
}

function unwrapList(data, keys = ['data', 'items', 'results']) {
  if (data == null) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object') {
    for (const k of keys) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}

// Build the per-bundle context dictionary that becomes part of every evidence row.
export function bundleContext(bundle, projectsById) {
  const pid = bundle.projectId || attr(bundle, 'project', 'id') || '';
  const proj = projectsById.get(pid) || {};
  const attachments = bundle.attachments || [];
  const findings = bundle.findings || [];
  const openFindings = findings.filter((f) => {
    const s = (f.status || '').toLowerCase();
    return s !== 'resolved' && s !== 'closed';
  }).length;
  const approvals = (bundle.stageApprovals || []).slice().sort((a, b) =>
    (b.timestamp || '').localeCompare(a.timestamp || '')
  );
  const latest = approvals[0] || {};
  return {
    project_id: pid,
    project_name: proj.name || bundle.projectName || '',
    project_owner: proj.owner_name || bundle.projectOwner || '',
    project_owner_username: proj.owner_username || '',
    bundle_id: bundle.id || bundle._id || '',
    bundle_name: bundle.name || '',
    bundle_stage: bundle.stage || '',
    bundle_state: attr(bundle, 'state', 'name') || bundle.state || '',
    bundle_classification: bundle.classificationValue || bundle.classification || '',
    bundle_created_at: bundle.createdAt || '',
    bundle_created_by: attr(bundle, 'createdBy', 'name') || attr(bundle, 'createdBy', 'userName') || '',
    // policy_id/name/version are set per-row from the computed payload, since a
    // bundle can have multiple policies attached.
    attachment_count: String(attachments.length),
    attachment_names: attachments.map((a) => stringify(a && a.name)).join('|'),
    attachment_ids: attachments.map((a) => stringify((a && (a.id || a._id)))).join('|'),
    findings_count: String(findings.length),
    findings_open_count: String(openFindings),
    latest_approval_action: latest.action || '',
    latest_approval_stage: latest.stage || '',
    latest_approval_at: latest.timestamp || '',
    latest_approver: attr(latest, 'approver', 'name') || '',
  };
}

// Render a result's artifactContent into a single CSV cell value. The shape
// varies by artifact type (string, primitive, object with .value, array, or a
// nested map of sub-answers).
function stringifyAnswer(content) {
  if (content == null) return '';
  if (typeof content === 'string' || typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) return content.map(stringify).join('|');
  if (typeof content === 'object') {
    if (content.value != null) return stringify(content.value);
    const entries = Object.entries(content).filter(([, v]) => v != null && v !== '');
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `${k}=${stringify(v)}`).join('|');
  }
  return String(content);
}

// Walk every policy artifact (question) reachable from a stage. Combines the
// artifacts referenced by approvals[].evidence and the stage-level evidenceSet[],
// de-duped by artifact id so a question that appears in both isn't double-counted.
function* iterStageArtifacts(stage) {
  const seen = new Set();
  const visit = function* (artifacts, ev) {
    for (const a of (artifacts || [])) {
      const key = a.id || a.policyEntityId || '';
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      yield { evidence: ev || {}, artifact: a };
    }
  };
  for (const ap of (stage.approvals || [])) {
    yield* visit(ap.evidence && ap.evidence.artifacts, ap.evidence);
  }
  for (const ev of (stage.evidenceSet || [])) {
    yield* visit(ev.artifacts, ev);
  }
}

// One row per policy question, left-joined with recorded results.
// `scope` filters which results are kept: 'latest' keeps only isLatest!=false;
// 'history' keeps all (one row per historical answer + an unanswered row only
// if no result of any kind exists for that artifact).
export function* policyArtifactRows(computed, ctx, exportedAt, scope = 'latest') {
  const policy = (computed && computed.policy) || {};
  const allResults = (computed && computed.results) || [];
  const policyMeta = {
    policy_id: policy.id || '',
    policy_name: policy.name || '',
    policy_version: policy.version || policy.policyVersion || '',
  };

  for (const stage of (policy.stages || [])) {
    const stageId = stage.policyEntityId || stage.id || '';
    const stageName = stage.name || stageId;
    for (const { evidence, artifact } of iterStageArtifacts(stage)) {
      const details = (artifact.details && typeof artifact.details === 'object') ? artifact.details : {};
      const base = {
        exported_at_utc: exportedAt,
        ...ctx,
        ...policyMeta,
        policy_stage: stageName,
        evidence_id: evidence.id || '',
        evidence_name: evidence.name || '',
        artifact_id: artifact.id || artifact.policyEntityId || '',
        artifact_type: artifact.artifactType || details.type || '',
        question_label: stringify(details.label) || stringify(details.name),
        answer_type: stringify(details.type),
        is_required: artifact.required ? 'true' : 'false',
        is_visible: artifact.visible === false ? 'false' : 'true',
      };

      const artifactId = artifact.id || '';
      let matches = artifactId
        ? allResults.filter((r) => r.artifactId === artifactId)
        : [];
      if (scope === 'latest') {
        matches = matches.filter((r) => r.isLatest !== false);
      }

      if (matches.length === 0) {
        yield {
          ...base,
          answer_value: '',
          is_answered: 'false',
          is_latest: '',
          evidence_created_at: '',
          evidence_created_by: '',
          evidence_created_by_id: '',
        };
        continue;
      }

      for (const r of matches) {
        yield {
          ...base,
          evidence_id: r.evidenceId || base.evidence_id,
          answer_value: stringifyAnswer(r.artifactContent),
          is_answered: 'true',
          is_latest: r.isLatest === false ? 'false' : 'true',
          evidence_created_at: r.createdAt || '',
          evidence_created_by: attr(r, 'createdBy', 'name') || attr(r, 'createdBy', 'userName') || '',
          evidence_created_by_id: attr(r, 'createdBy', 'id') || '',
        };
      }
    }
  }
}

// Streaming CSV writer — append rows in order; finalize() returns the full Blob.
export class CsvBuilder {
  constructor(columns) {
    this.columns = columns;
    this.parts = [row(columns)];
  }
  appendRow(rowObj) {
    this.parts.push(row(this.columns.map((c) => rowObj[c] ?? '')));
  }
  appendComputedPolicy(computed, ctx, exportedAt, scope = 'latest') {
    let n = 0;
    for (const ev of policyArtifactRows(computed, ctx, exportedAt, scope)) {
      this.appendRow(ev);
      n++;
    }
    if (n === 0) {
      // No policy artifacts at all (bundle has no policy or empty policy).
      this.appendRow({ exported_at_utc: exportedAt, ...ctx, question_label: '(no policy artifacts)' });
      return 1;
    }
    return n;
  }
  finalize() {
    return new Blob(this.parts, { type: 'text/csv;charset=utf-8' });
  }
  approxSize() {
    let n = 0;
    for (const p of this.parts) n += p.length;
    return n;
  }
}

export { unwrapList };
