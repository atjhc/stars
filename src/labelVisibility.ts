import type * as THREE from "three";
import type { SystemGroup } from "./types.ts";

export interface HighlightContext {
  meshToSystem: Map<THREE.Object3D, SystemGroup>;
  clusterOf: Map<THREE.Object3D, SystemGroup>;
  hoveredSystem: SystemGroup | null;
  selectedSystem: SystemGroup | null;
  lastHoveredMesh: THREE.Object3D | null;
  selectedMesh: THREE.Object3D | null;
}

// Label highlight = full opacity + glow + subtitle. True for individually
// hovered/selected stars, and for binary/trinary system members whose
// system is active. Cluster members are NOT label-highlighted when only
// their cluster is active — they get billboard glow via highlightSystem
// but their labels stay at normal opacity. A cluster member IS
// label-highlighted when individually hovered or selected.
export function shouldHighlightLabel(
  target: THREE.Object3D,
  ctx: HighlightContext,
): boolean {
  if (target === ctx.lastHoveredMesh || target === ctx.selectedMesh) return true;

  const sys = ctx.meshToSystem.get(target);
  if (sys && (sys === ctx.hoveredSystem || sys === ctx.selectedSystem)) return true;

  // Cluster membership does NOT trigger label highlight — only billboard glow.
  return false;
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

