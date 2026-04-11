import type * as THREE from "three";
import type { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { LabelRow } from "./catalog.ts";

// Star is an alias for the streamed catalog row that's stored on
// mesh.userData for every interactive star in the scene.
export type Star = LabelRow & { tile?: string };

interface SystemGroupBase {
  name: string;
  meshes: THREE.Object3D[];
  label: CSS2DObject;
  anchor: THREE.Object3D;
  centroid: THREE.Vector3;
  avgDist: number;
  wikipedia?: string;
  notes?: string;
}

export interface BinarySystem extends SystemGroupBase {
  kind: "binary";
  collapsedMembers: THREE.Object3D[];
  screens: { x: number; y: number }[];
  parents: number[];
}

export interface ClusterGroup extends SystemGroupBase {
  kind: "cluster";
  defaultShadow: string;
  aliases?: string[];
}

export type SystemGroup = BinarySystem | ClusterGroup;
