import * as THREE from "three";
import { GLOW_GLSL } from "./starShader.ts";
import {
  halfViewportPxUniform,
  starCameraOffsetUniform,
  starViewRotationUniform,
} from "./shaderUniforms.ts";
import { F_HALF_TAN_INV, F_HALF_TAN_INV_GLSL, VIEW_UNIFORMS_GLSL, TARGET_VIEW_GLSL } from "./shaderLib.ts";
import { LY_TO_SCENE } from "./constants.ts";

// Hover affordance — matched instance gets its intensity multiplied so
// the user sees a subtle brightness bump (no size change, since the
// disc's physical angular extent stays honest).
let hoveredWorldPos: THREE.Vector3 | null = null;
const hoveredActiveUniform: THREE.IUniform<number> = { value: 0 };
export const HOVER_BOOST = 1.6;

export function getHoveredWorldPos(): THREE.Vector3 | null { return hoveredWorldPos; }

export function setHoveredStar(pos: THREE.Vector3 | null): void {
  if (pos) {
    hoveredWorldPos = pos;
    hoveredActiveUniform.value = 1;
  } else {
    hoveredWorldPos = null;
    hoveredActiveUniform.value = 0;
  }
}

// Minimum orbit radius for a selected star — chosen so the disc can't
// exceed `maxFraction` of the viewport half-height at minimum zoom
// (i.e., disc diameter = 2·maxFraction of the viewport). 0.15 keeps
// the star prominent but leaves plenty of room for context.
export function computeStarMinOrbit(radius: number, maxFraction = 0.15): number {
  return (radius * DISC_SCALE * F_HALF_TAN_INV) / maxFraction;
}

// One instanced quad per star, one shader. Visual size and brightness
// derive from two physical quantities:
//   discPx = (R · DISC_SCALE / camDist) · fov_term · halfHeight
//   appMag = absMag + 5·log10(camDist / 10pc)

export const DISC_SCALE = 8.0;

// Lifts near-camera star intensity so cluster members and foreground
// stars read on dim/mobile displays without altering the distant field.
const FOREGROUND_BOOST = 2.0;
const FOREGROUND_NEAR = 0.5;
const FOREGROUND_FAR = 100 * LY_TO_SCENE;

// Tile binary format: 20 bytes per star. Matches scripts/build-catalog.py.
export const BYTES_PER_STAR = 20;

// Device-default mag limit. Desktop = 7.5 (everything visible at the
// darkest naked-eye sky); mobile = 6.5 to thin the background field.
// Overridable via the `?mag=` URL param and the −/= keyboard shortcut.
import { qualityProfile } from "./quality.ts";
export const DEFAULT_MAG_LIMIT = qualityProfile.magLimit;
export const magLimitUniform: THREE.IUniform<number> = { value: DEFAULT_MAG_LIMIT };
export function setMagLimit(v: number) { magLimitUniform.value = v; }

// Apparent magnitude from absolute magnitude and a scene-space distance.
// Shared with the vertex shader's inlined distance-modulus so TS and GLSL
// stay in lockstep. 30 scene units = 10 pc at SCALE = 3. Callers must
// supply a positive sceneDist (use 1e-20 guard for zero-risk paths);
// a hard clamp here would diverge from the shader at close range.
const LOG10 = Math.log(10);
export function apparentMag(absMag: number, sceneDist: number): number {
  return absMag + (5 * Math.log(sceneDist / 30)) / LOG10;
}

// Pixel-space rendering metrics for a single star at a given camera
// distance. THE ONE PLACE this math lives on the CPU — mirrored by the
// vertex shader below. Overlay driver, occluder, and label-margin code
// all call this, so the three stay in lockstep when formulas change.
export const HALO_FLOOR_PX = 4;
export interface StarScreenMetrics {
  discPx: number;
  coronaPx: number;
  halfBillPx: number;
  intensity: number;   // vIntensity equivalent on CPU
  rawBrightness: number;
}
const ZERO_METRICS: StarScreenMetrics = {
  discPx: 0, coronaPx: 0, halfBillPx: 0, intensity: 0, rawBrightness: 0,
};

export function computeStarScreenMetrics(
  radius: number,
  absMag: number,
  camDist: number,
): StarScreenMetrics {
  const safeDist = Math.max(camDist, 1e-20);
  const appMag = apparentMag(absMag, safeDist);
  const magLimit = magLimitUniform.value;
  // Mirrors the vertex shader's hard cull — past the mag limit, the GPU
  // emits no fragments, so occluder / label-margin consumers must also
  // see zeroed extents to avoid reserving real estate for invisible stars.
  if (appMag >= magLimit) return ZERO_METRICS;

  const angRadius = (radius * DISC_SCALE) / safeDist;
  const discPx = angRadius * F_HALF_TAN_INV * halfViewportPxUniform.value;

  const rawBrightness = Math.max(0.1, (magLimit - appMag) * 0.25);
  // Match the shader's smoothstep(uMagLimit-1.5, uMagLimit, appMag).
  const t = Math.max(0, Math.min(1, (appMag - (magLimit - 1.5)) / 1.5));
  const tierFade = 1 - t * t * (3 - 2 * t);
  const foregroundBoost = 1 + FOREGROUND_BOOST * (1 - THREE.MathUtils.smoothstep(safeDist, FOREGROUND_NEAR, FOREGROUND_FAR));
  const intensity = rawBrightness * tierFade * foregroundBoost;

  const coronaPx = HALO_FLOOR_PX * Math.max(1.0, Math.min(2.5, 0.5 + 0.3 * rawBrightness));
  return { discPx, coronaPx, halfBillPx: discPx + coronaPx, intensity, rawBrightness };
}

const vertexShader = `
  uniform float uMagLimit;
  uniform vec3 uLocalTarget;       // target - tileOrigin (per-tile, Float64 on CPU)
  uniform vec3 uLocalHoveredPos;   // hoveredPos - tileOrigin (per-tile)
  uniform float uHoveredActive;   // 1.0 when a star is hovered
  uniform float uHoverBoost;      // brightness multiplier when matched
  ${VIEW_UNIFORMS_GLSL}

  attribute vec3 instancePos;
  attribute vec3 instanceColor;
  attribute float instanceAbsMag;
  attribute float instanceRadius;

  varying vec3 vColor;
  varying float vIntensity;
  varying float vTierFade;
  varying float vDiscPx;
  varying float vHalfBillboardPx;
  varying vec2 vUv;

  ${F_HALF_TAN_INV_GLSL}
  const float DISC_SCALE = ${DISC_SCALE.toFixed(2)};
  const float HALO_FLOOR_PX = ${HALO_FLOOR_PX.toFixed(1)};
  const float FOREGROUND_BOOST = ${FOREGROUND_BOOST.toFixed(2)};
  const float FOREGROUND_NEAR = ${FOREGROUND_NEAR.toFixed(2)};
  const float FOREGROUND_FAR = ${FOREGROUND_FAR.toFixed(2)};
  ${TARGET_VIEW_GLSL}

  void main() {
    vUv = uv;
    vColor = instanceColor;

    // Floating-origin subtraction. uLocalTarget = target - tileOrigin,
    // computed in Float64 on the CPU. For rebased tiles both instancePos
    // and uLocalTarget are small, so the subtraction is precise.
    vec3 viewPos = targetToView(instancePos - uLocalTarget);
    float camDist = max(-viewPos.z, 1e-20);

    // Physical angular size on screen.
    float angRadius = instanceRadius * DISC_SCALE / camDist;
    float discPx = angRadius * F_HALF_TAN_INV * uHalfViewportPx;
    vDiscPx = discPx;

    // Apparent magnitude via distance modulus.
    float appMag = instanceAbsMag + 1.50515 * log2(camDist * (1.0 / 30.0));

    // Hard cull beyond the mag limit. The smoothstep tierFade fades the
    // glow over the last 1.5 mag, but discMask is geometric — without
    // this cull, sub-pixel stars past the limit still paint disc color
    // because smoothstep clamps to a non-zero coverage at small radii.
    if (appMag >= uMagLimit) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float rawBrightness = max(0.1, (uMagLimit - appMag) * 0.25);
    float tierFade = 1.0 - smoothstep(uMagLimit - 1.5, uMagLimit, appMag);
    vTierFade = tierFade;

    float hoverMul = 1.0;
    if (uHoveredActive > 0.5) {
      vec3 toHovered = instancePos - uLocalHoveredPos;
      if (dot(toHovered, toHovered) < 1e-10) hoverMul = uHoverBoost;
    }
    float foregroundBoost = 1.0 + FOREGROUND_BOOST * (1.0 - smoothstep(FOREGROUND_NEAR, FOREGROUND_FAR, camDist));
    vIntensity = rawBrightness * tierFade * hoverMul * foregroundBoost;

    // Halo rim thickness — brightness-driven, bounded, additive to disc.
    // For a sub-pixel star this is the entire visible element.
    float coronaPx = HALO_FLOOR_PX * clamp(0.5 + 0.3 * rawBrightness, 1.0, 2.5);
    float halfBillPx = discPx + coronaPx;
    vHalfBillboardPx = halfBillPx;

    // Map the quad's local ±0.5 vertices to span ±halfBillPx on screen.
    float worldScale = halfBillPx * camDist / (F_HALF_TAN_INV * uHalfViewportPx);
    viewPos.xy += position.xy * worldScale * 2.0;
    gl_Position = projectionMatrix * vec4(viewPos, 1.0);
  }
`;

const fragmentShader = `
  uniform float uTileOpacity;

  varying vec3 vColor;
  varying float vIntensity;
  varying float vTierFade;
  varying float vDiscPx;
  varying float vHalfBillboardPx;
  varying vec2 vUv;

  ${GLOW_GLSL}

  void main() {
    float rUv = length((vUv - 0.5) * 2.0);
    float rPx = rUv * vHalfBillboardPx;

    // Drop alpha at the inscribed circle so the square quad's corners
    // don't leak a rectangular edge via the radial falloff.
    float edgeFade = 1.0 - smoothstep(0.95, 1.0, rUv);

    // Disc: limb-darkened physical body at LDR saturation. Bounded
    // intensity (~1.0) keeps bloom contribution low — edges stay crisp.
    float discMask = smoothstep(vDiscPx + 0.5, vDiscPx - 0.5, rPx) * vTierFade;
    float r2 = (vDiscPx > 0.0) ? (rPx * rPx) / (vDiscPx * vDiscPx) : 1.0;
    float inside = max(0.0, 1.0 - r2);
    float limbDark = 1.0 - 0.6 * (1.0 - sqrt(inside));
    vec3 discColor = vColor * limbDark;

    // Halo: GLOW_GLSL profile normalized across the corona rim. A fixed
    // CORONA_PEAK_OFFSET lifts the sample past the profile peak so the
    // disc edge reads as a soft transition rather than a bright limb
    // ring. For sub-pixel stars (discPx ≈ 0), the profile spans the
    // whole quad with the peak near center — bright point of light.
    float coronaSpan = max(vHalfBillboardPx - vDiscPx, 1.0);
    float linearT = clamp((rPx - vDiscPx) / coronaSpan, 0.0, 1.0);
    const float CORONA_PEAK_OFFSET = 0.15;
    float coronaT = CORONA_PEAK_OFFSET + (1.0 - CORONA_PEAK_OFFSET) * linearT;
    vec2 g = glowAt(coronaT);
    float glowIntensity = g.x * vIntensity;
    vec3 glowColor = mix(vColor, vec3(1.0), smoothstep(0.3, 1.0, g.y * vIntensity));

    float outDisc = 1.0 - discMask;
    vec3 color = (discColor * discMask + glowColor * glowIntensity * outDisc) * edgeFade;
    float alpha = max(discMask, glowIntensity * outDisc) * edgeFade;

    gl_FragColor = vec4(color, alpha) * uTileOpacity;
  }
`;

// Unit-quad geometry shared across all InstancedBufferGeometries. Three.js
// clones the attribute arrays per-geometry so this is safe to reuse.
const QUAD_POSITIONS = new Float32Array([
  -0.5, -0.5, 0,
   0.5, -0.5, 0,
   0.5,  0.5, 0,
  -0.5,  0.5, 0,
]);
const QUAD_UVS = new Float32Array([
  0, 0,  1, 0,  1, 1,  0, 1,
]);
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

export interface TileInstanceData {
  count: number;
  positions: Float32Array;  // 3N, star world positions
  colors: Float32Array;     // 3N, star RGB in 0..1
  absMags: Float32Array;    // N, absolute magnitude
  radii: Float32Array;      // N, physical radius in scene units
}

export function decodeTileBinary(buffer: ArrayBuffer): TileInstanceData {
  const count = buffer.byteLength / BYTES_PER_STAR;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const absMags = new Float32Array(count);
  const radii = new Float32Array(count);

  const view = new DataView(buffer);
  for (let i = 0; i < count; i++) {
    const offset = i * BYTES_PER_STAR;
    positions[i * 3]     = view.getFloat32(offset, true);
    positions[i * 3 + 1] = view.getFloat32(offset + 4, true);
    positions[i * 3 + 2] = view.getFloat32(offset + 8, true);
    absMags[i] = view.getUint8(offset + 12) * 0.1 - 10.0;
    colors[i * 3]     = view.getUint8(offset + 13) / 255;
    colors[i * 3 + 1] = view.getUint8(offset + 14) / 255;
    colors[i * 3 + 2] = view.getUint8(offset + 15) / 255;
    radii[i] = view.getFloat32(offset + 16, true);
  }
  return { count, positions, colors, absMags, radii };
}

function createMaterial(
  opacityUniform: THREE.IUniform<number>,
  localTargetUniform: THREE.IUniform<THREE.Vector3>,
  localHoveredPosUniform: THREE.IUniform<THREE.Vector3>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMagLimit: magLimitUniform,
      uHalfViewportPx: halfViewportPxUniform,
      uTileOpacity: opacityUniform,
      uLocalTarget: localTargetUniform,
      uStarCameraOffset: starCameraOffsetUniform,
      uStarViewRotation: starViewRotationUniform,
      uLocalHoveredPos: localHoveredPosUniform,
      uHoveredActive: hoveredActiveUniform,
      uHoverBoost: { value: HOVER_BOOST },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
}

export function createTileMesh(
  data: TileInstanceData,
  opacityUniform: THREE.IUniform<number>,
  localTargetUniform: THREE.IUniform<THREE.Vector3>,
  localHoveredPosUniform: THREE.IUniform<THREE.Vector3>,
): THREE.Mesh {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(QUAD_POSITIONS, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(QUAD_UVS, 2));
  geometry.setIndex(new THREE.Uint16BufferAttribute(QUAD_INDICES, 1));
  geometry.instanceCount = data.count;

  geometry.setAttribute("instancePos", new THREE.InstancedBufferAttribute(data.positions, 3));
  geometry.setAttribute("instanceColor", new THREE.InstancedBufferAttribute(data.colors, 3));
  geometry.setAttribute("instanceAbsMag", new THREE.InstancedBufferAttribute(data.absMags, 1));
  geometry.setAttribute("instanceRadius", new THREE.InstancedBufferAttribute(data.radii, 1));

  const mesh = new THREE.Mesh(geometry, createMaterial(opacityUniform, localTargetUniform, localHoveredPosUniform));
  mesh.frustumCulled = false;
  return mesh;
}

// ─── Selected-star overlay ───────────────────────────────────────────────
//
// Pure screen-space rendering for the one star at the orbit target. The
// camera always looks at the orbit target, so a selected star is always
// at screen center by definition — we output gl_Position directly in
// clip space, with no world-space math. This is the same pattern the
// The camera-relative reference frame gives every star full Float32
// precision at close range, so no separate overlay is needed for the
// selected star. The instanced shader renders it correctly at all
// distances and during transit.
