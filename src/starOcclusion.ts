import { effectiveCamDist } from "./scene.ts";
import { getSelectedMesh } from "./systemStore.ts";
import { starRadiusScene } from "./color.ts";
import { computeStarScreenMetrics } from "./stars.ts";
import { registerScreenOccluder, type Occluder } from "./labelRegistry.ts";
import type { Star } from "./types.ts";

function metricsFor(star: Star, camDist: number) {
  const radius = starRadiusScene(star.lum, star.ci);
  return computeStarScreenMetrics(radius, star.absmag ?? 10, camDist);
}

// Full visible extent (disc + corona rim). Used for the screen-space
// occluder so labels behind the bright star region get hidden.
export function getStarVisualPx(): number {
  const selected = getSelectedMesh();
  const star = selected?.userData as Star | undefined;
  if (!selected || !star) return 0;
  return metricsFor(star, effectiveCamDist(selected.position)).halfBillPx;
}

function getStarScreenOcclusion(): Occluder | null {
  const visualPx = getStarVisualPx();
  if (visualPx <= 0) return null;
  return {
    cx: window.innerWidth / 2,
    cy: window.innerHeight / 2,
    radius: visualPx * 1.25,
  };
}

registerScreenOccluder(getStarScreenOcclusion);
