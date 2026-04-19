import type * as THREE from "three";
import type { SystemGroup } from "./types.ts";

export interface HighlightContext {
  meshToSystem: Map<THREE.Object3D, SystemGroup>;
  clusterOf: Map<THREE.Object3D, SystemGroup>;
  hoveredSystem: SystemGroup | null;
  selectedSystem: SystemGroup | null;
  selectedSubset: THREE.Object3D[] | null;
  lastHoveredMesh: THREE.Object3D | null;
  selectedMesh: THREE.Object3D | null;
}

// Label highlight = full opacity + glow + subtitle. True for individually
// hovered/selected stars, and for binary/trinary system members that are
// part of the active sub-selection. When a subset is pinned (e.g. A+B in
// Alpha Centauri), non-subset members (Proxima) render independently —
// the system designation is just a grouping for search/cluster labels,
// not a blanket highlight. Cluster members keep normal label opacity
// when only their cluster is active.
export function shouldHighlightLabel(
  target: THREE.Object3D,
  ctx: HighlightContext,
): boolean {
  if (target === ctx.lastHoveredMesh || target === ctx.selectedMesh) return true;

  const sys = ctx.meshToSystem.get(target);
  if (!sys) return false;

  if (sys === ctx.hoveredSystem) return true;
  if (sys !== ctx.selectedSystem) return false;

  return ctx.selectedSubset ? ctx.selectedSubset.includes(target) : true;
}

// Whether the target should be kept visible (target.visible = true) even
// when its normal fade would hide it. True for cluster members whose
// cluster is active, so the billboard glow renders.
export function shouldForceVisible(
  target: THREE.Object3D,
  ctx: HighlightContext,
): boolean {
  const cluster = ctx.clusterOf.get(target);
  return cluster !== undefined && (cluster === ctx.hoveredSystem || cluster === ctx.selectedSystem);
}

