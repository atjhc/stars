// Confirmed-exoplanet visualization. Lazy data load, lazy mesh
// construction: nothing renders until the user selects a host star
// that has matched planets. Cleared on any focus change.
//
// All orbital geometry is rendered in the host's local frame (group
// at the star's scene position). Inclination / node / argument of
// periastron are seeded-random per planet when not measured, so the
// scene shows that we don't pretend to know orientations we couldn't
// measure — but the placement is stable across reloads.

import * as THREE from "three";
import { scene, camera, animateTo, setMinOrbitOverride } from "./scene.ts";
import { KM_PER_PC, SCALE, SCENE_PER_AU, TILE_BASE_URL } from "./constants.ts";
import { kick } from "./renderLoop.ts";
import { getSelectedMesh } from "./systemStore.ts";
import type { Star } from "./types.ts";
import {
  registerCanvasLabel, unregisterCanvasLabel, updateCanvasLabel,
} from "./labelCanvas.ts";
import { registerLabelType, type LabelTypeHandler } from "./labelRegistry.ts";
import { createPlanetMesh, makeFallbackTexture } from "./planets.ts";
import { buildOrbitTrail } from "./orbitLine.ts";

const EARTH_RADIUS_KM = 6378;
const RE_TO_SCENE = (EARTH_RADIUS_KM / KM_PER_PC) * SCALE;

// Loose mass-radius bin tints — matched to scripts/fetch-exoplanets.py
// composition_class(). Earth-tone rocky, water-world blue-grey, pale
// Neptune blue, warm Jovian for gas giants.
const CLASS_TINT: Record<string, [number, number, number]> = {
  rocky: [0.55, 0.35, 0.25],
  superEarth: [0.40, 0.45, 0.55],
  neptune: [0.45, 0.55, 0.75],
  gasGiant: [0.85, 0.75, 0.55],
};

export interface ExoPlanet {
  name: string;
  radius_re: number;
  mass_me: number | null;
  a_au: number;
  e: number | null;
  period_days: number | null;
  incl_deg: number | null;
  lper_deg: number | null;
  eqt_k: number | null;
  class: string;
  disc_year: number | null;
  disc_method: string | null;
}

interface SystemEntry { host: string; planets: ExoPlanet[] }

interface ExoData {
  by_gaia: Record<string, SystemEntry>;
  aliases: Record<string, string>;
}

let data: ExoData | null = null;
let dataLoading: Promise<ExoData | null> | null = null;

function loadData(): Promise<ExoData | null> {
  if (data) return Promise.resolve(data);
  if (dataLoading) return dataLoading;
  dataLoading = fetch(`${TILE_BASE_URL}exoplanets.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { data = d; return d; })
    .catch(() => null);
  return dataLoading;
}

function resolveGaiaId(d: ExoData, star: Star): string | null {
  if (star.name && d.aliases[star.name]) return d.aliases[star.name];
  for (const a of star.aliases ?? []) {
    if (d.aliases[a]) return d.aliases[a];
  }
  return null;
}

interface MountedPlanet {
  name: string;
  worldPos: THREE.Vector3;
  radius: number;        // scene units
  data: ExoPlanet;
}

let currentMesh: THREE.Object3D | null = null;
let currentGroup: THREE.Group | null = null;
let currentPlanets: MountedPlanet[] = [];
let currentEntry: SystemEntry | null = null;

function canvasIdFor(name: string): string { return `exoplanet:${name}`; }

// Tear down the scene group + labels; currentMesh is owned by
// updateExoplanets() and tracks selection changes independently.
function teardown(): void {
  for (const p of currentPlanets) unregisterCanvasLabel(canvasIdFor(p.name));
  if (currentGroup) {
    scene.remove(currentGroup);
    currentGroup.traverse((o) => {
      if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && typeof (m as THREE.Material).dispose === "function") m.dispose();
    });
  }
  currentGroup = null;
  currentPlanets = [];
  currentEntry = null;
}

// Match docs/planets.md: Sol fades planet labels out over the
// 900–1000 AU band from the camera. Reusing the same band keeps the
// "you're in a planetary system" zoom range consistent across hosts.
const LABEL_FADE_NEAR_AU = 900;
const LABEL_FADE_FAR_AU = 1000;

export function updateExoplanets(): void {
  const mesh = getSelectedMesh();
  if (mesh !== currentMesh) {
    currentMesh = mesh;
    teardown();
    if (mesh) void mountFor(mesh);
    return;
  }
  if (currentPlanets.length === 0 || !currentGroup) return;
  const camDistAu = camera.position.distanceTo(currentGroup.position) / SCENE_PER_AU;
  const fade = 1 - THREE.MathUtils.smoothstep(camDistAu, LABEL_FADE_NEAR_AU, LABEL_FADE_FAR_AU);
  for (const p of currentPlanets) {
    updateCanvasLabel(canvasIdFor(p.name), { opacityTarget: fade });
  }
}

async function mountFor(mesh: THREE.Object3D): Promise<void> {
  const d = await loadData();
  if (currentMesh !== mesh) return;          // selection moved on
  if (!d) return;
  const star = mesh.userData as Star;
  const gid = resolveGaiaId(d, star);
  if (!gid) return;
  const entry = d.by_gaia[gid];
  if (!entry) return;
  currentGroup = buildSystem(entry, mesh.position);
  currentEntry = entry;
  scene.add(currentGroup);
  // Loosen the star-focus minimum-orbit floor so the user can scroll-zoom
  // (or click a planet) and get close enough to see the bodies, which are
  // sub-pixel at the default star-arrival distance. Smallest-planet
  // radius is the tightest sensible floor. Cleared on deselect via
  // interaction.ts's clearStarSystemSelection().
  let minR = Infinity;
  for (const p of currentPlanets) if (p.radius > 0) minR = Math.min(minR, p.radius);
  if (Number.isFinite(minR)) setMinOrbitOverride(minR * 2);
  kick();
}

function buildSystem(entry: SystemEntry, hostPos: THREE.Vector3): THREE.Group {
  const group = new THREE.Group();
  group.position.copy(hostPos);
  group.frustumCulled = false;
  currentPlanets = [];
  const plane = systemPlaneQuaternion(entry.host);
  for (const p of entry.planets) {
    if (p.a_au === null || p.a_au <= 0) continue;
    const q = planetOrbitQuaternion(plane, p);
    const phase = seededRng(p.name + "/phase")() * Math.PI * 2;
    const pos = orbitPositionAt(p, q, phase, new THREE.Vector3());
    group.add(buildOrbitLine(p, q));
    const body = buildBody(p, pos);
    group.add(body);
    const radius = p.radius_re * RE_TO_SCENE;
    const worldPos = hostPos.clone().add(pos);
    currentPlanets.push({ name: p.name, worldPos, radius, data: p });
    registerCanvasLabel({
      id: canvasIdFor(p.name),
      kind: "exoplanet",
      anchor: worldPos,
      text: p.name,
      font: EXO_LABEL_FONT,
      color: EXO_LABEL_COLOR,
      // Same band that Sol's planets occupy. Higher than BH/NS; lower
      // than Sol planets (we're never on screen with them — Sol's
      // planets only render inside Sol's system).
      rank: 1900,
      marginTop: 10,
      opacityTarget: 0,
      payload: { name: p.name },
    });
  }
  return group;
}

const EXO_LABEL_FONT = `12px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const EXO_LABEL_COLOR = "rgba(170,200,235,0.9)";

// Per-planet tilt from the shared system plane. σ ≈ 2.5° matches the
// Solar System's invariable-plane dispersion (Mercury 7°, others 1-3°),
// clamped at ±20° so an unlucky tail draw stays inside the
// envelope spanned by Pluto-like outliers without flipping the orbit
// upside down.
const TILT_SIGMA_DEG = 2.5;
const TILT_CLAMP_DEG = 20;

function systemPlaneQuaternion(hostName: string): THREE.Quaternion {
  const rng = seededRng(hostName + "/plane");
  // Uniform sample on the sphere → orientation of the system's
  // shared orbital plane normal.
  const u = rng() * 2 - 1;
  const phi = rng() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  const normal = new THREE.Vector3(s * Math.cos(phi), u, s * Math.sin(phi));
  return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
}

// q maps mesh-local frame (orbit in XZ, normal +Y, periapsis +X) to
// world. Composed plane × tilt × peri-rotation.
function planetOrbitQuaternion(plane: THREE.Quaternion, p: ExoPlanet): THREE.Quaternion {
  const rng = seededRng(p.name + "/orient");
  // Gaussian tilt magnitude, clamped. Axis of tilt is random around the
  // local +Y so the perturbation can point any direction off the plane.
  let tiltDeg = boxMuller(rng) * TILT_SIGMA_DEG;
  tiltDeg = Math.max(-TILT_CLAMP_DEG, Math.min(TILT_CLAMP_DEG, tiltDeg));
  const tiltAzimuth = rng() * Math.PI * 2;
  const tiltAxis = new THREE.Vector3(Math.cos(tiltAzimuth), 0, Math.sin(tiltAzimuth));
  const qTilt = new THREE.Quaternion().setFromAxisAngle(tiltAxis, tiltDeg * Math.PI / 180);
  // Argument of periastron in the planet's plane. Use the measured
  // value when present; the Archive's lper is per-planet so it doesn't
  // need a system-wide reference to be meaningful.
  const periAngle = p.lper_deg !== null
    ? p.lper_deg * Math.PI / 180
    : rng() * Math.PI * 2;
  const qPeri = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), periAngle,
  );
  return plane.clone().multiply(qTilt).multiply(qPeri);
}

// Box-Muller for a standard normal, clamped to a well-defined range.
function boxMuller(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-10);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function orbitPositionAt(
  p: ExoPlanet, q: THREE.Quaternion, nu: number, out: THREE.Vector3,
): THREE.Vector3 {
  const a = p.a_au * SCENE_PER_AU;
  const e = p.e ?? 0;
  const r = (a * (1 - e * e)) / (1 + e * Math.cos(nu));
  // Local frame: periapsis along +X, orbital normal +Y, perpendicular
  // (90° true anomaly) along +Z.
  return out.set(r * Math.cos(nu), 0, r * Math.sin(nu)).applyQuaternion(q);
}

function buildOrbitLine(p: ExoPlanet, q: THREE.Quaternion): THREE.Line {
  // Static-phase here (currentNu = 0): exoplanets don't propagate
  // around their orbit at runtime, so the "head" of the trail just
  // sits at the planet's deterministic phase. The fading head-to-tail
  // walk still reads as motion direction.
  return buildOrbitTrail((nu, out) => {
    orbitPositionAt(p, q, nu, out);
  }, 0);
}

// Per-class 1×1 tinted textures, reused across every planet of that
// class so we're not re-uploading a 4-byte DataTexture per body.
const classTextures = new Map<string, THREE.DataTexture>();
function classTexture(cls: string): THREE.DataTexture {
  let tex = classTextures.get(cls);
  if (tex) return tex;
  const rgb = CLASS_TINT[cls] ?? [0.5, 0.5, 0.5];
  tex = makeFallbackTexture(new THREE.Color(rgb[0], rgb[1], rgb[2]));
  classTextures.set(cls, tex);
  return tex;
}

function buildBody(p: ExoPlanet, pos: THREE.Vector3): THREE.Mesh {
  // Reuse Sol's body shader (createPlanetMesh) so exoplanets get the
  // same diffuse + specular + ambient-wrap shading. Uniforms not used
  // for v1 — surface texture, atmosphere, parent shine, sphere
  // occluders — default to their no-op values.
  const radius = p.radius_re * RE_TO_SCENE;
  // Host is at the group origin; planet sits at local-frame `pos`.
  // Sun direction (planet → host) is therefore -pos.
  const sunDir = pos.clone().normalize().negate();
  const mesh = createPlanetMesh(radius, sunDir, /* illumination */ 1, null, /* atmosphere */ 0);
  (mesh.material as THREE.ShaderMaterial).uniforms.uTexture!.value = classTexture(p.class);
  mesh.position.copy(pos);
  mesh.frustumCulled = false;
  return mesh;
}

function seededRng(seed: string): () => number {
  // FNV-1a → xorshift32. Deterministic across reloads so planet
  // positions and orbit orientations stay stable per system.
  let h = 2166136261 | 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) / 0x100000000);
  };
}

// Detail-panel hook: return the system data for a focused star so the
// detail builder can list "5 planets, …" without re-resolving the join.
export function exoplanetsForStar(star: Star): ExoPlanet[] | null {
  if (!data) { void loadData(); return null; }
  const gid = resolveGaiaId(data, star);
  if (!gid) return null;
  return data.by_gaia[gid]?.planets ?? null;
}

const CLASS_LABEL: Record<string, string> = {
  rocky: "Rocky",
  superEarth: "Super-Earth",
  neptune: "Neptune-like",
  gasGiant: "Gas giant",
};

export function exoplanetsDetailHtml(star: Star): string {
  // If the host star matches a mounted system, prefer the mounted list
  // (already resolved, ordered, and click-targetable). Otherwise fall
  // back to a static lookup — covers the brief window between selection
  // and async mount.
  let planets: ExoPlanet[] | null = null;
  if (currentEntry && currentMesh && (currentMesh.userData as Star) === star) {
    planets = currentEntry.planets;
  } else {
    planets = exoplanetsForStar(star);
  }
  if (!planets || planets.length === 0) return "";
  const rows = planets.map((p) => {
    const cls = CLASS_LABEL[p.class] ?? p.class;
    const a = p.a_au !== null ? `${p.a_au.toFixed(p.a_au < 1 ? 3 : 2)} AU` : "?";
    const r = `${p.radius_re.toFixed(2)} R⊕`;
    return `<div class="exoplanet-row" data-exoplanet-name="${p.name}">` +
      `<span class="exoplanet-name">${p.name}</span>` +
      `<span class="exoplanet-meta">${cls} · ${a} · ${r}</span>` +
      `</div>`;
  }).join("");
  return `<div class="exoplanets-section"><div class="exoplanets-header">Confirmed planets (${planets.length})</div>${rows}</div>`;
}

export function focusExoplanetByName(name: string): boolean {
  const planet = currentPlanets.find((p) => p.name === name);
  if (!planet) return false;
  // 6 × planet radius reads with the planet roughly half the viewport.
  animateTo(planet.worldPos, planet.radius * 6);
  kick();
  return true;
}

const exoplanetHandler: LabelTypeHandler = {
  type: "exoplanet",
  // Overlay — picking a planet must not clear the host-star focus, or
  // updateExoplanets would tear the system down the very next frame
  // (when getSelectedMesh() returns null). Same model constellations
  // use: the click retargets the camera while the underlying star
  // selection (and the URL's focus= param) stays intact.
  overlay: true,
  setVisible() { /* labels follow the global toggle via labelCanvas */ },
  update() { /* per-frame work happens in updateExoplanets() */ },
  selectByName(name) { return focusExoplanetByName(name); },
  clearSelection() { /* no internal selection state */ },
  getSelectedName() { return null; },
  setHoverByName() { /* no hover state */ },
  handleClick() { return false; },
  detailHtml() { return null; },
};
registerLabelType(exoplanetHandler);
