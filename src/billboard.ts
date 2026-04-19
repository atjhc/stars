import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Star } from "./types.ts";
import { LABEL_CSS, HIT_SCREEN_FRACTION } from "./constants.ts";

// Lightweight Object3D anchors for labeled stars. Carry a CSS2D label
// and a screen-space raycast hit sphere. No geometry — visuals come
// from the instanced mesh in stars.ts.

const scratchVec3 = new THREE.Vector3();

// Screen-space hit sphere: the anchor raycast-intersects against a sphere
// whose radius scales with camera distance, giving a consistent clickable
// target size in pixels regardless of zoom.
function attachHitSphere(obj: THREE.Object3D) {
  const hitSphere = new THREE.Sphere(new THREE.Vector3(), 0);
  obj.raycast = (raycaster, intersects) => {
    if (obj.visible === false) return;
    hitSphere.center.copy(obj.getWorldPosition(scratchVec3));
    const camDist = hitSphere.center.distanceTo(raycaster.ray.origin);
    hitSphere.radius = camDist * HIT_SCREEN_FRACTION;
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

export function createStarLabel(
  star: Star,
  parent: THREE.Object3D,
  initLabelDrag: (div: HTMLElement) => void,
): { div: HTMLElement; label: CSS2DObject } {
  const labelDiv = document.createElement("div");
  labelDiv.style.cssText = LABEL_CSS;
  labelDiv.textContent = star.name;
  initLabelDrag(labelDiv);
  const label = new CSS2DObject(labelDiv);
  label.center.set(0.5, 0);
  label.userData.target = parent;
  parent.add(label);
  return { div: labelDiv, label };
}
