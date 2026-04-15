// URL query-string round-trip for camera/focus state. Pure logic for the
// parse/serialize half; the wiring half (debounced writes, DOM history
// updates, reading the live scene) lives in initUrlState().

export interface UrlState {
  orbit?: { radius: number; phi: number; theta: number };
  focus?: string;
  toggles?: { labels?: boolean; grid?: boolean; constellations?: boolean; nebulae?: boolean };
}

function fmt(n: number): string {
  // Use exponential notation for very small values (deep zoom)
  if (n !== 0 && Math.abs(n) < 0.01) return n.toExponential(4);
  return Number(n.toFixed(2)).toString();
}

// Defaults: only write toggles that differ to keep URLs clean
const TOGGLE_DEFAULTS: Record<string, boolean> = {
  labels: true, grid: false, constellations: true, nebulae: true,
};

export function serializeUrlState(state: UrlState, base?: URLSearchParams): URLSearchParams {
  const q = new URLSearchParams(base ?? "");
  if (state.orbit) {
    q.set("r", fmt(state.orbit.radius));
    q.set("phi", fmt(state.orbit.phi));
    q.set("theta", fmt(state.orbit.theta));
  }
  if (state.focus !== undefined) q.set("focus", state.focus);
  else q.delete("focus");
  if (state.toggles) {
    for (const [key, def] of Object.entries(TOGGLE_DEFAULTS)) {
      const val = (state.toggles as Record<string, boolean | undefined>)[key];
      if (val !== undefined && val !== def) q.set(key, val ? "1" : "0");
      else q.delete(key);
    }
  }
  return q;
}

export function parseUrlState(search: string): UrlState {
  const q = new URLSearchParams(search);
  const result: UrlState = {};
  const focus = q.get("focus");
  if (focus) result.focus = focus;

  const keys = ["r", "phi", "theta"] as const;
  const raw = keys.map((k) => q.get(k));
  if (raw.every((v) => v !== null)) {
    const nums = raw.map((v) => parseFloat(v!));
    if (nums.every((n) => Number.isFinite(n))) {
      result.orbit = { radius: nums[0], phi: nums[1], theta: nums[2] };
    }
  }

  const toggles: UrlState["toggles"] = {};
  let hasToggle = false;
  for (const key of Object.keys(TOGGLE_DEFAULTS)) {
    if (q.has(key)) {
      (toggles as Record<string, boolean>)[key] = q.get(key) !== "0";
      hasToggle = true;
    }
  }
  if (hasToggle) result.toggles = toggles;
  return result;
}

// --- wiring ---

const WRITE_DELAY_MS = 400;

interface Wiring {
  getState: () => UrlState;
}

let wiring: Wiring | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writesEnabled = false;

function writeUrlNow(): void {
  if (!wiring || !writesEnabled) return;
  const base = new URLSearchParams(window.location.search);
  const q = serializeUrlState(wiring.getState(), base);
  const qs = q.toString();
  const url = `${window.location.pathname}${qs ? "?" + qs : ""}${window.location.hash}`;
  window.history.replaceState(null, "", url);
}

export function initUrlState(w: Wiring): void {
  wiring = w;
}

export function enableUrlWrites(): void {
  writesEnabled = true;
}

export function scheduleUrlWrite(): void {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writeUrlNow();
  }, WRITE_DELAY_MS);
}
