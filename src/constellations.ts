import * as THREE from "three";
import type { Star } from "./types.ts";
import { scene } from "./scene.ts";
import { notableObjects } from "./starfield.ts";

interface ConstellationDef {
  iau: string;
  description?: string;
  lines: [string, string][];
}

const TILE_BASE_URL = "/tiles/";

let constellations: Record<string, ConstellationDef> = {};
let lineSegments: THREE.LineSegments | null = null;

export async function initConstellations(): Promise<void> {
  const res = await fetch(`${TILE_BASE_URL}constellations.json`);
  if (!res.ok) {
    console.warn("constellations.json not found — constellation lines disabled");
    return;
  }
  constellations = await res.json();
  buildLineGeometry();
  console.log(
    `Constellations: ${Object.keys(constellations).length} loaded, ${(lineSegments?.geometry.attributes.position.count ?? 0) / 2} lines`,
  );
}

function buildLineGeometry(): void {
  const byName = new Map<string, THREE.Object3D>();
  for (const anchor of notableObjects) {
    const star = anchor.userData as Star;
    if (star.name) byName.set(star.name, anchor);
  }

  const positions: number[] = [];
  const unresolved = new Set<string>();
  for (const cdata of Object.values(constellations)) {
    for (const [a, b] of cdata.lines) {
      const oa = byName.get(a);
      const ob = byName.get(b);
      if (!oa) unresolved.add(a);
      if (!ob) unresolved.add(b);
      if (!oa || !ob) continue;
      positions.push(oa.position.x, oa.position.y, oa.position.z);
      positions.push(ob.position.x, ob.position.y, ob.position.z);
    }
  }
  if (unresolved.size > 0) {
    console.warn(`[constellations] unresolved stars: ${[...unresolved].join(", ")}`);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

  const material = new THREE.LineBasicMaterial({
    color: 0x88aadd,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  lineSegments = new THREE.LineSegments(geometry, material);
  lineSegments.frustumCulled = false;
  lineSegments.visible = true;
  scene.add(lineSegments);
}

export function setConstellationsVisible(v: boolean): void {
  if (lineSegments) lineSegments.visible = v;
}

export function toggleConstellations(): void {
  if (lineSegments) lineSegments.visible = !lineSegments.visible;
}

export function constellationsVisible(): boolean {
  return lineSegments?.visible ?? false;
}
