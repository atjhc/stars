// Shared GLSL snippets and constants for camera-relative view math.
// Used by stars.ts (instanced star shader) and neutronstars.ts
// (NS billboard shader) to avoid duplicating the precision-safe
// target-relative coordinate transform.

// Precomputed 1/tan(fov/2) for the 55° camera FOV. Converts angular
// radius to pixel radius: discPx = angRadius * F_HALF_TAN_INV * halfViewportPx.
export const F_HALF_TAN_INV = 1 / Math.tan((55 * Math.PI) / 360);

// GLSL uniform declarations for the target-relative view transform.
// Include in any vertex shader that needs camera-relative positioning.
export const VIEW_UNIFORMS_GLSL = `
  uniform float uHalfViewportPx;
  uniform vec3 uStarCameraOffset;
  uniform mat3 uStarViewRotation;
`;

// GLSL constant for the precomputed inverse half-tangent.
export const F_HALF_TAN_INV_GLSL = `const float F_HALF_TAN_INV = ${F_HALF_TAN_INV.toFixed(7)};`;

// GLSL function: given a position relative to the orbit target (already
// in the floating-origin frame), compute the view-space position and
// camera distance. Both callers subtract their own local target first
// (stars use per-tile uLocalTarget, NS uses uNSLocalTarget), so this
// function starts from the target-relative position.
export const TARGET_VIEW_GLSL = `
  vec3 targetToView(vec3 localPos) {
    vec3 camRel = localPos - uStarCameraOffset;
    return uStarViewRotation * camRel;
  }
`;

// GLSL helper: map a point in composer NDC space to UV in a half-res RT
// that was rendered at the *unwidened* (visible-viewport) FOV. The
// composer renders with a BLOOM_OVERSCAN-widened FOV, so the visible
// viewport's NDC range is [-1/BLOOM_OVERSCAN, +1/BLOOM_OVERSCAN].
// Scaling by BLOOM_OVERSCAN/2 maps those endpoints to the [0,1] texture
// edges. Currently used to sample halfResRT (dust). Callers pass
// BLOOM_OVERSCAN in so this module stays a leaf (no scene.ts dep).
export function composerNdcToHalfResUvGlsl(overscan: number): string {
  return `
    vec2 composerNdcToHalfResUv(vec2 ndc) {
      return ndc * float(${(overscan * 0.5).toFixed(7)}) + 0.5;
    }
  `;
}
