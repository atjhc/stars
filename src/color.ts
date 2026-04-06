import * as THREE from "three";

export function bvToColor(ci: number): THREE.Color {
  if (ci < -0.4) ci = -0.4;
  if (ci > 2.0) ci = 2.0;
  const temp = 4600.0 * (1.0 / (0.92 * ci + 1.7) + 1.0 / (0.92 * ci + 0.62));
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
