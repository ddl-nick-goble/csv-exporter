// Streaming CSV builder + browser-side row construction.
//
// Output shape: one row per bundle. Metadata columns (fixed; not user-configurable)
// sit on the left, then one column per *selected* evidence question with the
// question label as the header. The selection is policy- and question-driven —
// see derivePolicyOutlines() and how App.jsx wires its picker to bundleAnswers().

// Fixed metadata column set. Always written, in this order.
export const META_COLUMNS = [
  'exported_at_utc',
  'project_name',
  'bundle_id',
  'bundle_name',
  'bundle_stage',
  'bundle_state',
  'bundle_classification',
  'bundle_created_at',
  'bundle_created_by',
  'policy_name',
  'policy_version',
  'latest_approval_action',
  'latest_approval_at',
  'latest_approver',
  'export_error',
];

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

// Per-bundle context derived from the list-level bundle.
export function bundleContext(bundle, projectsById) {
  const pid = bundle.projectId || attr(bundle, 'project', 'id') || '';
  const proj = projectsById.get(pid) || {};
  return {
    project_id: pid,
    project_name: proj.name || bundle.projectName || '',
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

// Attachment / findings / latest-approval columns from the compute-policy payloads.
// (Same join semantics as before: bundle-level fields are taken from the first
// payload that has them; approvals are union-merged and the most recent wins.)
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
    findings_count: String(findingsCount),
    findings_open_count: String(openFindings),
    latest_approval_action: latest.status || '',
    latest_approval_at: latest.updatedAt || '',
    latest_approver: userDisplay(latest.updatedBy) || approverNames,
  };
}

// Policy id/name/version joined across the multiple compute-policy payloads
// attached to a bundle.
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

// Render a result's artifactContent into a single CSV cell value.
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

// Walk every policy artifact (question) reachable from a stage, grouped by
// section. Order is intentional: evidence sections come first, then approval
// sections at the end of the stage — approvals gate the stage transition, so
// readers naturally consume the gate last. Each approval section is prepended
// with a synthetic "status" entry so the approval's outcome (Approved /
// PendingSubmission / Rejected / …) can be selected and exported alongside the
// approver's textual answers. Duplicates (same artifact id) are dropped within
// a stage so the outline doesn't repeat a question that the policy lists in
// multiple places.
function* iterStageSections(stage) {
  const seen = new Set();

  // Special artifact types (modelmetric, monitorcheck, scriptedCheck, file,
  // metadata) don't always populate details.label/name. The bare UUID is
  // useless as a column header, so fall back to the section name before id.
  const labelFor = (a, sectionName) => {
    const details = (a.details && typeof a.details === 'object') ? a.details : {};
    return stringify(details.label) ||
           stringify(details.name) ||
           sectionName ||
           (a.id || a.policyEntityId || '');
  };

  for (const ev of (stage.evidenceSet || [])) {
    const sectionName = ev.name || 'Evidence';
    const questions = [];
    for (const a of (ev.artifacts || [])) {
      const id = a.id || a.policyEntityId || '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      questions.push({ id, label: labelFor(a, sectionName), required: !!a.required });
    }
    if (questions.length) {
      yield { kind: 'evidence', name: sectionName, questions };
    }
  }

  for (const ap of (stage.approvals || [])) {
    const ev = (ap && ap.evidence) || {};
    const approvalName = ap.name || ev.name || 'Approval';
    const approvalKey = ap.policyEntityId || ap.id || approvalName;
    const statusId = `__status__::${approvalKey}`;
    const questions = [{
      id: statusId,
      label: `${approvalName} — approval status`,
      required: false,
      isStatus: true,
      approvalName,
    }];
    for (const a of (ev.artifacts || [])) {
      const id = a.id || a.policyEntityId || '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      questions.push({ id, label: labelFor(a, approvalName), required: !!a.required });
    }
    yield { kind: 'approval', name: approvalName, questions, approvalName };
  }
}

function policyOutline(policy) {
  const stages = [];
  for (const stage of (policy.stages || [])) {
    const sections = [];
    for (const sec of iterStageSections(stage)) sections.push(sec);
    if (sections.length) {
      stages.push({
        id: stage.policyEntityId || stage.id || stage.name || '',
        name: stage.name || 'Stage',
        sections,
      });
    }
  }
  return {
    id: policy.id,
    name: policy.name || '(unnamed policy)',
    status: (policy.status || policy.lifecycleStatus || '').toLowerCase(),
    version: '',
    bundleIds: new Set(),
    stages,
  };
}

// Build the picker outline list from server-fetched policy definitions plus
// the bundle list. Each outline gets its bundleIds populated from bundles[]
// whose bundle.policies[*].policyId or top-level policyId matches.
//
//   [{
//     id, name, version,
//     bundleIds: Set<string>,
//     stages: [{ id, name, sections: [{ kind, name, questions: [{id, label, required}] }] }],
//   }]
export function buildPolicyOutlines(policies, bundles) {
  const byId = new Map();
  for (const p of (policies || [])) {
    if (!p || !p.id) continue;
    byId.set(p.id, policyOutline(p));
  }
  // Attach bundle counts + take the version from a referencing bundle (all
  // bundles pin a specific version; first-seen wins for the displayed label).
  for (const b of (bundles || [])) {
    const bid = b.id || b._id;
    if (!bid) continue;
    const refs = (b.policies && b.policies.length) ? b.policies
                 : (b.policyId ? [{ policyId: b.policyId, policyVersion: b.policyVersion }] : []);
    for (const r of refs) {
      const outline = byId.get(r && r.policyId);
      if (!outline) continue;
      outline.bundleIds.add(bid);
      if (!outline.version && r.policyVersion) outline.version = r.policyVersion;
    }
  }
  const statusRank = { draft: 0, published: 1, archived: 2 };
  return [...byId.values()].sort((a, b) => {
    const sr = (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99);
    if (sr !== 0) return sr;
    return (a.name || '').localeCompare(b.name || '');
  });
}

// Collect { artifactId -> latestAnswerString } for the artifacts that pass
// isSelected. If isSelected is null/undefined, every answered artifact is kept.
// Synthetic "status" entries (q.isStatus) are resolved against the bundle's
// approvals[] by matching approval name and taking the most recent updatedAt.
export function bundleAnswers(computedList, isSelected) {
  const accept = typeof isSelected === 'function' ? isSelected : () => true;
  const out = {};
  for (const computed of (computedList || [])) {
    const policy = (computed && computed.policy) || {};
    const results = (computed && computed.results) || [];

    // approvals[] holds the current approval records; same name can appear
    // multiple times across history — pick the latest by updatedAt.
    const statusByName = new Map();
    for (const ap of (computed?.approvals || [])) {
      const name = ap && ap.name;
      if (!name) continue;
      const cur = statusByName.get(name);
      if (!cur || (ap.updatedAt || '').localeCompare(cur.updatedAt || '') > 0) {
        statusByName.set(name, ap);
      }
    }

    for (const stage of (policy.stages || [])) {
      for (const sec of iterStageSections(stage)) {
        for (const q of sec.questions) {
          if (!accept(q.id)) continue;
          if (q.isStatus) {
            const ap = statusByName.get(q.approvalName);
            const val = ap && ap.status ? String(ap.status) : '';
            if (q.id in out && !val) continue;
            out[q.id] = val;
            continue;
          }
          const latest = results.find((r) => r.artifactId === q.id && r.isLatest !== false);
          if (q.id in out && !latest) continue;
          out[q.id] = latest ? stringifyAnswer(latest.artifactContent) : (out[q.id] ?? '');
        }
      }
    }
  }
  return out;
}

// Two-pass CSV writer. metaCols is the fixed list of metadata column keys;
// questionCols is the ordered [{ id, label, header? }] of selected question
// columns (id looks up the per-bundle answer; header — falling back to label —
// is the CSV column heading).
export class CsvBuilder {
  constructor(metaCols, questionCols) {
    this.metaCols = metaCols;
    this.questionCols = questionCols;
  }
  // Returns the array of string parts (BOM + header row + data rows). Used
  // by build() and exposed separately so tests can assert against text
  // without needing a working Blob.text()/arrayBuffer() in their runtime.
  buildParts(bundleRows) {
    const headers = [...this.metaCols, ...this.questionCols.map((q) => q.header || q.label)];
    const parts = ['﻿', row(headers)];
    for (const b of bundleRows) {
      parts.push(row([
        ...this.metaCols.map((c) => b.meta[c] ?? ''),
        ...this.questionCols.map((q) => b.answers[q.id] ?? ''),
      ]));
    }
    return parts;
  }
  buildText(bundleRows) {
    return this.buildParts(bundleRows).join('');
  }
  build(bundleRows) {
    return new Blob(this.buildParts(bundleRows), { type: 'text/csv;charset=utf-8' });
  }
}
