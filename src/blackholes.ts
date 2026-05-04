import * as THREE from "three";
import {
  scene, camera, animateTo, setMinOrbitOverride,
  isDeepZoom, orbitRadius, requestLensing,
  distanceFromCamera, animation,
} from "./scene.ts";
import {
  TILE_BASE_URL, RS_KM_PER_MSUN, KM_PER_PC, SCALE,
  DEEP_ZOOM_MIN_ORBIT, formatAstroDistance, solDistanceFade,
} from "./constants.ts";
import { setLabelsDirty } from "./systemStore.ts";
import { registerLabelType, type LabelTypeHandler } from "./labelRegistry.ts";
import { favoriteIcon } from "./detail.ts";
import { isFavorite } from "./favorites.ts";
import {
  registerCanvasLabel, updateCanvasLabel,
} from "./labelCanvas.ts";
import { computeStarMinOrbit } from "./stars.ts";
import { getSearchIndex } from "./catalog.ts";
import { inSolarSystemView } from "./planets.ts";

function resolveArrivalLookAt(
  ref: string | [number, number, number] | undefined,
): THREE.Vector3 | undefined {
  if (!ref) return undefined;
  if (typeof ref !== "string") return new THREE.Vector3(ref[0], ref[1], ref[2]);
  const entry = getSearchIndex().find((e) => e.n === ref);
  if (!entry) {
    console.warn(`[blackholes] arrivalLookAt name not found in search index: ${ref}`);
    return undefined;
  }
  return new THREE.Vector3(entry.p[0], entry.p[1], entry.p[2]);
}

const BH_CANVAS_FONT = `12px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const BH_CANVAS_COLOR = "rgba(180,140,220,0.85)";
const BH_CANVAS_SHADOW = { color: "rgba(120,80,180,0.7)", blur: 6 };
const BH_CANVAS_GLOW = { color: "rgba(160,100,220,1.0)", blur: 12 };
const BH_SUBTITLE_FONT = `9px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const BH_SUBTITLE_COLOR = "rgba(170,170,170,0.9)";

interface BlackHoleEntry {
  aliases?: string[];
  ra: number;
  dec: number;
  dist_pc: number;
  mass_msun: number;
  wikipedia?: string;
  notes?: string;
  scene_pos: [number, number, number];
  // Set-piece arrival direction: string → resolved against the search
  // index by name (e.g. "Sol"); tuple → direct scene-space position.
  // Camera arrives looking through the BH toward this point.
  arrivalLookAt?: string | [number, number, number];
  // Arrival distance from the BH center, in km. Overrides the
  // auto-computed "shadow fills 15% of viewport" default.
  arrivalRadiusKm?: number;
}

interface BlackHoleLabel {
  name: string;
  entry: BlackHoleEntry;
  anchor: THREE.Object3D;
}

const blackHoleLabels: BlackHoleLabel[] = [];
let selectedBH: BlackHoleLabel | null = null;
let hoveredBH: BlackHoleLabel | null = null;
let maxSolDist = 0;

// Departing lensing: when the selection is cleared mid-transit, keep
// requesting lensing for the old object so its effect fades naturally
// as the camera recedes rather than popping off.
let departingBH: BlackHoleLabel | null = null;

function canvasIdFor(name: string): string { return `blackhole:${name}`; }

function applyGlow(bh: BlackHoleLabel) {
  updateCanvasLabel(canvasIdFor(bh.name), {
    shadowColor: BH_CANVAS_GLOW.color,
    shadowBlur: BH_CANVAS_GLOW.blur,
  });
  setLabelsDirty(true);
}

function removeGlow(bh: BlackHoleLabel) {
  updateCanvasLabel(canvasIdFor(bh.name), {
    shadowColor: BH_CANVAS_SHADOW.color,
    shadowBlur: BH_CANVAS_SHADOW.blur,
  });
  setLabelsDirty(true);
}

function buildDetailHtml(bh: BlackHoleLabel): string {
  const e = bh.entry;
  const dist = bh === selectedBH ? orbitRadius : distanceFromCamera(bh.anchor.position);
  const aliasLine = e.aliases && e.aliases.length > 0
    ? `<div class="star-aliases">${e.aliases.join(" · ")}</div>` : "";
  const wikiLink = e.wikipedia
    ? `<div class="star-wiki"><a href="${e.wikipedia}" target="_blank">Wikipedia</a></div>` : "";
  const notes = e.notes ? `<div class="star-notes">${e.notes}</div>` : "";

  return `
    ${favoriteIcon(bh.name)}
    <div class="star-name">${bh.name}</div>
    ${aliasLine}
    <div class="detail-body">
      <div class="star-detail">
        Distance: ${formatAstroDistance(dist)}<br>
        Mass: ${e.mass_msun} M☉<br>
        Type: Stellar-mass black hole
      </div>
      ${notes}
      ${wikiLink}
    </div>`;
}

// Photon-ring factor: the BH "shadow" seen by a distant observer is
// ~2.6 rs, not 1 rs (gravitational lensing of the event-horizon edge
// through the photon sphere).
const BH_SHADOW_TO_RS = 2.6;


const bhHandler: LabelTypeHandler = {
  type: "blackhole",
  searchKind: "b",
  searchKeywords: ["black hole"],
  searchLabel: "Black Hole",

  setVisible(v) {
    for (const bh of blackHoleLabels) {
      bh.anchor.visible = v;
      const isActive = bh === selectedBH || bh === hoveredBH;
      if (v) {
        updateCanvasLabel(canvasIdFor(bh.name), {
          hidden: false,
          opacityTarget: isActive ? 1.0 : solDistanceFade(bh.anchor.position.length(), maxSolDist),
        });
      } else {
        updateCanvasLabel(canvasIdFor(bh.name), { hidden: true });
      }
    }
  },

  update() {
    if (maxSolDist === 0 && blackHoleLabels.length > 0) {
      for (const bh of blackHoleLabels) {
        const d = bh.anchor.position.length();
        if (d > maxSolDist) maxSolDist = d;
      }
    }
    const hideForSolarView = inSolarSystemView();
    for (const bh of blackHoleLabels) {
      if (!bh.anchor.visible) {
        updateCanvasLabel(canvasIdFor(bh.name), { hidden: true });
        continue;
      }
      const isActive = bh === selectedBH || bh === hoveredBH;
      if (hideForSolarView && !isActive) {
        updateCanvasLabel(canvasIdFor(bh.name), { hidden: true, pinned: false });
        continue;
      }
      const trueDist = bh === selectedBH ? orbitRadius : distanceFromCamera(bh.anchor.position);
      const opacity = isActive ? 1.0 : solDistanceFade(bh.anchor.position.length(), maxSolDist);
      updateCanvasLabel(canvasIdFor(bh.name), {
        hidden: false,
        opacityTarget: opacity,
        pinned: isActive,
        subtitles: isActive ? [formatAstroDistance(trueDist)] : [],
      });
    }

    if (selectedBH) {
      const dist = animation ? distanceFromCamera(selectedBH.anchor.position) : orbitRadius;
      const rsScene = ((RS_KM_PER_MSUN * selectedBH.entry.mass_msun) / KM_PER_PC) * SCALE;
      requestLensing({
        pos: selectedBH.anchor.position,
        shadowRadiusScene: BH_SHADOW_TO_RS * rsScene,
        massMsun: selectedBH.entry.mass_msun,
        mode: "shadow",
        camDist: dist,
      });
    }

    // Departing BH: keep requesting lensing until the animation ends
    // or the shadow fraction becomes negligible.
    if (departingBH) {
      if (!animation) {
        departingBH = null;
      } else {
        const dist = distanceFromCamera(departingBH.anchor.position);
        const rsScene = ((RS_KM_PER_MSUN * departingBH.entry.mass_msun) / KM_PER_PC) * SCALE;
        requestLensing({
          pos: departingBH.anchor.position,
          shadowRadiusScene: BH_SHADOW_TO_RS * rsScene,
          massMsun: departingBH.entry.mass_msun,
          mode: "shadow",
          camDist: dist,
        });
      }
    }
  },

  selectByName(name) {
    const bh = blackHoleLabels.find((b) => b.name === name);
    if (!bh) return false;
    if (selectedBH && selectedBH !== bh) {
      departingBH = selectedBH;
      removeGlow(selectedBH);
    }
    selectedBH = bh;
    applyGlow(bh);
    setMinOrbitOverride(DEEP_ZOOM_MIN_ORBIT);
    // Default: arrive where the shadow disc fills ~15% of the viewport.
    // Per-entity `arrivalRadiusKm` overrides for set-piece framing.
    const rsScene = ((RS_KM_PER_MSUN * bh.entry.mass_msun) / KM_PER_PC) * SCALE;
    const shadowRadius = BH_SHADOW_TO_RS * rsScene;
    const arrivalRadius = bh.entry.arrivalRadiusKm !== undefined
      ? (bh.entry.arrivalRadiusKm / KM_PER_PC) * SCALE
      : computeStarMinOrbit(shadowRadius, 0.15);
    const lookAt = resolveArrivalLookAt(bh.entry.arrivalLookAt);
    animateTo(bh.anchor.position, arrivalRadius, lookAt);
    setLabelsDirty(true);
    return true;
  },

  clearSelection() {
    if (selectedBH) {
      if (animation) departingBH = selectedBH;
      removeGlow(selectedBH);
      selectedBH = null;
      setMinOrbitOverride(null);
    }
    if (hoveredBH) { removeGlow(hoveredBH); hoveredBH = null; }
  },

  getSelectedName() {
    return selectedBH?.name ?? null;
  },

  setHoverByName(name) {
    const next = name ? blackHoleLabels.find((b) => b.name === name) ?? null : null;
    if (hoveredBH === next) return;
    if (hoveredBH && selectedBH !== hoveredBH) removeGlow(hoveredBH);
    hoveredBH = next;
    if (next && selectedBH !== next) applyGlow(next);
  },

  handleClick(div) {
    const name = div.getAttribute("data-label-name");
    return name ? this.selectByName(name) : false;
  },

  detailHtml() {
    return selectedBH ? buildDetailHtml(selectedBH) : null;
  },

};

export async function initBlackHoleLabels(): Promise<void> {
  const resp = await fetch(`${TILE_BASE_URL}blackholes.json`);
  if (!resp.ok) return;
  const data: Record<string, BlackHoleEntry> = await resp.json();

  for (const [name, entry] of Object.entries(data)) {
    const anchor = new THREE.Object3D();
    anchor.position.set(entry.scene_pos[0], entry.scene_pos[1], entry.scene_pos[2]);
    scene.add(anchor);

    const bh: BlackHoleLabel = { name, entry, anchor };
    blackHoleLabels.push(bh);

    registerCanvasLabel({
      id: canvasIdFor(name),
      kind: "blackhole",
      anchor: anchor.position,
      text: name,
      font: BH_CANVAS_FONT,
      color: BH_CANVAS_COLOR,
      shadowColor: BH_CANVAS_SHADOW.color,
      shadowBlur: BH_CANVAS_SHADOW.blur,
      subtitleFont: BH_SUBTITLE_FONT,
      subtitleColor: BH_SUBTITLE_COLOR,
      rank: 1800 + (isFavorite(name) ? 5000 : 0),
      marginTop: 0,
      centered: true,
      opacityTarget: 0,
      payload: { name },
    });
  }

  registerLabelType(bhHandler);
}
