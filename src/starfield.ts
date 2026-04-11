import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Star, SystemGroup, BinarySystem, ClusterGroup } from "./types.ts";
import { LABEL_CSS, CLUSTER_LABEL_CSS, CLUSTER_DEFAULT_SHADOW, SCALE } from "./constants.ts";
import { scene, camera } from "./scene.ts";
import { createBillboardMesh, createNotableAnchor, createStarLabel, rebindHitSphere } from "./billboard.ts";
import { setCompanionResolver, showSystemMembers } from "./interaction.ts";
import { setLabelsDirty, relinkAfterRebuild } from "./systemStore.ts";
import { registerMembers } from "./systemDispatch.ts";
import { GLOW_GLSL, createStarGlowTexture } from "./starShader.ts";
import {
  initCatalog, getMeta, getNotable, getSystems, getTileLabels,
  loadTileLabels, evictTileLabels,
  onTileLabelsLoaded, onTileLabelsEvicted,
  type LabelRow, type TileMeta,
} from "./catalog.ts";

const BYTES_PER_STAR = 16;
const MAX_LOADED_TILES = 80;
const TILE_BASE_URL = "/tiles/";
let tier1LoadDist = 150;

// The brightness byte encodes absolute magnitude linearly as
// `byte = (absmag + 10) * 10` (see build-catalog.py `brightness_byte`).
// Apparent magnitude is recovered per-vertex via the distance modulus;
// 30 scene units = 10 pc at SCALE=3. 1.50515 = 5 / log2(10).
const pointVertexShader = `
  uniform float uMagLimit;
  attribute float brightness;
  attribute vec3 starColor;
  varying vec3 vColor;
  varying float vBrightness;

  void main() {
    vColor = starColor;
    float absMag = brightness * 0.1 - 10.0;

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = max(-mvPosition.z, 1.0);
    float appMag = absMag + 1.50515 * log2(dist * (1.0 / 30.0));

    if (appMag > uMagLimit) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    float visibility = 1.0 - smoothstep(uMagLimit - 1.5, uMagLimit, appMag);
    vBrightness = visibility * max(0.1, (uMagLimit - appMag) * 0.25);
    gl_PointSize = clamp((uMagLimit + 9.5) - appMag, 10.0, 32.0);

    gl_Position = projectionMatrix * mvPosition;
  }
`;

// Three star rendering modes. Texture is the default — its mipmap filter
// pre-smooths the steep core gradient, killing sub-pixel flicker that bloom
// would otherwise amplify. Math and flat are kept for debug comparison.
export type StarMode = "texture" | "math" | "flat";

const FRAG_MAIN = `
  varying vec3 vColor;
  varying float vBrightness;
`;

const starGlowTexture = createStarGlowTexture(256);

const fragments: Record<StarMode, string> = {
  math: `
    ${FRAG_MAIN}
    ${GLOW_GLSL}
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = length(uv) * 2.0;
      vec2 g = glowAt(d);
      float intensity = g.x * vBrightness * 2.5;
      vec3 color = mix(vColor, vec3(1.0), smoothstep(0.3, 1.0, g.y * vBrightness));
      gl_FragColor = vec4(color * intensity, intensity);
    }
  `,
  texture: `
    uniform sampler2D uGlowTex;
    ${FRAG_MAIN}
    void main() {
      vec4 tex = texture2D(uGlowTex, gl_PointCoord);
      float intensity = tex.r * vBrightness * 2.5;
      vec3 color = mix(vColor, vec3(1.0), smoothstep(0.3, 1.0, tex.g * vBrightness));
      gl_FragColor = vec4(color * intensity, intensity);
    }
  `,
  flat: `
    ${FRAG_MAIN}
    void main() {
      vec2 uv = gl_PointCoord - 0.5;
      float d = length(uv) * 2.0;
      if (d > 1.0) discard;
      gl_FragColor = vec4(vColor * vBrightness, 1.0);
    }
  `,
};

export const DEFAULT_MAG_LIMIT = 7.5;

// Single source of truth shared between every point material and the
// tier-0 label fade. Mutate .value directly (or via setMagLimit).
export const magLimitUniform: THREE.IUniform<number> = { value: DEFAULT_MAG_LIMIT };

export function setMagLimit(value: number) {
  magLimitUniform.value = value;
}

// Apparent magnitude from absolute magnitude and a scene-space distance.
// Shared with the point vertex shader (which inlines the same distance
// modulus) so the TS and GLSL sides can't drift.
const LOG10 = Math.log(10);
export function apparentMag(absMag: number, sceneDist: number): number {
  const distPc = Math.max(sceneDist, 1) / SCALE;
  return absMag + 5 * Math.log(distPc / 10) / LOG10;
}

function makePointMaterial(mode: StarMode): THREE.ShaderMaterial {
  const flat = mode === "flat";
  const uniforms: Record<string, THREE.IUniform> = { uMagLimit: magLimitUniform };
  if (mode === "texture") uniforms.uGlowTex = { value: starGlowTexture };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: pointVertexShader,
    fragmentShader: fragments[mode],
    transparent: !flat,
    blending: flat ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
}

const pointMaterials: Record<StarMode, THREE.ShaderMaterial> = {
  texture: makePointMaterial("texture"),
  math: makePointMaterial("math"),
  flat: makePointMaterial("flat"),
};

let currentMode: StarMode = "texture";
let currentPointMaterial: THREE.ShaderMaterial = pointMaterials.texture;

export function setStarMode(mode: StarMode) {
  if (mode === currentMode) return;
  currentMode = mode;
  currentPointMaterial = pointMaterials[mode];
  for (const loaded of loadedTiles.values()) {
    loaded.points.material = currentPointMaterial;
  }
}

export function setPointDepthTest(enabled: boolean) {
  for (const mat of Object.values(pointMaterials)) {
    mat.depthTest = enabled;
    mat.needsUpdate = true;
  }
}

interface LoadedTile {
  geometry: THREE.BufferGeometry;
  points: THREE.Points;
  positions: Float32Array;
  starCount: number;
  lastUsed: number;
  labelsLoaded: boolean;
}

let pointsGroup: THREE.Group;
let billboardsGroup: THREE.Group;
let notableAnchorsGroup: THREE.Group;

const loadedTiles = new Map<string, LoadedTile>();
const loadingTiles = new Set<string>();
const tileSpheres = new Map<string, THREE.Sphere>();
let tileEntries: [string, TileMeta][] = [];

// Tier 0 = persistent Object3D "anchors" (no mesh, no shader, no canvas
// raycast). Tier 1 = streamed billboard meshes spawned on tile labels load.
export const notableObjects: THREE.Object3D[] = [];
export const notableLabelMap = new WeakMap<THREE.Object3D, HTMLElement>();
export const notableLabelMeshMap = new WeakMap<HTMLElement, THREE.Object3D>();

// Tier-0 billboards forward canvas-raycast hits to their anchor.
const billboardByAnchor = new WeakMap<THREE.Object3D, THREE.Mesh>();
const anchorByBillboard = new WeakMap<THREE.Mesh, THREE.Object3D>();

export const streamedLabelMap = new WeakMap<THREE.Mesh, HTMLElement>();
const tier1DivToMesh = new WeakMap<HTMLElement, THREE.Mesh>();

// Canvas raycast list: tier-0 billboards (when present) + tier-1 billboards.
// Anchors are NOT in this list — distant tier-0 hover goes through the label DOM.
export const allInteractiveStars: THREE.Object3D[] = [];

// Tier-1 billboards only, for label rendering (avoids anchor/billboard duplication).
export const tier1Meshes: THREE.Object3D[] = [];

// (tile, index) → anchor | tier-1 billboard, for system resolution.
const meshByRef = new Map<string, THREE.Object3D>();
function refKey(tile: string, i: number): string { return `${tile}/${i}`; }

const spawnedByTile = new Map<string, THREE.Mesh[]>();

// Coalesces rebuildSystems + notifyLabelsChanged so a burst of tile loads/evicts
// in a single updateStarfield tick results in one rebuild, not N.
let labelSetDirty = false;

// SystemGroup tracking. Rebuilt when label set changes.
export const systemGroups: SystemGroup[] = [];
export const meshToSystem = new Map<THREE.Object3D, SystemGroup>();
export const clusterOf = new Map<THREE.Object3D, SystemGroup>();

let initLabelDragFn: ((div: HTMLElement) => void) | null = null;
let labelChangeListeners: Array<() => void> = [];
export function onLabelsChanged(fn: () => void) { labelChangeListeners.push(fn); }
function notifyLabelsChanged() { for (const fn of labelChangeListeners) fn(); }

export function setInitLabelDrag(fn: (div: HTMLElement) => void) {
  initLabelDragFn = fn;
}

export function canonicalTarget(obj: THREE.Object3D): THREE.Object3D {
  return anchorByBillboard.get(obj as THREE.Mesh) ?? obj;
}

// Tier-0 anchors AND their billboards are spawned eagerly at boot from the
// pre-loaded notable.json. The billboard stays alive regardless of whether
// the star's octree tile is currently streamed in — otherwise you couldn't
// hover a notable star whose tile is outside the camera frustum (the tier-0
// label would still show from the anchor, but canvas raycast would find no
// mesh to hit).
function spawnNotableAnchors() {
  const notable = getNotable();
  for (const n of notable) {
    const [sx, sy, sz] = n.pos;
    const anchor = createNotableAnchor(n, sx, sy, sz);
    const { div } = createStarLabel(n, anchor, initLabelDragFn ?? (() => {}));
    notableAnchorsGroup.add(anchor);
    notableObjects.push(anchor);
    notableLabelMap.set(anchor, div);
    notableLabelMeshMap.set(div, anchor);
    const ref = refKey(n.tile, n.i);
    meshByRef.set(ref, anchor);

    const billboard = createBillboardMesh(n, sx, sy, sz);
    rebindHitSphere(billboard, anchor);
    billboardsGroup.add(billboard);
    billboardByAnchor.set(anchor, billboard);
    anchorByBillboard.set(billboard, anchor);
    allInteractiveStars.push(billboard);
  }
}

function spawnTier1Billboard(row: LabelRow, path: string, sx: number, sy: number, sz: number): THREE.Mesh {
  const star: Star = { ...row, tile: path };
  const mesh = createBillboardMesh(star, sx, sy, sz);
  const { div } = createStarLabel(star, mesh, initLabelDragFn ?? (() => {}));
  // Start hidden to avoid a one-frame flash before labels.ts runs.
  mesh.visible = false;
  billboardsGroup.add(mesh);
  streamedLabelMap.set(mesh, div);
  tier1DivToMesh.set(div, mesh);
  return mesh;
}

function spawnTileLabels(path: string, labels: LabelRow[]) {
  const tile = loadedTiles.get(path);
  if (!tile) return;
  if (tile.labelsLoaded) return;
  tile.labelsLoaded = true;
  const meshes: THREE.Mesh[] = [];
  for (const row of labels) {
    // Tier-0 is already handled by spawnNotableAnchors — skip.
    if (row.tier === 0) continue;
    const i = row.i;
    const sx = tile.positions[i * 3];
    const sy = tile.positions[i * 3 + 1];
    const sz = tile.positions[i * 3 + 2];
    const mesh = spawnTier1Billboard(row, path, sx, sy, sz);
    meshByRef.set(refKey(path, i), mesh);
    allInteractiveStars.push(mesh);
    tier1Meshes.push(mesh);
    meshes.push(mesh);
  }
  spawnedByTile.set(path, meshes);
  if (meshes.length > 0) {
    labelSetDirty = true;
    setLabelsDirty(true);
  }

  if (pendingSelection && pendingSelection.tile === path) {
    const mesh = meshByRef.get(refKey(path, pendingSelection.i));
    if (mesh) {
      const resolve = pendingSelection.onResolved;
      pendingSelection = null;
      forcedTiles.delete(path);
      resolve(mesh);
    }
  }
}

function despawnTileLabels(path: string) {
  const meshes = spawnedByTile.get(path);
  if (!meshes) return;
  for (const mesh of meshes) {
    billboardsGroup.remove(mesh);
    const idx = allInteractiveStars.indexOf(mesh);
    if (idx >= 0) allInteractiveStars.splice(idx, 1);

    const div = streamedLabelMap.get(mesh);
    if (div) {
      div.remove();
      streamedLabelMap.delete(mesh);
      tier1DivToMesh.delete(div);
    }
    const star = mesh.userData as Star & { tile?: string };
    if (star.tile !== undefined) meshByRef.delete(refKey(star.tile, star.i));
    const t1idx = tier1Meshes.indexOf(mesh);
    if (t1idx >= 0) tier1Meshes.splice(t1idx, 1);

    (mesh.material as THREE.Material).dispose();
    mesh.geometry.dispose();
  }
  spawnedByTile.delete(path);
  labelSetDirty = true;
}

function rebuildSystems() {
  // Dispose old system label anchors AND their DOM elements before clearing.
  for (const group of systemGroups) {
    group.anchor.removeFromParent();
    (group.label.element as HTMLElement).remove();
  }
  systemGroups.length = 0;
  meshToSystem.clear();
  clusterOf.clear();
  const catalog = getSystems();
  for (const [name, data] of Object.entries(catalog)) {
    const isCluster = data.kind === "cluster";
    if (!isCluster && data.members.length < 2) continue;
    const meshes: THREE.Object3D[] = [];
    for (const m of data.members) {
      const mesh = meshByRef.get(refKey(m.tile, m.i));
      if (mesh) meshes.push(mesh);
    }
    if (!isCluster && meshes.length < 2) continue;

    const labelDiv = document.createElement("div");
    labelDiv.style.cssText = isCluster ? CLUSTER_LABEL_CSS : LABEL_CSS;
    labelDiv.innerHTML = `<div>${name}</div>`;
    labelDiv.setAttribute("data-system-label", "");
    if (initLabelDragFn) initLabelDragFn(labelDiv);

    const anchor = new THREE.Object3D();
    scene.add(anchor);
    const label = new CSS2DObject(labelDiv);
    label.center.set(0.5, 0);
    label.visible = false;
    anchor.add(label);

    const centroid = new THREE.Vector3();
    if (isCluster && data.centroid) {
      centroid.set(data.centroid[0], data.centroid[1], data.centroid[2]);
      anchor.position.copy(centroid);
    } else {
      for (const m of meshes) centroid.add(m.position);
      centroid.divideScalar(meshes.length);
    }

    const avgDist = meshes.length > 0
      ? meshes.reduce((s, m) => s + ((m.userData as Star).dist ?? 0), 0) / meshes.length
      : centroid.length() / SCALE;

    const base = { name, meshes, label, anchor, centroid, avgDist, wikipedia: data.wikipedia, notes: data.notes };

    const group: SystemGroup = isCluster
      ? { ...base, kind: "cluster", defaultShadow: CLUSTER_DEFAULT_SHADOW, aliases: data.aliases } as ClusterGroup
      : { ...base, kind: "binary", collapsedMembers: [],
          screens: meshes.map(() => ({ x: 0, y: 0 })),
          parents: new Array(meshes.length) } as BinarySystem;

    systemGroups.push(group);
    registerMembers(group, meshToSystem, clusterOf);
  }

  relinkAfterRebuild(systemGroups, showSystemMembers);
}

function precomputeTileSpheres() {
  const meta = getMeta();
  if (!meta) return;
  tileEntries = Object.entries(meta.tiles);
  for (const [path, tile] of tileEntries) {
    const center = new THREE.Vector3(
      (tile.min[0] + tile.max[0]) / 2,
      (tile.min[1] + tile.max[1]) / 2,
      (tile.min[2] + tile.max[2]) / 2,
    );
    const halfSize = new THREE.Vector3(
      (tile.max[0] - tile.min[0]) / 2,
      (tile.max[1] - tile.min[1]) / 2,
      (tile.max[2] - tile.min[2]) / 2,
    );
    tileSpheres.set(path, new THREE.Sphere(center, halfSize.length()));
  }
}

// Tiles the user has explicitly targeted via search. They load regardless
// of frustum / cull distance and are exempt from LRU eviction until
// released. Entries are cleared once their pending selection resolves.
const forcedTiles = new Set<string>();
type PendingSelection = { tile: string; i: number; onResolved: (mesh: THREE.Object3D) => void };
let pendingSelection: PendingSelection | null = null;

export function requestTileFocus(
  tile: string,
  i: number,
  onResolved: (mesh: THREE.Object3D) => void,
) {
  const existing = meshByRef.get(refKey(tile, i));
  if (existing) { onResolved(existing); return; }
  forcedTiles.add(tile);
  pendingSelection = { tile, i, onResolved };
}

function shouldLoadGeometry(path: string, tile: TileMeta, frustum: THREE.Frustum, camPos: THREE.Vector3): boolean {
  if (forcedTiles.has(path)) return true;
  const meta = getMeta();
  if (!meta) return false;
  const cullDist = meta.buckets[tile.bucket]?.cullDist ?? null;
  // cullDist === null → always-loaded bucket (bright). Skip frustum + range.
  if (cullDist === null) return true;
  const sphere = tileSpheres.get(path);
  if (!sphere) return false;
  if (!frustum.intersectsSphere(sphere)) return false;
  return sphere.center.distanceTo(camPos) < cullDist;
}

function shouldLoadLabels(path: string, camPos: THREE.Vector3): boolean {
  if (forcedTiles.has(path)) return true;
  const sphere = tileSpheres.get(path);
  if (!sphere) return false;
  // Load labels if the tile's bounding sphere overlaps the tier-1 range.
  return sphere.center.distanceTo(camPos) - sphere.radius < tier1LoadDist;
}

async function loadTile(path: string, tile: TileMeta) {
  if (loadedTiles.has(path) || loadingTiles.has(path)) return;
  loadingTiles.add(path);
  try {
    const response = await fetch(`${TILE_BASE_URL}${tile.bin}`);
    if (!response.ok) return;
    const buffer = await response.arrayBuffer();
    const starCount = buffer.byteLength / BYTES_PER_STAR;

    const positions = new Float32Array(starCount * 3);
    const brightnesses = new Float32Array(starCount);
    const colors = new Float32Array(starCount * 3);

    const view = new DataView(buffer);
    for (let i = 0; i < starCount; i++) {
      const offset = i * BYTES_PER_STAR;
      positions[i * 3] = view.getFloat32(offset, true);
      positions[i * 3 + 1] = view.getFloat32(offset + 4, true);
      positions[i * 3 + 2] = view.getFloat32(offset + 8, true);
      brightnesses[i] = view.getUint8(offset + 12);
      colors[i * 3] = view.getUint8(offset + 13) / 255;
      colors[i * 3 + 1] = view.getUint8(offset + 14) / 255;
      colors[i * 3 + 2] = view.getUint8(offset + 15) / 255;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("brightness", new THREE.BufferAttribute(brightnesses, 1));
    geometry.setAttribute("starColor", new THREE.BufferAttribute(colors, 3));

    const points = new THREE.Points(geometry, currentPointMaterial);
    points.frustumCulled = false;
    pointsGroup.add(points);

    loadedTiles.set(path, {
      geometry, points, positions, starCount,
      lastUsed: performance.now(),
      labelsLoaded: false,
    });

    const cached = getTileLabels(path);
    if (cached) spawnTileLabels(path, cached);
  } catch (e) {
    console.warn(`Failed to load tile ${tile.bin}:`, e);
  } finally {
    loadingTiles.delete(path);
  }
}

function evictGeometryTile(path: string) {
  const tile = loadedTiles.get(path);
  if (!tile) return;
  despawnTileLabels(path);
  evictTileLabels(path);
  pointsGroup.remove(tile.points);
  tile.geometry.dispose();
  loadedTiles.delete(path);
}

function evictOldTiles() {
  if (loadedTiles.size <= MAX_LOADED_TILES) return;
  const meta = getMeta();
  const evictable = [...loadedTiles.entries()]
    .filter(([path]) => meta?.buckets[meta.tiles[path].bucket]?.cullDist !== null)
    .filter(([path]) => !forcedTiles.has(path))
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const toEvict = evictable.slice(0, loadedTiles.size - MAX_LOADED_TILES);
  for (const [path] of toEvict) evictGeometryTile(path);
}

const frustum = new THREE.Frustum();
const projScreenMatrix = new THREE.Matrix4();
let lastUpdateTime = 0;
const UPDATE_INTERVAL = 500;

export async function initStarfield() {
  pointsGroup = new THREE.Group();
  scene.add(pointsGroup);
  billboardsGroup = new THREE.Group();
  scene.add(billboardsGroup);
  notableAnchorsGroup = new THREE.Group();
  scene.add(notableAnchorsGroup);

  await initCatalog();
  const meta = getMeta();
  if (!meta) {
    console.warn("Catalog not loaded — run scripts/build-catalog.py to generate");
    return;
  }
  tier1LoadDist = meta.labelTierVisibility["1"] ?? tier1LoadDist;
  precomputeTileSpheres();

  onTileLabelsLoaded((path, labels) => spawnTileLabels(path, labels));
  onTileLabelsEvicted((path) => despawnTileLabels(path));

  spawnNotableAnchors();
  // Wire ripple-highlight: anchor → billboard if currently spawned, and
  // billboard → anchor (so highlighting an anchor lights up its billboard
  // and vice versa).
  setCompanionResolver((target) => {
    return billboardByAnchor.get(target) ?? anchorByBillboard.get(target as THREE.Mesh);
  });
  rebuildSystems();
  notifyLabelsChanged();
}

export function updateStarfield() {
  const meta = getMeta();
  if (!meta) return;

  const now = performance.now();
  if (now - lastUpdateTime < UPDATE_INTERVAL) return;
  lastUpdateTime = now;

  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreenMatrix);

  const camPos = camera.position;

  for (const [path, tile] of tileEntries) {
    const wantsGeometry = shouldLoadGeometry(path, tile, frustum, camPos);
    const loaded = loadedTiles.get(path);
    if (wantsGeometry) {
      if (loaded) {
        loaded.points.visible = true;
        loaded.lastUsed = now;
      } else {
        loadTile(path, tile);
      }
    } else if (loaded) {
      loaded.points.visible = false;
    }

    const wantsLabels = shouldLoadLabels(path, camPos);
    if (wantsLabels && tile.lbl) {
      loadTileLabels(path);
    } else if (!wantsLabels) {
      const loadedTile = loadedTiles.get(path);
      if (loadedTile?.labelsLoaded) {
        despawnTileLabels(path);
        loadedTile.labelsLoaded = false;
        evictTileLabels(path);
      }
    }
  }

  evictOldTiles();

  if (labelSetDirty) {
    labelSetDirty = false;
    rebuildSystems();
    notifyLabelsChanged();
  }
}

export const tier1LabelMeshFromDiv = (div: HTMLElement): THREE.Mesh | undefined =>
  tier1DivToMesh.get(div);
export const tier1LabelDivFromMesh = (mesh: THREE.Object3D): HTMLElement | undefined =>
  streamedLabelMap.get(mesh as THREE.Mesh);
