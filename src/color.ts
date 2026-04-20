import * as THREE from "three";
import { SCALE } from "./constants.ts";

const T_SUN = 5778;
const R_SUN_SCENE = 2.254e-8 * SCALE; // solar radius in scene units

// B-V color index → blackbody temperature (Ballesteros' approximation).
function bvToTemp(ci: number): number {
  const c = Math.max(-0.4, Math.min(2.0, ci));
  return 4600.0 * (1.0 / (0.92 * c + 1.7) + 1.0 / (0.92 * c + 0.62));
}

// Physical stellar radius in scene units via Stefan-Boltzmann.
export function starRadiusScene(lum: number, ci: number): number {
  const temp = bvToTemp(ci);
  const rSolar = Math.sqrt(Math.max(lum, 1e-6)) / Math.pow(temp / T_SUN, 2);
  return rSolar * R_SUN_SCENE;
}

export function bvToColor(ci: number): THREE.Color {
  const temp = bvToTemp(ci);
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

export function starGlowShadow(ci: number): string {
  const color = bvToColor(ci);
  const r = Math.round(Math.min(255, color.r * 255 * 1.3));
  const g = Math.round(Math.min(255, color.g * 255 * 1.3));
  const b = Math.round(Math.min(255, color.b * 255 * 1.3));
  return `0 0 8px rgba(${r},${g},${b},0.9), 0 0 20px rgba(${r},${g},${b},0.4), 0 0 4px #000`;
}

// Canvas-friendly glow — one color/blur pair approximating the
// multi-shadow CSS. Canvas shadowBlur is Gaussian like CSS text-shadow;
// using the inner-bright layer keeps the hot-spot visible at the cost
// of the soft 20px halo (visible only on very bright stars anyway).
export function starGlowCanvas(ci: number): { color: string; blur: number } {
  const color = bvToColor(ci);
  const r = Math.round(Math.min(255, color.r * 255 * 1.3));
  const g = Math.round(Math.min(255, color.g * 255 * 1.3));
  const b = Math.round(Math.min(255, color.b * 255 * 1.3));
  return { color: `rgba(${r},${g},${b},0.95)`, blur: 10 };
}
