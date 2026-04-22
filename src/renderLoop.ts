// Wake-on-demand rAF scheduler. Schedules a frame only when something
// is actively changing (input grace window, camera anim, label fade,
// tile fade) — otherwise the loop idles. Wake paths: bumpInput() from
// input handlers, kick() from programmatic state changes (animateTo,
// setLabelsDirty, tile-load completion), setAlwaysOn(true) for
// debug / bench modes that need continuous frames.

type StepFn = (now: number) => void;

let step: StepFn | null = null;
let rafHandle: number | null = null;
let alwaysOn = false;
let inputBumpUntil = 0;

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
