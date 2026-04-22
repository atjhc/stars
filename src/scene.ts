import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { GRID_SIZE, GRID_DIVISIONS, GRID_FADE_RADIUS, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS, ORBIT_SENSITIVITY, ANIM_DURATION, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD } from "./constants.ts";
import {
  halfViewportPxUniform,
  starTargetUniform, starCameraOffsetUniform, starViewRotationUniform,
} from "./shaderUniforms.ts";
import { kick, registerKeepFrame } from "./renderLoop.ts";

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(
  55, window.innerWidth / window.innerHeight, 0.01, 20000,
);

// Float64 view-rotation matrix (row-major, world → view). Built directly
// from the orbit angles in updateCamera so it has full Float64 precision.
// Layout: viewRotation[row * 3 + col] — row 0 is the view-space X axis,
// row 1 is Y, row 2 is Z (away from view direction).
const viewRotation = new Float64Array(9);

// Camera-to-target offset in world coordinates. Aliased to
// starCameraOffsetUniform.value so the star shader, label projection,
// and any other consumer all pull from the same source of truth.
export const cameraOffset = starCameraOffsetUniform.value;

// Project a world position to clip-space UV (0..1).
//
// The naive approach — `pos - camera.position` — suffers catastrophic
// cancellation at deep zoom: camera.position is stored as target +
// orbitOffset, but in Float64 at ~100pc magnitudes the orbitOffset is
// rounded away once it drops below ulp(target) (~3.5e-14). Instead, we
// compute the delta in the target-relative frame: (pos - target) is
// stable at scene magnitudes, cameraOffset is stable at orbit
// magnitudes, and neither subtraction catastrophically cancels. This is
// the same trick the star shader uses for per-instance precision.
//
// The parenthesization is load-bearing — swapping to
// `pos.x - (target.x + cameraOffset.x)` reintroduces the cancellation.
export interface ScreenUV { u: number; v: number; behind: boolean; }
export function projectToScreenUV(pos: THREE.Vector3, out: ScreenUV): void {
  const dx = (pos.x - target.x) - cameraOffset.x;
  const dy = (pos.y - target.y) - cameraOffset.y;
  const dz = (pos.z - target.z) - cameraOffset.z;
  const v = viewRotation;
  const rx = v[0]! * dx + v[1]! * dy + v[2]! * dz;
  const ry = v[3]! * dx + v[4]! * dy + v[5]! * dz;
  const rz = v[6]! * dx + v[7]! * dy + v[8]! * dz;
  const p = camera.projectionMatrix.elements;
  const ppx = p[0]! * rx + p[4]! * ry + p[8]! * rz + p[12]!;
  const ppy = p[1]! * rx + p[5]! * ry + p[9]! * rz + p[13]!;
  const ppz = p[2]! * rx + p[6]! * ry + p[10]! * rz + p[14]!;
  const ppw = p[3]! * rx + p[7]! * ry + p[11]! * rz + p[15]!;
  const invW = 1 / ppw;
  out.u = (ppx * invW) * 0.5 + 0.5;
  out.v = (ppy * invW) * 0.5 + 0.5;
  out.behind = ppz * invW > 1;
}

// Pixel-space wrapper around projectToScreenUV for canvas label layout.
export interface ScreenPos { x: number; y: number; behind: boolean; }
const _uvScratch: ScreenUV = { u: 0, v: 0, behind: false };
export function projectToLabelScreen(pos: THREE.Vector3, out: ScreenPos): void {
  projectToScreenUV(pos, _uvScratch);
  out.x = _uvScratch.u * window.innerWidth;
  out.y = (1 - _uvScratch.v) * window.innerHeight;
  out.behind = _uvScratch.behind;
}

// Precision-safe camera-to-position distance. Uses the same target-
// relative decomposition as the projection path so deep-zoom distances
// (where the focus target is at the camera origin) stay accurate.
export function distanceFromCamera(pos: THREE.Vector3): number {
  const dx = (pos.x - target.x) - cameraOffset.x;
  const dy = (pos.y - target.y) - cameraOffset.y;
  const dz = (pos.z - target.z) - cameraOffset.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const viewport = document.getElementById("viewport")!;

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);

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
  // Near plane floor: nothing renders inside 1e-4 of the camera — the
  // selected target is at the camera origin (no self-clipping), and BH
  // visuals come from a screen-space lensing pass rather than world-
  // space geometry. Keeps depth-buffer precision sane at any zoom.
  camera.near = Math.max(1e-4, orbitRadius * 0.001);
  camera.far = Math.max(20000, orbitRadius * 100000);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  // Float64 view rotation from orbit angles: z = orbit unit vector,
  // x = normalize(galUp × z), y = z × x. Rows are the view basis axes.
  const zx = galX.x * sinPhi * cosTheta + galZ.x * sinPhi * sinTheta + galUp.x * cosPhi;
  const zy = galX.y * sinPhi * cosTheta + galZ.y * sinPhi * sinTheta + galUp.y * cosPhi;
  const zz = galX.z * sinPhi * cosTheta + galZ.z * sinPhi * sinTheta + galUp.z * cosPhi;
  const xRawX = galUp.y * zz - galUp.z * zy;
  const xRawY = galUp.z * zx - galUp.x * zz;
  const xRawZ = galUp.x * zy - galUp.y * zx;
  const invXLen = 1 / Math.sqrt(xRawX * xRawX + xRawY * xRawY + xRawZ * xRawZ);
  const xx = xRawX * invXLen;
  const xy = xRawY * invXLen;
  const xz = xRawZ * invXLen;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  viewRotation[0] = xx; viewRotation[1] = xy; viewRotation[2] = xz;
  viewRotation[3] = yx; viewRotation[4] = yy; viewRotation[5] = yz;
  viewRotation[6] = zx; viewRotation[7] = zy; viewRotation[8] = zz;

  starTargetUniform.value.copy(target);
  starCameraOffsetUniform.value
    .set(0, 0, 0)
    .addScaledVector(galX, orbitRadius * sinPhi * cosTheta)
    .addScaledVector(galZ, orbitRadius * sinPhi * sinTheta)
    .addScaledVector(galUp, orbitRadius * cosPhi);
  starViewRotationUniform.value.set(xx, xy, xz, yx, yy, yz, zx, zy, zz);
}
updateCamera();

export function updateGridCenter() {
  const scratchVec3 = new THREE.Vector3();
  scratchVec3.copy(target).addScaledVector(galUp, -target.dot(galUp));
  gridShaderMat.uniforms.uCenter.value.copy(scratchVec3);
}

export let animation: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromRadius: number;
  toRadius: number;
  start: number;
} | null = null;

// Camera-to-star distance for angular-size math. Mid-animation,
// `orbitRadius` is unrelated to the selected star (target is
// interpolating), so fall back to the true world distance.
export function effectiveCamDist(starPos: THREE.Vector3): number {
  if (animation !== null) return camera.position.distanceTo(starPos);
  return orbitRadius;
}

// Eases the camera target (and, if needed, the orbit radius). When the
// caller doesn't pass toRadius, the default eases out to the current
// target's min-orbit (per-star / per-cluster / per-nebula), guaranteeing
// the camera ends at a sensible viewing distance for whatever was just
// selected. setMinOrbitOverride must be called BEFORE animateTo for
// this to pick up the new floor.
export function animateTo(pos: THREE.Vector3, toRadius?: number) {
  const targetRadius = toRadius ?? Math.max(orbitRadius, getEffectiveMinOrbit());
  animation = {
    from: target.clone(),
    to: pos.clone(),
    fromRadius: orbitRadius,
    toRadius: targetRadius,
    start: performance.now(),
  };
  kick();
}

// Jump directly to a target position, cancelling any in-flight target
// or orbit animation. Used when restoring from a shared URL, where the
// normal selection lerp would play a distracting flyby on page load.
export function setTargetImmediate(pos: THREE.Vector3) {
  target.copy(pos);
  animation = null;
  orbitAnim = null;
  updateGridCenter();
  updateCamera();
}

export function tickAnimation(now: number) {
  tickOrbitAnim(now);
  if (!animation) return;
  const t = Math.min(1, (now - animation.start) / ANIM_DURATION);
  const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  target.lerpVectors(animation.from, animation.to, ease);
  orbitRadius = animation.fromRadius + (animation.toRadius - animation.fromRadius) * ease;
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
  kick();
}

export function hasActiveCameraAnim(): boolean {
  return animation !== null || orbitAnim !== null;
}
registerKeepFrame(hasActiveCameraAnim);

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
// Selection-specific zoom floor. Callers set the exact value they want
// (e.g. per-star min based on physical radius, cluster spread, nebula
// volume). When no selection has an override active, fall back to the
// default MIN_ORBIT_RADIUS.
export function getEffectiveMinOrbit(): number { return minOrbitOverride ?? MIN_ORBIT_RADIUS; }

export function applyZoom(delta: number) {
  // The override IS the floor — not a boolean "allow deep zoom" flag.
  // Each selection type computes its own appropriate minimum.
  const minR = minOrbitOverride ?? MIN_ORBIT_RADIUS;
  const inDeepRange = orbitRadius < DEEP_ZOOM_ENTER;
  const zoomRate = inDeepRange ? 1.003 : 1.0007;
  orbitRadius = THREE.MathUtils.clamp(orbitRadius * Math.pow(zoomRate, delta), minR, MAX_ORBIT_RADIUS);
  updateDeepZoom();
  updateCamera();
}

// Deep zoom: local coordinate frame for extreme close-ups (black holes)
const DEEP_ZOOM_ENTER = 0.01;  // engage when orbit radius drops below this
const DEEP_ZOOM_EXIT = 0.02;   // disengage when orbit radius rises above this

let deepZoomActive = false;

export function isDeepZoom(): boolean { return deepZoomActive; }

export function updateDeepZoom() {
  if (minOrbitOverride === null) {
    deepZoomActive = false;
    return;
  }
  if (!deepZoomActive && orbitRadius < DEEP_ZOOM_ENTER) deepZoomActive = true;
  else if (deepZoomActive && orbitRadius > DEEP_ZOOM_EXIT) deepZoomActive = false;
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
// Screen-space gravitational lensing pass (enabled during deep zoom).
// Samples dust at the bent UV too so background nebulae warp with the
// scene. The tDust texture is window-sized (not the composer's
// oversized RT), so we scale the lookup UV by BLOOM_OVERSCAN — within
// the visible crop region this maps bentUV ∈ [MARGIN, 1-MARGIN] to
// dustUv ∈ [0, 1]; outside that range dustUv falls outside [0,1] and
// the step() mask zeros the sample.
const lensingPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    tDust: { value: null },
    uDustActive: { value: 0 },
    uDustScale: { value: BLOOM_OVERSCAN },
    uBHScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uShadowRadius: { value: 0.0 },
    uSchwarzRadius: { value: 0.0 },
    uAspect: { value: 1.0 },
    uScreenScale: { value: 100.0 },
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
    uniform sampler2D tDust;
    uniform float uDustActive;
    uniform float uDustScale;
    uniform vec2 uBHScreen;
    uniform float uShadowRadius;
    uniform float uSchwarzRadius;
    uniform float uAspect;
    uniform float uScreenScale;
    varying vec2 vUv;

    vec3 sampleDust(vec2 uv) {
      if (uDustActive < 0.5) return vec3(0.0);
      vec2 dustUv = (uv - 0.5) * uDustScale + 0.5;
      vec2 m = step(vec2(0.0), dustUv) * step(dustUv, vec2(1.0));
      return texture2D(tDust, dustUv).rgb * (m.x * m.y);
    }

    void main() {
      vec2 uv = vUv;

      if (uShadowRadius <= 0.0) {
        gl_FragColor = vec4(texture2D(tDiffuse, uv).rgb + sampleDust(uv), 1.0);
        return;
      }

      // Work in aspect-corrected space for circular geometry
      vec2 offset = uv - uBHScreen;
      vec2 corrected = vec2(offset.x * uAspect, offset.y);
      float dist = length(corrected);

      float b = dist / uShadowRadius;

      // Shadow: black inside capture radius
      if (b < 0.95) {
        float ringWidth = max(uScreenScale * 2.0, 50.0);
        float ring = exp(-pow((b - 1.0) * ringWidth, 2.0)) * 0.0;
        gl_FragColor = vec4(vec3(1.0, 0.97, 0.95) * ring, 1.0);
        return;
      }

      // Deflection in aspect-corrected space, then convert back to UV space
      float deflection = uSchwarzRadius / max(dist, uShadowRadius * 0.5);
      vec2 deflectDir = normalize(corrected);
      vec2 uvDeflect = vec2(deflectDir.x / uAspect, deflectDir.y) * deflection;
      vec2 bentUV = clamp(uv - uvDeflect, 0.0, 1.0);

      vec3 color = texture2D(tDiffuse, bentUV).rgb + sampleDust(bentUV);

      float shadow = smoothstep(0.95, 1.05, b);
      color *= shadow;

      float ringWidth = max(uScreenScale * 2.0, 50.0);
      float ring = exp(-pow((b - 1.0) * ringWidth, 2.0)) * 0.0;
      color += vec3(1.0, 0.97, 0.95) * ring;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
});
lensingPass.enabled = false;
composer.addPass(lensingPass);
export { lensingPass };

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
  halfViewportPxUniform.value = window.innerHeight / 2;
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
}
