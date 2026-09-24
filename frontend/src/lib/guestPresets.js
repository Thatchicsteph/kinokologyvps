/**
 * Guest control presets — saved & recalled from the browser's localStorage,
 * per-device, like the panel-layout customization. A preset is a snapshot of
 * the four control values (speed, depth, stroke, sensation) plus the selected
 * pattern index. Nothing is sent to the server: presets are private to the
 * guest's own browser ("only visible to you, this browser remembers it").
 *
 * Presets are keyed under a single storage key holding an array of
 * { id, name, values: {speed, depth, stroke, sensation, pattern} }.
 */
const STORAGE_KEY = "kinkology_guest_presets_v1";
const MAX_PRESETS = 12;

function safeParse(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

export function loadPresets() {
  if (typeof localStorage === "undefined") return [];
  return safeParse(localStorage.getItem(STORAGE_KEY));
}

function persist(presets) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets.slice(0, MAX_PRESETS)));
  } catch (_) {
    /* quota / private mode — presets just won't persist */
  }
}

function makeId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Normalise a values object to the known numeric fields only. */
function cleanValues(values) {
  const num = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  return {
    speed: num(values?.speed),
    depth: num(values?.depth),
    stroke: num(values?.stroke),
    sensation: num(values?.sensation),
    pattern: num(values?.pattern),
  };
}

/** Save a new preset. Returns the updated list. Enforces MAX_PRESETS. */
export function savePreset(name, values) {
  const presets = loadPresets();
  if (presets.length >= MAX_PRESETS) {
    return { presets, error: `Preset limit reached (${MAX_PRESETS}). Delete one first.` };
  }
  const trimmed = (name || "").trim().slice(0, 40) || `Preset ${presets.length + 1}`;
  const next = [...presets, { id: makeId(), name: trimmed, values: cleanValues(values) }];
  persist(next);
  return { presets: next };
}

/** Delete a preset by id. Returns the updated list. */
export function deletePreset(id) {
  const next = loadPresets().filter((p) => p.id !== id);
  persist(next);
  return next;
}

/** Rename a preset by id. Returns the updated list. */
export function renamePreset(id, name) {
  const trimmed = (name || "").trim().slice(0, 40);
  if (!trimmed) return loadPresets();
  const next = loadPresets().map((p) => (p.id === id ? { ...p, name: trimmed } : p));
  persist(next);
  return next;
}
