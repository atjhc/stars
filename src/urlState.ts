// URL query-string round-trip for camera/focus state. Pure logic for the
// parse/serialize half; the wiring half (debounced writes, DOM history
// updates, reading the live scene) lives in initUrlState().

export interface UrlState {
  orbit?: { radius: number; phi: number; theta: number };
  focus?: string;
}

function fmt(n: number): string {
  // Use exponential notation for very small values (deep zoom)
  if (n !== 0 && Math.abs(n) < 0.01) return n.toExponential(4);
  return Number(n.toFixed(2)).toString();
}

export function serializeUrlState(state: UrlState, base?: URLSearchParams): URLSearchParams {
  const q = new URLSearchParams(base ?? "");
  if (state.orbit) {
    q.set("r", fmt(state.orbit.radius));
    q.set("phi", fmt(state.orbit.phi));
    q.set("theta", fmt(state.orbit.theta));
  }
  if (state.focus !== undefined) q.set("focus", state.focus);
  else q.delete("focus");
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
