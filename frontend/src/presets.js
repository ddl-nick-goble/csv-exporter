// Local preset storage. Lives in window.localStorage; survives reloads but is
// scoped to this browser. A preset captures the current picker selection so
// the user can switch between common export scopes (e.g. "EU AI Act only",
// "All HR bundles") without re-clicking every box.
//
// Compatibility contract:
//   - The storage key embeds a version: `STORAGE_KEY` below.
//   - Any read that fails parsing, lacks `version: SCHEMA_VERSION`, or has an
//     unexpected shape is treated as empty. The user is NEVER asked to clear
//     their cache by hand — a corrupted/old payload just behaves as "no
//     presets" and the next save writes a clean record.
//   - When the schema needs to change, bump SCHEMA_VERSION and either migrate
//     old keys in `readAll()` or accept the one-time silent reset.

const STORAGE_KEY = 'governance-exporter:presets';
const SCHEMA_VERSION = 1;

const safeStorage = () => {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch { return null; }
};

// Returns an array of preset objects. Always returns a plain array, never
// throws — corrupt or version-mismatched storage degrades to an empty list.
export function readAll() {
  const storage = safeStorage();
  if (!storage) return [];
  let raw;
  try { raw = storage.getItem(STORAGE_KEY); } catch { return []; }
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  if (parsed.version !== SCHEMA_VERSION) return [];
  const list = Array.isArray(parsed.presets) ? parsed.presets : [];
  // Defensive filter: only keep entries that have the expected shape.
  return list.filter(isValidPreset);
}

function isValidPreset(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.name !== 'string' || !p.name.trim()) return false;
  if (!Array.isArray(p.projectIds)) return false;
  if (p.artifactIds !== null && !Array.isArray(p.artifactIds)) return false;
  return true;
}

function writeAll(list) {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({
      version: SCHEMA_VERSION,
      presets: list,
    }));
    return true;
  } catch {
    return false;
  }
}

// Upsert by name. Returns the new full list (post-write).
export function save(preset) {
  if (!isValidPreset(preset)) return readAll();
  const list = readAll();
  const idx = list.findIndex((p) => p.name === preset.name);
  const stamped = { ...preset, savedAt: new Date().toISOString() };
  if (idx >= 0) list[idx] = stamped;
  else list.push(stamped);
  list.sort((a, b) => a.name.localeCompare(b.name));
  writeAll(list);
  return list;
}

export function remove(name) {
  const list = readAll().filter((p) => p.name !== name);
  writeAll(list);
  return list;
}

export function clearAll() {
  const storage = safeStorage();
  if (!storage) return;
  try { storage.removeItem(STORAGE_KEY); } catch {}
}
