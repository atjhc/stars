// Comet-trail orbit line. Shared by src/planets.ts and src/exoplanets.ts:
// both walk their bodies around a closed ellipse and want the same
// alpha-fading head→tail visual, but each derives the per-ν position
// from its own orbital representation (full Keplerian state for Sol,
// quaternion + semi-major axis for exoplanets).

import * as THREE from "three";

export const ORBIT_BASE_OPACITY = 0.7;

const TRAIL_RGB: [number, number, number] = [0x4d, 0x7f, 0xc4];
const DEFAULT_SEGMENTS = 16384;

// Vertex 0 sits at positionAt(currentNu) (alpha 1); index walks backward
// in ν so the trail extends behind the body's direction of motion, with
// vertex alpha fading 1 → 0 over one full revolution. THREE.Line (not
// LineLoop) so the alpha-1 head and alpha-0 tail aren't bridged by a
// closing segment.
export function buildOrbitTrail(
  positionAt: (nu: number, out: THREE.Vector3) => void,
  currentNu: number,
  segments: number = DEFAULT_SEGMENTS,
): THREE.Line {
  const positions = new Float32Array(segments * 3);
  // RGBA Uint8 (normalized) — Three.js auto-enables USE_COLOR_ALPHA
  // when the color attribute has itemSize 4, multiplying vertex alpha
  // into the fragment alongside material.opacity. Saves the custom
  // shader and ~75% memory vs Float32 alpha + default RGB color.
  const colors = new Uint8Array(segments * 4);
  const step = (Math.PI * 2) / segments;
  const tmp = new THREE.Vector3();
  for (let i = 0; i < segments; i++) {
    positionAt(currentNu - i * step, tmp);
    positions[i * 3 + 0] = tmp.x;
    positions[i * 3 + 1] = tmp.y;
    positions[i * 3 + 2] = tmp.z;
    colors[i * 4 + 0] = TRAIL_RGB[0];
    colors[i * 4 + 1] = TRAIL_RGB[1];
    colors[i * 4 + 2] = TRAIL_RGB[2];
    colors[i * 4 + 3] = Math.round(255 * (1 - i / segments));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4, true));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: ORBIT_BASE_OPACITY,
    depthWrite: false,
  });
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  return line;
}
