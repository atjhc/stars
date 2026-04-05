import type * as THREE from "three";
import type { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export interface Star {
  name: string;
  x: number;
  y: number;
  z: number;
  dist: number;
  mag: number;
  absmag: number;
  ci: number;
  spect: string;
  lum: number;
  aliases?: string[];
  wikipedia?: string;
  notes?: string;
  system?: string;
}

export interface SystemGroup {
  name: string;
  meshes: THREE.Mesh[];
  label: CSS2DObject;
  anchor: THREE.Object3D;
  centroid: THREE.Vector3;
  avgDist: number;
  collapsedMembers: THREE.Mesh[];
  screens: { x: number; y: number }[];
  parents: number[];
  notable: boolean;
}
