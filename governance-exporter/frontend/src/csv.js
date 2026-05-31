// Streaming CSV builder + browser-side row construction.

export const COLUMN_GROUPS = [
  { id: 'project', label: 'Project', cols: ['project_id', 'project_name', 'project_owner', 'project_owner_username'] },
  { id: 'bundle', label: 'Bundle', cols: ['bundle_id', 'bundle_name', 'bundle_stage', 'bundle_state', 'bundle_classification', 'bundle_created_at', 'bundle_created_by'] },
  { id: 'policy', label: 'Policy', cols: ['policy_id', 'policy_name', 'policy_version', 'policy_stage'] },
  { id: 'evidence', label: 'Evidence', cols: ['evidence_id', 'artifact_id', 'artifact_type', 'question_label', 'answer_value', 'answer_type', 'is_required', 'is_latest'] },
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
    policy_id: bundle.policyId || attr(bundle, 'policy', 'id') || '',
    policy_name: bundle.policyName || attr(bundle, 'policy', 'name') || '',
    policy_version: bundle.policyVersion || attr(bundle, 'policy', 'version') || '',
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

// Normalize an evidence/results response into one row per evidence answer.
export function* evidenceRows(result, ctx, exportedAt) {
  const base = {
    exported_at_utc: exportedAt,
    ...ctx,
    policy_stage: result.policyEntityId || result.stage || '',
    evidence_created_at: result.createdAt || '',
    evidence_created_by: attr(result, 'createdBy', 'name') || attr(result, 'createdBy', 'userName') || '',
    evidence_created_by_id: attr(result, 'createdBy', 'id') || '',
    is_latest: result.isLatest === false ? 'false' : 'true',
  };

  const details = result.details;
  if (details && typeof details === 'object' && !Array.isArray(details) && ('label' in details || 'value' in details)) {
    yield {
      ...base,
      evidence_id: result.evidenceId || result.id || '',
      artifact_id: result.artifactId || '',
      artifact_type: result.artifactType || details.type || '',
      question_label: stringify(details.label),
      answer_value: stringify(details.value),
      answer_type: stringify(details.type),
      is_required: details.required ? 'true' : 'false',
    };
    return;
  }

  const content = result.artifactContent;
  let items = [];
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    items = Object.entries(content).filter(([, v]) => v && typeof v === 'object').map(([k, v]) => [k, v]);
  } else if (Array.isArray(content)) {
    items = content.filter((v) => v && typeof v === 'object').map((v) => [v.id || v.evidenceId || '', v]);
  }

  if (items.length === 0) {
    yield {
      ...base,
      evidence_id: result.id || '',
      artifact_id: result.artifactId || '',
      artifact_type: result.artifactType || '',
      question_label: '(no evidence details)',
      answer_value: '',
      answer_type: '',
      is_required: '',
    };
    return;
  }

  for (const [evId, item] of items) {
    const d = (item.details && typeof item.details === 'object') ? item.details : item;
    yield {
      ...base,
      evidence_id: evId || item.evidenceId || item.id || '',
      artifact_id: result.artifactId || item.artifactId || '',
      artifact_type: item.artifactType || d.type || '',
      question_label: stringify(d.label),
      answer_value: stringify(d.value),
      answer_type: stringify(d.type),
      is_required: d.required ? 'true' : 'false',
    };
  }
}

// Streaming CSV writer — append rows in order; finalize() returns the full Blob.
export class CsvBuilder {
  constructor(columns, metaLines = []) {
    this.columns = columns;
    this.parts = [];
    for (const line of metaLines) this.parts.push('# ' + line + '\n');
    this.parts.push(row(columns));
  }
  appendRow(rowObj) {
    this.parts.push(row(this.columns.map((c) => rowObj[c] ?? '')));
  }
  appendBundleResults(results, ctx, exportedAt) {
    if (!results.length) {
      const empty = { exported_at_utc: exportedAt, ...ctx };
      empty.question_label = '(no evidence)';
      this.appendRow(empty);
      return 1;
    }
    let n = 0;
    for (const result of results) {
      for (const ev of evidenceRows(result, ctx, exportedAt)) {
        this.appendRow(ev);
        n++;
      }
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
