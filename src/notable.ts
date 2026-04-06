import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Star } from "./types.ts";
import { SCALE, LABEL_CSS, HIT_SCREEN_FRACTION } from "./constants.ts";
import { scene, camera } from "./scene.ts";
import notableData from "../data/notable-stars.json";

// Notable distant stars — searchable/selectable billboards beyond 50 ly
// Uses the same shader as the point cloud for visual consistency

const notableVertexShader = `
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
    float proximityFade = smoothstep(40.0, 10.0, camDist);
    vBrightness = starBrightness * uHighlight * proximityFade;
    if (proximityFade < 0.01) {
      gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
      return;
    }
    mvCenter.xy += position.xy * scale;
    gl_Position = projectionMatrix * mvCenter;
  }
`;

const notableFragmentShader = `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vBrightness;
  void main() {
    vec2 uv = (vUv - 0.5) * 2.0;
    float d = length(uv);
    float core = exp(-d * d * 30.0);
    float halo = 1.0 / (1.0 + pow(d * 6.0, 2.0));
    float outerGlow = exp(-d * 4.0) * 0.3;
    float intensity = (core + halo * 0.4 + outerGlow) * vBrightness;
    vec3 color = mix(vColor, vec3(1.0), smoothstep(0.3, 1.0, core * vBrightness));
    gl_FragColor = vec4(color * intensity, intensity);
  }
`;

function bvToColor(ci: number): THREE.Color {
  if (ci < -0.4) ci = -0.4;
  if (ci > 2.0) ci = 2.0;
  const temp = 4600.0 * (1.0 / (0.92 * ci + 1.7) + 1.0 / (0.92 * ci + 0.62));
  const t = temp / 100.0;
  let r: number, g: number, b: number;
  if (t <= 66) { r = 1.0; } else { r = Math.min(1, 329.698727446 * Math.pow(t - 60, -0.1332047592) / 255); }
  if (t <= 66) { g = Math.min(1, Math.max(0, (99.4708025861 * Math.log(t) - 161.1195681661) / 255)); }
  else { g = Math.min(1, 288.1221695283 * Math.pow(t - 60, -0.0755148492) / 255); }
  if (t >= 66) { b = 1.0; } else if (t <= 19) { b = 0.0; }
  else { b = Math.min(1, Math.max(0, (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255)); }
  const avg = (r + g + b) / 3;
  const sat = 1.8;
  r = Math.min(1, Math.max(0, avg + (r - avg) * sat));
  g = Math.min(1, Math.max(0, avg + (g - avg) * sat));
  b = Math.min(1, Math.max(0, avg + (b - avg) * sat));
  return new THREE.Color(r, g, b);
}

export const notableObjects: THREE.Mesh[] = [];
export const notableLabelMap = new WeakMap<THREE.Mesh, HTMLElement>();
export const notableLabelMeshMap = new WeakMap<HTMLElement, THREE.Mesh>();

const starQuadGeo = new THREE.PlaneGeometry(1, 1);
const scratchVec3 = new THREE.Vector3();

export function createNotableStars(initLabelDrag: (div: HTMLElement) => void) {
  const group = new THREE.Group();
  scene.add(group);

  (notableData as Star[]).forEach((star) => {
    const color = bvToColor(star.ci);
    const quadSize = 0.4;
    const brightness = Math.max(0.8, Math.min(2.5, 0.9 + 0.35 * Math.log10(Math.max(star.lum, 0.001))));

    const mat = new THREE.ShaderMaterial({
      uniforms: { uHighlight: { value: 1.0 } },
      vertexShader: notableVertexShader,
      fragmentShader: notableFragmentShader,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });

    const geo = starQuadGeo.clone();
    geo.setAttribute("starColor", new THREE.Float32BufferAttribute(
      [color.r, color.g, color.b, color.r, color.g, color.b,
       color.r, color.g, color.b, color.r, color.g, color.b], 3));
    geo.setAttribute("starBrightness", new THREE.Float32BufferAttribute(
      [brightness, brightness, brightness, brightness], 1));

    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(quadSize, quadSize, 1);

    const hitSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    mesh.raycast = (raycaster, intersects) => {
      hitSphere.center.copy(mesh.getWorldPosition(scratchVec3));
      const camDist = hitSphere.center.distanceTo(raycaster.ray.origin);
      hitSphere.radius = camDist * HIT_SCREEN_FRACTION;
      const intersection = raycaster.ray.intersectSphere(hitSphere, scratchVec3);
      if (intersection) {
        const distance = raycaster.ray.origin.distanceTo(intersection);
        if (distance >= raycaster.near && distance <= raycaster.far) {
          intersects.push({ distance, point: intersection.clone(), object: mesh });
        }
      }
    };

    mesh.position.set(star.x * SCALE, star.z * SCALE, -star.y * SCALE);
    mesh.userData = star;
    group.add(mesh);
    notableObjects.push(mesh);

    // Label — hidden by default, shown on hover/select
    const labelDiv = document.createElement("div");
    labelDiv.style.cssText = LABEL_CSS;
    labelDiv.textContent = star.name;
    labelDiv.style.visibility = "hidden";
    notableLabelMap.set(mesh, labelDiv);
    notableLabelMeshMap.set(labelDiv, mesh);
    initLabelDrag(labelDiv);
    const label = new CSS2DObject(labelDiv);
    label.center.set(0.5, 0);
    mesh.add(label);
  });
}
