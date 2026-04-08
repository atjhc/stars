import * as THREE from "three";

// Shared radial glow profile: Gaussian core + inverse-square halo + soft
// exponential outer glow. Used by the point shader, the billboard shader,
// and the texture baker (so mipmap pre-filtering matches the math path).
export const GLOW_GLSL = `
  // glowAt(d): (intensity, coreOnly) for a unit-radius point at distance d
  vec2 glowAt(float d) {
    float core = exp(-d * d * 30.0);
    float halo = 1.0 / (1.0 + pow(d * 6.0, 2.0));
    float outerGlow = exp(-d * 4.0) * 0.3;
    return vec2(core + halo * 0.4 + outerGlow, core);
  }
`;

function glowAt(d: number): { intensity: number; core: number } {
  const core = Math.exp(-d * d * 30);
  const halo = 1 / (1 + (d * 6) ** 2);
  const outerGlow = Math.exp(-d * 4) * 0.3;
  return { intensity: core + halo * 0.4 + outerGlow, core };
}

// Bakes the same glow profile into a mipmapped texture. The mipmap filter
// pre-smooths the steep core, which kills sub-pixel shader-output oscillation
// that bloom would otherwise amplify into visible halo flicker.
export function createStarGlowTexture(size = 256): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size - 0.5) * 2;
      const dy = ((y + 0.5) / size - 0.5) * 2;
      const d = Math.sqrt(dx * dx + dy * dy);
      const { intensity, core } = glowAt(d);
      const i = (y * size + x) * 4;
      img.data[i] = Math.round(Math.min(1, intensity) * 255);
      img.data[i + 1] = Math.round(Math.min(1, core) * 255);
      img.data[i + 2] = 0;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}
