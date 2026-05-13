// Screen-space lens flare for the brightest visible stars.
//
// Faithful port of mu6k's "Lens Flare Example" (Shadertoy 4sX3Rs,
// public domain). The shader runs BEFORE UnrealBloomPass in the
// composer chain so the 1/r `f0` halo and chromatic ghost orbs get
// bloomed naturally — that's the soft glow visible in the reference.
//
// Per-source uniforms (vec4 packed):
//   xy = aspect-corrected source UV
//   z  = intensity (additive multiplier; flux ratio against REF_MAG)
//   w  = size (geometric scale; tied to apparent disc size)
// The flare math is mu6k's verbatim — every length in the falloff
// formulas is divided by `size` so small/distant sources flare small.

import * as THREE from "three";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { camera, projectToScreenUV } from "./scene.ts";
import type { ScreenUV } from "./scene.ts";
import { notableObjects } from "./starfield.ts";
import { apparentMag } from "./stars.ts";
import { starRadiusScene } from "./color.ts";
import { F_HALF_TAN_INV } from "./shaderLib.ts";
import { halfViewportPxUniform } from "./shaderUniforms.ts";
import type { Star } from "./types.ts";

const MAX_FLARES = 8;
// Apparent-magnitude floor for any flare computation. With
// OUTPUT_SCALE=0.03 and REF_MAG=−20.5, a source dimmer than ≈ −17
// contributes <1/255 sRGB at its peak — visually nothing — so this
// cutoff at −15 leaves a comfortable margin (Sol becomes visible
// around ~250 AU) while skipping the per-frame projection / flux work
// for the ~270 named stars that would otherwise loop through.
const FLARE_MAG_CUTOFF = -15.0;
// Reference magnitude for the flux curve. Calibrated so the flare hits
// INTENSITY_CEILING (full brightness) at 10 AU from Sol — Sol's apparent
// magnitude at 10 AU is −21.74, and exp(POGSON · (REF_MAG − mag)) = 3
// solves to REF_MAG ≈ −20.5. Falloff per distance:
//   1 AU            → cap (3.0)
//   10 AU           → cap (3.0) — flare goes full-bright here
//   30 AU           → 0.35
//   50 AU (Kuiper)  → 0.13
//   100 AU          → 0.03
//   1000 AU         → 3e-4
//   1 ly            → 3e-7  (invisible)
// Stars other than Sol can't reach the required mag, so they stay dark.
const FLARE_REF_MAG = -20.5;
const REFERENCE_DISC_PX = 5.0;
const MIN_SIZE = 0.15;
// Capped at ~1.0 to limit how wide the f0 halo can get on inner-planet
// views. Without this cap Mercury's halo is ~6× Ceres' (since size
// scales with √discPx and the halo with size² in the falloff), which
// reads as overpowering. Ceres-distance (S ≈ 0.62) sits comfortably
// under the cap; Earth lands right at it; closer views plateau.
const MAX_SIZE = 1.0;
// Per-source intensity ceiling. Flare runs in sRGB additive so values
// stack with the already-bloomed scene; peaks above ~0.6 read as
// blowout rather than dramatic glow.
const INTENSITY_CEILING = 3.0;
// Master scale. Peak f0 contribution at INTENSITY_CEILING is
// 3 × 1.85 × 1.4 × 0.03 ≈ 0.23 sRGB — calibrated so the in-system Sol
// flare reads at "Ceres looks best" without overpowering the inner
// planets when MAX_SIZE caps the halo extent.
const OUTPUT_SCALE = 0.03;
// Boost the orb chain so it reads when spread along the source→origin
// line (planet-focused views, Sol off-center). When focused on Sol the
// orbs collapse to the source per mu6k's math, so they only need to
// hold up at the planet-view geometry.
const ORB_BOOST = 6.0;
// log(2.512) — flux ratio per magnitude in natural log space.
const POGSON = Math.log(2.512);

const fragmentShader = `
  precision highp float;
  uniform sampler2D tDiffuse;
  uniform vec4 uFlares[${MAX_FLARES}];
  uniform float uAspect;
  varying vec2 vUv;

  // Procedural value noise replacing mu6k's iChannel0 texture sampler.
  float hash(float x) {
    return fract(sin(x * 12.9898) * 43758.5453);
  }
  float noise1(float p) {
    float i = floor(p);
    float f = fract(p);
    float u = f * f * (3.0 - 2.0 * f);
    return mix(hash(i), hash(i + 1.0), u);
  }

  // mu6k 4sX3Rs port. uv and pos are in aspect-corrected UV space
  // (vertical extent ±0.5). \`bright\` and \`size\` are added on top of
  // mu6k's stock formulas: every \`length(...)\` falloff term is
  // divided by \`size\` so small sources flare small.
  vec3 lensflare(vec2 uv, vec2 pos, float bright, float size) {
    float S = max(size, 0.05);

    vec2 main = uv - pos;
    vec2 uvd = uv * length(uv);

    float ang = atan(main.x, main.y);
    float dist = length(main);
    float distP = pow(max(dist, 1e-5), 0.1);

    // f0 — the dominant 1/r halo with subtle ray-modulation. The "rays"
    // visible in mu6k's reference are this halo's modulated brightness,
    // not a separate component. Quadratic size scaling (1/S²) makes
    // small/distant sources have a much tighter halo. Falloff multiplier
    // 32 (mu6k's stock 16 made the halo half the screen wide for big S).
    float f0 = 1.0 / (length(uv - pos) / (S * S) * 32.0 + 1.0);
    f0 = f0 + f0 * (sin(noise1(sin(ang * 2.0 + pos.x) * 4.0
                              - cos(ang * 3.0 + pos.y)) * 16.0) * 0.1
                    + distP * 0.1 + 0.8);

    // Chromatic ghost orbs along the curved (uvd) path.
    float f2  = max(1.0 / (1.0 + 32.0 * pow(length(uvd + 0.80 * pos) / S, 2.0)), 0.0) * 0.25;
    float f22 = max(1.0 / (1.0 + 32.0 * pow(length(uvd + 0.85 * pos) / S, 2.0)), 0.0) * 0.23;
    float f23 = max(1.0 / (1.0 + 32.0 * pow(length(uvd + 0.90 * pos) / S, 2.0)), 0.0) * 0.21;

    vec2 uvx = mix(uv, uvd, -0.5);
    float f4  = max(0.01 - pow(length(uvx + 0.40 * pos) / S, 2.4), 0.0) * 6.0;
    float f42 = max(0.01 - pow(length(uvx + 0.45 * pos) / S, 2.4), 0.0) * 5.0;
    float f43 = max(0.01 - pow(length(uvx + 0.50 * pos) / S, 2.4), 0.0) * 3.0;

    uvx = mix(uv, uvd, -0.4);
    float f5  = max(0.01 - pow(length(uvx + 0.20 * pos) / S, 5.5), 0.0) * 2.0;
    float f52 = max(0.01 - pow(length(uvx + 0.40 * pos) / S, 5.5), 0.0) * 2.0;
    float f53 = max(0.01 - pow(length(uvx + 0.60 * pos) / S, 5.5), 0.0) * 2.0;

    uvx = mix(uv, uvd, -0.5);
    float f6  = max(0.01 - pow(length(uvx - 0.30  * pos) / S, 1.6), 0.0) * 6.0;
    float f62 = max(0.01 - pow(length(uvx - 0.325 * pos) / S, 1.6), 0.0) * 3.0;
    float f63 = max(0.01 - pow(length(uvx - 0.35  * pos) / S, 1.6), 0.0) * 5.0;

    vec3 c = vec3(0.0);
    c.r += f2 + f4 + f5 + f6;
    c.g += f22 + f42 + f52 + f62;
    c.b += f23 + f43 + f53 + f63;
    c = c * 1.3 - vec3(length(uvd) * 0.05);
    c = max(c, vec3(0.0));

    // Boost orbs separately from f0 — the chromatic chain is much
    // dimmer than the halo in mu6k's stock formula and gets lost when
    // there's a rendered disc behind it.
    vec3 result = c * float(${ORB_BOOST.toFixed(2)}) + vec3(f0);
    return result * vec3(1.4, 1.2, 1.0) * bright * float(${OUTPUT_SCALE.toFixed(4)});
  }

  void main() {
    vec3 base = texture2D(tDiffuse, vUv).rgb;
    // mu6k's uv space: screen-centered, aspect-corrected.
    vec2 uv = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);

    vec3 flare = vec3(0.0);
    for (int i = 0; i < ${MAX_FLARES}; i++) {
      vec4 f = uFlares[i];
      if (f.z <= 0.0) continue;
      vec2 pos = vec2((f.x - 0.5) * uAspect, f.y - 0.5);

      // Occlusion: sample the post-bloom scene at the source's screen
      // position; if it's dim, something is in front (e.g. a planet
      // covering Sol), so attenuate the flare. Off-screen sources skip
      // the sample (texture lookup would clamp to edge and falsely
      // dim them) and stay full-strength.
      float visibility = 1.0;
      if (f.x >= 0.0 && f.x <= 1.0 && f.y >= 0.0 && f.y <= 1.0) {
        vec3 src = texture2D(tDiffuse, f.xy).rgb;
        float luma = max(max(src.r, src.g), src.b);
        visibility = smoothstep(0.3, 0.8, luma);
      }

      flare += lensflare(uv, pos, f.z, f.w) * visibility;
    }

    gl_FragColor = vec4(base + flare, 1.0);
  }
`;

export const lensFlarePass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uFlares: {
      value: Array.from({ length: MAX_FLARES }, () => new THREE.Vector4()),
    },
    uAspect: { value: 1 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader,
});
// Read back the cloned uniforms — ShaderPass deep-clones via UniformsUtils,
// so updating the originals passed into the constructor has no effect.
const flaresUniform = lensFlarePass.uniforms.uFlares as THREE.IUniform<THREE.Vector4[]>;
const aspectUniform = lensFlarePass.uniforms.uAspect as THREE.IUniform<number>;

interface Candidate {
  x: number;
  y: number;
  intensity: number;
  size: number;
  rank: number;
}
const candidates: Candidate[] = [];
const screenUV: ScreenUV = { u: 0, v: 0, behind: false };

export function updateLensFlares(width: number, height: number): void {
  let n = 0;

  if (lensFlarePass.enabled) {
    aspectUniform.value = width / height;
    candidates.length = 0;

    for (const obj of notableObjects) {
      const star = obj.userData as Star;
      if (star.absmag === undefined || star.lum === undefined || star.ci === undefined) continue;

      projectToScreenUV(obj.position, screenUV);
      if (screenUV.behind) continue;
      // No on-screen bounds check — when the source slides just off-frame
      // the f0 halo and ghost chain still extend onto the visible viewport,
      // so cutting them off abruptly looks wrong. Far-off sources contribute
      // negligibly because of f0's 1/r falloff.

      const camDist = Math.max(camera.position.distanceTo(obj.position), 1e-20);
      const mag = apparentMag(star.absmag, camDist);
      if (mag > FLARE_MAG_CUTOFF) continue;

      const flux = Math.exp(POGSON * (FLARE_REF_MAG - mag));
      const intensity = Math.min(INTENSITY_CEILING, flux);

      const radius = starRadiusScene(star.lum, star.ci);
      const discPx = (radius / camDist) * F_HALF_TAN_INV * halfViewportPxUniform.value;
      const sizeRaw = Math.sqrt(discPx / REFERENCE_DISC_PX);
      const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, sizeRaw));

      candidates.push({
        x: screenUV.u,
        y: screenUV.v,
        intensity,
        size,
        rank: intensity * size,
      });
    }

    candidates.sort((a, b) => b.rank - a.rank);
    n = Math.min(MAX_FLARES, candidates.length);
    for (let i = 0; i < n; i++) {
      const c = candidates[i]!;
      flaresUniform.value[i]!.set(c.x, c.y, c.intensity, c.size);
    }
  }

  for (let i = n; i < MAX_FLARES; i++) flaresUniform.value[i]!.set(0, 0, 0, 0);
}
