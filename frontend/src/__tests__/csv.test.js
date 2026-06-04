import { describe, expect, it } from 'vitest';

import {
  META_COLUMNS,
  bundleContext,
  bundleComputedContext,
  bundlePolicyContext,
  bundleAnswers,
  buildPolicyOutlines,
  CsvBuilder,
} from '../csv.js';

// ── bundleContext ────────────────────────────────────────────────────────────
describe('bundleContext', () => {
  it('joins bundle metadata with the project lookup', () => {
    const bundle = {
      id: 'b1',
      name: 'Cardio v1',
      stage: 'Planning',
      classificationValue: 'High',
      createdAt: '2026-06-01T00:00:00Z',
      createdBy: { firstName: 'Nick', lastName: 'Goble', userName: 'nick' },
      projectId: 'p1',
      state: { name: 'Active' },
    };
    const ctx = bundleContext(bundle, new Map([['p1', {
      name: 'Cardiovascular Research', owner_username: 'nick',
    }]]));
    expect(ctx).toMatchObject({
      project_id: 'p1',
      project_name: 'Cardiovascular Research',
      bundle_id: 'b1',
      bundle_name: 'Cardio v1',
      bundle_stage: 'Planning',
      bundle_state: 'Active',
      bundle_classification: 'High',
      bundle_created_by: 'Nick Goble',
    });
  });

  it('falls back to bundle.projectName when the project map misses', () => {
    const ctx = bundleContext(
      { id: 'b1', projectId: 'p1', projectName: 'inline-name', state: 'Active' },
      new Map(),
    );
    expect(ctx.project_name).toBe('inline-name');
    expect(ctx.bundle_state).toBe('Active');
  });

  it('uses userName when no first/last is set on createdBy', () => {
    const ctx = bundleContext(
      { id: 'b', createdBy: { userName: 'just-username' } },
      new Map(),
    );
    expect(ctx.bundle_created_by).toBe('just-username');
  });
});


// ── bundlePolicyContext ──────────────────────────────────────────────────────
describe('bundlePolicyContext', () => {
  it('joins policy names + versions across multiple computed payloads', () => {
    const ctx = bundlePolicyContext([
      {
        policy: { id: 'p1', name: 'EU AI Act' },
        bundle: { policies: [{ policyId: 'p1', policyVersion: '1.0' }] },
      },
      {
        policy: { id: 'p2', name: 'NIST AI RMF' },
        bundle: { policies: [{ policyId: 'p2', policyVersion: '2.1' }] },
      },
    ]);
    expect(ctx.policy_id).toBe('p1|p2');
    expect(ctx.policy_name).toBe('EU AI Act|NIST AI RMF');
    expect(ctx.policy_version).toBe('1.0|2.1');
  });

  it('skips entries with no policy id', () => {
    expect(bundlePolicyContext([{ policy: {} }, null])).toEqual({
      policy_id: '', policy_name: '', policy_version: '',
    });
  });
});


// ── bundleComputedContext ────────────────────────────────────────────────────
describe('bundleComputedContext', () => {
  it('picks the most recent approval across payloads', () => {
    const ctx = bundleComputedContext([
      { approvals: [{ status: 'PendingSubmission', updatedAt: '2026-01-01T00:00:00Z' }] },
      { approvals: [{ status: 'Approved', updatedAt: '2026-06-01T00:00:00Z',
                      updatedBy: { firstName: 'A', lastName: 'B' } }] },
    ]);
    expect(ctx.latest_approval_action).toBe('Approved');
    expect(ctx.latest_approval_at).toBe('2026-06-01T00:00:00Z');
    expect(ctx.latest_approver).toBe('A B');
  });

  it('counts open findings across payloads', () => {
    const ctx = bundleComputedContext([
      { findingsInfo: {
          bundleFindingsCount: 3,
          approvalFindingsMap: {
            a: [{ status: 'Open' }, { status: 'Resolved' }],
            b: [{ status: 'InReview' }],
          },
        },
      },
    ]);
    expect(ctx.findings_count).toBe('3');
    expect(ctx.findings_open_count).toBe('2');
  });
});


// ── bundleAnswers ────────────────────────────────────────────────────────────
describe('bundleAnswers', () => {
  const computedList = [{
    policy: {
      stages: [{
        evidenceSet: [{
          name: 'Planning',
          artifacts: [
            { id: 'a1', details: { label: 'Purpose' } },
            { id: 'a2', details: { label: 'Risks' } },
          ],
        }],
        approvals: [{
          name: 'Sign-off',
          policyEntityId: 'ap1',
          evidence: { artifacts: [] },
        }],
      }],
    },
    results: [
      { artifactId: 'a1', artifactContent: 'business problem text', isLatest: true },
      { artifactId: 'a2', artifactContent: { value: 'two-line risk text' }, isLatest: true },
    ],
    approvals: [
      { name: 'Sign-off', status: 'Approved', updatedAt: '2026-06-02T00:00:00Z' },
      { name: 'Sign-off', status: 'PendingSubmission', updatedAt: '2026-05-01T00:00:00Z' },
    ],
  }];

  it('returns the latest artifact answers for accepted ids', () => {
    const answers = bundleAnswers(computedList, () => true);
    expect(answers.a1).toBe('business problem text');
    expect(answers.a2).toBe('two-line risk text');
  });

  it('synthetic status entry picks the most recent approval', () => {
    const answers = bundleAnswers(computedList, () => true);
    expect(answers['__status__::ap1']).toBe('Approved');
  });

  it('skips artifacts the selector rejects', () => {
    const answers = bundleAnswers(computedList, (id) => id === 'a1');
    expect(answers).toHaveProperty('a1');
    expect(answers).not.toHaveProperty('a2');
  });
});


// ── buildPolicyOutlines ──────────────────────────────────────────────────────
describe('buildPolicyOutlines', () => {
  const policy = {
    id: 'p1',
    name: 'EU AI Act',
    stages: [{
      id: 's1', name: 'Stage 1',
      evidenceSet: [{
        name: 'Planning',
        artifacts: [{ id: 'a1', details: { label: 'Purpose' } }],
      }],
      approvals: [],
    }],
  };

  it('produces one outline per policy with questions intact', () => {
    const outlines = buildPolicyOutlines([policy], []);
    expect(outlines).toHaveLength(1);
    expect(outlines[0].stages[0].sections[0].questions[0].label).toBe('Purpose');
  });

  it('attaches bundle ids whose policies match', () => {
    const outlines = buildPolicyOutlines([policy], [
      { id: 'b1', policies: [{ policyId: 'p1', policyVersion: '1.0' }] },
      { id: 'b2', policies: [{ policyId: 'other' }] },
    ]);
    expect([...outlines[0].bundleIds]).toEqual(['b1']);
    expect(outlines[0].version).toBe('1.0');
  });

  it('drops policies whose every section has zero questions', () => {
    const empty = { id: 'p2', name: 'Empty', stages: [] };
    const outlines = buildPolicyOutlines([empty], []);
    expect(outlines).toEqual([]);
  });
});


// ── CsvBuilder ───────────────────────────────────────────────────────────────
describe('CsvBuilder', () => {
  it('writes headers, escapes cells with commas and quotes', () => {
    const builder = new CsvBuilder(['bundle_id', 'bundle_name'], [
      { id: 'a1', label: 'Purpose', header: 'Policy: Purpose' },
    ]);
    const text = builder.buildText([{
      meta: { bundle_id: 'b1', bundle_name: 'has, "comma"' },
      answers: { a1: 'one\ntwo' },
    }]);
    // Strip the UTF-8 BOM that buildText prepends for Excel compatibility.
    const [header, ...rest] = text.replace(/^\ufeff/, '').split('\n');
    expect(header).toBe('bundle_id,bundle_name,Policy: Purpose');
    expect(rest.join('\n')).toContain('"has, ""comma"""');
    expect(rest.join('\n')).toContain('"one\ntwo"');
  });

  it('falls back to label when no header is provided', () => {
    const builder = new CsvBuilder(['bundle_id'], [{ id: 'a1', label: 'Just Label' }]);
    const text = builder.buildText([{ meta: { bundle_id: 'b' }, answers: {} }]);
    expect(text.replace(/^\ufeff/, '').split('\n')[0]).toBe('bundle_id,Just Label');
  });
});


// ── META_COLUMNS sanity ──────────────────────────────────────────────────────
describe('META_COLUMNS', () => {
  it('is non-empty and contains the bundle id', () => {
    expect(META_COLUMNS.length).toBeGreaterThan(0);
    expect(META_COLUMNS).toContain('bundle_id');
  });
});
