import { beforeEach, describe, expect, it } from 'vitest';

import * as presetStore from '../presets.js';

const KEY = 'governance-exporter:presets';

beforeEach(() => {
  localStorage.clear();
});

describe('presets — round trip', () => {
  it('save then readAll returns the saved preset', () => {
    presetStore.save({ name: 'EU only', projectIds: ['p1', 'p2'], artifactIds: ['a1'] });
    const all = presetStore.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: 'EU only', projectIds: ['p1', 'p2'], artifactIds: ['a1'] });
    expect(all[0].savedAt).toBeTruthy();
  });

  it('save with null artifactIds preserves the "all selected" sentinel', () => {
    presetStore.save({ name: 'All', projectIds: [], artifactIds: null });
    expect(presetStore.readAll()[0].artifactIds).toBeNull();
  });

  it('upserts by name (no duplicates)', () => {
    presetStore.save({ name: 'p', projectIds: [], artifactIds: null });
    presetStore.save({ name: 'p', projectIds: ['x'], artifactIds: ['y'] });
    const all = presetStore.readAll();
    expect(all).toHaveLength(1);
    expect(all[0].projectIds).toEqual(['x']);
    expect(all[0].artifactIds).toEqual(['y']);
  });

  it('returns the list sorted by name', () => {
    presetStore.save({ name: 'zeta', projectIds: [], artifactIds: null });
    presetStore.save({ name: 'alpha', projectIds: [], artifactIds: null });
    expect(presetStore.readAll().map((p) => p.name)).toEqual(['alpha', 'zeta']);
  });

  it('remove drops only the named preset', () => {
    presetStore.save({ name: 'a', projectIds: [], artifactIds: null });
    presetStore.save({ name: 'b', projectIds: [], artifactIds: null });
    presetStore.remove('a');
    expect(presetStore.readAll().map((p) => p.name)).toEqual(['b']);
  });

  it('clearAll wipes the store', () => {
    presetStore.save({ name: 'a', projectIds: [], artifactIds: null });
    presetStore.clearAll();
    expect(presetStore.readAll()).toEqual([]);
  });
});


describe('presets — defensive reads (backwards-compat contract)', () => {
  it('returns [] when storage is empty', () => {
    expect(presetStore.readAll()).toEqual([]);
  });

  it('returns [] when stored JSON is corrupt', () => {
    localStorage.setItem(KEY, '{ not json');
    expect(presetStore.readAll()).toEqual([]);
  });

  it('returns [] when stored value has the wrong version', () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 999, presets: [
      { name: 'x', projectIds: [], artifactIds: null },
    ] }));
    expect(presetStore.readAll()).toEqual([]);
  });

  it('returns [] when stored value has no version field at all', () => {
    localStorage.setItem(KEY, JSON.stringify({ presets: [
      { name: 'x', projectIds: [], artifactIds: null },
    ] }));
    expect(presetStore.readAll()).toEqual([]);
  });

  it('filters out invalidly-shaped entries but keeps the valid ones', () => {
    localStorage.setItem(KEY, JSON.stringify({
      version: 1,
      presets: [
        { name: 'good', projectIds: [], artifactIds: null },
        { name: '', projectIds: [], artifactIds: null },          // empty name
        { name: 'bad-proj', projectIds: 'oops', artifactIds: null }, // wrong type
        { name: 'bad-art', projectIds: [], artifactIds: 'oops' },   // wrong type
        null,                                                       // garbage
      ],
    }));
    expect(presetStore.readAll().map((p) => p.name)).toEqual(['good']);
  });

  it('save with invalid shape silently returns the unchanged list', () => {
    presetStore.save({ name: 'real', projectIds: [], artifactIds: null });
    const result = presetStore.save({ name: '', projectIds: [], artifactIds: null });
    expect(result.map((p) => p.name)).toEqual(['real']);
  });
});
