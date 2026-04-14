import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { scene, camera, animateTo, setMinOrbitOverride } from "./scene.ts";
import { SCALE, LY_PER_PARSEC, solDistanceFade, TILE_BASE_URL } from "./constants.ts";
import { initLabelDragFn } from "./starfield.ts";
import { setLabelsDirty } from "./systemStore.ts";
import { registerLabelType, type LabelTypeHandler } from "./labelRegistry.ts";
import type { RankedLabel } from "./labelCollision.ts";
import { favoriteIcon } from "./detail.ts";
import { isFavorite } from "./favorites.ts";

// 0.05 ly ≈ 0.0153 pc × SCALE(3) ≈ 0.046 scene units
const BH_MIN_ORBIT = 0.046;

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
  mesh: THREE.Mesh;
  div: HTMLElement;
  distDiv: HTMLElement;
}

const blackHoleLabels: BlackHoleLabel[] = [];
let selectedBH: BlackHoleLabel | null = null;
let hoveredBH: BlackHoleLabel | null = null;
let maxSolDist = 0;

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
  const distPc = bh.anchor.position.distanceTo(camera.position) / SCALE;
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
        Distance: ${(distPc * LY_PER_PARSEC).toFixed(1)} ly<br>
        Mass: ${e.mass_msun} M☉<br>
        Type: Stellar-mass black hole
      </div>
      ${notes}
      ${wikiLink}
    </div>`;
}

// Black hole visual: billboard quad sized to subtend a consistent angle
// that grows slowly at close range (sqrt falloff instead of 1/dist)
const BH_ANGULAR_SIZE = 0.075;

function createBlackHoleMesh(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      void main() {
        vec2 center = vUv - 0.5;
        float d = length(center) * 2.0;
        float core = step(d, 0.875);
        float edge = smoothstep(1.0, 0.875, d) * (1.0 - core);
        float t = (d - 0.875) / 0.125;
        vec3 hot = vec3(1.0, 0.95, 1.0);
        vec3 cool = vec3(0.4, 0.1, 0.55);
        vec3 color = mix(hot, cool, t) * edge;
        float alpha = core + edge * (1.0 - t * t) * 0.5;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
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
        const camDist = bh.anchor.position.distanceTo(camera.position);
        const ly = (camDist / SCALE) * LY_PER_PARSEC;
        bh.distDiv.textContent = ly < 10 ? `${ly.toFixed(2)} ly` : `${ly.toFixed(1)} ly`;
        bh.distDiv.style.display = "";
      } else {
        bh.distDiv.style.display = "none";
      }
      // Billboard: face camera, scale so it appears small when far and large when close
      const camDist = Math.max(0.01, bh.anchor.position.distanceTo(camera.position));
      const scale = BH_ANGULAR_SIZE * Math.sqrt(camDist);
      bh.mesh.scale.set(scale, scale, scale);
      bh.mesh.lookAt(camera.position);
      // Project disc radius to screen pixels for label offset
      const fov = camera.fov * Math.PI / 180;
      const screenPx = (scale * 0.9 / camDist) * (window.innerHeight / (2 * Math.tan(fov / 2)));
      bh.div.style.marginTop = `${Math.max(16, screenPx + 14)}px`;
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
    if (selectedBH) { removeGlow(selectedBH); selectedBH = null; setMinOrbitOverride(null); }
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

    const mesh = createBlackHoleMesh();
    anchor.add(mesh);

    const label = new CSS2DObject(div);
    label.center.set(0.5, 0);
    anchor.add(label);
    scene.add(anchor);

    const distDiv = div.querySelector("div:last-child") as HTMLElement;
    const bh: BlackHoleLabel = { name, entry, anchor, mesh, div, distDiv };
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
