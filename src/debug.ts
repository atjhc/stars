// Debug mode: activated by URL query `?debug=1`.
//
// Provides a small on-screen panel and keyboard shortcuts for toggling
// rendering features and tuning numeric parameters. Toggle features
// listen via `onDebugChange(fn)`; scalar tuning is applied directly
// from the binding table below.

import { camera, target, orbitRadius, orbitPhi, orbitTheta, bloomPass } from "./scene.ts";
import { BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD } from "./constants.ts";
import { DEFAULT_MAG_LIMIT, setMagLimit } from "./starfield.ts";
import { makeCollapsible } from "./collapse.ts";
import { getSelectedSystem, getSelectedMesh } from "./systemStore.ts";
import type { Star } from "./types.ts";
import { setStatsPhaseImpl } from "./statsPhase.ts";

type ToggleKey =
  | "textureGlow"   // sample glow from a mipmapped texture instead of math
  | "bloom"         // composer bloom pass on/off
  | "flatStars"     // shade stars as flat color discs
  | "depthTest"     // depth test on star materials
  | "hitTargets";   // overlay label hit rects + star disc occluders

type ScalarKey =
  | "bloom_strength" | "bloom_radius" | "bloom_threshold"
  | "mag_limit";

interface DebugState {
  textureGlow: boolean;
  bloom: boolean;
  flatStars: boolean;
  depthTest: boolean;
  hitTargets: boolean;
  bloom_strength: number;
  bloom_radius: number;
  bloom_threshold: number;
  mag_limit: number;
}

const initialState: DebugState = {
  textureGlow: true,
  bloom: true,
  flatStars: false,
  depthTest: true,
  hitTargets: false,
  bloom_strength: BLOOM_STRENGTH,
  bloom_radius: BLOOM_RADIUS,
  bloom_threshold: BLOOM_THRESHOLD,
  mag_limit: DEFAULT_MAG_LIMIT,
};

const query = new URLSearchParams(window.location.search);
export const benchEnabled = query.get("bench") === "1";
// ?bench=1 implies debug mode — bench needs statsKit (created by
// initDebug) to collect samples.
export const debugEnabled = benchEnabled || query.get("debug") === "1";
export const debug: DebugState = { ...initialState };

const toggleListeners: Array<(key: ToggleKey, value: boolean) => void> = [];

export function onDebugChange(fn: (key: ToggleKey, value: boolean) => void) {
  toggleListeners.push(fn);
}

function notifyToggle(key: ToggleKey, value: boolean) {
  for (const fn of toggleListeners) fn(key, value);
  renderStatic();
}

const toggles: Array<{ shiftNum: number; label: string; prop: ToggleKey }> = [
  { shiftNum: 1, label: "texture glow", prop: "textureGlow" },
  { shiftNum: 2, label: "bloom", prop: "bloom" },
  { shiftNum: 3, label: "flat stars", prop: "flatStars" },
  { shiftNum: 4, label: "depth test", prop: "depthTest" },
  { shiftNum: 5, label: "hit targets", prop: "hitTargets" },
];

interface TuneBinding {
  downKey: string;
  upKey: string;
  prop: ScalarKey;
  label: string;
  section: "bloom" | "eye";
  step: number;
  min: number;
  max: number;
  apply: (value: number) => void;
}

const applyBloom = () => {
  bloomPass.strength = debug.bloom_strength;
  bloomPass.radius = debug.bloom_radius;
  bloomPass.threshold = debug.bloom_threshold;
};

const tuneBindings: TuneBinding[] = [
  { downKey: "[", upKey: "]", prop: "bloom_strength", label: "strength", section: "bloom", step: 0.1, min: 0, max: 3, apply: applyBloom },
  { downKey: ";", upKey: "'", prop: "bloom_radius", label: "radius", section: "bloom", step: 0.05, min: 0, max: 2, apply: applyBloom },
  { downKey: ",", upKey: ".", prop: "bloom_threshold", label: "threshold", section: "bloom", step: 0.02, min: 0, max: 1, apply: applyBloom },
  { downKey: "-", upKey: "=", prop: "mag_limit", label: "mag limit", section: "eye", step: 0.25, min: 2, max: 10, apply: setMagLimit },
];

let panel: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let staticEl: HTMLDivElement | null = null;
let cameraEl: HTMLDivElement | null = null;
let camLine: HTMLDivElement | null = null;
let tgtLine: HTMLDivElement | null = null;
let orbLine: HTMLDivElement | null = null;
let lastCamText = "";
let lastTgtText = "";
let lastOrbText = "";

// Stats panels — FPS / MS / MB. One visible at a time; click cycles.
// Adapted from stats.js (mrdoob) but draws bars from a history buffer
// instead of blitting, so the canvas width can stretch to whatever the
// debug panel's current width is without pixel-art distortion.
interface StatsPanel {
  dom: HTMLCanvasElement;
  update(value: number, maxValue: number): void;
}

function createStatsPanel(name: string, fg: string, bg: string): StatsPanel {
  const dpr = Math.round(window.devicePixelRatio || 1);
  const HEIGHT_CSS = 48;
  const TEXT_Y_CSS = 2;
  const GRAPH_Y_CSS = 15;
  const GRAPH_H_CSS = 30;
  const PAD_CSS = 3;
  const FONT_PX = 9;

  const canvas = document.createElement("canvas");
  canvas.style.cssText = `display:block;width:100%;height:${HEIGHT_CSS}px`;
  const ctx = canvas.getContext("2d")!;

  let min = Infinity;
  let max = 0;
  const history: Array<{ v: number; m: number }> = [];
  let measuredWidth = 0;

  function syncSize() {
    const wCss = canvas.clientWidth || 80;
    const targetW = wCss * dpr;
    const targetH = HEIGHT_CSS * dpr;
    if (canvas.width === targetW && canvas.height === targetH) return;
    canvas.width = targetW;
    canvas.height = targetH;
    ctx.font = `bold ${FONT_PX * dpr}px Helvetica,Arial,sans-serif`;
    ctx.textBaseline = "top";
    measuredWidth = wCss;
  }

  function draw() {
    syncSize();
    const W = canvas.width;
    const H = canvas.height;
    const TEXT_X = PAD_CSS * dpr;
    const TEXT_Y = TEXT_Y_CSS * dpr;
    const GRAPH_X = PAD_CSS * dpr;
    const GRAPH_Y = GRAPH_Y_CSS * dpr;
    const GRAPH_W = W - 2 * PAD_CSS * dpr;
    const GRAPH_H = GRAPH_H_CSS * dpr;

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = fg;
    const label = history.length > 0
      ? `${Math.round(history[history.length - 1]!.v)} ${name} (${Math.round(min)}-${Math.round(max)})`
      : name;
    ctx.fillText(label, TEXT_X, TEXT_Y);

    // Graph background — fg tinted to near-bg via 0.9 alpha overlay.
    ctx.fillStyle = fg;
    ctx.fillRect(GRAPH_X, GRAPH_Y, GRAPH_W, GRAPH_H);
    ctx.fillStyle = bg;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(GRAPH_X, GRAPH_Y, GRAPH_W, GRAPH_H);
    ctx.globalAlpha = 1;

    // One CSS-pixel bar per sample, right-aligned.
    ctx.fillStyle = fg;
    const maxBars = Math.max(1, Math.floor(GRAPH_W / dpr));
    const start = Math.max(0, history.length - maxBars);
    for (let i = start; i < history.length; i++) {
      const { v, m } = history[i]!;
      const barH = Math.min(GRAPH_H, Math.max(1, (v / m) * GRAPH_H));
      const x = GRAPH_X + (i - start) * dpr;
      ctx.fillRect(x, GRAPH_Y + GRAPH_H - barH, dpr, barH);
    }
  }

  function update(value: number, maxValue: number) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    history.push({ v: value, m: maxValue });
    const capacity = Math.max(1, measuredWidth - 2 * PAD_CSS);
    while (history.length > capacity) history.shift();
    draw();
  }

  return { dom: canvas, update };
}

interface SampleSummary {
  frames: number;
  seconds: number;
  fps_avg: number;
  mean_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  min_ms: number;
  max_ms: number;
  phases: Record<string, { calls: number; total_ms: number; per_frame_ms: number }>;
}

interface StatsKit {
  container: HTMLDivElement;
  begin(): void;
  end(): void;
  toggleSampling(): void;
  lastSummary(): SampleSummary | null;
  phase<T>(name: string, fn: () => T): T;
}

function createStatsKit(): StatsKit {
  const container = document.createElement("div");
  container.style.cssText = "margin-top:8px;cursor:pointer;display:block";

  const panels: StatsPanel[] = [
    createStatsPanel("FPS", "#0ff", "#002"),
    createStatsPanel("MS", "#0f0", "#020"),
  ];
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (memory) panels.push(createStatsPanel("MB", "#f08", "#201"));

  let mode = 0;
  const show = (i: number) => panels.forEach((p, idx) => { p.dom.style.display = idx === i ? "block" : "none"; });
  for (const p of panels) container.appendChild(p.dom);
  show(0);

  // Status line under the graph — only shows text while sampling.
  const statusEl = document.createElement("div");
  statusEl.style.cssText = "font:10px/1.3 monospace;color:#fc6;margin-top:2px;min-height:12px;cursor:default";
  container.appendChild(statusEl);

  // Eat mouse events so clicking the stats panel doesn't also toggle
  // the enclosing debug panel via makeCollapsible's mouseup handler.
  container.addEventListener("mousedown", (e) => e.stopPropagation());
  container.addEventListener("mouseup", (e) => {
    e.stopPropagation();
    mode = (mode + 1) % panels.length;
    show(mode);
  });

  let beginTime = performance.now();
  let prevTime = beginTime;
  let frames = 0;

  // Sampling: on toggle, collect every frame's MS reading into an array.
  // On second toggle, compute percentiles and dump to console. Lets the
  // user run a controlled 10-30s session (fly a path, zoom, hover),
  // then A/B against a stashed change with solid numbers instead of
  // watching the live graph jitter.
  let samples: number[] | null = null;
  let sampleStart = 0;
  // Per-phase timing accumulator. Populated only while sampling is on;
  // phase() is a straight passthrough otherwise so the instrumentation
  // costs nothing in production use.
  const phaseTotals = new Map<string, { calls: number; totalMs: number }>();

  let lastSummary: SampleSummary | null = null;

  function summarize(arr: number[], elapsed: number): SampleSummary {
    const sorted = [...arr].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const seconds = elapsed / 1000;
    const phases: SampleSummary["phases"] = {};
    for (const [name, data] of phaseTotals) {
      phases[name] = {
        calls: data.calls,
        total_ms: +data.totalMs.toFixed(2),
        per_frame_ms: +(data.totalMs / arr.length).toFixed(3),
      };
    }
    const summary: SampleSummary = {
      frames: arr.length,
      seconds: +seconds.toFixed(2),
      fps_avg: +(arr.length / seconds).toFixed(2),
      mean_ms: +mean.toFixed(3),
      p50_ms: +pct(0.5).toFixed(3),
      p95_ms: +pct(0.95).toFixed(3),
      p99_ms: +pct(0.99).toFixed(3),
      min_ms: +sorted[0]!.toFixed(3),
      max_ms: +sorted[sorted.length - 1]!.toFixed(3),
      phases,
    };
    // eslint-disable-next-line no-console
    console.log(
      `[stats sample] ${summary.frames} frames / ${summary.seconds}s — `
      + `fps=${summary.fps_avg} mean=${summary.mean_ms}ms p50=${summary.p50_ms}ms `
      + `p95=${summary.p95_ms}ms p99=${summary.p99_ms}ms `
      + `min=${summary.min_ms}ms max=${summary.max_ms}ms`,
    );
    // eslint-disable-next-line no-console
    console.table(summary);
    if (Object.keys(phases).length > 0) {
      // eslint-disable-next-line no-console
      console.table(phases);
    }
    return summary;
  }

  return {
    container,
    begin() { beginTime = performance.now(); },
    end() {
      const now = performance.now();
      const frameMs = now - beginTime;
      frames++;
      panels[1]!.update(frameMs, 200);
      if (samples !== null) samples.push(frameMs);
      if (now >= prevTime + 1000) {
        panels[0]!.update((frames * 1000) / (now - prevTime), 100);
        frames = 0;
        prevTime = now;
        if (memory) {
          panels[2]!.update(memory.usedJSHeapSize / 1048576, memory.jsHeapSizeLimit / 1048576);
        }
        if (samples !== null) {
          statusEl.textContent = `● sampling ${((now - sampleStart) / 1000).toFixed(0)}s / ${samples.length}f`;
        }
      }
    },
    toggleSampling() {
      if (samples === null) {
        samples = [];
        sampleStart = performance.now();
        phaseTotals.clear();
        statusEl.textContent = "● sampling 0s / 0f";
      } else {
        const elapsed = performance.now() - sampleStart;
        const arr = samples;
        samples = null;
        statusEl.textContent = "";
        if (arr.length > 0) lastSummary = summarize(arr, elapsed);
      }
    },
    lastSummary() { return lastSummary; },
    phase<T>(name: string, fn: () => T): T {
      if (samples === null) return fn();
      const t0 = performance.now();
      const result = fn();
      const elapsedMs = performance.now() - t0;
      const cur = phaseTotals.get(name);
      if (cur) { cur.calls++; cur.totalMs += elapsedMs; }
      else phaseTotals.set(name, { calls: 1, totalMs: elapsedMs });
      return result;
    },
  };
}

let statsKit: StatsKit | null = null;

function fmt(n: number) {
  if (n !== 0 && Math.abs(n) < 0.01) return n.toExponential(4);
  return n.toFixed(2);
}

const BUG_SVG = `
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <ellipse cx="12" cy="13" rx="5" ry="7"/>
    <line x1="12" y1="7" x2="12" y2="19"/>
    <circle cx="12" cy="5" r="1.8"/>
    <line x1="10.5" y1="4" x2="8" y2="2"/>
    <line x1="13.5" y1="4" x2="16" y2="2"/>
    <line x1="7" y1="10" x2="3" y2="8"/>
    <line x1="7" y1="13" x2="2.5" y2="13"/>
    <line x1="7" y1="16" x2="3" y2="18"/>
    <line x1="17" y1="10" x2="21" y2="8"/>
    <line x1="17" y1="13" x2="21.5" y2="13"/>
    <line x1="17" y1="16" x2="21" y2="18"/>
  </svg>
`;

function renderStatic() {
  if (!staticEl) return;
  const toggleLines = toggles
    .map((t) => {
      const on = debug[t.prop];
      const check = on ? "●" : "○";
      return `<div style="opacity:${on ? 1 : 0.5}">${check} Shift+${t.shiftNum}  ${t.label}</div>`;
    })
    .join("");
  const lineFor = (b: TuneBinding) =>
    `<div>${b.downKey} ${b.upKey}  ${b.label} = ${fmt(debug[b.prop])}</div>`;
  const bloomLines = tuneBindings.filter((b) => b.section === "bloom").map(lineFor).join("");
  const eyeLines = tuneBindings.filter((b) => b.section === "eye").map(lineFor).join("");
  staticEl.innerHTML =
    toggleLines +
    `<div style="margin-top:6px;opacity:0.7">bloom tuning:</div>${bloomLines}` +
    `<div style="margin-top:6px;opacity:0.7">eye:</div>${eyeLines}`;
}

function cameraStateText() {
  const cp = camera.position;
  return `cam ${fmt(cp.x)} ${fmt(cp.y)} ${fmt(cp.z)}\ntgt ${fmt(target.x)} ${fmt(target.y)} ${fmt(target.z)}\norb r=${fmt(orbitRadius)} φ=${fmt(orbitPhi)} θ=${fmt(orbitTheta)}`;
}

function cameraStateUrl() {
  const params = new URLSearchParams();
  params.set("debug", "1");
  const name = getSelectedSystem()?.name ?? (getSelectedMesh()?.userData as Star | undefined)?.name;
  if (name) params.set("name", name);
  params.set("r", fmt(orbitRadius));
  params.set("phi", fmt(orbitPhi));
  params.set("theta", fmt(orbitTheta));
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

function renderCamera() {
  if (!camLine || !tgtLine || !orbLine) return;
  // Skip DOM writes when text hasn't changed to preserve active selections
  const cp = camera.position;
  const ct = `cam  ${fmt(cp.x)}  ${fmt(cp.y)}  ${fmt(cp.z)}`;
  const tt = `tgt  ${fmt(target.x)}  ${fmt(target.y)}  ${fmt(target.z)}`;
  const ot = `orb  r=${fmt(orbitRadius)} φ=${fmt(orbitPhi)} θ=${fmt(orbitTheta)}`;
  if (ct !== lastCamText) { camLine.textContent = ct; lastCamText = ct; }
  if (tt !== lastTgtText) { tgtLine.textContent = tt; lastTgtText = tt; }
  if (ot !== lastOrbText) { orbLine.textContent = ot; lastOrbText = ot; }
}

// Bracket the frame's JS work — the MS panel reads ms spent between
// begin/end, giving a headroom reading (16.7ms budget at 60fps) rather
// than just FPS. No-ops when debug mode is off.
export function statsBegin() { statsKit?.begin(); }
export function statsEnd() { statsKit?.end(); }

// Programmatic sampling control — used by ?bench=1 for unattended runs.
// statsKit lazily initializes on initDebug (?debug=1), so these no-op
// when debug mode is off. Bench mode forces initDebug to run.
export function statsToggleSampling() { statsKit?.toggleSampling(); }
export function getLastSampleSummary() { return statsKit?.lastSummary() ?? null; }

// Phase timing — wraps a piece of the animate loop so its runtime
// accumulates into the current sample's per-phase totals. Zero cost
// when debug is off (?.phase is undefined → fn() runs directly via
// the statsKit's own pass-through when sampling is idle).
export function statsPhase<T>(name: string, fn: () => T): T {
  return statsKit ? statsKit.phase(name, fn) : fn();
}

// Per-frame refresh — only the live camera block rewrites, not the full panel.
export function tickDebug() {
  renderCamera();
}

// External re-render trigger — used when a tuned value (currently just
// mag_limit) is owned outside debug.ts and mutated on debug.*, so the
// panel body can be rebuilt without round-tripping through the local
// keyboard handler. No-op when the panel isn't live.
export function refreshDebugPanel() {
  if (!staticEl) return;
  renderStatic();
}

export function initDebug() {
  if (!debugEnabled) return;

  panel = document.createElement("div");
  panel.id = "debug-panel";
  panel.classList.add("collapsed");

  bodyEl = document.createElement("div");
  bodyEl.className = "debug-body";
  staticEl = document.createElement("div");
  cameraEl = document.createElement("div");
  camLine = document.createElement("div");
  tgtLine = document.createElement("div");
  orbLine = document.createElement("div");
  cameraEl.appendChild(camLine);
  cameraEl.appendChild(tgtLine);
  cameraEl.appendChild(orbLine);

  const copyBtn = document.createElement("span");
  copyBtn.className = "debug-copy";
  copyBtn.title = "Copy camera state";
  copyBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(cameraStateUrl());
    copyBtn.style.opacity = "1";
    setTimeout(() => { copyBtn.style.opacity = ""; }, 600);
  });

  const cameraHeader = document.createElement("div");
  cameraHeader.style.cssText = "margin-top:6px;opacity:0.7;display:inline";
  cameraHeader.textContent = "camera:";

  const headerRow = document.createElement("div");
  headerRow.appendChild(cameraHeader);
  headerRow.appendChild(copyBtn);

  bodyEl.appendChild(staticEl);
  bodyEl.appendChild(headerRow);
  bodyEl.appendChild(cameraEl);

  const bugIcon = document.createElement("div");
  bugIcon.className = "debug-bug";
  bugIcon.innerHTML = BUG_SVG;

  panel.appendChild(bodyEl);
  panel.appendChild(bugIcon);
  document.body.appendChild(panel);

  // FPS / MS / MB graphs — custom, full-width, crisp at any panel size.
  // Click cycles which panel is showing; its own handlers stopPropagation
  // so the debug panel's collapse click doesn't also fire.
  statsKit = createStatsKit();
  setStatsPhaseImpl((name, fn) => statsKit!.phase(name, fn));
  bodyEl.appendChild(statsKit.container);

  makeCollapsible(panel, "debug");

  renderStatic();
  renderCamera();

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;

    // Shift+number toggles — use e.code so it's layout-independent.
    if (e.shiftKey) {
      const match = /^Digit([1-9])$/.exec(e.code);
      const t = match ? toggles[Number(match[1]) - 1] : undefined;
      if (t) {
        (debug as Record<string, unknown>)[t.prop] = !debug[t.prop];
        notifyToggle(t.prop, debug[t.prop] as boolean);
        e.preventDefault();
        return;
      }
    }

    if (e.code === "KeyP" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      statsKit?.toggleSampling();
      e.preventDefault();
      return;
    }

    for (const b of tuneBindings) {
      // mag_limit is owned by main.ts so the -/= keys work even without
      // ?debug=1 and the value round-trips through the URL. The binding
      // stays in this table purely for its panel-display formatting.
      if (b.prop === "mag_limit") continue;
      if (e.key === b.downKey || e.key === b.upKey) {
        const dir = e.key === b.upKey ? 1 : -1;
        debug[b.prop] = Math.min(b.max, Math.max(b.min, debug[b.prop] + dir * b.step));
        b.apply(debug[b.prop]);
        renderStatic();
        e.preventDefault();
        return;
      }
    }
  });

}
