import type * as THREE from "three";
import type { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { LabelRow } from "./catalog.ts";

// Star is an alias for the streamed catalog row that's stored on
// mesh.userData for every interactive star in the scene.
export type Star = LabelRow & { tile?: string };

export interface SystemGroup {
  name: string;
  meshes: THREE.Object3D[];
  label: CSS2DObject;
  anchor: THREE.Object3D;
  centroid: THREE.Vector3;
  avgDist: number;
  collapsedMembers: THREE.Object3D[];
  screens: { x: number; y: number }[];
  parents: number[];
  kind?: "cluster";
  aliases?: string[];
  wikipedia?: string;
  notes?: string;
}
