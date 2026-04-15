import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import {
  scene, camera, animateTo, setMinOrbitOverride,
  isDeepZoom, orbitRadius, lensingPass, BLOOM_OVERSCAN,
} from "./scene.ts";
import { SCALE, LY_PER_PARSEC, solDistanceFade, TILE_BASE_URL } from "./constants.ts";
import { initLabelDragFn } from "./starfield.ts";
import { setLabelsDirty } from "./systemStore.ts";
import { registerLabelType, type LabelTypeHandler } from "./labelRegistry.ts";
import type { RankedLabel } from "./labelCollision.ts";
import { favoriteIcon } from "./detail.ts";
import { isFavorite } from "./favorites.ts";

// 0.001 ly ≈ 3e-4 pc × SCALE(3) ≈ 0.001 scene units
const BH_MIN_ORBIT = 0.001;

const BH_LABEL_CSS = `
  color: rgba(180,140,220,0.85); font-size: 12px;
  letter-spacing: 0.5px;
  pointer-events: auto; white-space: nowrap;
  text-shadow: 0 0 8px rgba(120,80,180,0.6), 0 0 3px #000;
  -webkit-user-select: none; user-select: none; text-align: center; cursor: pointer;
`;

const BH_GLOW = "0 0 12px rgba(160,100,220,1.0), 0 0 28px rgba(130,70,200,0.5), 0 0 4px rgba(200,160,255,0.9)";
const BH_DEFAULT_SHADOW = "0 0 8px rgba(120,80,180,0.6), 0 0 3px #000";

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
  div: HTMLElement;
  distDiv: HTMLElement;
}

const blackHoleLabels: BlackHoleLabel[] = [];
let selectedBH: BlackHoleLabel | null = null;
let hoveredBH: BlackHoleLabel | null = null;
let maxSolDist = 0;

function formatBHDist(pc: number): string {
  const ly = pc * LY_PER_PARSEC;
  const au = ly * 63241;
  const km = au * 1.496e8;
  if (km < 1e6) return `${km.toFixed(0)} km`;
  if (au < 1000) return `${au.toFixed(1)} AU`;
  if (ly < 10) return `${ly.toFixed(2)} ly`;
  return `${ly.toFixed(1)} ly`;
}

function applyGlow(bh: BlackHoleLabel) {
  bh.div.style.textShadow = BH_GLOW;
  setLabelsDirty(true);
}

function removeGlow(bh: BlackHoleLabel) {
  bh.div.style.textShadow = BH_DEFAULT_SHADOW;
  setLabelsDirty(true);
}

function buildDetailHtml(bh: BlackHoleLabel): string {
  const e = bh.entry;
  const distPc = (bh === selectedBH ? orbitRadius : bh.anchor.position.distanceTo(camera.position)) / SCALE;
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
        Distance: ${formatBHDist(distPc)}<br>
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
    for (const bh of blackHoleLabels) bh.anchor.visible = v;
  },

  update() {
    if (maxSolDist === 0 && blackHoleLabels.length > 0) {
      for (const bh of blackHoleLabels) {
        const d = bh.anchor.position.length();
        if (d > maxSolDist) maxSolDist = d;
      }
    }
    for (const bh of blackHoleLabels) {
      const isActive = bh === selectedBH || bh === hoveredBH;
      if (isActive) {
        // Use orbitRadius for true distance (main camera is clamped in deep zoom)
        const trueDist = bh === selectedBH ? orbitRadius : bh.anchor.position.distanceTo(camera.position);
        const pc = trueDist / SCALE;
        const ly = pc * LY_PER_PARSEC;
        const au = ly * 63241;
        const km = au * 1.496e8;
        let distText: string;
        if (km < 1e6) distText = `${km.toFixed(0)} km`;
        else if (au < 1000) distText = `${au.toFixed(1)} AU`;
        else if (ly < 10) distText = `${ly.toFixed(2)} ly`;
        else distText = `${ly.toFixed(1)} ly`;
        bh.distDiv.textContent = distText;
        bh.distDiv.style.display = "";
      } else {
        bh.distDiv.style.display = "none";
      }
      bh.div.style.marginTop = "16px";
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
    setMinOrbitOverride(BH_MIN_ORBIT);
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

  collectVisibleLabels() {
    const result: RankedLabel[] = [];
    for (const bh of blackHoleLabels) {
      if (!bh.anchor.visible) continue;
      const isActive = bh === selectedBH || bh === hoveredBH;
      const solDist = bh.anchor.position.length();
      const opacity = isActive ? 1.0 : solDistanceFade(solDist, maxSolDist);
      const favBonus = isFavorite(bh.name) ? 5000 : 0;
      result.push({
        div: bh.div,
        rank: 1800 + favBonus,
        pinned: isActive,
        opacity,
      });
    }
    return result;
  },
};

export async function initBlackHoleLabels(): Promise<void> {
  const resp = await fetch(`${TILE_BASE_URL}blackholes.json`);
  if (!resp.ok) return;
  const data: Record<string, BlackHoleEntry> = await resp.json();

  for (const [name, entry] of Object.entries(data)) {
    const div = document.createElement("div");
    div.style.cssText = BH_LABEL_CSS;
    div.innerHTML = `<div>${name}</div><div class="system-members" style="display:none"></div>`;
    div.setAttribute("data-label-type", "blackhole");
    div.setAttribute("data-label-name", name);
    if (initLabelDragFn) initLabelDragFn(div);

    const anchor = new THREE.Object3D();
    anchor.position.set(entry.scene_pos[0], entry.scene_pos[1], entry.scene_pos[2]);

    const label = new CSS2DObject(div);
    label.center.set(0.5, 0);
    anchor.add(label);
    scene.add(anchor);

    const distDiv = div.querySelector("div:last-child") as HTMLElement;
    const bh: BlackHoleLabel = { name, entry, anchor, div, distDiv };
    blackHoleLabels.push(bh);

    div.addEventListener("mouseenter", () => {
      if (selectedBH !== bh) { hoveredBH = bh; applyGlow(bh); }
    });
    div.addEventListener("mouseleave", () => {
      if (hoveredBH === bh) { hoveredBH = null; if (selectedBH !== bh) removeGlow(bh); }
    });
  }

  registerLabelType(bhHandler);
}
