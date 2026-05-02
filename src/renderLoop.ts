// Wake-on-demand rAF scheduler. Schedules a frame only when something
// is actively changing (input grace window, camera anim, label fade,
// tile fade) — otherwise the loop idles. Wake paths: bumpInput() from
// input handlers, kick() from programmatic state changes (animateTo,
// setLabelsDirty, tile-load completion), setAlwaysOn(true) for
// debug / bench modes that need continuous frames.

import { qualityProfile } from "./quality.ts";

type StepFn = (now: number) => void;

let step: StepFn | null = null;
let rafHandle: number | null = null;
let alwaysOn = false;
let inputBumpUntil = 0;

// Mobile fps cap. Capping below the device's max keeps thermals down:
// each frame finishes well inside its 33 ms budget, the GPU sits idle
// for the rest. We pick a *dynamic* engagement: cap only when the
// device naturally runs faster than the cap, otherwise let it float at
// its natural rate. A static cap penalizes light frames (60 → 30 fps)
// without recovering anything from frames that are already over budget,
// so for variable workloads it lowers the average.
//
// Cap value is 32 ms (not 33.33), kept safely under the 60 Hz 2-vsync
// boundary — a cap exactly at 33.33 ms is randomly above or below the
// 2nd-vsync delta thanks to float jitter, and being just-above falls
// through to the 3rd vsync (50 ms = 20 fps).
const FPS_CAP_MS = qualityProfile.fpsCapMs;
let lastFrameTime = 0;

// Dynamic-cap state. `capActive` is the live decision: when true,
// frames running faster than FPS_CAP_MS get held back. We re-evaluate
// from a small window of recent rAF intervals — those reflect the
// device's natural cadence (browser fires rAF at vsync regardless of
// our skip logic; if work blocks main thread, the next rAF naturally
// falls on a later vsync).
let capActive = FPS_CAP_MS > 0;
let lastRafTime = 0;
const RAF_WINDOW = 12;
const recentRafIntervals: number[] = [];
// Hysteresis: engage when device is running clearly faster than cap;
// disengage when the natural rate is at or above the cap (so the cap
// would only add overhead).
const CAP_ENGAGE_BELOW_MS = FPS_CAP_MS - 8;
const CAP_DISENGAGE_AT_MS = FPS_CAP_MS - 2;

const keepFramePredicates: Array<() => boolean> = [];

export function startRenderLoop(stepFn: StepFn): void {
  step = stepFn;
  kick();
}

export function kick(): void {
  if (rafHandle !== null || !step) return;
  rafHandle = requestAnimationFrame(tick);
}

function tick(now: number): void {
  rafHandle = null;

  if (FPS_CAP_MS > 0) {
    if (lastRafTime > 0) {
      recentRafIntervals.push(now - lastRafTime);
      if (recentRafIntervals.length > RAF_WINDOW) recentRafIntervals.shift();
    }
    lastRafTime = now;
    if (recentRafIntervals.length === RAF_WINDOW) {
      // Median is robust to spike frames (tile load, GC). Below cap −8 ms
      // means the device clearly has headroom; above cap −2 ms means it's
      // already running at-or-below the cap rate naturally.
      const sorted = [...recentRafIntervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      if (!capActive && median < CAP_ENGAGE_BELOW_MS) capActive = true;
      else if (capActive && median > CAP_DISENGAGE_AT_MS) capActive = false;
    }

    // Skip the step if we're still inside the per-frame quantum, but
    // reschedule so the next vsync pulls us out. Wake conditions are
    // honored — the rAF still fires for keep-frame predicates.
    if (capActive && now - lastFrameTime < FPS_CAP_MS) {
      if (alwaysOn || needsAnotherFrame(now)) kick();
      return;
    }
  }

  lastFrameTime = now;
  step!(now);
  if (alwaysOn || needsAnotherFrame(now)) kick();
}

function needsAnotherFrame(now: number): boolean {
  if (now < inputBumpUntil) return true;
  for (const p of keepFramePredicates) {
    if (p()) return true;
  }
  return false;
}

export function registerKeepFrame(p: () => boolean): void {
  keepFramePredicates.push(p);
}

// Grace window after the last input event. Covers bursts (wheel inertia,
// touch drag) without kicking on every event, and lets layout settle
// after input stops.
const DEFAULT_INPUT_GRACE_MS = 300;
export function bumpInput(graceMs: number = DEFAULT_INPUT_GRACE_MS): void {
  const until = performance.now() + graceMs;
  if (until > inputBumpUntil) inputBumpUntil = until;
  kick();
}

export function setAlwaysOn(v: boolean): void {
  alwaysOn = v;
  if (v) kick();
}
