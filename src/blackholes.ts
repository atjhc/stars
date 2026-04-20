import * as THREE from "three";
import {
  scene, camera, animateTo, setMinOrbitOverride,
  isDeepZoom, orbitRadius, lensingPass, BLOOM_OVERSCAN,
} from "./scene.ts";
import {
  SCALE, TILE_BASE_URL,
  DEEP_ZOOM_MIN_ORBIT, formatAstroDistance, solDistanceFade,
} from "./constants.ts";
import { setLabelsDirty } from "./systemStore.ts";
import { registerLabelType, registerScreenOccluder, type LabelTypeHandler } from "./labelRegistry.ts";
import { favoriteIcon } from "./detail.ts";
import { isFavorite } from "./favorites.ts";
import {
  registerCanvasLabel, updateCanvasLabel,
} from "./labelCanvas.ts";

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
  const dist = bh === selectedBH ? orbitRadius : bh.anchor.position.distanceTo(camera.position);
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

// Black hole visual: billboard quad sized to subtend a consistent angle
// that grows slowly at close range (sqrt falloff instead of 1/dist)
// Screen-space lensing pass control
const projVecBH = new THREE.Vector3();

function updateLensingPass(bh: BlackHoleLabel) {
  const uniforms = lensingPass.uniforms as Record<string, THREE.IUniform>;

  // BH is always at the orbit target — screen center. No need to project
  // (projection would suffer Float32 cancellation at deep zoom distances).
  uniforms.uBHScreen.value.set(0.5, 0.5);
  uniforms.uAspect.value = camera.aspect;

  // Schwarzschild radius → screen-space shadow fraction in overscan RT
  const rsKm = 2.953 * bh.entry.mass_msun;
  const rsPc = rsKm / 3.086e13;
  const rsScene = rsPc * SCALE;
  const fov = camera.fov * Math.PI / 180;
  const halfTan = Math.tan(fov / 2) * BLOOM_OVERSCAN;
  const shadowFrac = (2.6 * rsScene / orbitRadius) / (2 * halfTan);
  uniforms.uShadowRadius.value = shadowFrac;
  uniforms.uSchwarzRadius.value = (rsScene / orbitRadius) / (2 * halfTan);
  uniforms.uScreenScale.value = shadowFrac * window.innerHeight * BLOOM_OVERSCAN;

  lensingPass.enabled = true;
}

function disableLensingPass() {
  lensingPass.enabled = false;
}

export function getSelectedBlackHoleName(): string | null {
  return selectedBH?.name ?? null;
}

export function setBlackHoleHoverByName(name: string | null): void {
  const next = name ? blackHoleLabels.find((b) => b.name === name) ?? null : null;
  if (hoveredBH === next) return;
  if (hoveredBH && selectedBH !== hoveredBH) removeGlow(hoveredBH);
  hoveredBH = next;
  if (next && selectedBH !== next) applyGlow(next);
}

export function getBHScreenOcclusion(): { cx: number; cy: number; radius: number } | null {
  if (!lensingPass.enabled || !selectedBH) return null;
  const uniforms = lensingPass.uniforms as Record<string, THREE.IUniform>;
  const bhScreen = uniforms.uBHScreen.value as THREE.Vector2;
  const shadowFrac = uniforms.uShadowRadius.value as number;
  return {
    cx: bhScreen.x * window.innerWidth,
    cy: (1 - bhScreen.y) * window.innerHeight,
    radius: shadowFrac * window.innerHeight * 4,
  };
}

const bhHandler: LabelTypeHandler = {
  type: "blackhole",

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
    for (const bh of blackHoleLabels) {
      if (!bh.anchor.visible) {
        updateCanvasLabel(canvasIdFor(bh.name), { hidden: true });
        continue;
      }
      const isActive = bh === selectedBH || bh === hoveredBH;
      const trueDist = bh === selectedBH ? orbitRadius : bh.anchor.position.distanceTo(camera.position);
      const opacity = isActive ? 1.0 : solDistanceFade(bh.anchor.position.length(), maxSolDist);
      updateCanvasLabel(canvasIdFor(bh.name), {
        hidden: false,
        opacityTarget: opacity,
        pinned: isActive,
        subtitles: isActive ? [formatAstroDistance(trueDist)] : [],
      });
    }

    if (isDeepZoom() && selectedBH) {
      updateLensingPass(selectedBH);
    } else {
      disableLensingPass();
    }
  },

  selectByName(name) {
    const bh = blackHoleLabels.find((b) => b.name === name);
    if (!bh) return false;
    if (selectedBH && selectedBH !== bh) removeGlow(selectedBH);
    selectedBH = bh;
    applyGlow(bh);
    setMinOrbitOverride(DEEP_ZOOM_MIN_ORBIT);
    animateTo(bh.anchor.position);
    setLabelsDirty(true);
    return true;
  },

  clearSelection() {
    if (selectedBH) { removeGlow(selectedBH); selectedBH = null; setMinOrbitOverride(null); disableLensingPass(); }
    if (hoveredBH) { removeGlow(hoveredBH); hoveredBH = null; }
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
      marginTop: 16,
      opacityTarget: 0,
      payload: { name },
    });
  }

  registerLabelType(bhHandler);
  registerScreenOccluder(getBHScreenOcclusion);
}
