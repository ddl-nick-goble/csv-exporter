// Light/dark theme state. Persisted to a cookie so it survives across
// Domino app restarts and different browser sessions, matching the
// durability of server-side user storage.
//
// Cookie: governance-exporter:theme  value: "light" | "dark"
// Expiry: 1 year rolling; SameSite=Lax; path=/

const COOKIE_KEY = 'governance-exporter:theme';

function readCookie() {
  try {
    const match = document.cookie.split('; ').find((r) => r.startsWith(COOKIE_KEY + '='));
    if (!match) return null;
    const v = match.split('=')[1];
    return v === 'light' || v === 'dark' ? v : null;
  } catch { return null; }
}

function writeCookie(theme) {
  try {
    const age = 365 * 24 * 60 * 60;
    document.cookie = `${COOKIE_KEY}=${theme}; max-age=${age}; path=/; SameSite=Lax`;
  } catch {}
}

// Effective theme: cookie choice (if any) > light default.
export function effective() {
  return readCookie() || 'light';
}

// Apply theme to <html>. Called by the inline boot script in index.html
// AND by React on toggle — exporting it keeps both paths in sync.
export function apply(theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}

export function setTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  writeCookie(t);
  apply(t);
  return t;
}

export function toggle() {
  return setTheme(effective() === 'dark' ? 'light' : 'dark');
}
