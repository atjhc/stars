import * as THREE from "three";
import type { Star } from "./types.ts";
import { LABEL_CSS } from "./constants.ts";
import { scene } from "./scene.ts";
import { createBillboardMesh, createStarLabel } from "./billboard.ts";
import notableData from "../data/notable-stars.json";

export const notableObjects: THREE.Mesh[] = [];
export const notableLabelMap = new WeakMap<THREE.Mesh, HTMLElement>();
export const notableLabelMeshMap = new WeakMap<HTMLElement, THREE.Mesh>();

export function createNotableStars(initLabelDrag: (div: HTMLElement) => void) {
  const group = new THREE.Group();
  scene.add(group);

  (notableData as Star[]).forEach((star) => {
    const mesh = createBillboardMesh(star);
    group.add(mesh);
    notableObjects.push(mesh);

    const { div } = createStarLabel(star, mesh, initLabelDrag);
    notableLabelMap.set(mesh, div);
    notableLabelMeshMap.set(div, mesh);
  });
}
