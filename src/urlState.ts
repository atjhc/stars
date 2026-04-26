// URL query-string round-trip for camera/focus state. Pure logic for the
// parse/serialize half; the wiring half (debounced writes, DOM history
// updates, reading the live scene) lives in initUrlState().

export interface UrlState {
  orbit?: { radius: number; phi: number; theta: number };
  focus?: string;
  toggles?: { labels?: boolean; grid?: boolean; constellations?: boolean; nebulae?: boolean };
  mag?: number;
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
// Matches stars.ts::DEFAULT_MAG_LIMIT — hardcoded here to keep
// urlState.ts import-free of scene modules.
const DEFAULT_MAG = 7.5;

// Short aliases for toggle params. We always write the short form;
// the long form is still accepted on parse for back-compat with old
// shareable URLs.
const TOGGLE_SHORT: Record<string, string> = {
  labels: "l", grid: "g", constellations: "c", nebulae: "n",
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
      const short = TOGGLE_SHORT[key];
      const val = (state.toggles as Record<string, boolean | undefined>)[key];
      // Strip any prior long-form leftover before writing the short.
      q.delete(key);
      q.delete(short);
      if (val !== undefined && val !== def) {
        q.set(short, val ? "1" : "0");
      }
    }
  }
  q.delete("mag");
  if (state.mag !== undefined && Math.abs(state.mag - DEFAULT_MAG) > 1e-6) {
    q.set("mag", fmt(state.mag));
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
    const short = TOGGLE_SHORT[key];
    const raw = q.get(short) ?? q.get(key);
    if (raw !== null) {
      (toggles as Record<string, boolean>)[key] = raw !== "0";
      hasToggle = true;
    }
  }
  if (hasToggle) result.toggles = toggles;

  const magRaw = q.get("mag");
  if (magRaw !== null) {
    const n = parseFloat(magRaw);
    if (Number.isFinite(n)) result.mag = n;
  }

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
