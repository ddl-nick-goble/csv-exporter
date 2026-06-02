// Streaming CSV builder + browser-side row construction.
//
// Output shape: ONE ROW PER BUNDLE. Metadata columns (configurable, in
// COLUMN_GROUPS) sit on the left. After them, one column per unique evidence
// question label across every exported bundle, with the question label as the
// header. Cells are the latest answer for that bundle, or empty if the bundle's
// policy doesn't include that question (or it was never answered).

export const COLUMN_GROUPS = [
  { id: 'project', label: 'Project', cols: ['project_id', 'project_name', 'project_owner', 'project_owner_username'] },
  { id: 'bundle', label: 'Bundle', cols: ['bundle_id', 'bundle_name', 'bundle_stage', 'bundle_state', 'bundle_classification', 'bundle_created_at', 'bundle_created_by', 'export_error'] },
  { id: 'policy', label: 'Policy', cols: ['policy_id', 'policy_name', 'policy_version'] },
  { id: 'refs', label: 'Attachments & findings', cols: ['attachment_count', 'attachment_names', 'attachment_ids', 'findings_count', 'findings_open_count'] },
  { id: 'approvals', label: 'Latest approval', cols: ['latest_approval_action', 'latest_approval_stage', 'latest_approval_at', 'latest_approver'] },
];
export const ALL_COLUMNS = ['exported_at_utc', ...COLUMN_GROUPS.flatMap((g) => g.cols)];
export const COLUMN_PRESETS = {
  audit: ['exported_at_utc', ...COLUMN_GROUPS.filter((g) => g.id !== 'refs').flatMap((g) => g.cols)],
  full: ALL_COLUMNS,
  minimal: ['exported_at_utc', 'project_name', 'bundle_name', 'bundle_stage'],
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

// Domino governance User objects expose {firstName, lastName, userName} — there
// is no top-level `name` field. Build a display name in that priority order.
function userDisplay(u) {
  if (!u || typeof u !== 'object') return '';
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.userName || '';
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

// Per-bundle context derived from the list-level bundle. Project + bundle
// metadata only — attachments, findings, approvals, and policy metadata come
// from the compute-policy payloads (see bundleComputedContext / bundlePolicyContext).
export function bundleContext(bundle, projectsById) {
  const pid = bundle.projectId || attr(bundle, 'project', 'id') || '';
  const proj = projectsById.get(pid) || {};
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
    bundle_created_by: userDisplay(bundle.createdBy),
  };
}

// Derive attachment / findings / latest-approval columns from the array of
// compute-policy payloads cached for a bundle. These fields are only available
// in the compute-policy response (and partly on the per-bundle GET endpoint).
//
// - bundle.attachments is repeated across each payload (it's bundle-level);
//   we take the first non-empty list.
// - findingsInfo.bundleFindingsCount is bundle-level too; pick the max we see.
// - approvals[] is per-policy; we union across payloads, then sort by
//   updatedAt and report the most recent.
export function bundleComputedContext(computedList) {
  const list = Array.isArray(computedList) ? computedList : [];
  let attachments = [];
  let findingsCount = 0;
  let openFindings = 0;
  const allApprovals = [];
  for (const c of list) {
    const b = (c && c.bundle) || {};
    if (!attachments.length && Array.isArray(b.attachments) && b.attachments.length) {
      attachments = b.attachments;
    }
    const fi = (c && c.findingsInfo) || {};
    if ((fi.bundleFindingsCount || 0) > findingsCount) findingsCount = fi.bundleFindingsCount;
    for (const flist of Object.values(fi.approvalFindingsMap || {})) {
      for (const f of (flist || [])) {
        const s = (f && f.status ? String(f.status) : '').toLowerCase();
        if (s && s !== 'resolved' && s !== 'closed' && s !== 'done') openFindings++;
      }
    }
    if (Array.isArray(c && c.approvals)) allApprovals.push(...c.approvals);
  }
  const sorted = allApprovals.slice().sort((a, b) =>
    (b.updatedAt || '').localeCompare(a.updatedAt || '')
  );
  const latest = sorted[0] || {};
  const approverNames = (latest.approvers || []).map((a) => a && a.name).filter(Boolean).join('|');
  return {
    attachment_count: String(attachments.length),
    attachment_names: attachments.map((a) => stringify(attr(a, 'identifier', 'name') || a.name)).join('|'),
    attachment_ids: attachments.map((a) => stringify(a && (a.id || a._id))).join('|'),
    findings_count: String(findingsCount),
    findings_open_count: String(openFindings),
    // status is the approval state ("PendingSubmission", "Approved", "Rejected" …);
    // there is no separate "action" field in this API.
    latest_approval_action: latest.status || '',
    latest_approval_stage: latest.name || '',
    latest_approval_at: latest.updatedAt || '',
    latest_approver: userDisplay(latest.updatedBy) || approverNames,
  };
}

// Bundles can have multiple policies attached (bundle.policies[]) and we fetch
// compute-policy for each. Join the per-policy ids/names/versions with '|' so
// the bundle row keeps a single value per column.
export function bundlePolicyContext(computedList) {
  const list = Array.isArray(computedList) ? computedList : [];
  const ids = [], names = [], versions = [];
  for (const c of list) {
    const policy = (c && c.policy) || {};
    const bundle = (c && c.bundle) || {};
    if (!policy.id) continue;
    ids.push(policy.id);
    names.push(policy.name || bundle.policyName || '');
    const match = (bundle.policies || []).find((p) => p && p.policyId === policy.id);
    versions.push((match && match.policyVersion) || bundle.policyVersion || '');
  }
  return {
    policy_id: ids.join('|'),
    policy_name: names.join('|'),
    policy_version: versions.join('|'),
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
  const visit = function* (artifacts) {
    for (const a of (artifacts || [])) {
      const key = a.id || a.policyEntityId || '';
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      yield a;
    }
  };
  for (const ap of (stage.approvals || [])) {
    yield* visit(ap.evidence && ap.evidence.artifacts);
  }
  for (const ev of (stage.evidenceSet || [])) {
    yield* visit(ev.artifacts);
  }
}

// Collect { questionLabel -> latestAnswerString } across every policy attached
// to a bundle. If the same label appears in multiple stages/policies, prefer
// a non-empty answer over an empty one (otherwise first-wins).
export function bundleAnswers(computedList) {
  const out = {};
  for (const computed of (computedList || [])) {
    const policy = (computed && computed.policy) || {};
    const results = (computed && computed.results) || [];
    for (const stage of (policy.stages || [])) {
      for (const artifact of iterStageArtifacts(stage)) {
        const details = (artifact.details && typeof artifact.details === 'object') ? artifact.details : {};
        const label = stringify(details.label) || stringify(details.name);
        if (!label) continue;
        const artifactId = artifact.id || '';
        const latest = artifactId
          ? results.find((r) => r.artifactId === artifactId && r.isLatest !== false)
          : null;
        const value = latest ? stringifyAnswer(latest.artifactContent) : '';
        if (!(label in out) || (value && !out[label])) {
          out[label] = value;
        }
      }
    }
  }
  return out;
}

// Two-pass CSV writer: collect per-bundle data, then finalize() emits the file
// once the full set of question columns is known.
export class CsvBuilder {
  constructor(metaColumns) {
    this.metaColumns = metaColumns;
    this.bundles = [];
    this.questionLabels = new Set();
  }
  addBundle(meta, answers) {
    const a = answers || {};
    for (const label of Object.keys(a)) this.questionLabels.add(label);
    this.bundles.push({ meta: meta || {}, answers: a });
  }
  get rowCount() {
    return this.bundles.length;
  }
  get questionCount() {
    return this.questionLabels.size;
  }
  finalize() {
    const sortedQuestions = [...this.questionLabels].sort((a, b) => a.localeCompare(b));
    const headers = [...this.metaColumns, ...sortedQuestions];
    const parts = [row(headers)];
    for (const b of this.bundles) {
      const cells = [
        ...this.metaColumns.map((c) => b.meta[c] ?? ''),
        ...sortedQuestions.map((q) => b.answers[q] ?? ''),
      ];
      parts.push(row(cells));
    }
    return new Blob(parts, { type: 'text/csv;charset=utf-8' });
  }
}

export { unwrapList };
