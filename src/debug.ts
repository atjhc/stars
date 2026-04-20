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

type ToggleKey =
  | "textureGlow"   // sample glow from a mipmapped texture instead of math
  | "bloom"         // composer bloom pass on/off
  | "flatStars"     // shade stars as flat color discs
  | "depthTest"     // depth test on star materials
  | "directRender"; // bypass composer and render directly

type ScalarKey =
  | "bloom_strength" | "bloom_radius" | "bloom_threshold"
  | "mag_limit";

interface DebugState {
  textureGlow: boolean;
  bloom: boolean;
  flatStars: boolean;
  depthTest: boolean;
  directRender: boolean;
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
  directRender: false,
  bloom_strength: BLOOM_STRENGTH,
  bloom_radius: BLOOM_RADIUS,
  bloom_threshold: BLOOM_THRESHOLD,
  mag_limit: DEFAULT_MAG_LIMIT,
};

export const debugEnabled = new URLSearchParams(window.location.search).get("debug") === "1";
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
  { shiftNum: 5, label: "direct render", prop: "directRender" },
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

interface StatsKit {
  container: HTMLDivElement;
  begin(): void;
  end(): void;
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

  return {
    container,
    begin() { beginTime = performance.now(); },
    end() {
      const now = performance.now();
      frames++;
      panels[1]!.update(now - beginTime, 200);
      if (now >= prevTime + 1000) {
        panels[0]!.update((frames * 1000) / (now - prevTime), 100);
        frames = 0;
        prevTime = now;
        if (memory) {
          panels[2]!.update(memory.usedJSHeapSize / 1048576, memory.jsHeapSizeLimit / 1048576);
        }
      }
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

// Per-frame refresh — only the live camera block rewrites, not the full panel.
export function tickDebug() {
  renderCamera();
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

    for (const b of tuneBindings) {
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
