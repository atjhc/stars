import * as THREE from "three";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { GRID_SIZE, GRID_DIVISIONS, GRID_FADE_RADIUS, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS, ORBIT_SENSITIVITY, ANIM_DURATION, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD } from "./constants.ts";

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.01, 20000,
);

const viewport = document.getElementById("viewport")!;

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

export const labelRenderer = new CSS2DRenderer();
labelRenderer.sortObjects = false;
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.top = "0";
labelRenderer.domElement.style.left = "0";
labelRenderer.domElement.style.overflow = "hidden";
labelRenderer.domElement.style.pointerEvents = "none";
labelRenderer.domElement.style.zIndex = "10";
labelRenderer.domElement.style.userSelect = "none";
labelRenderer.domElement.style.webkitUserSelect = "none";
viewport.appendChild(labelRenderer.domElement);

// Galactic plane grid
const raGNP = (192.8595 * Math.PI) / 180;
const decGNP = (27.1284 * Math.PI) / 180;
const galNorthEq = new THREE.Vector3(
  Math.cos(decGNP) * Math.cos(raGNP),
  Math.sin(decGNP),
  -Math.cos(decGNP) * Math.sin(raGNP),
).normalize();

const gridShaderMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uCenter: { value: new THREE.Vector3(0, 0, 0) },
    uFadeRadius: { value: GRID_FADE_RADIUS },
    uColor: { value: new THREE.Color(0x4d7fc4) },
  },
  vertexShader: `
    varying vec3 vWorldPos;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorldPos = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: `
    uniform vec3 uCenter;
    uniform float uFadeRadius;
    uniform vec3 uColor;
    varying vec3 vWorldPos;
    void main() {
      float d = distance(vWorldPos, uCenter);
      float alpha = 1.0 * smoothstep(uFadeRadius, 0.0, d);
      if (alpha < 0.005) discard;
      gl_FragColor = vec4(uColor, alpha);
    }
  `,
});

export const gridHelper = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS);
gridHelper.material = gridShaderMat;
gridHelper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), galNorthEq);
scene.add(gridHelper);

// Camera orbit
const galUp = galNorthEq;
const ref = Math.abs(galUp.dot(new THREE.Vector3(1, 0, 0))) < 0.9
  ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
const galX = new THREE.Vector3().crossVectors(galUp, ref).normalize();
const galZ = new THREE.Vector3().crossVectors(galX, galUp).normalize();
camera.up.copy(galUp);

export const target = new THREE.Vector3(0, 0, 0);
export let orbitRadius = 7.8;
export let orbitPhi = 1.24;
export let orbitTheta = 0.485;

export function setOrbitRadius(r: number) { orbitRadius = r; }
export function setOrbitPhi(p: number) { orbitPhi = p; }
export function setOrbitTheta(t: number) { orbitTheta = t; }

export function updateCamera() {
  const sinPhi = Math.sin(orbitPhi);
  const cosPhi = Math.cos(orbitPhi);
  const sinTheta = Math.sin(orbitTheta);
  const cosTheta = Math.cos(orbitTheta);
  camera.position
    .copy(target)
    .addScaledVector(galX, orbitRadius * sinPhi * cosTheta)
    .addScaledVector(galZ, orbitRadius * sinPhi * sinTheta)
    .addScaledVector(galUp, orbitRadius * cosPhi);
  camera.lookAt(target);
}
updateCamera();

export function updateGridCenter() {
  const scratchVec3 = new THREE.Vector3();
  scratchVec3.copy(target).addScaledVector(galUp, -target.dot(galUp));
  gridShaderMat.uniforms.uCenter.value.copy(scratchVec3);
}

export let animation: { from: THREE.Vector3; to: THREE.Vector3; start: number } | null = null;

export function animateTo(pos: THREE.Vector3) {
  animation = { from: target.clone(), to: pos.clone(), start: performance.now() };
}

export function tickAnimation(now: number) {
  if (!animation) return;
  const t = Math.min(1, (now - animation.start) / ANIM_DURATION);
  const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  target.lerpVectors(animation.from, animation.to, ease);
  updateGridCenter();
  updateCamera();
  if (t >= 1) animation = null;
}

export function applyOrbitDrag(dx: number, dy: number) {
  orbitTheta += dx * ORBIT_SENSITIVITY;
  orbitPhi = THREE.MathUtils.clamp(orbitPhi - dy * ORBIT_SENSITIVITY, 0.1, Math.PI - 0.1);
  updateCamera();
}

export function onWheel(e: WheelEvent) {
  e.preventDefault();
  orbitRadius = THREE.MathUtils.clamp(orbitRadius + e.deltaY * 0.02, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS);
  updateCamera();
}

// Bloom post-processing with OVERSCAN.
//
// Rationale:
// - The composer RT is non-multisampled by default; with MSAA + HalfFloat
//   precision we avoid sub-pixel coverage flicker and accumulation banding.
// - `UnrealBloomPass` runs a Gaussian blur on mip-chain RTs. At screen
//   edges, blur samples that go out of bounds get clamped to the edge
//   value, which biases the kernel sum and makes stars at the edge of
//   the screen bloom asymmetrically brighter than stars in the middle.
// - Fix: render the scene into a render target that's larger than the
//   viewport (~10% gutter on each axis) by temporarily widening the
//   camera FOV. The bloom pipeline operates on the oversized buffer, so
//   blur samples near the *visible* edge always have real data to read
//   from the gutter. A final CropPass samples the center region and
//   writes it to the screen at viewport resolution.
export const BLOOM_OVERSCAN = 1.2;
const OVERSCAN_MARGIN = (BLOOM_OVERSCAN - 1) / (2 * BLOOM_OVERSCAN);

function makeComposerRT() {
  return new THREE.WebGLRenderTarget(
    Math.round(window.innerWidth * BLOOM_OVERSCAN * window.devicePixelRatio),
    Math.round(window.innerHeight * BLOOM_OVERSCAN * window.devicePixelRatio),
    { samples: 8, type: THREE.HalfFloatType },
  );
}
let composerRT = makeComposerRT();
export const composer = new EffectComposer(renderer, composerRT);
composer.setSize(
  Math.round(window.innerWidth * BLOOM_OVERSCAN),
  Math.round(window.innerHeight * BLOOM_OVERSCAN),
);
composer.addPass(new RenderPass(scene, camera));
export const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth * BLOOM_OVERSCAN, window.innerHeight * BLOOM_OVERSCAN),
  BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD,
);
for (const rt of bloomPass.renderTargetsHorizontal) rt.texture.type = THREE.HalfFloatType;
for (const rt of bloomPass.renderTargetsVertical) rt.texture.type = THREE.HalfFloatType;
bloomPass.renderTargetBright.texture.type = THREE.HalfFloatType;
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// Final crop pass: samples the center (1 / OVERSCAN) portion of the
// oversized composer output and writes to the screen framebuffer at
// the real viewport resolution. Everything past the visible viewport
// is discarded, taking the bloom edge-bias artifact with it.
const cropPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uMargin: { value: OVERSCAN_MARGIN },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uMargin;
    varying vec2 vUv;
    void main() {
      vec2 uv = uMargin + vUv * (1.0 - 2.0 * uMargin);
      gl_FragColor = texture2D(tDiffuse, uv);
    }
  `,
});
composer.addPass(cropPass);

// Camera FOV widening helpers — called from main's animate loop so the
// scene renders into the oversized RT with the visible viewport centered.
const BLOOM_WIDENED_FOV_HALF_TAN = Math.tan((camera.fov * Math.PI) / 360) * BLOOM_OVERSCAN;
const BLOOM_WIDENED_FOV = (Math.atan(BLOOM_WIDENED_FOV_HALF_TAN) * 360) / Math.PI;
let origFov = 0;
export function beginBloomRender() {
  origFov = camera.fov;
  camera.fov = BLOOM_WIDENED_FOV;
  camera.updateProjectionMatrix();
}
export function endBloomRender() {
  camera.fov = origFov;
  camera.updateProjectionMatrix();
}

let lastDPR = window.devicePixelRatio;
export function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (window.devicePixelRatio !== lastDPR) {
    lastDPR = window.devicePixelRatio;
    composerRT.dispose();
    composerRT = makeComposerRT();
    composer.reset(composerRT);
  }
  composer.setSize(
    Math.round(window.innerWidth * BLOOM_OVERSCAN),
    Math.round(window.innerHeight * BLOOM_OVERSCAN),
  );
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
}
