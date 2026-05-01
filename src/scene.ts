import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS, ORBIT_SENSITIVITY, ANIM_DURATION, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD, KM_PER_PC, RS_KM_PER_MSUN, SCALE } from "./constants.ts";
import {
  halfViewportPxUniform,
  starCameraOffsetUniform, starViewRotationUniform,
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

// Scratch Vector3 for projection math.
const _projScratch = new THREE.Vector3();

// Float64 orbit offset, kept separate from the Float32 shader uniform.
// Used by projectToScreenUV for sub-ULP label precision.
const cameraOffset = new Float64Array(3);

// Project a world position to clip-space UV (0..1). Uses two-part
// decomposition (pos - target) - orbitOffset so both subtractions stay
// in their precision regime. Direct pos - camera.position would lose
// ~1 ULP(300) ≈ 7e-14 in the addition target+offset, causing ~1px
// label jitter at deep zoom.
export interface ScreenUV { u: number; v: number; behind: boolean; }
export function projectToScreenUV(pos: THREE.Vector3, out: ScreenUV): void {
  const dx = (pos.x - target.x) - cameraOffset[0]!;
  const dy = (pos.y - target.y) - cameraOffset[1]!;
  const dz = (pos.z - target.z) - cameraOffset[2]!;
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

export function distanceFromCamera(pos: THREE.Vector3): number {
  const dx = (pos.x - target.x) - cameraOffset[0]!;
  const dy = (pos.y - target.y) - cameraOffset[1]!;
  const dz = (pos.z - target.z) - cameraOffset[2]!;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const viewport = document.getElementById("viewport")!;

// Re-exported so existing scene.ts importers don't have to change.
// The implementations live in quality.ts (no Three.js dependency)
// so renderLoop.ts can import them eagerly without the renderLoop ↔
// scene module cycle.
export { getRenderPixelRatio, isMobileQuality } from "./quality.ts";
import { getRenderPixelRatio, isMobileQuality } from "./quality.ts";

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(getRenderPixelRatio());
viewport.appendChild(renderer.domElement);

// Galactic basis. galUp is the IAU galactic north pole in equatorial-XYZ.
// galX / galZ are arbitrary in-plane axes (used by the procedural grid
// shader and the camera orbit).
const raGNP = (192.8595 * Math.PI) / 180;
const decGNP = (27.1284 * Math.PI) / 180;
const galNorthEq = new THREE.Vector3(
  Math.cos(decGNP) * Math.cos(raGNP),
  Math.sin(decGNP),
  -Math.cos(decGNP) * Math.sin(raGNP),
).normalize();
const galUp = galNorthEq;
const ref = Math.abs(galUp.dot(new THREE.Vector3(1, 0, 0))) < 0.9
  ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
const galX = new THREE.Vector3().crossVectors(galUp, ref).normalize();
const galZ = new THREE.Vector3().crossVectors(galX, galUp).normalize();

// Galactic-plane grid. A circular mesh sits at the focused target,
// oriented with its local axes along (galX, galZ, galUp). Cell spacing
// is derived from orbit radius and snaps to the nearest power of 10;
// two scales crossfade for seamless LOD as you zoom across decades.
const gridShaderMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  uniforms: {
    uColor: { value: new THREE.Color(0x4d7fc4) },
    uOrbitRadius: { value: 1.0 },
    uSide: { value: 1.0 },
  },
  vertexShader: `
    uniform float uSide;
    varying vec2 vUv2;
    void main() {
      vUv2 = position.xy * uSide;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uColor;
    uniform float uOrbitRadius;
    varying vec2 vUv2;

    // 1.0 on a grid line, 0.0 elsewhere. fwidth keeps the line constant
    // ~1.5 px wide regardless of zoom, so distant grids stay visible.
    float gridLine(vec2 uv, float spacing) {
      vec2 g = uv / spacing;
      vec2 dist = abs(fract(g - 0.5) - 0.5);
      vec2 px = max(fwidth(g), vec2(1e-30));
      vec2 line = smoothstep(vec2(0.0), px * 1.5, dist);
      return 1.0 - min(line.x, line.y);
    }

    void main() {
      // Two-scale grid: pick minor = nearest pow(10) below orbitRadius/5,
      // major = 10× coarser. Minor fades out as zoom approaches the next
      // decade, at which point the just-major becomes the new minor and
      // a new (sparser) major appears — seamless in the visible area.
      float spacing = uOrbitRadius * 0.2;
      float logS = log(spacing) / log(10.0);
      float levelF = floor(logS);
      float frac = logS - levelF;
      float minor = pow(10.0, levelF);
      float major = minor * 10.0;

      float minorAlpha = gridLine(vUv2, minor) * (1.0 - frac);
      float majorAlpha = gridLine(vUv2, major);
      float alpha = max(minorAlpha, majorAlpha);

      // Radial fade — keeps the visible grid disc ~30% of view.
      alpha *= 1.0 - smoothstep(uOrbitRadius * 0.3, uOrbitRadius * 0.6, length(vUv2));

      if (alpha < 0.01) discard;
      gl_FragColor = vec4(uColor, alpha);
    }
  `,
});

// Local axes (X, Y, Z) aligned with (galX, galZ, galUp) so the vertex
// shader can read in-plane offsets directly from position.xy. Disc
// radius (mesh.scale) is sized just past the shader's 0.6×R fade end.
export const gridMesh = new THREE.Mesh(new THREE.CircleGeometry(1, 64), gridShaderMat);
gridMesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(galX, galZ, galUp));
gridMesh.visible = false;
gridMesh.frustumCulled = false;
scene.add(gridMesh);

const _gridScratch = new THREE.Vector3();
function updateGrid() {
  // Always refresh — toggling visibility doesn't run updateCamera,
  // and we want the next render to use current target/orbit state.
  _gridScratch.copy(target).addScaledVector(galUp, -target.dot(galUp));
  gridMesh.position.copy(_gridScratch);
  const side = orbitRadius * 0.7;
  gridMesh.scale.set(side, side, 1);
  gridShaderMat.uniforms.uOrbitRadius.value = orbitRadius;
  gridShaderMat.uniforms.uSide.value = side;
}

// Normalize an angle delta into [-π, π] for shortest-path interpolation.
function shortestAngleTo(from: number, to: number): number {
  let d = to - from;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  return from + d;
}
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
  // Near plane scales with orbit radius (capped so it never crowds
  // the camera at typical zooms, floored only to keep `near > 0` as
  // Three.js requires). The 0.1× factor keeps near well inside the
  // orbit sphere; at planet-close orbits this drops well below 1 km.
  camera.near = Math.max(1e-30, Math.min(0.01, orbitRadius * 0.1));
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

  // Float64 orbit offset for label projection (two-part decomposition).
  const oxPhi = orbitRadius * sinPhi;
  cameraOffset[0] = galX.x * oxPhi * cosTheta + galZ.x * oxPhi * sinTheta + galUp.x * orbitRadius * cosPhi;
  cameraOffset[1] = galX.y * oxPhi * cosTheta + galZ.y * oxPhi * sinTheta + galUp.y * orbitRadius * cosPhi;
  cameraOffset[2] = galX.z * oxPhi * cosTheta + galZ.z * oxPhi * sinTheta + galUp.z * orbitRadius * cosPhi;

  // Camera orbit offset for Float32 shaders. The other half of the
  // decomposition (target - tileOrigin) is computed per-tile in
  // starfield.ts updateTileTargets().
  starCameraOffsetUniform.value.set(cameraOffset[0]!, cameraOffset[1]!, cameraOffset[2]!);
  starViewRotationUniform.value.set(xx, xy, xz, yx, yy, yz, zx, zy, zz);
  updateGrid();
}
updateCamera();

export let animation: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromRadius: number;
  toRadius: number;
  start: number;
  duration: number;    // ms — scaled by log range of transit
  totalDist: number;
  dir: THREE.Vector3;
  D0: number;         // initial camera-to-destination distance
  // Orbit rotation interpolated in parallel with the transit.
  fromTheta: number;
  fromPhi: number;
  toTheta: number;
  toPhi: number;
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
  // Skip no-op animations. Re-selecting the star the camera is already
  // framed on otherwise triggers 600 ms of "animating" with from == to,
  // during which updateStarDeepZoom hands rendering from the overlay
  // to the instanced mesh and back — producing a visible blip on the
  // zoomed-in disc.
  if (target.equals(pos) && orbitRadius === targetRadius) return;
  const from = target.clone();
  const to = pos.clone();
  const dir = new THREE.Vector3().subVectors(to, from);
  const totalDist = dir.length();
  if (totalDist > 0) dir.divideScalar(totalDist);
  const D0 = totalDist + orbitRadius;
  // Scale duration by the log range of the transit so deep-zoom
  // approaches that span many orders of magnitude get enough frames
  // to render each scale smoothly. Base duration covers ~6 orders
  // (typical star-to-star); each additional order adds ~120ms.
  const logRange = Math.abs(Math.log(D0) - Math.log(targetRadius));
  const duration = Math.max(ANIM_DURATION, ANIM_DURATION + (logRange - 6) * 120);
  // Compute destination orbit angles so the camera faces the target
  // on arrival. The rotation interpolates in parallel with the transit.
  let toTheta = orbitTheta;
  let toPhi = orbitPhi;
  if (totalDist > 0) {
    const lookDir = new THREE.Vector3().subVectors(from, to).normalize();
    const lx = lookDir.dot(galX);
    const lz = lookDir.dot(galZ);
    const ly = lookDir.dot(galUp);
    toTheta = Math.atan2(lz, lx);
    toPhi = THREE.MathUtils.clamp(Math.acos(THREE.MathUtils.clamp(ly, -1, 1)), 0.1, Math.PI - 0.1);
    toTheta = shortestAngleTo(orbitTheta, toTheta);
  }

  animation = {
    from, to,
    fromRadius: orbitRadius,
    toRadius: targetRadius,
    start: performance.now(),
    duration,
    totalDist, dir, D0,
    fromTheta: orbitTheta, fromPhi: orbitPhi,
    toTheta, toPhi,
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
  updateCamera();
}

// Asymmetric quintic — MID=0.45 leaves more time for deceleration so
// the camera glides to rest. The quintic shape (vs the more common
// easeInOutExpo) is load-bearing: transit distance interpolates in
// LOG space, so target velocity at t=0+ scales as ease'(0) ×
// log(D₀ / toRadius). For a deep-zoom transit (log range ~10), any
// nonzero ease'(0) sweeps the start star off-screen in the first
// frame. Quintic gives ease(0) = ease'(0) = 0 exactly.
function easeInOutQuintRest(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const MID = 0.45;
  return t < MID
    ? 0.5 * (t / MID) ** 5
    : 1 - 0.5 * ((1 - t) / (1 - MID)) ** 5;
}

// Hold Shift to slow transit animations 10×.
let slowMotion = false;
window.addEventListener("keydown", (e) => { if (e.key === "Shift") slowMotion = true; });
window.addEventListener("keyup", (e) => { if (e.key === "Shift") slowMotion = false; });

export function tickAnimation(now: number) {
  tickAutoOrbit(now);
  tickOrbitAnim(now);
  if (!animation) return;
  const duration = slowMotion ? animation.duration * 10 : animation.duration;
  const t = Math.min(1, (now - animation.start) / duration);
  const ease = easeInOutQuintRest(t);

  // Orbit rotation: ease in/out over the first half of the transit
  // so the camera is fully facing the destination during approach.
  const ROT_FRAC = 0.5;
  const rotT = Math.min(1, t / ROT_FRAC);
  const rotEase = rotT * rotT * (3 - 2 * rotT); // smoothstep
  orbitTheta = animation.fromTheta + (animation.toTheta - animation.fromTheta) * rotEase;
  orbitPhi = animation.fromPhi + (animation.toPhi - animation.fromPhi) * rotEase;

  if (t >= 1) {
    // Exact endpoint — no residual, no snap.
    target.copy(animation.to);
    orbitRadius = animation.toRadius;
  } else {
    // D (camera-to-destination) interpolates in log-space over the full
    // ease. Orbit radius is DELAYED — it stays at fromRadius during
    // departure so the camera doesn't zoom in before it starts moving,
    // then eases to toRadius during the approach. Clamped to D so
    // remaining = D - orbitRadius >= 0 always.
    const { D0, fromRadius, toRadius, dir } = animation;
    const logD = Math.log(D0) * (1 - ease) + Math.log(toRadius) * ease;
    const D = Math.exp(logD);
    const RADIUS_DELAY = 0.3;
    const rEase = Math.max(0, (ease - RADIUS_DELAY) / (1 - RADIUS_DELAY));
    const logR = Math.log(fromRadius) * (1 - rEase) + Math.log(toRadius) * rEase;
    orbitRadius = Math.min(Math.exp(logR), D);
    const remaining = D - orbitRadius;
    target.copy(animation.to).addScaledVector(dir, -remaining);
  }

  updateCamera();
  if (t >= 1) animation = null;
}

const ORBIT_ANIM_MS = 500;
let orbitAnim: { fromTheta: number; fromPhi: number; toTheta: number; toPhi: number; start: number } | null = null;

export function lookToward(worldPos: THREE.Vector3) {
  // Skip when the target already is worldPos — subVectors would give a
  // zero-length direction that normalizes to (0,0,0) and produces a
  // bogus (theta, phi) default pose. This path is hit when the search
  // preview lands on the currently-focused star, so a no-op here keeps
  // the camera still instead of spinning to an arbitrary rotation.
  if (target.equals(worldPos)) return;
  const dir = new THREE.Vector3().subVectors(target, worldPos).normalize();
  const x = dir.dot(galX);
  const z = dir.dot(galZ);
  const y = dir.dot(galUp);
  let toTheta = Math.atan2(z, x);
  let toPhi = Math.acos(THREE.MathUtils.clamp(y, -1, 1));
  toPhi = THREE.MathUtils.clamp(toPhi, 0.1, Math.PI - 0.1);

  toTheta = shortestAngleTo(orbitTheta, toTheta);

  orbitAnim = { fromTheta: orbitTheta, fromPhi: orbitPhi, toTheta, toPhi, start: performance.now() };
  kick();
}

// Auto-orbit: steady rotation around the focus target.
let autoOrbitActive = false;
const AUTO_ORBIT_RAD_PER_SEC = 0.15;

export function isAutoOrbit(): boolean { return autoOrbitActive; }

export function toggleAutoOrbit(): void {
  autoOrbitActive = !autoOrbitActive;
  if (autoOrbitActive) kick();
}

export function stopAutoOrbit(): void { autoOrbitActive = false; }

let lastAutoOrbitTime = 0;
function tickAutoOrbit(now: number): void {
  if (!autoOrbitActive) { lastAutoOrbitTime = 0; return; }
  if (lastAutoOrbitTime === 0) { lastAutoOrbitTime = now; return; }
  const dt = (now - lastAutoOrbitTime) / 1000;
  lastAutoOrbitTime = now;
  orbitTheta += AUTO_ORBIT_RAD_PER_SEC * dt;
  updateCamera();
}

export function hasActiveCameraAnim(): boolean {
  return animation !== null || orbitAnim !== null || autoOrbitActive;
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
// Margin around the visible viewport that the bloom kernel can read
// into without hitting edge-clamp / black. Sized so the deepest bloom
// mip level's blur reach fits inside the cropped-out region.
export const BLOOM_OVERSCAN = 1.1;
const OVERSCAN_MARGIN = (BLOOM_OVERSCAN - 1) / (2 * BLOOM_OVERSCAN);

function makeComposerRT() {
  // 8× MSAA + HalfFloat is 64 bytes/pixel in tile memory; mobile TBDR
  // GPUs split into tiny tiles and pay binning overhead at each
  // boundary. 4× is the mobile sweet spot.
  const samples = isMobileQuality() ? 4 : 8;
  return new THREE.WebGLRenderTarget(
    Math.round(window.innerWidth * BLOOM_OVERSCAN * getRenderPixelRatio()),
    Math.round(window.innerHeight * BLOOM_OVERSCAN * getRenderPixelRatio()),
    { samples, type: THREE.HalfFloatType },
  );
}
let composerRT = makeComposerRT();
export const composer = new EffectComposer(renderer, composerRT);
composer.setSize(
  Math.round(window.innerWidth * BLOOM_OVERSCAN),
  Math.round(window.innerHeight * BLOOM_OVERSCAN),
);
composer.addPass(new RenderPass(scene, camera));
// Mobile bloom runs at half the input resolution. UnrealBloomPass
// internally halves again per mip, so this puts level-0 at 1/4 the
// linear viewport (1/16 the pixel area). The composite step
// bilinearly upsamples; bloom is low-frequency so the softening is
// essentially invisible.
const BLOOM_DIVISOR = isMobileQuality() ? 2 : 1;
export const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(
    Math.round(window.innerWidth * BLOOM_OVERSCAN / BLOOM_DIVISOR),
    Math.round(window.innerHeight * BLOOM_OVERSCAN / BLOOM_DIVISOR),
  ),
  BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD,
);
if (BLOOM_DIVISOR !== 1) {
  // composer.setSize() forwards through to every pass — intercept so
  // resize events keep the halved resolution.
  const origSetSize = bloomPass.setSize.bind(bloomPass);
  bloomPass.setSize = function (w: number, h: number): void {
    origSetSize(Math.round(w / BLOOM_DIVISOR), Math.round(h / BLOOM_DIVISOR));
  };
}
for (const rt of bloomPass.renderTargetsHorizontal) rt.texture.type = THREE.HalfFloatType;
for (const rt of bloomPass.renderTargetsVertical) rt.texture.type = THREE.HalfFloatType;
bloomPass.renderTargetBright.texture.type = THREE.HalfFloatType;
composer.addPass(bloomPass);

// Crop margin + linear→sRGB transfer in one fullscreen pass. Combining
// these two trivial post-bloom steps avoids an extra read/write of the
// oversized composer RT.
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
    // Three.js's sRGBTransferOETF, inlined.
    vec3 linearToSRGB(vec3 v) {
      return mix(
        pow(v, vec3(0.41666)) * 1.055 - vec3(0.055),
        v * 12.92,
        vec3(lessThanEqual(v, vec3(0.0031308)))
      );
    }
    void main() {
      vec2 uv = uMargin + vUv * (1.0 - 2.0 * uMargin);
      vec4 c = texture2D(tDiffuse, uv);
      gl_FragColor = vec4(linearToSRGB(c.rgb), c.a);
    }
  `,
});
// cropPass precedes lensingPass: lensing distorts gamma-encoded
// (sRGB) samples — distorting linear HDR makes bright stars look
// wrong when bent. Operating on already-cropped content also lets
// lensing work in viewport-UV space without BLOOM_OVERSCAN scaling.
composer.addPass(cropPass);

// Screen-space gravitational lensing pass (enabled during deep zoom).
// Samples dust at the bent UV too so background nebulae warp with the
// scene.
const lensingPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    tDust: { value: null },
    uDustActive: { value: 0 },
    uDustScale: { value: 1.0 },
    uBHScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uShadowRadius: { value: 0.0 },
    uSchwarzRadius: { value: 0.0 },
    uAspect: { value: 1.0 },
    uScreenScale: { value: 100.0 },
    // Interior mode: 0 = BH event horizon (shader draws black),
    // >0 = NS (interior is already drawn into tDiffuse by the
    // billboard so the shader just passes it through). The NS and
    // BH handlers set this when they drive the pass.
    uBodyEmissive: { value: 0.0 },
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
    uniform float uBodyEmissive;
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

      // Bend every pixel's sight line around the body.
      float deflection = uSchwarzRadius / max(dist, uShadowRadius * 0.5);
      vec2 deflectDir = normalize(corrected);
      vec2 uvDeflect = vec2(deflectDir.x / uAspect, deflectDir.y) * deflection;
      vec2 bentUV = clamp(uv - uvDeflect, 0.0, 1.0);
      vec3 bent = texture2D(tDiffuse, bentUV).rgb + sampleDust(bentUV);

      // Black holes: the interior is the event horizon (shadow).
      // The shadow mask goes from 0 at b < 0.95 (pure black) to 1
      // at b > 1.05 (full lensed background), with a smooth edge
      // between.
      //
      // Neutron stars: the body is rendered by its billboard in a
      // separate pass after this composer, so there's nothing to
      // draw for the body here — just pass the bent background
      // through and the billboard will cover the body region.
      if (uBodyEmissive < 0.5) {
        float shadow = smoothstep(0.95, 1.05, b);
        gl_FragColor = vec4(bent * shadow, 1.0);
      } else {
        gl_FragColor = vec4(bent, 1.0);
      }
    }
  `,
});
lensingPass.enabled = false;
composer.addPass(lensingPass);
export { lensingPass };

// ─── Lensing arbiter ────────────────────────────────────────────────
//
// `lensingPass` is shared between black-hole and neutron-star handlers.
// Before this arbiter existed, each handler's update() directly toggled
// `lensingPass.enabled` and wrote uniforms. Because both update() fns
// run every frame in registration order, whichever ran last stomped
// whatever the other had set — selecting a BH with the NS handler
// registered later caused the BH lensing to be disabled every frame.
//
// Now each handler calls `requestLensing({...})` during its update().
// `finalizeLensingFrame()` is called once per frame from the render
// loop after updateAllLabels(): if no one requested lensing, it
// disables the pass. Single writer, no ordering fragility.
export type LensingMode = "shadow" | "bodyElsewhere";
export interface LensingParams {
  pos: THREE.Vector3;
  shadowRadiusScene: number;   // where the event-horizon shadow ends
  massMsun: number;             // for Schwarzschild deflection magnitude
  mode: LensingMode;
  camDist?: number;             // actual camera-to-object distance (defaults to orbitRadius)
}
// Per-frame lensing candidates. Multiple handlers may call
// requestLensing in the same frame (e.g. departing BH + arriving NS
// during a transit). finalizeLensingFrame picks the one with the
// largest on-screen shadow — the closer/more-massive object wins.
interface LensingCandidate {
  params: LensingParams;
  shadowFrac: number;
}
let lensingCandidates: LensingCandidate[] = [];

export function requestLensing(p: LensingParams): void {
  const dist = p.camDist ?? orbitRadius;
  const fov = camera.fov * Math.PI / 180;
  const halfTan = Math.tan(fov / 2);
  const shadowFrac = (p.shadowRadiusScene / dist) / (2 * halfTan);
  lensingCandidates.push({ params: p, shadowFrac });
}

function applyLensing(p: LensingParams, shadowFrac: number): void {
  const uniforms = lensingPass.uniforms as Record<string, THREE.IUniform>;
  const dist = p.camDist ?? orbitRadius;

  // When the lensed body IS the orbit target, the screen UV is
  // (0.5, 0.5) by construction. Shortcut avoids residual Float32
  // projection-matrix drift that can shimmer nebula dust under NS
  // lensing. Safe at rest and during transit (camera always looks
  // at target; when pos=target the body is at screen center).
  if (p.pos.equals(target)) {
    uniforms.uBHScreen!.value.set(0.5, 0.5);
  } else {
    projectToScreenUV(p.pos, _uvScratch);
    if (_uvScratch.behind) {
      lensingPass.enabled = false;
      return;
    }
    uniforms.uBHScreen!.value.set(_uvScratch.u, _uvScratch.v);
  }
  uniforms.uAspect!.value = camera.aspect;

  const rsScene = ((RS_KM_PER_MSUN * p.massMsun) / KM_PER_PC) * SCALE;
  const fov = camera.fov * Math.PI / 180;
  const halfTan = Math.tan(fov / 2);
  uniforms.uShadowRadius!.value = shadowFrac;
  uniforms.uSchwarzRadius!.value = (rsScene / dist) / (2 * halfTan);
  uniforms.uScreenScale!.value = shadowFrac * window.innerHeight;
  uniforms.uBodyEmissive!.value = p.mode === "bodyElsewhere" ? 1 : 0;

  lensingPass.enabled = true;
}

export function finalizeLensingFrame(): void {
  if (lensingCandidates.length === 0) {
    lensingPass.enabled = false;
  } else {
    let best = lensingCandidates[0]!;
    for (let i = 1; i < lensingCandidates.length; i++) {
      if (lensingCandidates[i]!.shadowFrac > best.shadowFrac) {
        best = lensingCandidates[i]!;
      }
    }
    // Skip the full-screen shader when the shadow covers less than
    // ~0.1 px — no visible effect, just GPU cost.
    const MIN_SHADOW_FRAC = 0.1 / window.innerHeight;
    if (best.shadowFrac < MIN_SHADOW_FRAC) {
      lensingPass.enabled = false;
      lensingCandidates.length = 0;
      return;
    }
    applyLensing(best.params, best.shadowFrac);
  }
  lensingCandidates.length = 0;
}

export function getLensingOccluder(): { cx: number; cy: number; radius: number } | null {
  if (!lensingPass.enabled) return null;
  const uniforms = lensingPass.uniforms as Record<string, THREE.IUniform>;
  const screen = uniforms.uBHScreen!.value as THREE.Vector2;
  const shadowFrac = uniforms.uShadowRadius!.value as number;
  return {
    cx: screen.x * window.innerWidth,
    cy: (1 - screen.y) * window.innerHeight,
    radius: shadowFrac * window.innerHeight * 4,
  };
}

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

let lastDPR = getRenderPixelRatio();
export function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(getRenderPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  halfViewportPxUniform.value = window.innerHeight / 2;
  if (getRenderPixelRatio() !== lastDPR) {
    lastDPR = getRenderPixelRatio();
    composerRT.dispose();
    composerRT = makeComposerRT();
    composer.reset(composerRT);
  }
  composer.setSize(
    Math.round(window.innerWidth * BLOOM_OVERSCAN),
    Math.round(window.innerHeight * BLOOM_OVERSCAN),
  );
}
