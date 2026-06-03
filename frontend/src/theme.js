// Light/dark theme state. Persisted to localStorage; defaults to the OS
// preference via `prefers-color-scheme`.
//
// Compatibility contract (same posture as presets.js):
//   - Stored value is either the string "light" or "dark". Anything else is
//     ignored, and the effective theme falls back to system preference.
//   - Reading never throws (private-mode storage, quota errors, etc).

const STORAGE_KEY = 'governance-exporter:theme';

const safeStorage = () => {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch { return null; }
};

export function readStored() {
  const s = safeStorage();
  if (!s) return null;
  let v;
  try { v = s.getItem(STORAGE_KEY); } catch { return null; }
  return v === 'light' || v === 'dark' ? v : null;
}

function writeStored(theme) {
  const s = safeStorage();
  if (!s) return;
  try { s.setItem(STORAGE_KEY, theme); } catch {}
}

function systemPref() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Effective theme: stored choice (if any) > system preference.
export function effective() {
  return readStored() || systemPref();
}

// Apply theme to <html>. Called by the inline boot script in index.html
// AND by React on toggle — exporting it keeps both paths in sync.
export function apply(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}

export function setTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  writeStored(t);
  apply(t);
  return t;
}

export function toggle() {
  return setTheme(effective() === 'dark' ? 'light' : 'dark');
}
