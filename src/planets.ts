import * as THREE from "three";
import {
  scene, camera, animateTo, setMinOrbitOverride,
  orbitRadius, distanceFromCamera,
} from "./scene.ts";
import {
  TILE_BASE_URL, KM_PER_PC, SCALE, AU_PER_PC,
  formatAstroDistance,
} from "./constants.ts";
import { setLabelsDirty } from "./systemStore.ts";
import { kick, registerKeepFrame } from "./renderLoop.ts";
import { OCCLUDER_LAYER, setOccluderActive } from "./dust.ts";
import { pushFrameOccluder } from "./labelRegistry.ts";
import { projectToLabelScreen } from "./scene.ts";
import { registerLabelType, registerSearchKindAlias, type LabelTypeHandler } from "./labelRegistry.ts";
import { favoriteIcon } from "./detail.ts";
import { isFavorite } from "./favorites.ts";
import { registerCanvasLabel, updateCanvasLabel } from "./labelCanvas.ts";
import { starLabelMargin } from "./labels.ts";
import { getSearchIndex, whenSearchIndexReady } from "./catalog.ts";
import {
  julianCenturiesSinceJ2000, julianDaysSinceJ2000,
  orbitState, helioEcliptic,
  type PlanetElements, type OrbitState, type Vec3,
} from "./keplerian.ts";

const PLANET_CANVAS_FONT = `12px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const PLANET_CANVAS_COLOR = "rgba(220,200,160,0.85)";
const PLANET_CANVAS_SHADOW = { color: "rgba(120,100,80,0.7)", blur: 6 };
const PLANET_CANVAS_GLOW = { color: "rgba(220,180,100,1.0)", blur: 12 };
const PLANET_SUBTITLE_FONT = `9px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const PLANET_SUBTITLE_COLOR = "rgba(170,170,170,0.9)";

const PLANET_FALLBACK_COLOR = new THREE.Color(0.55, 0.55, 0.55);

// 1×1 grey for bodies whose texture hasn't loaded (or doesn't exist).
// Same shader path as textured planets so async loads can swap the
// uniform without forcing a shader recompile.
function makeFallbackTexture(color: THREE.Color): THREE.DataTexture {
  const data = new Uint8Array([
    Math.round(color.r * 255),
    Math.round(color.g * 255),
    Math.round(color.b * 255),
    255,
  ]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
const FALLBACK_TEXTURE = makeFallbackTexture(PLANET_FALLBACK_COLOR);

// Bodies that ship a surface texture and the file extension to fetch.
// Most are 2k JPEGs from Solar System Scope or Wikimedia photo mosaics;
// Eros uses a PNG (Stooke/Askaniy grayscale map preserved as PNG to
// avoid JPEG ringing on the high-contrast crater terminator). Bodies
// missing here stay on FALLBACK_TEXTURE.
const TEXTURED_BODIES: Record<string, "jpg" | "png"> = {
  Mercury: "jpg", Venus: "jpg", Earth: "jpg", Luna: "jpg", Mars: "jpg",
  Jupiter: "jpg", Saturn: "jpg", Uranus: "jpg", Neptune: "jpg",
  Ceres: "jpg", Pluto: "jpg", Eris: "jpg", Haumea: "jpg", Makemake: "jpg",
  Eros: "png", Phobos: "png", Deimos: "png",
  Io: "jpg", Europa: "jpg", Ganymede: "png", Callisto: "png",
  Mimas: "jpg", Enceladus: "jpg", Tethys: "jpg", Dione: "jpg",
  Rhea: "jpg", Titan: "jpg", Iapetus: "jpg",
  Triton: "jpg", Charon: "jpg",
};

// Bodies with a real spacecraft-derived shape model. Loaded lazily as
// a Drake binary mesh ('DSHP') and used in place of the triaxial
// ellipsoid baked from `axes_km`. See scripts/fetch-planet-meshes.py
// for sources (PDS Gaskell for Eros/Phobos, Thomas for Deimos — all
// public domain).
const MESHED_BODIES = new Set(["Eros", "Phobos", "Deimos"]);
const SHAPE_MAGIC = 0x50485344; // 'DSHP'

const textureLoader = new THREE.TextureLoader();
function tryLoadTexture(url: string): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    textureLoader.load(
      url,
      (tex) => {
        // SSS ships sRGB JPEGs; tag so the renderer linearises before
        // lighting and re-encodes on output. anisotropy=4 keeps grazing
        // angles sharp at min orbit (planet fills ~70% of FOV). REPEAT
        // wrap is needed for shape-mesh seam-fix UVs that go up to ~2.0.
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.wrapS = THREE.RepeatWrapping;
        resolve(tex);
      },
      undefined,
      () => resolve(null),
    );
  });
}

// Serialise texture loads — JPEG decode + GPU upload is main-thread
// work, and firing 12 in parallel stalls the initial frame.
const textureQueue: Array<{ url: string; mesh: THREE.Mesh }> = [];
let textureProcessing = false;
function enqueueTexture(url: string, mesh: THREE.Mesh): void {
  textureQueue.push({ url, mesh });
  pumpTextureQueue();
}
function pumpTextureQueue(): void {
  if (textureProcessing) return;
  const next = textureQueue.shift();
  if (!next) return;
  textureProcessing = true;
  tryLoadTexture(next.url).then((tex) => {
    textureProcessing = false;
    if (tex) {
      (next.mesh.material as THREE.ShaderMaterial).uniforms.uTexture!.value = tex;
      const onLoaded = next.mesh.userData.onTextureLoaded;
      if (typeof onLoaded === "function") onLoaded();
      kick();
    }
    pumpTextureQueue();
  });
}

const SCENE_PER_AU = SCALE / AU_PER_PC;
// Fade band sits well outside the orbits we render (Eris's aphelion
// is ~97 AU) so the rings stay annotated whenever the camera is
// anywhere near the Solar System. Past 1000 AU labels would pile up
// on Sol's pixel during interstellar views.
const SOLAR_SYSTEM_LABEL_DIST = 1000 * SCENE_PER_AU;
const SOLAR_SYSTEM_FADE_START = 900 * SCENE_PER_AU;
// Orbit lines fade more gradually than labels — labels pile up on Sol's
// pixel past ~1000 AU, but rings can stay faintly visible to preserve
// Solar-System scale cues during the transition to interstellar views.
const ORBIT_FADE_END = 3000 * SCENE_PER_AU;
const ECLIPTIC_OBLIQUITY = (23.4393 * Math.PI) / 180;
const ORBIT_BASE_OPACITY = 0.7;

function solarSystemFade(camDistFromSol: number): number {
  return 1 - THREE.MathUtils.smoothstep(camDistFromSol, SOLAR_SYSTEM_FADE_START, SOLAR_SYSTEM_LABEL_DIST);
}

function orbitFade(camDistFromSol: number): number {
  return 1 - THREE.MathUtils.smoothstep(camDistFromSol, SOLAR_SYSTEM_FADE_START, ORBIT_FADE_END);
}

type PlanetKind = "planet" | "dwarf" | "asteroid" | "moon";

// IAU rotational elements: [pole_ra_deg, pole_dec_deg, W0_deg,
// W_dot_deg_per_day]. Pole is in J2000 inertial (ICRS); W is the
// prime meridian angle from Q (ascending node of body equator on
// J2000 equator) at J2000.0, plus a daily rate. Source: IAU WGCCRE
// 2015 (Archinal et al. 2018).
type RotationElements = [number, number, number, number];

interface PlanetEntry {
  kind?: PlanetKind;
  parent?: string;
  aliases?: string[];
  radius_km: number;
  // Triaxial semi-axes [a, c, b] in km — a along mesh +X (longest
  // equatorial), c along mesh +Y (polar, shortest for Haumea-like
  // fast spinners), b along mesh +Z (intermediate equatorial). When
  // present the runtime bakes a triaxial ellipsoid into the geometry
  // instead of a uniform sphere; absent → standard sphere of
  // radius_km. radius_km stays the volumetric mean for orbit-arrival
  // distance and search-distance display.
  axes_km?: [number, number, number];
  elements: PlanetElements;
  rotation?: RotationElements;
  wikipedia?: string;
  notes?: string;
}

const KIND_LABEL: Record<PlanetKind, string> = {
  planet: "Planet",
  dwarf: "Dwarf planet",
  asteroid: "Asteroid",
  moon: "Moon",
};

interface PendingTexture { url: string; mesh: THREE.Mesh }

interface Planet {
  name: string;
  entry: PlanetEntry;
  anchor: THREE.Object3D;
  mesh: THREE.Mesh;
  orbitLine: THREE.Line;
  sceneRadius: number;
  // Time-independent pole orientation; spin = W0 + W_dot·days around
  // mesh-local +Y per frame. Precession is sub-degree on decade
  // horizons so qBase is built once at init.
  qBase: THREE.Quaternion | null;
  W0_rad: number;
  W_dot_rad_per_day: number;
  // Texture and shape-mesh loads deferred until the body is visible
  // (fade > 0 or active). Drained on first visibility frame to spare
  // bandwidth for users who never enter the Solar System.
  pendingTextures: PendingTexture[];
  pendingMeshUrl: string | null;
}

// Heliocentric ecliptic AU → scene XYZ via R_x(obliquity) then the
// (eq_x, eq_z, -eq_y) swap — same chain build-catalog.py mirrors.
const COS_OBL = Math.cos(ECLIPTIC_OBLIQUITY);
const SIN_OBL = Math.sin(ECLIPTIC_OBLIQUITY);
function eclipticToScene(p: Vec3, out: THREE.Vector3): void {
  const eq_y = p.y * COS_OBL - p.z * SIN_OBL;
  const eq_z = p.y * SIN_OBL + p.z * COS_OBL;
  out.set(
    p.x * SCENE_PER_AU,
    eq_z * SCENE_PER_AU,
    -eq_y * SCENE_PER_AU,
  );
}

// Build the time-independent part of the body's orientation quaternion.
// Mesh-local +Y maps to the body's pole (P), mesh-local +X to Q (the
// ascending node of the body equator on the J2000 equator — the
// direction the prime meridian points when W=0). Time-varying spin
// around the pole is layered on top per-frame.
//
// IAU pole α₀, δ₀ are J2000 equatorial; we apply the same equatorial
// → scene swap (sx, sy, sz) = (eq_x, eq_z, -eq_y) used everywhere
// else. Cross products survive the swap (it's a rotation), so the
// right-hand basis stays consistent.
function buildOrientationBase(poleRaDeg: number, poleDecDeg: number): THREE.Quaternion {
  const a = poleRaDeg * Math.PI / 180;
  const d = poleDecDeg * Math.PI / 180;
  const cosA = Math.cos(a), sinA = Math.sin(a);
  const cosD = Math.cos(d), sinD = Math.sin(d);

  const Pscene = new THREE.Vector3(cosA * cosD, sinD, -sinA * cosD);
  const Qscene = new THREE.Vector3(-sinA, 0, -cosA);
  // Mesh-local +Z = +X × +Y; Three.js sphere UV puts longitude -90°
  // there (90° west of prime meridian), so this completes the body
  // basis right-handed.
  const Zscene = new THREE.Vector3().crossVectors(Qscene, Pscene);

  const m = new THREE.Matrix4().makeBasis(Qscene, Pscene, Zscene);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TAU = Math.PI * 2;
const tmpQuat = new THREE.Quaternion();
const tmpScreen = { x: 0, y: 0, behind: false };

// Faint elliptical ring traced from the body's current orbital state.
// Walks ν over [0, 2π) with r(ν) = a(1-e²)/(1 + e cos ν), so the ring
// is the actual ellipse, not a circle approximation. Vertex 0 sits
// exactly on the body — anchors the ring there without chord offset;
// 16k segments keep the inscribed-polygon dip between vertices well
// below a planet radius even for Neptune.
//
// Builds the orbit as a fading comet-trail: vertex 0 is at the
// planet's current true anomaly, and increasing index walks BACKWARD
// in nu so the trail extends behind the planet's direction of motion,
// with a per-vertex RGBA alpha that fades 1 → 0 over one full
// revolution. THREE.Line (not LineLoop) so the alpha-1 head and
// alpha-0 tail aren't bridged by a closing segment.
//
// `orbitFocusScene` is the scene position of the orbit's focus —
// (0,0,0) for heliocentric bodies, the parent's scene position for
// moons. Vertices are stored relative to `planetScenePos` and the
// caller sets `orbitLine.position` to match; Three.js folds the
// offset back in via `modelViewMatrix` on the CPU in Float64, so the
// GPU's view transform sees a small camera-to-body delta — for Eros
// (orbit ~2.1e-5) raw world coords would quantise to Float32 ULP
// ~2.5e-12, the same scale as the body's diameter.
function createOrbitLine(
  state: OrbitState,
  planetScenePos: THREE.Vector3,
  orbitFocusScene: THREE.Vector3,
): THREE.Line {
  const segments = 16384;
  const positions = new Float32Array(segments * 3);
  // RGBA Uint8 (normalized) — Three.js auto-enables USE_COLOR_ALPHA
  // when the color attribute has itemSize 4, multiplying vertex alpha
  // into the fragment alongside material.opacity. Saves the custom
  // shader and ~75% memory vs Float32 alpha + default RGB color.
  const colors = new Uint8Array(segments * 4);
  const step = (Math.PI * 2) / segments;
  const e = state.e;
  const semiLatus = state.a * (1 - e * e);
  // Hoisted out of the per-vertex loop — calling helioEclipticAt
  // would recompute these 16k times.
  const omega = state.long_peri - state.long_node;
  const cn = Math.cos(state.long_node), sn = Math.sin(state.long_node);
  const ci = Math.cos(state.i), si = Math.sin(state.i);
  for (let i = 0; i < segments; i++) {
    const nu = state.nu - i * step;
    const r = semiLatus / (1 + e * Math.cos(nu));
    const angle = nu + omega;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const ex = r * (cn * ca - sn * sa * ci);
    const ey = r * (sn * ca + cn * sa * ci);
    const ez = r * sa * si;
    const eq_y = ey * COS_OBL - ez * SIN_OBL;
    const eq_z = ey * SIN_OBL + ez * COS_OBL;
    positions[i * 3 + 0] = orbitFocusScene.x + ex * SCENE_PER_AU - planetScenePos.x;
    positions[i * 3 + 1] = orbitFocusScene.y + eq_z * SCENE_PER_AU - planetScenePos.y;
    positions[i * 3 + 2] = orbitFocusScene.z + -eq_y * SCENE_PER_AU - planetScenePos.z;
    colors[i * 4 + 0] = 0x4d;
    colors[i * 4 + 1] = 0x7f;
    colors[i * 4 + 2] = 0xc4;
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

// gl_Position must route through `modelViewMatrix` (Float64 on the
// CPU) and not via `modelMatrix * vec4(position, 1.0)` first: tiny
// bodies like Eros (scene radius ~8e-13 at world position ~1.4e-5)
// have radius-scaled vertex offsets below Float32 ULP, and the
// world-space sum collapses every vertex to the same point. Lighting
// takes the sun direction as a uniform — the planet's diameter is
// many orders of magnitude smaller than its heliocentric distance,
// so the sun's bearing is effectively constant across the surface.
const planetVertex = `
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const planetFragment = `
varying vec3 vNormal;
varying vec2 vUv;
uniform sampler2D uTexture;
uniform vec3 uSunDir;
uniform float uIllumination;
void main() {
  float diff = max(dot(normalize(vNormal), uSunDir), 0.0);
  vec3 albedo = texture2D(uTexture, vUv).rgb;
  vec3 color = albedo * (0.05 + 0.95 * diff) * uIllumination;
  gl_FragColor = vec4(color, 1.0);
}
`;

// Soft 1/r^0.3 falloff instead of physical 1/r² — the eye can't
// compress 1200× dynamic range (Earth→Pluto under inverse-square)
// without auto-exposure. Clamped to 1.0 so Mercury at 0.39 AU
// doesn't blow out the bloom pipeline.
function illuminationFor(rAu: number): number {
  return Math.min(1.0, 1.0 / Math.pow(rAu, 0.3));
}

// Bake a triaxial ellipsoid into a unit-sphere geometry by scaling
// vertex positions and recomputing each normal as the gradient of
// x²/a² + y²/c² + z²/b² = 1. Mesh.scale stays uniform = sceneRadius,
// keeping the world matrix orthogonal-uniform so the existing
// `mat3(modelMatrix) * normal` lighting path works unchanged.
function bakeEllipsoid(geometry: THREE.SphereGeometry, axesNorm: THREE.Vector3): void {
  const a = axesNorm.x, c = axesNorm.y, b = axesNorm.z;
  const positions = geometry.attributes.position!;
  const normals = geometry.attributes.normal!;
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    positions.setXYZ(i, x * a, y * c, z * b);
    const nx = x / a, ny = y / c, nz = z / b;
    const nlen = Math.hypot(nx, ny, nz);
    normals.setXYZ(i, nx / nlen, ny / nlen, nz / nlen);
  }
  positions.needsUpdate = true;
  normals.needsUpdate = true;
}

// Load a DSHP shape model and swap it onto the planet's mesh in place
// of the procedural sphere/ellipsoid. The binary stores body-fixed km
// (Z = rotation pole, X = prime meridian, right-handed); we apply a
// rigid R_x(-90°) so mesh-local +Y is the pole, matching the qBase
// basis. The map is `(x, y, z) → (x, z, -y)` — a true rotation, so
// handedness and winding are preserved without index reversal.
//
// UV is filled with a spherical mapping so an equirectangular texture
// would wrap correctly if one is added later — for now uTexture stays
// the 1×1 grey fallback.
async function loadShapeMesh(url: string, mesh: THREE.Mesh, radiusKm: number): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) return;
  const buf = await resp.arrayBuffer();
  if (buf.byteLength < 16) return;
  const header = new Uint32Array(buf, 0, 4);
  if (header[0] !== SHAPE_MAGIC) {
    console.warn(`[planets] bad shape mesh magic for ${url}: ${header[0]?.toString(16)}`);
    return;
  }
  const nv = header[2]!;
  const ni = header[3]!;
  const srcPositions = new Float32Array(buf, 16, nv * 3);
  const srcIndices = new Uint32Array(buf, 16 + nv * 12, ni);

  // Step 1: positions in mesh-local frame, per-vertex spherical UVs.
  const positions: number[] = new Array(nv * 3);
  const uvs: number[] = new Array(nv * 2);
  const inv = 1 / radiusKm;
  for (let i = 0; i < nv; i++) {
    const xBody = srcPositions[i * 3 + 0]! * inv;
    const yBody = srcPositions[i * 3 + 1]! * inv;
    const zBody = srcPositions[i * 3 + 2]! * inv;
    const x = xBody;
    const y = zBody;
    const z = -yBody;
    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    const r = Math.hypot(x, y, z);
    uvs[i * 2 + 0] = 0.5 + Math.atan2(z, x) / (2 * Math.PI);
    uvs[i * 2 + 1] = 0.5 + Math.asin(y / Math.max(r, 1e-30)) / Math.PI;
  }

  // Step 2: per-triangle UV repair. Linearly-interpolated equirectangular
  // UVs smear across the longitude seam (lon=180°, u jumps ~1↔0) and
  // at poles (u is undefined; atan2(0,0) collapses to 0.5). Duplicate
  // vertices on demand, only for triangles that would smear.
  const POLE_THRESH = 0.999;
  const isPole = new Uint8Array(nv);
  for (let i = 0; i < nv; i++) {
    const x = positions[i * 3 + 0]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (Math.abs(y) / Math.hypot(x, y, z) > POLE_THRESH) isPole[i] = 1;
  }

  const newIndices = new Uint32Array(ni);
  const dupVertex = (origIdx: number, newU: number): number => {
    const idx = positions.length / 3;
    positions.push(
      positions[origIdx * 3 + 0]!,
      positions[origIdx * 3 + 1]!,
      positions[origIdx * 3 + 2]!,
    );
    uvs.push(newU, uvs[origIdx * 2 + 1]!);
    return idx;
  };

  for (let t = 0; t < ni; t += 3) {
    let ia = srcIndices[t + 0]!;
    let ib = srcIndices[t + 1]!;
    let ic = srcIndices[t + 2]!;

    // Seam fix on non-pole vertices first (poles are at u=0.5 and don't
    // signal the seam). Shifting low-u vertices up by 1 keeps the
    // triangle's u range continuous; texture wrap REPEAT handles u > 1.
    let minU = Infinity, maxU = -Infinity;
    if (!isPole[ia]) { const u = uvs[ia * 2]!; if (u < minU) minU = u; if (u > maxU) maxU = u; }
    if (!isPole[ib]) { const u = uvs[ib * 2]!; if (u < minU) minU = u; if (u > maxU) maxU = u; }
    if (!isPole[ic]) { const u = uvs[ic * 2]!; if (u < minU) minU = u; if (u > maxU) maxU = u; }
    if (maxU - minU > 0.5) {
      if (!isPole[ia] && uvs[ia * 2]! < 0.5) ia = dupVertex(ia, uvs[ia * 2]! + 1);
      if (!isPole[ib] && uvs[ib * 2]! < 0.5) ib = dupVertex(ib, uvs[ib * 2]! + 1);
      if (!isPole[ic] && uvs[ic * 2]! < 0.5) ic = dupVertex(ic, uvs[ic * 2]! + 1);
    }

    // Pole fix: each pole vertex gets its own duplicate with u set to the
    // midpoint of the other two vertices' (already seam-corrected) u.
    if (isPole[ia]) ia = dupVertex(ia, (uvs[ib * 2]! + uvs[ic * 2]!) * 0.5);
    if (isPole[ib]) ib = dupVertex(ib, (uvs[ia * 2]! + uvs[ic * 2]!) * 0.5);
    if (isPole[ic]) ic = dupVertex(ic, (uvs[ia * 2]! + uvs[ib * 2]!) * 0.5);

    newIndices[t + 0] = ia;
    newIndices[t + 1] = ib;
    newIndices[t + 2] = ic;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(new THREE.BufferAttribute(newIndices, 1));
  geometry.computeVertexNormals();

  const old = mesh.geometry;
  mesh.geometry = geometry;
  old.dispose();
  kick();
}

function createPlanetMesh(
  sceneRadius: number,
  sunDir: THREE.Vector3,
  illumination: number,
  axesNorm: THREE.Vector3 | null,
): THREE.Mesh {
  // 64x32 segments cuts vertex count 4x vs 128x64. Round bodies still
  // look round; the silhouette has ~5.6° polygon edges that may be
  // visible only at extreme close zoom on the largest body in view.
  const geometry = new THREE.SphereGeometry(1, 64, 32);
  if (axesNorm) bakeEllipsoid(geometry, axesNorm);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: FALLBACK_TEXTURE },
      uSunDir: { value: sunDir },
      uIllumination: { value: illumination },
    },
    vertexShader: planetVertex,
    fragmentShader: planetFragment,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.setScalar(sceneRadius);
  return mesh;
}

const planets: Planet[] = [];
const planetByName = new Map<string, Planet>();
let selectedPlanet: Planet | null = null;
let hoveredPlanet: Planet | null = null;
let orbitsVisible = true;

export function setOrbitsVisible(v: boolean): void {
  orbitsVisible = v;
  kick();
}
export function getOrbitsVisible(): boolean { return orbitsVisible; }
export function toggleOrbits(): void { setOrbitsVisible(!orbitsVisible); }

// Search-index kinds that route to the planet handler. Keep in sync
// with the registerSearchKindAlias calls at end of initPlanetLabels.
const PLANET_SEARCH_KINDS = new Set(["p", "d", "a", "m"]);

// Per-frame disc picks. Drained by pickPlanetAt() from main.ts so a
// click on a body's rendered disc selects it like its label would.
interface PlanetPick { planet: Planet; x: number; y: number; rSq: number }
const planetPicks: PlanetPick[] = [];

export function pickPlanetAt(x: number, y: number): string | null {
  let bestName: string | null = null;
  let bestD = Infinity;
  for (const p of planetPicks) {
    const dx = x - p.x, dy = y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= p.rSq && d2 < bestD) {
      bestD = d2;
      bestName = p.planet.name;
    }
  }
  return bestName;
}

function canvasIdFor(name: string): string { return `planet:${name}`; }

function applyGlow(p: Planet) {
  updateCanvasLabel(canvasIdFor(p.name), {
    shadowColor: PLANET_CANVAS_GLOW.color,
    shadowBlur: PLANET_CANVAS_GLOW.blur,
  });
  setLabelsDirty(true);
}

function removeGlow(p: Planet) {
  updateCanvasLabel(canvasIdFor(p.name), {
    shadowColor: PLANET_CANVAS_SHADOW.color,
    shadowBlur: PLANET_CANVAS_SHADOW.blur,
  });
  setLabelsDirty(true);
}

function buildDetailHtml(p: Planet): string {
  const e = p.entry;
  const dist = p === selectedPlanet ? orbitRadius : distanceFromCamera(p.anchor.position);
  const aliasLine = e.aliases && e.aliases.length > 0
    ? `<div class="star-aliases">${e.aliases.join(" · ")}</div>` : "";
  const wikiLink = e.wikipedia
    ? `<div class="star-wiki"><a href="${e.wikipedia}" target="_blank">Wikipedia</a></div>` : "";
  const notes = e.notes ? `<div class="star-notes">${e.notes}</div>` : "";

  return `
    ${favoriteIcon(p.name)}
    <div class="star-name">${p.name}</div>
    ${aliasLine}
    <div class="detail-body">
      <div class="star-detail">
        Distance: ${formatAstroDistance(dist)}<br>
        Semi-major axis: ${e.elements.a_au[0].toFixed(3)} AU<br>
        Radius: ${e.radius_km.toLocaleString()} km<br>
        Type: ${KIND_LABEL[e.kind ?? "planet"]}
      </div>
      ${notes}
      ${wikiLink}
    </div>`;
}

const planetHandler: LabelTypeHandler = {
  type: "planet",
  searchKind: "p",
  searchKeywords: ["planet"],
  searchLabel: "Planet",

  setVisible(v) {
    // Mesh stays on when text labels are toggled — only the canvas
    // label hides.
    for (const p of planets) {
      updateCanvasLabel(canvasIdFor(p.name),
        v ? { hidden: false, opacityTarget: 1.0 } : { hidden: true });
    }
  },

  update() {
    const camDist = camera.position.length();
    const fade = solarSystemFade(camDist);
    const orbitOpacity = orbitFade(camDist);
    setOccluderActive(fade > 0 || selectedPlanet !== null || hoveredPlanet !== null);
    const halfTan = Math.tan((camera.fov * Math.PI) / 360);
    const halfHeight = window.innerHeight / 2;
    const days = julianDaysSinceJ2000();
    planetPicks.length = 0;
    for (const p of planets) {
      const orbitMat = p.orbitLine.material as THREE.LineBasicMaterial;
      orbitMat.opacity = ORBIT_BASE_OPACITY * orbitOpacity;
      p.orbitLine.visible = orbitsVisible && orbitOpacity > 0;

      const isActive = p === selectedPlanet || p === hoveredPlanet;
      if (fade <= 0 && !isActive) {
        updateCanvasLabel(canvasIdFor(p.name), { hidden: true });
        continue;
      }
      // First-visibility texture and shape-mesh loads — defers
      // ~10 MB of bandwidth for users who never enter the Solar System.
      if (p.pendingTextures.length > 0) {
        for (const t of p.pendingTextures) enqueueTexture(t.url, t.mesh);
        p.pendingTextures.length = 0;
      }
      if (p.pendingMeshUrl) {
        loadShapeMesh(p.pendingMeshUrl, p.mesh, p.entry.radius_km);
        p.pendingMeshUrl = null;
      }
      if (p.qBase) {
        // Wrap W into [0, 2π) — Earth's raw W_rad would otherwise
        // grow to ~1.6e6 by 2050, hurting quaternion conditioning.
        const w = (p.W0_rad + p.W_dot_rad_per_day * days) % TAU;
        tmpQuat.setFromAxisAngle(Y_AXIS, w);
        p.mesh.quaternion.copy(p.qBase).multiply(tmpQuat);
      }
      const trueDist = p === selectedPlanet ? orbitRadius : distanceFromCamera(p.anchor.position);
      const discPx = (p.sceneRadius / Math.max(trueDist, 1e-30)) * halfHeight / halfTan;
      // Disc serves as both label occluder and click target. 6 px
      // floor on the hit radius keeps small bodies (Eros, distant
      // dwarfs) clickable on high-DPI screens.
      if (discPx > 2) {
        projectToLabelScreen(p.anchor.position, tmpScreen);
        if (!tmpScreen.behind) {
          pushFrameOccluder({ cx: tmpScreen.x, cy: tmpScreen.y, radius: discPx });
          const hitR = Math.max(discPx, 6);
          planetPicks.push({
            planet: p, x: tmpScreen.x, y: tmpScreen.y, rSq: hitR * hitR,
          });
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
  },

  selectByName(name) {
    const p = planetByName.get(name);
    if (!p) return false;
    if (selectedPlanet && selectedPlanet !== p) removeGlow(selectedPlanet);
    selectedPlanet = p;
    applyGlow(p);
    // No DISC_SCALE corona inflation here (planets have no halo).
    // Min 3R fills ~70% of FOV (arcsin(1/3) ≈ 19.5°), the closest
    // zoom that doesn't wrap the body around the camera; arrive 6R.
    const minOrbit = p.sceneRadius * 3.0;
    const arrivalOrbit = p.sceneRadius * 6.0;
    setMinOrbitOverride(minOrbit);
    animateTo(p.anchor.position, arrivalOrbit);
    setLabelsDirty(true);
    return true;
  },

  clearSelection() {
    if (selectedPlanet) {
      removeGlow(selectedPlanet);
      selectedPlanet = null;
      setMinOrbitOverride(null);
    }
    if (hoveredPlanet) { removeGlow(hoveredPlanet); hoveredPlanet = null; }
  },

  getSelectedName() {
    return selectedPlanet?.name ?? null;
  },

  setHoverByName(name) {
    const next = name ? planetByName.get(name) ?? null : null;
    if (hoveredPlanet === next) return;
    if (hoveredPlanet && selectedPlanet !== hoveredPlanet) removeGlow(hoveredPlanet);
    hoveredPlanet = next;
    if (next && selectedPlanet !== next) applyGlow(next);
  },

  handleClick(div) {
    const name = div.getAttribute("data-label-name");
    return name ? this.selectByName(name) : false;
  },

  detailHtml() {
    return selectedPlanet ? buildDetailHtml(selectedPlanet) : null;
  },
};

// Saturn rings — flat alpha-textured annulus tilted to Saturn's
// equatorial plane. Three.js RingGeometry creates an XY-plane ring
// with face normal +Z; we rotate to the XZ plane so mesh-local +Y is
// the face normal. That matches the planet body's qBase convention
// (mesh +Y → pole), so the rings tilt with Saturn for free.
//
// Source texture is SSS's 2k_saturn_ring_alpha.png — 2048×125 with
// alpha encoding gap structure (Cassini Division etc.). Inner texture
// edge maps to the D-ring inner (~66,900 km, 1.110 R_Saturn) and
// outer to the A-ring outer (~136,800 km, 2.270 R_Saturn) per SSS
// convention.
const SATURN_RING_INNER_KM = 66900;
const SATURN_RING_OUTER_KM = 136800;
const ringVertex = `
varying float vRadial;
varying vec3 vNormal;
uniform float uInnerRadius;
uniform float uOuterRadius;
void main() {
  float r = length(position);
  vRadial = (r - uInnerRadius) / (uOuterRadius - uInnerRadius);
  // Mesh-local face normal is +Y after the geometry rotation below;
  // mat3(modelMatrix) rotates it into world via qBase.
  vNormal = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const ringFragment = `
varying float vRadial;
varying vec3 vNormal;
uniform sampler2D uTexture;
uniform vec3 uSunDir;
uniform float uIllumination;
void main() {
  vec4 t = texture2D(uTexture, vec2(vRadial, 0.5));
  if (t.a < 0.01) discard;
  vec3 N = normalize(vNormal);
  // Two-sided: flip the normal to match the visible face so each side
  // is lit when its face is toward the sun.
  if (!gl_FrontFacing) N = -N;
  float diff = max(dot(N, uSunDir), 0.0);
  vec3 color = t.rgb * (0.10 + 0.90 * diff) * uIllumination;
  gl_FragColor = vec4(color, t.a);
}
`;

function attachSaturnRings(saturn: Planet, illumination: number): void {
  const innerScene = (SATURN_RING_INNER_KM / KM_PER_PC) * SCALE;
  const outerScene = (SATURN_RING_OUTER_KM / KM_PER_PC) * SCALE;

  // Default RingGeometry is in XY (normal +Z). Tilt to XZ so mesh +Y
  // is the face normal — consistent with how qBase is built.
  const geometry = new THREE.RingGeometry(innerScene, outerScene, 128, 1);
  geometry.rotateX(-Math.PI / 2);

  const sunDir = saturn.anchor.position.clone().normalize().negate();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: FALLBACK_TEXTURE },
      uSunDir: { value: sunDir },
      uInnerRadius: { value: innerScene },
      uOuterRadius: { value: outerScene },
      uIllumination: { value: illumination },
    },
    vertexShader: ringVertex,
    fragmentShader: ringFragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const ring = new THREE.Mesh(geometry, material);
  ring.position.copy(saturn.anchor.position);
  if (saturn.qBase) ring.quaternion.copy(saturn.qBase);
  // Hidden until the alpha texture loads — the 1×1 grey fallback
  // would render as an opaque grey disc, which is worse than nothing.
  ring.visible = false;
  ring.frustumCulled = false;
  scene.add(ring);

  ring.userData.onTextureLoaded = () => { ring.visible = true; };
  saturn.pendingTextures.push({
    url: `${TILE_BASE_URL}planets/saturn_ring.png`,
    mesh: ring,
  });
}

export async function initPlanetLabels(): Promise<void> {
  const [resp] = await Promise.all([
    fetch(`${TILE_BASE_URL}planets.json`),
    // Planet entries in the search index get their position fixed up
    // below to match the live anchor (the build-time bake is approximate).
    whenSearchIndexReady(),
  ]);
  if (!resp.ok) return;
  const raw: Record<string, PlanetEntry & { _about?: unknown }> = await resp.json();

  const T = julianCenturiesSinceJ2000();
  // Heliocentric ecliptic positions, keyed by name — parentless bodies
  // populate this in pass 1 so moons in pass 2 can offset from their
  // parent's heliocentric position.
  const helioEcls: Record<string, Vec3> = {};

  function addBody(
    name: string,
    entry: PlanetEntry,
    state: OrbitState,
    helioEcl: Vec3,
    orbitFocusScene: THREE.Vector3,
  ) {
    const scenePos = new THREE.Vector3();
    eclipticToScene(helioEcl, scenePos);

    const anchor = new THREE.Object3D();
    anchor.position.copy(scenePos);
    scene.add(anchor);

    const sceneRadius = (entry.radius_km / KM_PER_PC) * SCALE;
    const rAu = Math.hypot(helioEcl.x, helioEcl.y, helioEcl.z);
    const illumination = illuminationFor(rAu);
    const sunDir = anchor.position.clone().normalize().negate();
    const axesNorm = entry.axes_km
      ? new THREE.Vector3(...entry.axes_km).divideScalar(entry.radius_km)
      : null;
    const mesh = createPlanetMesh(sceneRadius, sunDir, illumination, axesNorm);
    mesh.position.copy(anchor.position);
    // Add to OCCLUDER_LAYER so the dust pre-pass rasterises this body's
    // silhouette into halfResRT's depth, blocking dust through it.
    mesh.layers.enable(OCCLUDER_LAYER);
    scene.add(mesh);

    // For heliocentric bodies the orbit focus is Sol (origin); for
    // moons the focus is the parent's scene position. createOrbitLine
    // stores vertices relative to the body's anchor and Three.js folds
    // the offset back via modelViewMatrix in Float64.
    const orbitLine = createOrbitLine(state, anchor.position, orbitFocusScene);
    orbitLine.position.copy(anchor.position);
    scene.add(orbitLine);

    let qBase: THREE.Quaternion | null = null;
    let W0_rad = 0;
    let W_dot_rad_per_day = 0;
    if (entry.rotation) {
      const [poleRa, poleDec, W0, Wdot] = entry.rotation;
      qBase = buildOrientationBase(poleRa, poleDec);
      W0_rad = W0 * Math.PI / 180;
      W_dot_rad_per_day = Wdot * Math.PI / 180;
    }

    const pendingTextures: PendingTexture[] = [];
    const ext = TEXTURED_BODIES[name];
    if (ext) {
      pendingTextures.push({
        url: `${TILE_BASE_URL}planets/${name.toLowerCase()}.${ext}`,
        mesh,
      });
    }
    const pendingMeshUrl = MESHED_BODIES.has(name)
      ? `${TILE_BASE_URL}planets/${name.toLowerCase()}.bin`
      : null;

    const planet: Planet = {
      name, entry, anchor, mesh, orbitLine, sceneRadius,
      qBase, W0_rad, W_dot_rad_per_day, pendingTextures, pendingMeshUrl,
    };
    planets.push(planet);
    planetByName.set(name, planet);

    // Push the live position back into the search index — build-catalog
    // bakes a build-time approximation, but URL focus restore via
    // setTargetImmediate reads entry.p, so it has to agree with where
    // selectByName actually flies to.
    const searchEntry = getSearchIndex().find(
      (s) => s.k !== undefined && PLANET_SEARCH_KINDS.has(s.k) && s.n === name,
    );
    if (searchEntry) {
      searchEntry.p[0] = anchor.position.x;
      searchEntry.p[1] = anchor.position.y;
      searchEntry.p[2] = anchor.position.z;
    }

    registerCanvasLabel({
      id: canvasIdFor(name),
      kind: "planet",
      anchor: anchor.position,
      text: name,
      font: PLANET_CANVAS_FONT,
      color: PLANET_CANVAS_COLOR,
      shadowColor: PLANET_CANVAS_SHADOW.color,
      shadowBlur: PLANET_CANVAS_SHADOW.blur,
      subtitleFont: PLANET_SUBTITLE_FONT,
      subtitleColor: PLANET_SUBTITLE_COLOR,
      // Above BH (1800) and NS (1700) — when planets are on screen the
      // camera is inside the Solar System, where they're the relevant
      // annotation; the only stellar objects potentially co-projected
      // are Sol itself or distant BH/NS, and we want planets to win.
      rank: 2000 + (isFavorite(name) ? 5000 : 0),
      marginTop: 10,
      opacityTarget: 0,
      payload: { name },
    });
    return planet;
  }

  const ORIGIN = new THREE.Vector3(0, 0, 0);

  // Pass 1: parentless bodies (heliocentric).
  for (const [name, entry] of Object.entries(raw)) {
    if (name.startsWith("_")) continue;
    if (entry.parent) continue;
    const state = orbitState(entry.elements, T);
    const helioEcl = helioEcliptic(state);
    helioEcls[name] = helioEcl;
    const planet = addBody(name, entry, state, helioEcl, ORIGIN);
    if (name === "Saturn") {
      const rAu = Math.hypot(helioEcl.x, helioEcl.y, helioEcl.z);
      attachSaturnRings(planet, illuminationFor(rAu));
    }
  }

  // Pass 2: parented bodies (moons). Moon's `elements` are geocentric;
  // sum with the parent's heliocentric position to get the moon's
  // scene position. The orbit ring focus is the parent so the ring
  // traces around the parent, not Sol.
  for (const [name, entry] of Object.entries(raw)) {
    if (name.startsWith("_")) continue;
    if (!entry.parent) continue;
    const parentEcl = helioEcls[entry.parent];
    if (!parentEcl) {
      console.warn(`[planets] ${name}: parent "${entry.parent}" not found`);
      continue;
    }
    const state = orbitState(entry.elements, T);
    const rel = helioEcliptic(state);
    const helioEcl: Vec3 = {
      x: parentEcl.x + rel.x,
      y: parentEcl.y + rel.y,
      z: parentEcl.z + rel.z,
    };
    const parentScene = new THREE.Vector3();
    eclipticToScene(parentEcl, parentScene);
    addBody(name, entry, state, helioEcl, parentScene);
  }

  registerLabelType(planetHandler);
  // Sub-kinds dispatch to the same handler but get their own search
  // sublabel. Keep PLANET_SEARCH_KINDS in sync.
  registerSearchKindAlias("d", "planet", ["dwarf planet", "dwarf"], "Dwarf Planet");
  registerSearchKindAlias("a", "planet", ["asteroid"], "Asteroid");
  registerSearchKindAlias("m", "planet", ["moon"], "Moon");

  // Keep the wake-on-demand loop alive while a planet is selected so
  // rotation animates visibly; phase is still correct on any wake.
  registerKeepFrame(() => selectedPlanet !== null);
}
