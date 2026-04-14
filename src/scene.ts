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
gridHelper.visible = false;
scene.add(gridHelper);

// Camera orbit
const galUp = galNorthEq;
const ref = Math.abs(galUp.dot(new THREE.Vector3(1, 0, 0))) < 0.9
  ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
const galX = new THREE.Vector3().crossVectors(galUp, ref).normalize();
const galZ = new THREE.Vector3().crossVectors(galX, galUp).normalize();
camera.up.copy(galUp);

export const target = new THREE.Vector3(0, 0, 0);
export let orbitRadius = MIN_ORBIT_RADIUS;
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
  // Tighten frustum at close zoom for depth precision
  camera.near = Math.max(1e-6, orbitRadius * 0.001);
  camera.far = Math.max(20000, orbitRadius * 100000);
  camera.updateProjectionMatrix();
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
  tickOrbitAnim(now);
  if (!animation) return;
  const t = Math.min(1, (now - animation.start) / ANIM_DURATION);
  const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  target.lerpVectors(animation.from, animation.to, ease);
  updateGridCenter();
  updateCamera();
  if (t >= 1) animation = null;
}

const ORBIT_ANIM_MS = 500;
let orbitAnim: { fromTheta: number; fromPhi: number; toTheta: number; toPhi: number; start: number } | null = null;

export function lookToward(worldPos: THREE.Vector3) {
  const dir = new THREE.Vector3().subVectors(target, worldPos).normalize();
  const x = dir.dot(galX);
  const z = dir.dot(galZ);
  const y = dir.dot(galUp);
  let toTheta = Math.atan2(z, x);
  let toPhi = Math.acos(THREE.MathUtils.clamp(y, -1, 1));
  toPhi = THREE.MathUtils.clamp(toPhi, 0.1, Math.PI - 0.1);

  // Shortest angular path for theta
  let dTheta = toTheta - orbitTheta;
  if (dTheta > Math.PI) toTheta -= 2 * Math.PI;
  else if (dTheta < -Math.PI) toTheta += 2 * Math.PI;

  orbitAnim = { fromTheta: orbitTheta, fromPhi: orbitPhi, toTheta, toPhi, start: performance.now() };
}

function tickOrbitAnim(now: number) {
  if (!orbitAnim) return;
  const t = Math.min(1, (now - orbitAnim.start) / ORBIT_ANIM_MS);
  const ease = (1 - Math.cos(Math.PI * t)) / 2;
  orbitTheta = orbitAnim.fromTheta + (orbitAnim.toTheta - orbitAnim.fromTheta) * ease;
  orbitPhi = orbitAnim.fromPhi + (orbitAnim.toPhi - orbitAnim.fromPhi) * ease;
  updateCamera();
  if (t >= 1) orbitAnim = null;
}

export function applyOrbitDrag(dx: number, dy: number) {
  orbitTheta += dx * ORBIT_SENSITIVITY;
  orbitPhi = THREE.MathUtils.clamp(orbitPhi - dy * ORBIT_SENSITIVITY, 0.1, Math.PI - 0.1);
  updateCamera();
}

let minOrbitOverride: number | null = null;
export function setMinOrbitOverride(v: number | null) { minOrbitOverride = v; }
export function getEffectiveMinOrbit(): number { return minOrbitOverride ?? MIN_ORBIT_RADIUS; }

export function applyZoom(delta: number) {
  const minR = minOrbitOverride ?? MIN_ORBIT_RADIUS;
  orbitRadius = THREE.MathUtils.clamp(orbitRadius * Math.pow(1.0007, delta), minR, MAX_ORBIT_RADIUS);
  updateCamera();
}

// Deep zoom: local coordinate frame for extreme close-ups (black holes)
const DEEP_ZOOM_ENTER = 0.01;  // engage when orbit radius drops below this
const DEEP_ZOOM_EXIT = 0.02;   // disengage when orbit radius rises above this

let deepZoomActive = false;
let deepZoomOrigin = new THREE.Vector3();

export const deepZoomScene = new THREE.Scene();
export const deepZoomCamera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.001, 100);

export function isDeepZoom(): boolean { return deepZoomActive; }
export function getDeepZoomScale(): number { return deepZoomActive ? 1 / orbitRadius : 1; }

export function updateDeepZoom() {
  if (minOrbitOverride !== null && minOrbitOverride < DEEP_ZOOM_ENTER) {
    if (!deepZoomActive && orbitRadius < DEEP_ZOOM_ENTER) {
      deepZoomActive = true;
      deepZoomOrigin.copy(target);
    } else if (deepZoomActive && orbitRadius > DEEP_ZOOM_EXIT) {
      deepZoomActive = false;
    }
  } else if (deepZoomActive) {
    deepZoomActive = false;
  }

  if (!deepZoomActive) return;

  // Position deep zoom camera in local space (BH at origin, scale so camera is at distance ~1)
  const scale = 1 / orbitRadius;
  const sinPhi = Math.sin(orbitPhi);
  const cosPhi = Math.cos(orbitPhi);
  const sinTheta = Math.sin(orbitTheta);
  const cosTheta = Math.cos(orbitTheta);
  deepZoomCamera.position.set(
    sinPhi * cosTheta,
    cosPhi,
    sinPhi * sinTheta,
  );
  deepZoomCamera.lookAt(0, 0, 0);
  deepZoomCamera.near = 0.001;
  deepZoomCamera.far = 100;
  deepZoomCamera.aspect = camera.aspect;
  deepZoomCamera.updateProjectionMatrix();
}

// Cubemap for starfield background in deep zoom
export let deepZoomCubeRT: THREE.WebGLCubeRenderTarget | null = null;
let cubeCamera: THREE.CubeCamera | null = null;

export function captureDeepZoomCubemap(renderer: THREE.WebGLRenderer, mainScene: THREE.Scene) {
  if (!deepZoomCubeRT) {
    deepZoomCubeRT = new THREE.WebGLCubeRenderTarget(512, {
      format: THREE.RGBAFormat,
      generateMipmaps: false,
    });
    cubeCamera = new THREE.CubeCamera(0.01, 20000, deepZoomCubeRT);
  }
  cubeCamera!.position.copy(deepZoomOrigin);
  cubeCamera!.update(renderer, mainScene);
}

export function onWheel(e: WheelEvent) {
  e.preventDefault();
  applyZoom(e.deltaY);
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
  deepZoomCamera.aspect = camera.aspect;
  deepZoomCamera.updateProjectionMatrix();
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
