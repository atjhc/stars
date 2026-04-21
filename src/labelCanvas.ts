// Canvas-based label layer. Replaces the Three.js CSS2DRenderer /
// <div> label path — see docs/canvas-labels-plan.md.
//
// Frame pipeline:
//   1. Project each active label via labelCamera (unclamped camera
//      position — matches the star shader's target-relative frame).
//   2. Measure text via OffscreenCanvas (cache by font|text).
//   3. Fade: interpolate opacityCurrent toward opacityTarget over ~400ms.
//   4. Collision: sort by pinned desc, rank desc; spatial-grid overlap.
//      Respects collectScreenOccluders() from labelRegistry.
//   5. Paint: fillText per visible label, optional subtitle lines.
//   6. Publish hitRegions for pointer pick-scans.

import * as THREE from "three";
import { labelCamera, camera } from "./scene.ts";
import { collectScreenOccluders, type Occluder } from "./labelRegistry.ts";
import { COLLISION_PAD_PX, COLLISION_ALPHA_CUTOFF, HIT_PX_PADDING } from "./constants.ts";
import { computeStarScreenMetrics } from "./stars.ts";
import { starRadiusScene } from "./color.ts";
import type { Star } from "./types.ts";

// Hit-target debug overlay (Shift+5 via debug.ts) — kept local so the
// labelCanvas → debug import doesn't cycle through starfield. main.ts
// wires the toggle into setHitTargetsOverlay via onDebugChange.
let hitTargetsOverlay = false;
export function setHitTargetsOverlay(on: boolean): void {
  hitTargetsOverlay = on;
}

export type LabelKind = "star" | "system" | "nebula" | "blackhole";

// A label registration — stable identity across frames. The renderer
// derives per-frame screen positions and metrics; callers only update
// semantic state (text, rank, pinned, opacityTarget).
//
// subtitles is zero or more extra lines painted below the main text —
// used for distance subtitles on highlighted stars, and for member-
// name + distance lines on active binary/cluster labels. Subtitles
// don't participate in collision (main text line only), matching the
// DOM path which reads only firstElementChild for collision rects.
export interface CanvasLabelDescriptor {
  id: string;
  kind: LabelKind;
  anchor: THREE.Vector3;
  text: string;
  subtitles?: string[];
  font: string;
  color: string;
  shadowColor?: string;
  shadowBlur?: number;
  subtitleFont?: string;
  subtitleColor?: string;
  rank: number;
  pinned?: boolean;
  marginTop: number;
  opacityTarget: number;
  // Caller-requested "force hidden". Distinct from the collision pass'
  // decisions (occlusion, overlap) — used when something outside the
  // canvas wants the label off screen (e.g. camDist > LABEL_HIDE_DIST).
  // Flows through the same visibleFactor fade so the hide animates
  // instead of snapping to 0 alpha.
  hidden?: boolean;
  // Raw payload for selection / hover handlers. Not touched by the renderer.
  payload?: unknown;
}

interface CanvasLabel extends CanvasLabelDescriptor {
  screenX: number;
  screenY: number;
  behind: boolean;
  width: number;
  height: number;
  // Painted alpha = opacityTarget × visibleFactor. opacityTarget is the
  // distance-modulated value callers set via updateCanvasLabel and is
  // applied directly (matches DOM setLabelStyle). visibleFactor is the
  // collision channel — linearly interpolated 0↔1 over FADE_MS so the
  // hide/show transition is animated like the DOM WAAPI fade.
  visibleFactor: number;
  // Most-recent collision decision. Flips only in the batched
  // collision pass; between passes, visibleFactor continues fading
  // toward (collisionVisible ? 1 : 0).
  collisionVisible: boolean;
}

const labels = new Map<string, CanvasLabel>();

// Flag the collision pass to re-decide on the next frame. Collision is
// batched — not re-run every frame — so the linear fade animations can
// actually play out instead of targets flickering back to opaque when
// a sub-pixel camera jitter breaks a transient overlap.
//
// Callers that mutate label state must set this:
//   - registerCanvasLabel / unregisterCanvasLabel flag it automatically
//   - labels.ts::updateLabels flags it at the top of each dirty pass
//     via markCanvasCollisionDirty
//   - nebula / BH handlers flag it when their hover/select state flips
let collisionDirty = true;
export function markCanvasCollisionDirty(): void {
  collisionDirty = true;
}

// Global label-visibility gate (the `L` key / labels toggle).
// labels.ts::updateLabels early-returns when labels are off, which
// freezes opacityTarget but doesn't stop renderLabelCanvas — we
// still need visibleFactor to fade to 0. Gate the collision pass
// on this flag so every label reads as "hidden" and fades together.
let allLabelsVisible = true;
export function setCanvasLabelsVisible(v: boolean): void {
  if (allLabelsVisible === v) return;
  allLabelsVisible = v;
  collisionDirty = true;
}

export function registerCanvasLabel(desc: CanvasLabelDescriptor): void {
  // If the same id is already registered, preserve its animation state
  // (visibleFactor, collisionVisible). rebuildSystems in starfield.ts
  // re-registers every system each time a tile streams in, and clusters
  // with stable tier-0 members would otherwise fade out → in on every
  // stream event. Measurements are still invalidated so a text change
  // is re-measured.
  const prev = labels.get(desc.id);
  labels.set(desc.id, {
    ...desc,
    pinned: desc.pinned ?? false,
    hidden: desc.hidden ?? false,
    screenX: prev?.screenX ?? 0,
    screenY: prev?.screenY ?? 0,
    behind: prev?.behind ?? true,
    width: 0,
    height: 0,
    visibleFactor: prev?.visibleFactor ?? 0,
    collisionVisible: prev?.collisionVisible ?? false,
  });
  collisionDirty = true;
}

export function unregisterCanvasLabel(id: string): void {
  labels.delete(id);
  collisionDirty = true;
}

export function updateCanvasLabel(id: string, patch: Partial<CanvasLabelDescriptor>): void {
  const label = labels.get(id);
  if (!label) return;
  // Text / font changes invalidate cached measurements.
  if (patch.text !== undefined && patch.text !== label.text) label.width = 0;
  if (patch.font !== undefined && patch.font !== label.font) label.width = 0;
  Object.assign(label, patch);
}

export function hasCanvasLabel(id: string): boolean {
  return labels.has(id);
}

// True when the label is drawn this frame AND not faded past the
// interactivity cutoff. Used by hover/click handlers to match the DOM
// path's `isLabelInteractive(div)` semantics.
export function isCanvasLabelInteractive(id: string): boolean {
  const l = labels.get(id);
  if (!l) return false;
  // Alpha the label is actually painting at this frame.
  const alpha = l.opacityTarget * l.visibleFactor;
  return l.collisionVisible && alpha >= COLLISION_ALPHA_CUTOFF;
}

// Mesh-to-id bridge — callers (starfield, interaction) store the anchor
// Object3D here so glow/hover code can discover whether an anchor has a
// canvas label and pull its id without touching starfield internals.
const meshToId = new WeakMap<object, string>();
export function linkMeshToCanvasLabel(mesh: object, id: string): void {
  meshToId.set(mesh, id);
}
export function unlinkMeshFromCanvasLabel(mesh: object): void {
  meshToId.delete(mesh);
}
export function getCanvasLabelIdForMesh(mesh: object): string | undefined {
  return meshToId.get(mesh);
}

// --- Text metrics cache ---

type MeasureCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
let measureCtx: MeasureCtx | null = null;

function getMeasureCtx(): MeasureCtx {
  if (measureCtx) return measureCtx;
  if (typeof OffscreenCanvas !== "undefined") {
    measureCtx = new OffscreenCanvas(1, 1).getContext("2d")!;
  } else {
    const c = document.createElement("canvas");
    c.width = 1; c.height = 1;
    measureCtx = c.getContext("2d")!;
  }
  return measureCtx;
}

const metricsCache = new Map<string, { width: number; height: number }>();

function measureText(font: string, text: string): { width: number; height: number } {
  const key = `${font}|${text}`;
  const cached = metricsCache.get(key);
  if (cached) return cached;
  const ctx = getMeasureCtx();
  ctx.font = font;
  const m = ctx.measureText(text);
  // fontBoundingBox* describes the font's typographic bounds and is
  // stable across glyph content — Safari's actualBoundingBoxDescent
  // shrinks to the actual descent of the drawn text, so "Sirius"
  // (no descenders) got a shorter box than "Galaxy" (with 'y'), and
  // the hit rect cut below the glyph bottom on descender-free labels.
  // Fall back to actualBoundingBox on old browsers where
  // fontBoundingBox isn't supported, and a fixed estimate if neither.
  const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? 8;
  const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? 2;
  const result = { width: m.width, height: ascent + descent };
  metricsCache.set(key, result);
  return result;
}

// --- Canvas element ---

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let canvasWidthCss = 0;
let canvasHeightCss = 0;

function ensureCanvas(): HTMLCanvasElement {
  if (canvas) return canvas;
  canvas = document.createElement("canvas");
  canvas.id = "label-canvas";
  // z-index above CSS2DRenderer (10) so in transition stages the canvas
  // draws on top, matching the z-order of migrated labels.
  canvas.style.cssText =
    "position:absolute;top:0;left:0;pointer-events:none;z-index:11;user-select:none";
  const viewport = document.getElementById("viewport") ?? document.body;
  viewport.appendChild(canvas);
  ctx = canvas.getContext("2d")!;
  syncCanvasSize();
  return canvas;
}

function syncCanvasSize(): void {
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvasWidthCss === w && canvasHeightCss === h && canvas.width === Math.round(w * dpr)) return;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvasWidthCss = w;
  canvasHeightCss = h;
}

window.addEventListener("resize", syncCanvasSize);

export function initLabelCanvas(): void {
  ensureCanvas();
}

// --- Projection ---

const projVec = new THREE.Vector3();
function project(pos: THREE.Vector3, out: { x: number; y: number; behind: boolean }): void {
  projVec.copy(pos).project(labelCamera);
  out.x = (projVec.x * 0.5 + 0.5) * window.innerWidth;
  out.y = (-projVec.y * 0.5 + 0.5) * window.innerHeight;
  out.behind = projVec.z > 1;
}

// --- Collision ---

interface CanvasRect { x: number; y: number; w: number; h: number; }
const CELL_SIZE = 64;
function cellKey(cx: number, cy: number): number {
  return (cx & 0xffff) | ((cy & 0xffff) << 16);
}

// True when the occluder circle covers any part of the rect — tests
// the closest point of the rect to the circle center. Center-only
// tests under-counted occlusion: a star disc that covered most of a
// short label could leave the text centroid just outside the disc and
// the label would stay visible.
function rectIntersectsOccluder(r: CanvasRect, occ: Occluder): boolean {
  const closestX = Math.max(r.x, Math.min(occ.cx, r.x + r.w));
  const closestY = Math.max(r.y, Math.min(occ.cy, r.y + r.h));
  const dx = closestX - occ.cx;
  const dy = closestY - occ.cy;
  return dx * dx + dy * dy < occ.radius * occ.radius;
}

// --- Pointer hit regions ---

interface HitRegion { id: string; rect: CanvasRect; }
const hitRegions: HitRegion[] = [];

// Linear scan — typical frame has ~100-300 visible labels. Iterate in
// reverse so later-drawn (higher-rank / pinned) labels win on overlap.
export function pickLabelAt(x: number, y: number): string | null {
  for (let i = hitRegions.length - 1; i >= 0; i--) {
    const { id, rect } = hitRegions[i]!;
    if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
      return id;
    }
  }
  return null;
}

// Per-frame list of star anchors with their current pixel-radius hit
// circle. Published by renderLabelCanvas; consumed by pickStarAt.
// Screen-space replaces the old 3D hit-sphere raycast for the canvas
// era — sidesteps clamped-camera deep-zoom skew and ambiguity when two
// binary members' 3D hit spheres overlap.
interface StarPick { mesh: unknown; x: number; y: number; rSq: number; }
const starPicks: StarPick[] = [];

// Pick the closest canvas-interactive star whose hit circle contains
// (x, y). Returns the mesh payload if hit, else null.
export function pickStarAt(x: number, y: number): unknown | null {
  let best: StarPick | null = null;
  let bestD = Infinity;
  for (const p of starPicks) {
    const dx = x - p.x;
    const dy = y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= p.rSq && d2 < bestD) {
      bestD = d2;
      best = p;
    }
  }
  return best?.mesh ?? null;
}

export function getCanvasLabel(id: string): CanvasLabelDescriptor | undefined {
  const l = labels.get(id);
  if (!l) return undefined;
  return l;
}

// --- Render ---

const FADE_MS = 400;
let lastFrameTime = 0;

// Scratch buffers reused across frames to avoid per-frame allocations.
const scratchProj = { x: 0, y: 0, behind: false };
const frameBuf: CanvasLabel[] = [];

export function renderLabelCanvas(): void {
  if (!canvas || !ctx) ensureCanvas();
  if (!ctx) return;
  syncCanvasSize();

  const now = performance.now();
  // Normalize per-frame fade delta. Clamp to avoid large jumps when the
  // tab was backgrounded and rAF catches up.
  const rawDt = lastFrameTime > 0 ? (now - lastFrameTime) : 16;
  const fadeStep = Math.min(1, rawDt / FADE_MS);
  lastFrameTime = now;

  ctx.clearRect(0, 0, canvasWidthCss, canvasHeightCss);
  hitRegions.length = 0;
  starPicks.length = 0;

  if (labels.size === 0) return;

  // Phase 1: project + measure.
  frameBuf.length = 0;
  for (const label of labels.values()) {
    project(label.anchor, scratchProj);
    label.screenX = scratchProj.x;
    label.screenY = scratchProj.y;
    label.behind = scratchProj.behind;
    if (scratchProj.behind) {
      // Behind camera — snap off, no fade.
      label.collisionVisible = false;
      label.visibleFactor = 0;
      continue;
    }
    if (label.width === 0) {
      const m = measureText(label.font, label.text);
      label.width = m.width;
      label.height = m.height;
    }
    frameBuf.push(label);
  }

  // Phase 2: collision — only on dirty. All overlap / occlusion /
  // visibility decisions flip together in the same frame, so the
  // subsequent fade reads as a single batched transition instead of
  // labels blinking in and out one by one as camera jitter makes
  // transient overlaps come and go.
  if (collisionDirty) {
    frameBuf.sort(compareLabels);
    const occluders = collectScreenOccluders();
    const grid = new Map<number, CanvasRect[]>();
    for (const label of frameBuf) {
      const textRect = labelRect(label);
      // Disc occlusion uses the larger hit rect — matches the user's
      // "disc occludes any of the hit target rect" expectation and
      // prevents a disc from just clipping the corner of a label and
      // leaving the text readable but unclickable.
      const hRect = hitRect(label);
      let visible: boolean;
      if (!allLabelsVisible) {
        visible = false;
      } else if (label.pinned) {
        visible = true;
      } else if (label.hidden) {
        visible = false;
      } else if (label.opacityTarget < COLLISION_ALPHA_CUTOFF) {
        visible = false;
      } else if (occludedByAny(hRect, occluders)) {
        visible = false;
      } else if (overlapsPlaced(textRect, grid)) {
        visible = false;
      } else {
        visible = true;
      }
      label.collisionVisible = visible;
      if (visible) insertPlaced(textRect, grid);
    }
    collisionDirty = false;
  }

  // Phase 3: step visibleFactor toward collision decision. This is the
  // ONLY axis that fades over FADE_MS — opacityTarget is applied
  // directly in phase 4 so distance-based fading tracks the camera
  // every frame instead of lagging behind the collision animation.
  for (const label of frameBuf) {
    const target = label.collisionVisible ? 1 : 0;
    stepVisibleFactor(label, target, fadeStep);
  }

  // Phase 4: paint + publish hit regions + star picks. Painted alpha
  // combines the distance-modulated opacityTarget (set by updateLabels)
  // with the smoothly animated visibleFactor.
  for (const label of frameBuf) {
    const alpha = label.opacityTarget * label.visibleFactor;
    if (alpha < 0.01) continue;
    paintLabel(ctx, label, alpha);
    if (label.collisionVisible) {
      hitRegions.push({ id: label.id, rect: hitRect(label) });
      // Publish a star-disc pick entry too — lets main.ts pick the
      // closest star to the cursor in pure screen space instead of a
      // 3D hit sphere raycast that skews with deep-zoom clamping and
      // can pick the wrong binary member when two hit spheres overlap
      // in 3D but not on screen.
      if (label.kind === "star" && label.payload) {
        const anchor = label.payload as { userData?: Star; position: THREE.Vector3 } | undefined;
        const star = anchor?.userData;
        if (star) {
          const camDist = anchor!.position.distanceTo(camera.position);
          const radius = starRadiusScene(star.lum, star.ci);
          const { halfBillPx } = computeStarScreenMetrics(radius, star.absmag ?? 10, Math.max(camDist, 1e-20));
          const rPx = halfBillPx + HIT_PX_PADDING;
          starPicks.push({ mesh: anchor, x: label.screenX, y: label.screenY, rSq: rPx * rPx });
        }
      }
    }
  }

  // Debug overlay — Shift+5 toggles `debug.hitTargets`. Draws the exact
  // rects pickLabelAt scans against and the disc occluders that drive
  // label hiding so the shapes can be eyeballed against what feels
  // clickable.
  if (hitTargetsOverlay) paintHitTargetOverlay(ctx, frameBuf, collectScreenOccluders());
}

function paintHitTargetOverlay(
  ctx: CanvasRenderingContext2D,
  labels: CanvasLabel[],
  occluders: Occluder[],
): void {
  ctx.save();
  ctx.lineWidth = 1;

  // Label hit rects — yellow, the rect pickLabelAt scans against.
  ctx.fillStyle = "rgba(255,220,0,0.25)";
  ctx.strokeStyle = "rgba(255,220,0,0.9)";
  for (const label of labels) {
    const alpha = label.opacityTarget * label.visibleFactor;
    if (alpha < 0.01 || !label.collisionVisible) continue;
    const r = hitRect(label);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }

  // Star anchor hit spheres — magenta. Mirrors the pickStarAt math
  // (halfBillPx + HIT_PX_PADDING) and filters to labels whose pick
  // would produce a meaningful selection: collisionVisible, alpha ≥
  // cutoff, and not pinned. Pinned covers the currently selected /
  // hovered star — hovering / clicking it doesn't change state so
  // drawing its hit overlay is just visual noise on top of the glow.
  ctx.fillStyle = "rgba(255,80,200,0.18)";
  ctx.strokeStyle = "rgba(255,80,200,0.9)";
  for (const label of labels) {
    if (label.kind !== "star") continue;
    if (label.behind) continue;
    if (!label.collisionVisible) continue;
    if (label.pinned) continue;
    const alpha = label.opacityTarget * label.visibleFactor;
    if (alpha < COLLISION_ALPHA_CUTOFF) continue;
    const anchor = label.payload as { userData?: Star; position: THREE.Vector3 } | undefined;
    if (!anchor || !anchor.userData) continue;
    const camDist = anchor.position.distanceTo(camera.position);
    const star = anchor.userData;
    const radius = starRadiusScene(star.lum, star.ci);
    const { halfBillPx } = computeStarScreenMetrics(radius, star.absmag ?? 10, Math.max(camDist, 1e-20));
    ctx.beginPath();
    ctx.arc(label.screenX, label.screenY, halfBillPx + HIT_PX_PADDING, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Star disc occluders — cyan. Region that currently hides labels
  // behind it via rectIntersectsOccluder.
  ctx.fillStyle = "rgba(0,200,255,0.2)";
  ctx.strokeStyle = "rgba(0,200,255,0.9)";
  for (const occ of occluders) {
    ctx.beginPath();
    ctx.arc(occ.cx, occ.cy, occ.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function compareLabels(a: CanvasLabel, b: CanvasLabel): number {
  const ap = a.pinned ? 1 : 0;
  const bp = b.pinned ? 1 : 0;
  if (ap !== bp) return bp - ap;
  return b.rank - a.rank;
}

// Tight text bounds — used for collision to keep stacked labels visually
// apart without wasting pixels.
function labelRect(label: CanvasLabel): CanvasRect {
  return {
    x: label.screenX - label.width / 2,
    y: label.screenY + label.marginTop,
    w: label.width,
    h: label.height,
  };
}

// Visual offset mirroring what DOM line-height centering gives a
// CSS div — actualBoundingBox* puts the text a hair higher on screen
// than CSS box layout does, making labels feel shifted up. Also used
// by hitRect so the pointer rect tracks the painted text.
const TEXT_BASELINE_OFFSET = 1;

// Pointer hit rect — uniform padding on all edges. Aligns to the
// *painted* text top (marginTop + TEXT_BASELINE_OFFSET), not the
// anchor-relative marginTop, so padding is symmetric above and below
// the glyphs. Earlier version missed the baseline offset and the rect
// sat 1 px too high — descenders poked past the bottom edge.
const HIT_PAD = 2;
function hitRect(label: CanvasLabel): CanvasRect {
  return {
    x: label.screenX - label.width / 2 - HIT_PAD,
    y: label.screenY + label.marginTop + TEXT_BASELINE_OFFSET - HIT_PAD,
    w: label.width + 2 * HIT_PAD,
    h: label.height + 2 * HIT_PAD,
  };
}

function occludedByAny(r: CanvasRect, occluders: Occluder[]): boolean {
  for (const occ of occluders) {
    if (rectIntersectsOccluder(r, occ)) return true;
  }
  return false;
}

function overlapsPlaced(r: CanvasRect, grid: Map<number, CanvasRect[]>): boolean {
  const pad = COLLISION_PAD_PX;
  const x0 = Math.floor((r.x - pad) / CELL_SIZE);
  const x1 = Math.floor((r.x + r.w + pad) / CELL_SIZE);
  const y0 = Math.floor((r.y - pad) / CELL_SIZE);
  const y1 = Math.floor((r.y + r.h + pad) / CELL_SIZE);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const cell = grid.get(cellKey(cx, cy));
      if (!cell) continue;
      for (const p of cell) {
        if (r.x - pad < p.x + p.w + pad
          && r.x + r.w + pad > p.x - pad
          && r.y - pad < p.y + p.h + pad
          && r.y + r.h + pad > p.y - pad) {
          return true;
        }
      }
    }
  }
  return false;
}

function insertPlaced(r: CanvasRect, grid: Map<number, CanvasRect[]>): void {
  const x0 = Math.floor(r.x / CELL_SIZE);
  const x1 = Math.floor((r.x + r.w) / CELL_SIZE);
  const y0 = Math.floor(r.y / CELL_SIZE);
  const y1 = Math.floor((r.y + r.h) / CELL_SIZE);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      const key = cellKey(cx, cy);
      let cell = grid.get(key);
      if (!cell) { cell = []; grid.set(key, cell); }
      cell.push(r);
    }
  }
}

// Linear step of visibleFactor toward target (0 or 1). `step` is the
// max absolute change this frame — 0.04 when the last rAF delta was
// 16 ms and FADE_MS is 400, giving a wall-clock fade of ~400 ms. All
// labels whose collisionVisible flipped in the same batched decision
// step together, so the transition reads as one event.
function stepVisibleFactor(label: CanvasLabel, target: number, step: number): void {
  const diff = target - label.visibleFactor;
  if (Math.abs(diff) <= step) { label.visibleFactor = target; return; }
  label.visibleFactor += Math.sign(diff) * step;
}

function paintLabel(ctx: CanvasRenderingContext2D, label: CanvasLabel, alpha: number): void {
  const nameX = label.screenX;
  const nameY = label.screenY + label.marginTop + TEXT_BASELINE_OFFSET;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  // Premultiply alpha into the color strings and leave ctx.globalAlpha
  // at 1. Safari doesn't apply globalAlpha consistently to shadows
  // rendered via shadowBlur; painting with a pre-dimmed rgba color /
  // shadowColor works uniformly across browsers (the alpha channel of
  // each color is respected in both text fill and shadow blur).
  const fill = multiplyAlpha(label.color, alpha);
  const sColor = label.shadowColor ? multiplyAlpha(label.shadowColor, alpha) : undefined;
  paintTextWithGlow(ctx, label.text, nameX, nameY, label.font, fill, sColor, label.shadowBlur ?? 0);

  if (label.subtitles && label.subtitles.length > 0) {
    const subFont = label.subtitleFont ?? label.font;
    const subFill = multiplyAlpha(label.subtitleColor ?? label.color, alpha);
    let y = nameY + label.height + 2;
    for (const line of label.subtitles) {
      paintTextWithGlow(ctx, line, nameX, y, subFont, subFill, sColor, label.shadowBlur ?? 0);
      const m = measureText(subFont, line);
      y += m.height + 2;
    }
  }
  ctx.restore();
}

// Paints text with the given (already alpha-premultiplied) fill and
// shadow. Highlighted labels (blur ≥ 8) get a three-pass render to
// approximate the CSS multi-shadow `starGlowShadow` returns: soft
// outer halo, inner bright ring, and a sharp crisp top. Non-
// highlighted labels get a single drop shadow.
function paintTextWithGlow(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  fill: string,
  shadow: string | undefined,
  blur: number,
): void {
  ctx.font = font;
  ctx.fillStyle = fill;

  if (shadow && blur >= 8) {
    ctx.shadowColor = shadow;
    ctx.shadowBlur = blur * 2;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = blur;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
    ctx.fillText(text, x, y);
  } else if (shadow && blur > 0) {
    ctx.shadowColor = shadow;
    ctx.shadowBlur = blur;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 0;
  } else {
    ctx.fillText(text, x, y);
  }
}

// Parse a CSS color once + cache the RGBA tuple. multiplyAlpha hits
// this on every fillText so the parse needs to amortize — but the
// final rgba(...) string can't be reused because mul changes each
// frame during fades.
interface ParsedColor { r: number; g: number; b: number; a: number; }
const parsedColorCache = new Map<string, ParsedColor | null>();
function parseColor(color: string): ParsedColor | null {
  const cached = parsedColorCache.get(color);
  if (cached !== undefined) return cached;
  let parsed: ParsedColor | null = null;
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(color);
  if (rgba) {
    parsed = {
      r: +rgba[1]!, g: +rgba[2]!, b: +rgba[3]!,
      a: parseFloat(rgba[4] ?? "1"),
    };
  } else {
    const hex = /^#([\da-fA-F]{3}|[\da-fA-F]{6})$/.exec(color);
    if (hex) {
      const h = hex[1]!;
      let r: number, g: number, b: number;
      if (h.length === 3) {
        r = parseInt(h[0]! + h[0], 16);
        g = parseInt(h[1]! + h[1], 16);
        b = parseInt(h[2]! + h[2], 16);
      } else {
        r = parseInt(h.slice(0, 2), 16);
        g = parseInt(h.slice(2, 4), 16);
        b = parseInt(h.slice(4, 6), 16);
      }
      parsed = { r, g, b, a: 1 };
    }
  }
  parsedColorCache.set(color, parsed);
  return parsed;
}

// Multiply a CSS color's alpha by `mul` and return an rgba(...) string.
// Safari doesn't apply globalAlpha consistently to text shadows —
// premultiplying into the color channel works uniformly.
function multiplyAlpha(color: string, mul: number): string {
  if (mul >= 0.999) return color;
  const p = parseColor(color);
  if (!p) return color;
  return `rgba(${p.r},${p.g},${p.b},${(p.a * mul).toFixed(3)})`;
}
