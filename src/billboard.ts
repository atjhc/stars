import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Star } from "./types.ts";
import { LABEL_CSS, HIT_SCREEN_FRACTION } from "./constants.ts";
import { bvToColor } from "./color.ts";
import { GLOW_GLSL } from "./starShader.ts";

// Billboard meshes add detailed glow when close to camera.
// At distance they fade to zero, letting the point cloud take over.
export const billboardVertexShader = `
  attribute vec3 starColor;
  attribute float starBrightness;
  uniform float uHighlight;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vBrightness;
  void main() {
    vUv = uv;
    vColor = starColor;
    vec4 mvCenter = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float camDist = -mvCenter.z;
    float scale = clamp(log(1.0 + camDist * 0.5) * 0.12, 0.02, 0.15);
    bool isHighlighted = uHighlight > 1.01;
    // When highlighted, ensure the billboard is large enough for visible glow
    if (isHighlighted) scale = max(scale, camDist * 0.012);
    float proximityFade = isHighlighted ? 1.0 : smoothstep(40.0, 10.0, camDist);
    vBrightness = starBrightness * uHighlight * proximityFade;
    if (proximityFade < 0.01) {
      gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
      return;
    }
    mvCenter.xy += position.xy * scale;
    gl_Position = projectionMatrix * mvCenter;
  }
`;

export const billboardFragmentShader = `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vBrightness;
  ${GLOW_GLSL}
  void main() {
    float d = length((vUv - 0.5) * 2.0);
    vec2 g = glowAt(d);
    float intensity = g.x * vBrightness;
    vec3 color = mix(vColor, vec3(1.0), smoothstep(0.3, 1.0, g.y * vBrightness));
    gl_FragColor = vec4(color * intensity, intensity);
  }
`;

const quadGeo = new THREE.PlaneGeometry(1, 1);
const scratchVec3 = new THREE.Vector3();

// Screen-space hit sphere: lets an Object3D be raycast-hit regardless of
// geometry. `visibilitySource`, if provided, gates the hit on a different
// object's .visible — used so tier-0 billboards follow their anchor.
function attachHitSphere(obj: THREE.Object3D, visibilitySource?: THREE.Object3D) {
  const hitSphere = new THREE.Sphere(new THREE.Vector3(), 0);
  obj.raycast = (raycaster, intersects) => {
    const source = visibilitySource ?? obj;
    if (source.visible === false) return;
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

export function rebindHitSphere(obj: THREE.Object3D, visibilitySource: THREE.Object3D) {
  attachHitSphere(obj, visibilitySource);
}

// Persistent label-bearing position holder for tier-0 stars (no mesh, no
// raycast). At close range a separate billboard mesh spawns alongside to
// provide the glow + canvas hit target.
export function createNotableAnchor(star: Star, sx: number, sy: number, sz: number): THREE.Object3D {
  const anchor = new THREE.Object3D();
  anchor.position.set(sx, sy, sz);
  anchor.userData = star;
  // Start hidden; labels.ts will enable on the first pass. Prevents a
  // single-frame flash of every notable label at page load.
  anchor.visible = false;
  return anchor;
}

export function createBillboardMesh(star: Star, sceneX: number, sceneY: number, sceneZ: number): THREE.Mesh {
  const color = bvToColor(star.ci);
  const brightness = Math.max(0.8, Math.min(2.5, 0.9 + 0.35 * Math.log10(Math.max(star.lum, 0.001))));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uHighlight: { value: 1.0 } },
    vertexShader: billboardVertexShader,
    fragmentShader: billboardFragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });

  const geo = quadGeo.clone();
  geo.setAttribute("starColor", new THREE.Float32BufferAttribute(
    [color.r, color.g, color.b, color.r, color.g, color.b,
     color.r, color.g, color.b, color.r, color.g, color.b], 3));
  geo.setAttribute("starBrightness", new THREE.Float32BufferAttribute(
    [brightness, brightness, brightness, brightness], 1));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(0.4, 0.4, 1);
  attachHitSphere(mesh);
  mesh.position.set(sceneX, sceneY, sceneZ);
  mesh.userData = star;
  return mesh;
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
