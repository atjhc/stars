import * as THREE from "three";
import { scene, animateTo, setMinOrbitOverride, distanceFromCamera } from "./scene.ts";
import { SCALE, LY_PER_PARSEC, solDistanceFade, TILE_BASE_URL, formatAstroDistance } from "./constants.ts";
import { setLabelsDirty } from "./systemStore.ts";
import { isDustVisible } from "./dust.ts";
import { registerLabelType, type LabelTypeHandler } from "./labelRegistry.ts";
import { favoriteIcon } from "./detail.ts";
import { isFavorite } from "./favorites.ts";
import {
  registerCanvasLabel, updateCanvasLabel,
} from "./labelCanvas.ts";
import { inSolarSystemView } from "./planets.ts";

const NEBULA_CANVAS_FONT = `13px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const NEBULA_CANVAS_COLOR = "rgba(255,180,120,0.85)";
const NEBULA_CANVAS_SHADOW = { color: "rgba(200,120,60,0.7)", blur: 6 };
const NEBULA_CANVAS_GLOW = { color: "rgba(255,160,80,1.0)", blur: 12 };
const NEBULA_SUBTITLE_FONT = `9px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const NEBULA_SUBTITLE_COLOR = "rgba(170,170,170,0.9)";

interface NebulaEntry {
  aliases?: string[];
  type: string;
  pos_pc: [number, number, number];
  wikipedia?: string;
  notes?: string;
  scene_pos: [number, number, number];
  dist_pc: number;
}

interface NebulaLabel {
  name: string;
  entry: NebulaEntry;
  anchor: THREE.Object3D;
}

// Zoom floor for a selected nebula (~5 pc / 16 ly). Nebulae are
// volumetric — too-close zoom puts the camera inside the dust cube
// with nothing useful to see.
const NEBULA_MIN_ORBIT = 15;

const nebulaLabels: NebulaLabel[] = [];
let selectedNebula: NebulaLabel | null = null;
let hoveredNebula: NebulaLabel | null = null;
let maxSolDist = 0;


// Detail-panel distance formatter — intentionally surfaces both ly and pc.
// Subtitles use formatAstroDistance (km → AU → ly cascade).
function formatDistFull(pc: number): string {
  return `${(pc * LY_PER_PARSEC).toFixed(1)} ly (${pc.toFixed(2)} pc)`;
}

function canvasIdFor(name: string): string { return `nebula:${name}`; }

function applyGlow(nl: NebulaLabel) {
  updateCanvasLabel(canvasIdFor(nl.name), {
    shadowColor: NEBULA_CANVAS_GLOW.color,
    shadowBlur: NEBULA_CANVAS_GLOW.blur,
  });
}
function removeGlow(nl: NebulaLabel) {
  updateCanvasLabel(canvasIdFor(nl.name), {
    shadowColor: NEBULA_CANVAS_SHADOW.color,
    shadowBlur: NEBULA_CANVAS_SHADOW.blur,
  });
}

function buildDetailHtml(nl: NebulaLabel): string {
  const e = nl.entry;
  const distPc = distanceFromCamera(nl.anchor.position) / SCALE;
  const aliasLine = e.aliases && e.aliases.length > 0
    ? `<div class="star-aliases">${e.aliases.join(" · ")}</div>` : "";
  const wikiLink = e.wikipedia
    ? `<div class="star-wiki"><a href="${e.wikipedia}" target="_blank">Wikipedia</a></div>` : "";
  const notes = e.notes ? `<div class="star-notes">${e.notes}</div>` : "";

  return `
    ${favoriteIcon(nl.name)}
    <div class="star-name">${nl.name}</div>
    ${aliasLine}
    <div class="detail-body">
      <div class="star-detail">Type: ${e.type}<br>Distance: ${formatDistFull(distPc)}</div>
      ${notes}
      ${wikiLink}
    </div>`;
}

const nebulaHandler: LabelTypeHandler = {
  type: "nebula",
  searchKind: "n",
  searchKeywords: ["nebula", "molecular cloud", "dark nebula"],
  searchLabel: "Nebula",

  setVisible(v) {
    for (const nl of nebulaLabels) {
      nl.anchor.visible = v && isDustVisible();
      const isActive = nl === selectedNebula || nl === hoveredNebula;
      if (nl.anchor.visible) {
        updateCanvasLabel(canvasIdFor(nl.name), {
          hidden: false,
          opacityTarget: isActive ? 1.0 : solDistanceFade(nl.anchor.position.length(), maxSolDist),
        });
      } else {
        updateCanvasLabel(canvasIdFor(nl.name), { hidden: true });
      }
    }
  },

  update() {
    if (maxSolDist === 0 && nebulaLabels.length > 0) {
      for (const nl of nebulaLabels) {
        const d = nl.anchor.position.length();
        if (d > maxSolDist) maxSolDist = d;
      }
    }
    const hideForSolarView = inSolarSystemView();
    for (const nl of nebulaLabels) {
      const isActive = nl === selectedNebula || nl === hoveredNebula;
      if (!nl.anchor.visible) {
        updateCanvasLabel(canvasIdFor(nl.name), { hidden: true });
        continue;
      }
      if (hideForSolarView && !isActive) {
        updateCanvasLabel(canvasIdFor(nl.name), { hidden: true, pinned: false });
        continue;
      }
      const camDist = distanceFromCamera(nl.anchor.position);
      const subtitles = isActive ? [formatAstroDistance(camDist)] : [];
      const opacity = isActive ? 1.0
        : solDistanceFade(nl.anchor.position.length(), maxSolDist);
      updateCanvasLabel(canvasIdFor(nl.name), {
        hidden: false,
        opacityTarget: opacity,
        pinned: isActive,
        subtitles,
      });
    }
  },

  selectByName(name) {
    const nl = nebulaLabels.find((n) => n.name === name);
    if (!nl) return false;
    if (selectedNebula && selectedNebula !== nl) removeGlow(selectedNebula);
    selectedNebula = nl;
    applyGlow(nl);
    // The centroid of a nebula isn't interesting on its own — what
    // matters is seeing the surrounding volume. 5 pc keeps enough of
    // the dust structure in frame. Override goes BEFORE animateTo so
    // its default toRadius picks up the new floor.
    setMinOrbitOverride(NEBULA_MIN_ORBIT);
    animateTo(nl.anchor.position, NEBULA_MIN_ORBIT);
    setLabelsDirty(true);
    return true;
  },

  clearSelection() {
    if (selectedNebula) { removeGlow(selectedNebula); selectedNebula = null; setMinOrbitOverride(null); }
    if (hoveredNebula) { removeGlow(hoveredNebula); hoveredNebula = null; }
  },

  getSelectedName() {
    return selectedNebula?.name ?? null;
  },

  setHoverByName(name) {
    const next = name ? nebulaLabels.find((n) => n.name === name) ?? null : null;
    if (hoveredNebula === next) return;
    if (hoveredNebula && selectedNebula !== hoveredNebula) removeGlow(hoveredNebula);
    hoveredNebula = next;
    if (next && selectedNebula !== next) applyGlow(next);
  },

  handleClick(div) {
    const name = div.getAttribute("data-label-name");
    return name ? this.selectByName(name) : false;
  },

  detailHtml() {
    return selectedNebula ? buildDetailHtml(selectedNebula) : null;
  },

};

export async function initNebulaeLabels(): Promise<void> {
  const resp = await fetch(`${TILE_BASE_URL}nebulae.json`);
  if (!resp.ok) return;
  const data: Record<string, NebulaEntry> = await resp.json();

  for (const [name, entry] of Object.entries(data)) {
    const anchor = new THREE.Object3D();
    anchor.position.set(entry.scene_pos[0], entry.scene_pos[1], entry.scene_pos[2]);
    scene.add(anchor);

    const nl: NebulaLabel = { name, entry, anchor };
    nebulaLabels.push(nl);

    registerCanvasLabel({
      id: canvasIdFor(name),
      kind: "nebula",
      anchor: anchor.position,
      text: name,
      font: NEBULA_CANVAS_FONT,
      color: NEBULA_CANVAS_COLOR,
      shadowColor: NEBULA_CANVAS_SHADOW.color,
      shadowBlur: NEBULA_CANVAS_SHADOW.blur,
      subtitleFont: NEBULA_SUBTITLE_FONT,
      subtitleColor: NEBULA_SUBTITLE_COLOR,
      rank: 2000 + (isFavorite(name) ? 5000 : 0),
      marginTop: 0,
      centered: true,
      opacityTarget: 0,
      payload: { name },
    });
  }

  registerLabelType(nebulaHandler);
  console.log(`Nebula labels: ${nebulaLabels.length} placed`);
}
