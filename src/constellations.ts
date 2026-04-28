import * as THREE from "three";
import type { Star } from "./types.ts";
import { scene, camera, lookToward } from "./scene.ts";
import { notableObjects } from "./starfield.ts";
import { SCALE, LY_PER_PARSEC, TILE_BASE_URL } from "./constants.ts";
import { type SearchEntry, getSearchIndex } from "./catalog.ts";
import { setLabelsDirty } from "./systemStore.ts";
import { registerLabelType, type LabelTypeHandler } from "./labelRegistry.ts";
import { favoriteIcon } from "./detail.ts";
import { isFavorite } from "./favorites.ts";
import {
  registerCanvasLabel, updateCanvasLabel,
} from "./labelCanvas.ts";

// -- Visual constants --------------------------------------------------

const BASE_COLOR = new THREE.Color(0xaabbdd);
const HIGHLIGHT_COLOR = new THREE.Color(0xddeeff);
const BASE_OPACITY = 0.22;
const HOVER_OPACITY = 0.5;
const SELECTED_OPACITY = 0.7;

// Sol-distance fading thresholds (in light-years)
const FADE_FULL_LY = 5;
const FADE_ZERO_LY = 30;

const LABEL_FONT = `14px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const LABEL_COLOR = "rgba(180,210,255,0.85)";
const LABEL_SHADOW = { color: "rgba(140,180,240,0.5)", blur: 6 };
const LABEL_GLOW = { color: "rgba(210,225,255,0.9)", blur: 14 };
const SUBTITLE_FONT = `9px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const SUBTITLE_COLOR = "rgba(170,170,170,0.9)";
const LABEL_OPACITY = 0.55;

// -- Types -------------------------------------------------------------

interface ConstellationDef {
  iau: string;
  description?: string;
  asterism?: boolean;
  wikipedia?: string;
  lines: [string, string][];
  stars?: Record<string, [number, number, number]>;
}

interface ConstellationInstance {
  name: string;
  canvasKey: string;
  def: ConstellationDef;
  mesh: THREE.LineSegments;
  centroid: THREE.Vector3;
  starNames: string[];
}

// -- Module state -------------------------------------------------------

const instances: ConstellationInstance[] = [];
const instancesByName = new Map<string, ConstellationInstance>();
let selectedConstellation: ConstellationInstance | null = null;
let hoveredConstellation: ConstellationInstance | null = null;
// Two independent toggles. C / URL controls the feature itself
// (lines + labels). L (via the label registry) only governs labels.
// Mesh visibility = featureEnabled; label hidden = !featureEnabled
// || !labelsEnabledExternally.
let featureEnabled = true;
let labelsEnabledExternally = true;
let lastFade = -1;
let lastSelected: ConstellationInstance | null = null;
let lastHovered: ConstellationInstance | null = null;

// -- Helpers ------------------------------------------------------------

function makeCanvasKey(name: string): string { return `constellation:${name}`; }

function cameraFade(): number {
  const distLy = (camera.position.length() / SCALE) * LY_PER_PARSEC;
  if (distLy <= FADE_FULL_LY) return 1.0;
  if (distLy >= FADE_ZERO_LY) return 0.0;
  return 1.0 - (distLy - FADE_FULL_LY) / (FADE_ZERO_LY - FADE_FULL_LY);
}

// Sky-projected centroid: average the unit direction vectors, then scale
// to a representative distance so the label sits at a sensible depth.
function skyCentroid(positions: THREE.Vector3[]): THREE.Vector3 {
  const dir = new THREE.Vector3();
  let avgDist = 0;
  for (const p of positions) {
    const len = p.length();
    if (len > 0) dir.addScaledVector(p, 1 / len);
    avgDist += len;
  }
  dir.normalize();
  avgDist /= positions.length;
  return dir.multiplyScalar(avgDist);
}

function applyGlow(ci: ConstellationInstance) {
  updateCanvasLabel(ci.canvasKey, {
    shadowColor: LABEL_GLOW.color,
    shadowBlur: LABEL_GLOW.blur,
  });
}

function removeGlow(ci: ConstellationInstance) {
  updateCanvasLabel(ci.canvasKey, {
    shadowColor: LABEL_SHADOW.color,
    shadowBlur: LABEL_SHADOW.blur,
  });
}

function setMeshHighlight(ci: ConstellationInstance, color: THREE.Color, opacity: number) {
  const mat = ci.mesh.material as THREE.LineBasicMaterial;
  mat.color.copy(color);
  mat.opacity = opacity;
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function buildDetailHtml(ci: ConstellationInstance): string {
  const d = ci.def;
  const typeLabel = d.asterism ? "Asterism" : "Constellation";
  const starLinks = ci.starNames
    .map((s) => `<span class="constellation-star-link" data-star="${escAttr(s)}">${escAttr(s)}</span>`)
    .join(" &middot; ");

  return `
    ${favoriteIcon(ci.name)}
    <div class="star-name">${ci.name}</div>
    <div class="star-aliases">${d.iau}</div>
    <div class="detail-body">
      <div class="star-detail">${typeLabel} &middot; ${d.lines.length} lines &middot; ${ci.starNames.length} stars</div>
      ${d.description ? `<div class="star-notes">${d.description}</div>` : ""}
      ${d.wikipedia ? `<div class="star-wiki"><a href="${d.wikipedia}" target="_blank">Wikipedia</a></div>` : ""}
      <div class="constellation-stars">${starLinks}</div>
    </div>`;
}

// -- Handler ------------------------------------------------------------

const constellationHandler: LabelTypeHandler = {
  type: "constellation",
  overlay: true,
  searchKind: "x",
  searchKeywords: ["constellation", "asterism"],
  searchLabel: "Constellation",

  setVisible(v) {
    labelsEnabledExternally = v;
    applyVisibility();
  },

  update() {
    if (!featureEnabled) return;
    const fade = cameraFade();
    const fadeQ = Math.round(fade * 200);
    if (fadeQ === lastFade && selectedConstellation === lastSelected && hoveredConstellation === lastHovered) return;
    lastFade = fadeQ;
    lastSelected = selectedConstellation;
    lastHovered = hoveredConstellation;
    for (const ci of instances) {
      if (fade <= 0) {
        ci.mesh.visible = false;
        updateCanvasLabel(ci.canvasKey, { hidden: true });
        continue;
      }
      ci.mesh.visible = true;
      const isActive = ci === selectedConstellation || ci === hoveredConstellation;
      if (isActive) {
        const op = ci === selectedConstellation ? SELECTED_OPACITY : HOVER_OPACITY;
        setMeshHighlight(ci, HIGHLIGHT_COLOR, op * fade);
      } else {
        setMeshHighlight(ci, BASE_COLOR, BASE_OPACITY * fade);
      }
      updateCanvasLabel(ci.canvasKey, {
        hidden: !labelsEnabledExternally,
        opacityTarget: isActive ? fade : LABEL_OPACITY * fade,
        pinned: isActive,
      });
    }
  },

  selectByName(name) {
    const ci = instancesByName.get(name);
    if (!ci) return false;
    if (selectedConstellation && selectedConstellation !== ci) {
      removeGlow(selectedConstellation);
    }
    selectedConstellation = ci;
    applyGlow(ci);
    lookToward(ci.centroid);
    setLabelsDirty(true);
    return true;
  },

  clearSelection() {
    if (selectedConstellation) { removeGlow(selectedConstellation); selectedConstellation = null; }
    if (hoveredConstellation) { removeGlow(hoveredConstellation); hoveredConstellation = null; }
  },

  getSelectedName() {
    return selectedConstellation?.name ?? null;
  },

  setHoverByName(name) {
    const next = name ? instancesByName.get(name) ?? null : null;
    if (hoveredConstellation === next) return;
    if (hoveredConstellation && selectedConstellation !== hoveredConstellation) {
      removeGlow(hoveredConstellation);
    }
    hoveredConstellation = next;
    if (next && selectedConstellation !== next) applyGlow(next);
  },

  handleClick(div) {
    const name = div.getAttribute("data-label-name");
    return name ? this.selectByName(name) : false;
  },

  detailHtml() {
    return selectedConstellation ? buildDetailHtml(selectedConstellation) : null;
  },
};

// -- Init ---------------------------------------------------------------

export async function initConstellations(): Promise<void> {
  const res = await fetch(`${TILE_BASE_URL}constellations.json`);
  if (!res.ok) {
    console.warn("constellations.json not found — constellation lines disabled");
    return;
  }
  const defs: Record<string, ConstellationDef> = await res.json();

  // Build name -> position lookup. Tier-0 (notable) stars have scene
  // anchors with precise positions; for all other named stars, fall back
  // to the search index which covers tier-0 + tier-1 (~5k stars).
  const byName = new Map<string, THREE.Vector3>();
  for (const anchor of notableObjects) {
    const star = anchor.userData as Star;
    if (star.name) byName.set(star.name, anchor.position);
  }
  const searchIdx = getSearchIndex();
  for (const entry of searchIdx) {
    if (!byName.has(entry.n)) {
      byName.set(entry.n, new THREE.Vector3(entry.p[0], entry.p[1], entry.p[2]));
    }
  }

  const unresolved = new Set<string>();

  // Resolve a star name to a position: catalog first, then embedded fallback.
  function resolve(starName: string, embedded?: Record<string, [number, number, number]>): THREE.Vector3 | undefined {
    const catalogPos = byName.get(starName);
    if (catalogPos) return catalogPos;
    const fallback = embedded?.[starName];
    if (fallback) return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
    return undefined;
  }

  for (const [name, def] of Object.entries(defs)) {
    const positions: number[] = [];
    const starPositions: THREE.Vector3[] = [];
    const starNameSet = new Set<string>();

    for (const [a, b] of def.lines) {
      const pa = resolve(a, def.stars);
      const pb = resolve(b, def.stars);
      if (!pa) unresolved.add(a);
      if (!pb) unresolved.add(b);
      if (!pa || !pb) continue;
      positions.push(pa.x, pa.y, pa.z);
      positions.push(pb.x, pb.y, pb.z);
      if (!starNameSet.has(a)) { starNameSet.add(a); starPositions.push(pa); }
      if (!starNameSet.has(b)) { starNameSet.add(b); starPositions.push(pb); }
    }

    if (positions.length === 0) continue;
    for (const s of starNameSet) constellationStarNames.add(s);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

    const mesh = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      color: BASE_COLOR,
      transparent: true,
      opacity: BASE_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    mesh.frustumCulled = false;
    scene.add(mesh);

    const centroid = skyCentroid(starPositions);
    const canvasKey = makeCanvasKey(name);
    const starNames = [...starNameSet];

    const ci: ConstellationInstance = { name, canvasKey, def, mesh, centroid, starNames };
    instances.push(ci);
    instancesByName.set(name, ci);

    registerCanvasLabel({
      id: canvasKey,
      kind: "constellation",
      anchor: centroid,
      text: name,
      font: LABEL_FONT,
      color: LABEL_COLOR,
      shadowColor: LABEL_SHADOW.color,
      shadowBlur: LABEL_SHADOW.blur,
      subtitleFont: SUBTITLE_FONT,
      subtitleColor: SUBTITLE_COLOR,
      rank: 3000 + (isFavorite(name) ? 5000 : 0),
      marginTop: 0,
      centered: true,
      opacityTarget: 0,
      payload: { name },
    });

    getSearchIndex().push({
      n: name,
      p: [centroid.x, centroid.y, centroid.z],
      mg: 0, M: 0, d: 0,
      k: "x",
      a: [def.iau],
    });
  }

  if (unresolved.size > 0) {
    console.warn(`[constellations] unresolved stars: ${[...unresolved].join(", ")}`);
  }

  // featureEnabled may already be `false`; apply it now that instances exist.
  applyVisibility();
  registerLabelType(constellationHandler);
  console.log(
    `Constellations: ${instances.length} loaded, ` +
    `${instances.reduce((s, c) => s + c.def.lines.length, 0)} lines`,
  );
}

function applyVisibility(): void {
  // Force update() to re-run so its memo doesn't keep stale fade
  // state when feature/label visibility flips.
  lastFade = -1;
  for (const ci of instances) {
    ci.mesh.visible = featureEnabled;
    updateCanvasLabel(ci.canvasKey, {
      hidden: !featureEnabled || !labelsEnabledExternally,
    });
  }
  setLabelsDirty(true);
}

export function setConstellationsVisible(v: boolean): void {
  featureEnabled = v;
  applyVisibility();
}

export function toggleConstellations(): void {
  setConstellationsVisible(!featureEnabled);
}

export function constellationsVisible(): boolean {
  return featureEnabled;
}

// Stars that belong to at least one constellation. Populated at init.
const constellationStarNames = new Set<string>();

export function isConstellationStar(name: string): boolean {
  return featureEnabled && constellationStarNames.has(name);
}
