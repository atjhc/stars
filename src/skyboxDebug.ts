// Calibration overlay for the Milky Way skybox: gated on `?skyboxdebug=1`.
// Renders bright markers in scene-space at known galactic directions —
// galactic centre/anti-centre, l=±90° cardinals, both galactic poles,
// and a sparse equator/meridian grid. Each marker is positioned by
// applying GAL_TO_SCENE to a known galactic-frame direction, so if the
// inverse matrix in `src/skybox.ts` is correct, every marker lands on
// the panorama feature it names. Specifically: GC must sit on the
// bright bulge, NGP/SGP at the top/bottom of the visible Milky Way
// arch, and the b=0 row of grid dots must trace the bright band.

import * as THREE from "three";
import { scene, galX, galZ, galUp, GAL_TO_SCENE } from "./scene.ts";

// Far enough that the markers feel "at infinity" relative to the dust
// volume (~1 kpc / ~5000 scene units) but still well inside the
// camera's far plane (20000+).
const FAR = 8000;

const skyboxDebugEnabled = new URLSearchParams(window.location.search).get("skyboxdebug") === "1";

interface Landmark { name: string; gal: [number, number, number]; }

function galDir(lDeg: number, bDeg: number): [number, number, number] {
  const l = (lDeg * Math.PI) / 180;
  const b = (bDeg * Math.PI) / 180;
  return [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
}

const LANDMARKS: Landmark[] = [
  { name: "GC",     gal: galDir(0, 0) },
  { name: "AC",     gal: galDir(180, 0) },
  { name: "l=+90°", gal: galDir(90, 0) },
  { name: "l=-90°", gal: galDir(-90, 0) },
  { name: "NGP",    gal: galDir(0, 90) },
  { name: "SGP",    gal: galDir(0, -90) },
];

// Sparse grid: every 30° in longitude along b=0, plus b=±30° at the
// six cardinal meridians. Unnamed — just dots.
const GRID: [number, number, number][] = [];
for (const lDeg of [-150, -120, -60, -30, 30, 60, 120, 150]) GRID.push(galDir(lDeg, 0));
for (const bDeg of [-30, 30]) {
  for (const lDeg of [-90, 0, 90, 180]) GRID.push(galDir(lDeg, bDeg));
}

function makeLabelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 80;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 36px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.strokeText(text, 128, 40);
  ctx.fillStyle = "#ff66ff";
  ctx.fillText(text, 128, 40);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(800, 250, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function placeAtGalDir(obj: THREE.Object3D, gal: [number, number, number]): void {
  const v = new THREE.Vector3(...gal).applyMatrix3(GAL_TO_SCENE).multiplyScalar(FAR);
  obj.position.copy(v);
}

const DOT_GEOM = new THREE.SphereGeometry(40, 12, 8);
const NAMED_DOT_MAT = new THREE.MeshBasicMaterial({ color: 0xff66ff, depthTest: false });
const GRID_DOT_MAT = new THREE.MeshBasicMaterial({ color: 0x00ffff, depthTest: false });
// Green great-circle markers traced in the gridMesh's actual plane
// (using the same galX/galZ basis scene.ts uses to orient the grid),
// for direct visual comparison against the cyan b=0 markers above.
// If these don't overlay, the grid plane differs from the panorama
// plane and we have a real bug; if they do, the perceived skew is
// purely viewing-angle.
const GRID_PLANE_MAT = new THREE.MeshBasicMaterial({ color: 0x00ff66, depthTest: false });

export function initSkyboxDebug(): void {
  if (!skyboxDebugEnabled) return;

  for (const lm of LANDMARKS) {
    const dot = new THREE.Mesh(DOT_GEOM, NAMED_DOT_MAT);
    dot.renderOrder = 999;
    placeAtGalDir(dot, lm.gal);
    scene.add(dot);

    const label = makeLabelSprite(lm.name);
    placeAtGalDir(label, lm.gal);
    // Offset in scene-space so the label doesn't overlap the dot.
    label.position.y += 200;
    scene.add(label);
  }

  for (const g of GRID) {
    const dot = new THREE.Mesh(DOT_GEOM, GRID_DOT_MAT);
    dot.renderOrder = 999;
    placeAtGalDir(dot, g);
    scene.add(dot);
  }

  // Green great-circle traced in the gridMesh's plane (scene.ts's
  // galX × galZ basis). Same FAR distance as the panorama markers so
  // the comparison is direct.
  const ringSteps = 72;
  for (let i = 0; i < ringSteps; i++) {
    const a = (i / ringSteps) * Math.PI * 2;
    const dir = new THREE.Vector3()
      .addScaledVector(galX, Math.cos(a))
      .addScaledVector(galZ, Math.sin(a))
      .normalize();
    const dot = new THREE.Mesh(DOT_GEOM, GRID_PLANE_MAT);
    dot.renderOrder = 999;
    dot.position.copy(dir).multiplyScalar(FAR);
    scene.add(dot);
  }
  // Pole markers along ±galUp so we can see exactly which axis the
  // grid considers its normal.
  for (const sign of [1, -1]) {
    const dot = new THREE.Mesh(DOT_GEOM, GRID_PLANE_MAT);
    dot.renderOrder = 999;
    dot.position.copy(galUp).multiplyScalar(sign * FAR);
    scene.add(dot);
  }

  console.log(`[skyboxdebug] placed ${LANDMARKS.length} named + ${GRID.length} grid markers + ${ringSteps + 2} grid-plane traces`);
}
