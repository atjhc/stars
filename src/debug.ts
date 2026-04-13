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
    navigator.clipboard.writeText(cameraStateText());
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
