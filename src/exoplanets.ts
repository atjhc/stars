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
import {
  scene, camera, animateTo, setMinOrbitOverride,
  distanceFromCamera, projectToLabelScreen, target,
} from "./scene.ts";
import {
  KM_PER_PC, SCALE, SCENE_PER_AU, TILE_BASE_URL, formatAstroDistance,
} from "./constants.ts";
import { kick } from "./renderLoop.ts";
import { getSelectedMesh } from "./systemStore.ts";
import { whenSearchIndexReady, type SearchEntry } from "./catalog.ts";
import { isFavorite } from "./favorites.ts";
import { pushFrameOccluder } from "./labelRegistry.ts";
import { starLabelMargin } from "./labels.ts";
import type { Star } from "./types.ts";
import {
  registerCanvasLabel, unregisterCanvasLabel, updateCanvasLabel,
} from "./labelCanvas.ts";
import { registerLabelType, type LabelTypeHandler } from "./labelRegistry.ts";
import { createPlanetMesh, makeFallbackTexture } from "./planets.ts";
import { buildPrecisionOrbitLine } from "./orbitLine.ts";

const EARTH_RADIUS_KM = 6378;
const RE_TO_SCENE = (EARTH_RADIUS_KM / KM_PER_PC) * SCALE;

// Tints follow scripts/fetch-exoplanets.py composition_class(). Only
// classes confidently inferable from radius + density get a colour;
// the ambiguous middle (sub-Neptune / mini-Neptune / water world)
// renders as neutral gray so we don't claim a composition we can't
// support.
const CLASS_TINT: Record<string, [number, number, number]> = {
  rocky: [0.55, 0.35, 0.25],
  neptune: [0.45, 0.55, 0.75],
  gasGiant: [0.85, 0.75, 0.55],
  unknown: [0.50, 0.48, 0.50],
};

export interface ExoPlanet {
  name: string;
  radius_re: number;
  mass_me: number | null;
  density_gcm3: number | null;
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
const mountedByHost = new Map<string, MountedPlanet[]>();
const mountResolvers = new Map<string, Array<() => void>>();

// Host position relative to the camera target, refreshed each frame in
// updateExoplanets(). Drives the orbit-line shader's view-space math —
// see buildPrecisionOrbitLine().
const hostFromTargetUniform: THREE.IUniform<THREE.Vector3> = {
  value: new THREE.Vector3(),
};

// Currently selected exoplanet (clicked via label / search / detail row).
// Overlay-mode selection: distinct from the host-star focus, lives only
// here. Active state drives label pinning + subtitle, and gives the
// detail panel something to render in place of the host's panel.
let selectedExoplanet: MountedPlanet | null = null;
let hoveredExoplanet: MountedPlanet | null = null;

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
  if (currentMesh) {
    const starName = (currentMesh.userData as Star | undefined)?.name;
    if (starName) mountedByHost.delete(starName);
  }
  currentGroup = null;
  currentPlanets = [];
  currentEntry = null;
  selectedExoplanet = null;
  hoveredExoplanet = null;
}

// Match docs/planets.md: Sol fades planet labels out over the
// 900–1000 AU band from the camera. Reusing the same band keeps the
// "you're in a planetary system" zoom range consistent across hosts.
const LABEL_FADE_NEAR_AU = 900;
const LABEL_FADE_FAR_AU = 1000;

const tmpScreen = { x: 0, y: 0, behind: false };

export function updateExoplanets(): void {
  const mesh = getSelectedMesh();
  if (mesh !== currentMesh) {
    currentMesh = mesh;
    teardown();
    if (mesh) void mountFor(mesh);
    return;
  }
  if (currentPlanets.length === 0 || !currentGroup) return;
  // Float64 host - target; orbit-line shader divides by view-z so any
  // Float32-pipeline noise here is amplified to many pixels of wobble
  // for the orbit vertex closest to the camera.
  hostFromTargetUniform.value.copy(currentGroup.position).sub(target);
  const camDistAu = camera.position.distanceTo(currentGroup.position) / SCENE_PER_AU;
  const fade = 1 - THREE.MathUtils.smoothstep(camDistAu, LABEL_FADE_NEAR_AU, LABEL_FADE_FAR_AU);
  const halfTan = Math.tan((camera.fov * Math.PI) / 360);
  const halfHeight = window.innerHeight / 2;
  for (const p of currentPlanets) {
    const isActive = p === selectedExoplanet;
    const trueDist = distanceFromCamera(p.worldPos);
    const discPx = (p.radius / Math.max(trueDist, 1e-30)) * halfHeight / halfTan;
    // Mirrors planetHandler.update() — the disc occluder also gates
    // label collision against the body, and the pixel-floor click
    // radius keeps small bodies hittable on high-DPI displays.
    if (discPx > 2) {
      projectToLabelScreen(p.worldPos, tmpScreen);
      if (!tmpScreen.behind) {
        pushFrameOccluder({ cx: tmpScreen.x, cy: tmpScreen.y, radius: discPx });
      }
    }
    updateCanvasLabel(canvasIdFor(p.name), {
      hidden: false,
      opacityTarget: isActive ? 1.0 : fade,
      pinned: isActive,
      subtitles: isActive ? [formatAstroDistance(trueDist)] : [],
      marginTop: starLabelMargin(discPx, discPx),
    });
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
  // Key by the star's runtime name, not the Archive's `host` field —
  // search entries (and whenExoplanetMounted callers) use the catalog's
  // primary name (e.g. "Chalawan"), not the Archive's loose alias
  // ("47 UMa"). Same scheme keeps mount lookups consistent regardless
  // of which alias kicked off the selection.
  const starName = (mesh.userData as Star).name;
  if (starName) {
    mountedByHost.set(starName, currentPlanets);
    const waiters = mountResolvers.get(starName);
    if (waiters) {
      mountResolvers.delete(starName);
      for (const r of waiters) r();
    }
  }
  kick();
}

// Resolves the next time the named host's system is mounted (or
// immediately if it already is). Used by search-select: clicking an
// exoplanet entry first selects the host star, which kicks off
// mountFor() asynchronously — the caller awaits this before asking
// the handler to focus the individual planet.
export function whenExoplanetMounted(hostName: string): Promise<void> {
  if (mountedByHost.has(hostName)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const arr = mountResolvers.get(hostName) ?? [];
    arr.push(resolve);
    mountResolvers.set(hostName, arr);
  });
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
    group.add(buildOrbitLine(p, q, phase));
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
      shadowColor: EXO_CANVAS_SHADOW.color,
      shadowBlur: EXO_CANVAS_SHADOW.blur,
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
const EXO_CANVAS_SHADOW = { color: "rgba(80,100,140,0.7)", blur: 6 };
const EXO_CANVAS_GLOW = { color: "rgba(170,200,235,1.0)", blur: 12 };

function applyGlow(name: string) {
  updateCanvasLabel(canvasIdFor(name), {
    shadowColor: EXO_CANVAS_GLOW.color,
    shadowBlur: EXO_CANVAS_GLOW.blur,
  });
}

function removeGlow(name: string) {
  updateCanvasLabel(canvasIdFor(name), {
    shadowColor: EXO_CANVAS_SHADOW.color,
    shadowBlur: EXO_CANVAS_SHADOW.blur,
  });
}

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

function buildOrbitLine(p: ExoPlanet, q: THREE.Quaternion, phase: number): THREE.Line {
  // Trail head sits at the body's current true anomaly so the bright
  // tip and the planet line up; the alpha then fades back along the
  // direction of orbital motion. Phase is the same seeded value used
  // for the body's position, so the two stay synced.
  return buildPrecisionOrbitLine((nu, out) => {
    orbitPositionAt(p, q, nu, out);
  }, phase, hostFromTargetUniform);
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
  neptune: "Ice giant",
  gasGiant: "Gas giant",
  unknown: "Composition unclear",
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
  if (selectedExoplanet && selectedExoplanet !== planet) removeGlow(selectedExoplanet.name);
  selectedExoplanet = planet;
  applyGlow(planet.name);
  // Min 3R fills ~70% of FOV (matches planetHandler); arrive at 6R.
  setMinOrbitOverride(planet.radius * 3);
  animateTo(planet.worldPos, planet.radius * 6);
  kick();
  return true;
}

// World position of the currently-selected exoplanet, if any. Used by
// URL restore to anchor the camera target on the planet after the
// async mount completes, so the saved r/phi/theta apply around the
// planet rather than the host star.
export function getSelectedExoplanetPos(): THREE.Vector3 | null {
  return selectedExoplanet ? selectedExoplanet.worldPos : null;
}

function buildPlanetDetailHtml(p: ExoPlanet, hostName: string): string {
  const cls = CLASS_LABEL[p.class] ?? p.class;
  const a = p.a_au !== null ? `${p.a_au.toFixed(p.a_au < 1 ? 3 : 2)} AU` : "?";
  const r = `${p.radius_re.toFixed(2)} R⊕`;
  const massRow = p.mass_me !== null
    ? `<br>Mass: ${p.mass_me.toFixed(p.mass_me < 1 ? 3 : 2)} M⊕`
    : "";
  const densityRow = p.density_gcm3 !== null
    ? `<br>Density: ${p.density_gcm3.toFixed(2)} g/cm³`
    : "";
  const periodRow = p.period_days !== null
    ? `<br>Period: ${formatPeriod(p.period_days)}`
    : "";
  const eccRow = p.e !== null && p.e > 0
    ? `<br>Eccentricity: ${p.e.toFixed(3)}`
    : "";
  const eqtRow = p.eqt_k !== null
    ? `<br>Equilibrium temp: ${Math.round(p.eqt_k)} K`
    : "";
  const discRow = p.disc_year !== null
    ? `<br>Discovered: ${p.disc_year}${p.disc_method ? ` (${p.disc_method})` : ""}`
    : "";
  const favIcon = isFavorite(p.name) ? "★" : "☆";
  const escapedName = p.name.replace(/"/g, "&quot;");
  return `
    <span class="favorite-toggle" data-name="${escapedName}">${favIcon}</span>
    <div class="star-name">${p.name}</div>
    <div class="star-aliases">Exoplanet · orbits ${hostName}</div>
    <div class="detail-body">
      <div class="star-detail">
        Class: ${cls}<br>
        Radius: ${r}${massRow}${densityRow}<br>
        Semi-major axis: ${a}${periodRow}${eccRow}${eqtRow}${discRow}
      </div>
    </div>`;
}

function formatPeriod(days: number): string {
  if (days < 2) return `${(days * 24).toFixed(1)} hr`;
  if (days < 365) return `${days.toFixed(1)} d`;
  return `${(days / 365.25).toFixed(2)} yr`;
}

const exoplanetHandler: LabelTypeHandler = {
  type: "exoplanet",
  searchKind: "ep",
  searchKeywords: ["exoplanet", "planet"],
  searchLabel: "Exoplanet",
  // Overlay — selecting an exoplanet must not clear the host-star focus,
  // or updateExoplanets would tear the system down the very next frame
  // (when getSelectedMesh() returns null). The constellation handler uses
  // the same pattern.
  overlay: true,
  setVisible(v) {
    for (const p of currentPlanets) {
      updateCanvasLabel(canvasIdFor(p.name),
        v ? { hidden: false, opacityTarget: 1.0 } : { hidden: true });
    }
  },
  update() { /* per-frame work happens in updateExoplanets() */ },
  selectByName(name) { return focusExoplanetByName(name); },
  clearSelection() {
    if (selectedExoplanet) {
      removeGlow(selectedExoplanet.name);
      selectedExoplanet = null;
      setMinOrbitOverride(null);
    }
    if (hoveredExoplanet) {
      removeGlow(hoveredExoplanet.name);
      hoveredExoplanet = null;
    }
  },
  getSelectedName() { return selectedExoplanet?.name ?? null; },
  setHoverByName(name) {
    const next = name ? currentPlanets.find((p) => p.name === name) ?? null : null;
    if (hoveredExoplanet === next) return;
    if (hoveredExoplanet && hoveredExoplanet !== selectedExoplanet) removeGlow(hoveredExoplanet.name);
    hoveredExoplanet = next;
    if (next && next !== selectedExoplanet) applyGlow(next.name);
  },
  handleClick(div) {
    const name = div.getAttribute("data-label-name");
    return name ? focusExoplanetByName(name) : false;
  },
  detailHtml() {
    if (!selectedExoplanet || !currentEntry) return null;
    return buildPlanetDetailHtml(selectedExoplanet.data, currentEntry.host);
  },
};
registerLabelType(exoplanetHandler);

// Inject search entries for every planet of every host star whose AT-HYG
// entry is in the search index. The host's position (and magnitudes /
// distance) doubles as the planet's search position — at search-select
// time we navigate to the host first, then to the planet after mount.
let searchEntriesReady: () => void = () => {};
const searchEntriesReadyPromise = new Promise<void>((r) => { searchEntriesReady = r; });

// Resolves once exoplanet rows have been pushed onto the shared search
// index (or once load failed and there's nothing to push). URL restore
// awaits this so ?focus=<planet> can resolve on a cold load.
export function whenExoplanetSearchEntriesReady(): Promise<void> {
  return searchEntriesReadyPromise;
}

void loadData().then(async (d) => {
  if (!d) { searchEntriesReady(); return; }
  const index = await whenSearchIndexReady();
  // Invert d.aliases (name → gaia) into gaia → names[]; index lookup by
  // any alias the catalog might surface as a star's primary `n`.
  const namesByGaia = new Map<string, string[]>();
  for (const [name, gid] of Object.entries(d.aliases)) {
    const arr = namesByGaia.get(gid) ?? [];
    arr.push(name);
    namesByGaia.set(gid, arr);
  }
  const indexByName = new Map<string, SearchEntry>();
  for (const e of index) if (e.n) indexByName.set(e.n, e);
  let added = 0;
  for (const [gid, sys] of Object.entries(d.by_gaia)) {
    let hostEntry: SearchEntry | undefined;
    for (const n of namesByGaia.get(gid) ?? []) {
      const e = indexByName.get(n);
      if (e) { hostEntry = e; break; }
    }
    if (!hostEntry) continue;
    for (const p of sys.planets) {
      index.push({
        n: p.name,
        p: hostEntry.p,
        mg: hostEntry.mg,
        M: hostEntry.M,
        d: hostEntry.d,
        // sy must be the host's *primary* catalog name (what
        // SearchEntry.n holds), not the Archive's hostname — that's
        // what main.ts's handleSearchSelect looks up to pre-mount the
        // system. e.g. "Chalawan", not "47 UMa".
        sy: hostEntry.n,
        k: "ep",
      });
      added++;
    }
  }
  if (added > 0) console.log(`Exoplanets: +${added} search entries`);
  searchEntriesReady();
});
