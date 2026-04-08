// Debug mode: activated by URL query `?debug=1`.
//
// Provides a small on-screen panel and keyboard shortcuts for toggling
// rendering features and tuning bloom parameters during visual bug
// investigations. Features listen via `onDebugChange(fn)` / `onBloomTune(fn)`.

import { camera, target, orbitRadius, orbitPhi, orbitTheta } from "./scene.ts";
import { BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD } from "./constants.ts";
import { makeCollapsible } from "./collapse.ts";

type ToggleKey =
  | "textureGlow"   // sample glow from a mipmapped texture instead of math
  | "bloom"         // composer bloom pass on/off
  | "flatStars"     // shade stars as flat color discs
  | "depthTest"     // depth test on star materials
  | "directRender"; // bypass composer and render directly

export interface BloomParams {
  strength: number;
  radius: number;
  threshold: number;
}

interface DebugState {
  textureGlow: boolean;
  bloom: boolean;
  flatStars: boolean;
  depthTest: boolean;
  directRender: boolean;
  bloom_strength: number;
  bloom_radius: number;
  bloom_threshold: number;
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
};

export const debugEnabled = new URLSearchParams(window.location.search).get("debug") === "1";
export const debug: DebugState = { ...initialState };

const toggleListeners: Array<(key: ToggleKey, value: boolean) => void> = [];
const bloomListeners: Array<(params: BloomParams) => void> = [];

export function onDebugChange(fn: (key: ToggleKey, value: boolean) => void) {
  toggleListeners.push(fn);
}

export function onBloomTune(fn: (params: BloomParams) => void) {
  bloomListeners.push(fn);
}

function notifyToggle(key: ToggleKey, value: boolean) {
  for (const fn of toggleListeners) fn(key, value);
  renderStatic();
}

function notifyBloom() {
  const params = {
    strength: debug.bloom_strength,
    radius: debug.bloom_radius,
    threshold: debug.bloom_threshold,
  };
  for (const fn of bloomListeners) fn(params);
  renderStatic();
}

const toggles: Array<{ shiftNum: number; label: string; prop: ToggleKey }> = [
  { shiftNum: 1, label: "texture glow", prop: "textureGlow" },
  { shiftNum: 2, label: "bloom", prop: "bloom" },
  { shiftNum: 3, label: "flat stars", prop: "flatStars" },
  { shiftNum: 4, label: "depth test", prop: "depthTest" },
  { shiftNum: 5, label: "direct render", prop: "directRender" },
];

// Bloom parameter bindings: key + step + clamp.
type BloomParam = "bloom_strength" | "bloom_radius" | "bloom_threshold";
interface BloomBinding {
  downKey: string;
  upKey: string;
  prop: BloomParam;
  label: string;
  step: number;
  min: number;
  max: number;
}

const bloomBindings: BloomBinding[] = [
  { downKey: "[", upKey: "]", prop: "bloom_strength", label: "strength", step: 0.1, min: 0, max: 3 },
  { downKey: ";", upKey: "'", prop: "bloom_radius", label: "radius", step: 0.05, min: 0, max: 2 },
  { downKey: ",", upKey: ".", prop: "bloom_threshold", label: "threshold", step: 0.02, min: 0, max: 1 },
];

let panel: HTMLDivElement | null = null;
let bodyEl: HTMLDivElement | null = null;
let staticEl: HTMLDivElement | null = null;
let cameraEl: HTMLDivElement | null = null;

function fmt(n: number) {
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
  const bloomLines = bloomBindings
    .map((b) => `<div>${b.downKey} ${b.upKey}  ${b.label} = ${fmt(debug[b.prop])}</div>`)
    .join("");
  staticEl.innerHTML =
    toggleLines +
    `<div style="margin-top:6px;opacity:0.7">bloom tuning:</div>${bloomLines}` +
    `<div style="margin-top:6px;opacity:0.7">camera:</div>`;
}

function renderCamera() {
  if (!cameraEl) return;
  const cp = camera.position;
  cameraEl.innerHTML =
    `<div>cam  ${fmt(cp.x)}  ${fmt(cp.y)}  ${fmt(cp.z)}</div>` +
    `<div>tgt  ${fmt(target.x)}  ${fmt(target.y)}  ${fmt(target.z)}</div>` +
    `<div>orb  r=${fmt(orbitRadius)} φ=${fmt(orbitPhi)} θ=${fmt(orbitTheta)}</div>`;
}

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
  bodyEl.appendChild(staticEl);
  bodyEl.appendChild(cameraEl);

  const bugIcon = document.createElement("div");
  bugIcon.className = "debug-bug";
  bugIcon.innerHTML = BUG_SVG;

  panel.appendChild(bodyEl);
  panel.appendChild(bugIcon);
  document.body.appendChild(panel);

  makeCollapsible(panel);

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

    // Bloom parameter tuning
    for (const b of bloomBindings) {
      if (e.key === b.downKey || e.key === b.upKey) {
        const dir = e.key === b.upKey ? 1 : -1;
        const next = Math.min(b.max, Math.max(b.min, debug[b.prop] + dir * b.step));
        debug[b.prop] = next;
        notifyBloom();
        e.preventDefault();
        return;
      }
    }
  });

}
