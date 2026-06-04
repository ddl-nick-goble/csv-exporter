import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as themeStore from '../theme.js';

const KEY = 'governance-exporter:theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockSystemPref(prefersDark) {
  vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(prefers-color-scheme: dark)' ? prefersDark : false,
    media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

describe('theme', () => {
  it('falls back to system preference when nothing is stored', () => {
    mockSystemPref(true);
    expect(themeStore.effective()).toBe('dark');

    mockSystemPref(false);
    expect(themeStore.effective()).toBe('light');
  });

  it('stored value wins over system preference', () => {
    localStorage.setItem(KEY, 'dark');
    mockSystemPref(false);
    expect(themeStore.effective()).toBe('dark');
  });

  it('invalid stored value is ignored', () => {
    localStorage.setItem(KEY, 'rainbow');
    mockSystemPref(false);
    expect(themeStore.effective()).toBe('light');
  });

  it('setTheme persists and applies', () => {
    themeStore.setTheme('dark');
    expect(localStorage.getItem(KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('setTheme coerces non-"dark" to "light"', () => {
    themeStore.setTheme('rainbow');
    expect(localStorage.getItem(KEY)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('toggle flips effective theme', () => {
    mockSystemPref(false);
    expect(themeStore.toggle()).toBe('dark');
    expect(themeStore.toggle()).toBe('light');
    expect(themeStore.toggle()).toBe('dark');
  });

  it('readStored returns null on garbage', () => {
    localStorage.setItem(KEY, '{}');
    expect(themeStore.readStored()).toBeNull();
  });

  it('readStored returns the stored value when valid', () => {
    localStorage.setItem(KEY, 'light');
    expect(themeStore.readStored()).toBe('light');
  });
});
