import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { scene, camera, animateTo } from "./scene.ts";
import { NEBULA_LABEL_CSS, NEBULA_DEFAULT_SHADOW, SCALE, LY_PER_PARSEC, solDistanceFade, TILE_BASE_URL } from "./constants.ts";
import { initLabelDragFn } from "./starfield.ts";
import { setLabelsDirty } from "./systemStore.ts";
import { isDustVisible } from "./dust.ts";
import { registerLabelType, type LabelTypeHandler } from "./labelRegistry.ts";
import type { RankedLabel } from "./labelCollision.ts";
import { favoriteIcon } from "./detail.ts";
import { isFavorite } from "./favorites.ts";

const NEBULA_GLOW = "0 0 12px rgba(255,160,80,1.0), 0 0 28px rgba(255,130,50,0.5), 0 0 4px rgba(255,200,150,0.9)";

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
  div: HTMLElement;
  distDiv: HTMLElement;
}

const nebulaLabels: NebulaLabel[] = [];
let selectedNebula: NebulaLabel | null = null;
let hoveredNebula: NebulaLabel | null = null;
let maxSolDist = 0;

function formatDist(pc: number): string {
  const ly = pc * LY_PER_PARSEC;
  return ly < 100 ? `${ly.toFixed(1)} ly` : `${Math.round(ly)} ly`;
}

function formatDistFull(pc: number): string {
  return `${(pc * LY_PER_PARSEC).toFixed(1)} ly (${pc.toFixed(2)} pc)`;
}

function applyGlow(nl: NebulaLabel) { nl.div.style.textShadow = NEBULA_GLOW; }
function removeGlow(nl: NebulaLabel) { nl.div.style.textShadow = NEBULA_DEFAULT_SHADOW; }

function buildDetailHtml(nl: NebulaLabel): string {
  const e = nl.entry;
  const distPc = nl.anchor.position.distanceTo(camera.position) / SCALE;
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

  setVisible(v) {
    for (const nl of nebulaLabels) nl.anchor.visible = v && isDustVisible();
  },

  update() {
    if (maxSolDist === 0 && nebulaLabels.length > 0) {
      for (const nl of nebulaLabels) {
        const d = nl.anchor.position.length();
        if (d > maxSolDist) maxSolDist = d;
      }
    }
    // Only update distance subtitle — opacity is managed by resolveCollisions
    for (const nl of nebulaLabels) {
      const isActive = nl === selectedNebula || nl === hoveredNebula;
      if (isActive) {
        const camDist = nl.anchor.position.distanceTo(camera.position);
        const distPc = camDist / SCALE;
        nl.distDiv.textContent = formatDist(distPc);
        nl.distDiv.style.display = "";
      } else {
        nl.distDiv.style.display = "none";
      }
    }
  },

  selectByName(name) {
    const nl = nebulaLabels.find((n) => n.name === name);
    if (!nl) return false;
    if (selectedNebula && selectedNebula !== nl) removeGlow(selectedNebula);
    selectedNebula = nl;
    applyGlow(nl);
    animateTo(nl.anchor.position);
    setLabelsDirty(true);
    return true;
  },

  clearSelection() {
    if (selectedNebula) { removeGlow(selectedNebula); selectedNebula = null; }
    if (hoveredNebula) { removeGlow(hoveredNebula); hoveredNebula = null; }
  },

  handleClick(div) {
    const name = div.getAttribute("data-label-name");
    return name ? this.selectByName(name) : false;
  },

  detailHtml() {
    return selectedNebula ? buildDetailHtml(selectedNebula) : null;
  },

  collectVisibleLabels() {
    const result: RankedLabel[] = [];
    for (const nl of nebulaLabels) {
      if (!nl.anchor.visible) continue;
      const isActive = nl === selectedNebula || nl === hoveredNebula;
      const solDist = nl.anchor.position.length();
      const opacity = isActive ? 1.0 : solDistanceFade(solDist, maxSolDist);
      const favBonus = isFavorite(nl.name) ? 5000 : 0;
      result.push({
        div: nl.div,
        rank: 2000 + favBonus,
        pinned: isActive,
        opacity,
      });
    }
    return result;
  },
};

export async function initNebulaeLabels(): Promise<void> {
  const resp = await fetch(`${TILE_BASE_URL}nebulae.json`);
  if (!resp.ok) return;
  const data: Record<string, NebulaEntry> = await resp.json();

  for (const [name, entry] of Object.entries(data)) {
    const div = document.createElement("div");
    div.style.cssText = NEBULA_LABEL_CSS;
    div.innerHTML = `<div>${name}</div><div class="system-members" style="display:none"></div>`;
    div.setAttribute("data-label-type", "nebula");
    div.setAttribute("data-label-name", name);
    if (initLabelDragFn) initLabelDragFn(div);

    const anchor = new THREE.Object3D();
    anchor.position.set(entry.scene_pos[0], entry.scene_pos[1], entry.scene_pos[2]);
    const label = new CSS2DObject(div);
    label.center.set(0.5, 0);
    anchor.add(label);
    scene.add(anchor);

    const distDiv = div.querySelector("div:last-child") as HTMLElement;
    const nl: NebulaLabel = { name, entry, anchor, div, distDiv };
    nebulaLabels.push(nl);

    div.addEventListener("mouseenter", () => {
      if (selectedNebula !== nl) { hoveredNebula = nl; applyGlow(nl); }
    });
    div.addEventListener("mouseleave", () => {
      if (hoveredNebula === nl && selectedNebula !== nl) { hoveredNebula = null; removeGlow(nl); }
    });
  }

  registerLabelType(nebulaHandler);
  console.log(`Nebula labels: ${nebulaLabels.length} placed`);
}
