// GPU phase timing via EXT_disjoint_timer_query_webgl2.
//
// Wall-clock CPU timing (statsPhase) misses GPU work — the JS side
// just queues commands and returns; the actual rasterization happens
// asynchronously. This module wraps a render call with a timer query
// so we can attribute frame-to-frame GPU cost between bloom, the scene
// pass, lensing, dust, etc.
//
// Queries don't read back synchronously: results are available a few
// frames later. drainGpuQueries() polls in-order and accumulates ready
// results into per-phase totals. flushGpuPhases() reports the totals.
//
// No-op when the extension isn't available (Safari without
// developer extensions, some headless contexts), so it's safe to
// leave the wrappers permanently in the render loop.

import type * as THREE from "three";

interface PendingQuery {
  name: string;
  query: WebGLQuery;
}

interface PhaseTotal {
  totalNs: number;
  calls: number;
}

let gl: WebGL2RenderingContext | null = null;
let ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
let enabled = false;
const pending: PendingQuery[] = [];
const totals = new Map<string, PhaseTotal>();

// Only one TIME_ELAPSED query can be active at a time per WebGL2
// context. Nested gpuPhase calls would silently drop the inner one;
// guard with a flag so a misuse is loud.
let active = false;

export function initGpuTimer(renderer: THREE.WebGLRenderer): boolean {
  const ctx = renderer.getContext();
  if (typeof WebGL2RenderingContext === "undefined" || !(ctx instanceof WebGL2RenderingContext)) {
    return false;
  }
  gl = ctx;
  const e = gl.getExtension("EXT_disjoint_timer_query_webgl2") as
    | { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
    | null;
  if (!e) return false;
  ext = e;
  enabled = true;
  return true;
}

export function gpuPhase<T>(name: string, fn: () => T): T {
  if (!enabled || active) return fn();
  const query = gl!.createQuery();
  if (!query) return fn();
  active = true;
  gl!.beginQuery(ext!.TIME_ELAPSED_EXT, query);
  try {
    return fn();
  } finally {
    gl!.endQuery(ext!.TIME_ELAPSED_EXT);
    pending.push({ name, query });
    active = false;
  }
}

// Drain ready queries front-to-back. Queries complete in submission
// order, so the first not-ready slot bails the loop. Disjoint events
// (GPU preemption) invalidate any query that was in flight; we drop
// affected queries silently — the tradeoff is occasional gaps in the
// sample, not bad data.
export function drainGpuQueries(): void {
  if (!enabled) return;
  while (pending.length > 0) {
    const p = pending[0]!;
    const ready = gl!.getQueryParameter(p.query, gl!.QUERY_RESULT_AVAILABLE);
    if (!ready) break;
    const disjoint = gl!.getParameter(ext!.GPU_DISJOINT_EXT);
    if (!disjoint) {
      const ns = gl!.getQueryParameter(p.query, gl!.QUERY_RESULT) as number;
      const t = totals.get(p.name) ?? { totalNs: 0, calls: 0 };
      t.totalNs += ns;
      t.calls += 1;
      totals.set(p.name, t);
    }
    gl!.deleteQuery(p.query);
    pending.shift();
  }
}

export function resetGpuPhases(): void {
  totals.clear();
}

export interface GpuPhaseSummary {
  per_frame_ms: number;
  total_ms: number;
  calls: number;
}

export function getGpuPhases(): Record<string, GpuPhaseSummary> {
  const out: Record<string, GpuPhaseSummary> = {};
  for (const [name, t] of totals) {
    out[name] = {
      per_frame_ms: t.calls ? t.totalNs / 1e6 / t.calls : 0,
      total_ms: t.totalNs / 1e6,
      calls: t.calls,
    };
  }
  return out;
}

export function isGpuTimerEnabled(): boolean {
  return enabled;
}

// Monkey-patch each pass's render method to wrap it in a timer query.
// Three.js's EffectComposer iterates passes and calls pass.render() in
// order, so wrapping at the pass level gives us a clean per-pass
// breakdown without modifying the composer itself. Names default to
// constructor.name (readable in dev; minified builds may need
// explicit overrides via the optional namesByCtor map).
export function wrapComposerPasses(
  composer: { passes: Array<{ render: (...args: unknown[]) => unknown }> },
  prefix: string,
  namesByCtor?: Record<string, string>,
): void {
  if (!enabled) return;
  for (const pass of composer.passes) {
    const ctorName = (pass.constructor as { name?: string }).name ?? "Pass";
    const label = `${prefix}.${namesByCtor?.[ctorName] ?? ctorName}`;
    const orig = pass.render.bind(pass);
    pass.render = function (...args: unknown[]) {
      return gpuPhase(label, () => orig(...args));
    };
  }
}
