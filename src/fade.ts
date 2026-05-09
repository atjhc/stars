// Self-contained 0..1 toggle-fade state. Each owner stores a FadeState,
// calls `setFadeTarget` to flip on/off, and `tickFade` once per frame to
// advance the animation. The state tracks its own previous tick time so
// callers don't have to plumb dt through their update path.
//
// `tickFade` returns true while animating — wire it through
// renderLoop.registerKeepFrame so the wake-on-demand loop stays alive
// for the duration of the fade.

export interface FadeState {
  current: number;
  target: number;
  lastTickMs: number;
}

export function makeFade(initial: 0 | 1): FadeState {
  return { current: initial, target: initial, lastTickMs: 0 };
}

export function setFadeTarget(s: FadeState, v: boolean): void {
  s.target = v ? 1 : 0;
}

// Force the fade to its endpoint without animating. Used at startup
// when restoring URL toggles — flickering fades on page load look
// like a glitch rather than a deliberate transition.
export function snapFade(s: FadeState, v: boolean): void {
  s.current = v ? 1 : 0;
  s.target = s.current;
  s.lastTickMs = 0;
}

export function tickFade(s: FadeState, durationMs = 400): boolean {
  if (s.current === s.target) {
    s.lastTickMs = 0;
    return false;
  }
  const now = performance.now();
  // Cap dt at ~2 frames so a fade kicked off from the wake-from-idle
  // frame still spans durationMs instead of snapping.
  const dt = s.lastTickMs > 0 ? Math.min(32, now - s.lastTickMs) : 16;
  s.lastTickMs = now;
  const step = dt / durationMs;
  if (s.current < s.target) s.current = Math.min(s.target, s.current + step);
  else s.current = Math.max(s.target, s.current - step);
  return true;
}
