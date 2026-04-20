import * as THREE from "three";
import type { Star } from "./types.ts";
import { HIT_PX_PADDING } from "./constants.ts";
import { starRadiusScene } from "./color.ts";
import { computeStarScreenMetrics } from "./stars.ts";
import { camera } from "./scene.ts";

// Lightweight Object3D anchors for labeled stars. Carry a CSS2D label
// and a screen-space raycast hit sphere. No geometry — visuals come
// from the instanced mesh in stars.ts.

const scratchVec3 = new THREE.Vector3();

// Screen-space hit sphere sized from the star's full visible extent
// (disc + halo corona) plus a few pixels of padding. At normal zoom,
// discPx ≈ 0 for almost every star — the halo is what's visible — so
// sizing off `halfBillPx` instead of `discPx` keeps bright stars with
// big halos easy to click and gives sub-pixel stars a ~coronaPx +
// HIT_PX_PADDING circle that still matches what the user sees.
function attachHitSphere(obj: THREE.Object3D) {
  const hitSphere = new THREE.Sphere(new THREE.Vector3(), 0);
  obj.raycast = (raycaster, intersects) => {
    if (obj.visible === false) return;
    hitSphere.center.copy(obj.getWorldPosition(scratchVec3));
    const camDist = hitSphere.center.distanceTo(raycaster.ray.origin);
    const star = obj.userData as Star;
    const radius = starRadiusScene(star.lum, star.ci);
    const { halfBillPx } = computeStarScreenMetrics(radius, star.absmag ?? 10, Math.max(camDist, 1e-20));
    // Convert hit pixel radius → scene-unit radius at camDist.
    const fovRad = (camera.fov * Math.PI) / 180;
    const scenePerPx = (camDist * Math.tan(fovRad / 2)) / (window.innerHeight / 2);
    hitSphere.radius = (halfBillPx + HIT_PX_PADDING) * scenePerPx;
    const intersection = raycaster.ray.intersectSphere(hitSphere, scratchVec3);
    if (intersection) {
      const distance = raycaster.ray.origin.distanceTo(intersection);
      if (distance >= raycaster.near && distance <= raycaster.far) {
        intersects.push({ distance, point: intersection.clone(), object: obj });
      }
    }
  };
}

// Create a labelable, hit-testable Object3D at a star's position. Used for
// tier-0 (eagerly loaded from notable.json) and tier-1 (spawned when the
// containing tile's labels stream in). Starts hidden — labels.ts flips
// .visible on the first pass to avoid a flash of every label at page load.
export function createStarAnchor(star: Star, sx: number, sy: number, sz: number): THREE.Object3D {
  const anchor = new THREE.Object3D();
  anchor.position.set(sx, sy, sz);
  anchor.userData = star;
  anchor.visible = false;
  attachHitSphere(anchor);
  return anchor;
}

