import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Star, SystemGroup, BinarySystem, ClusterGroup } from "./types.ts";
import { LABEL_CSS, CLUSTER_LABEL_CSS, CLUSTER_DEFAULT_SHADOW, SCALE, TILE_BASE_URL } from "./constants.ts";
import { scene, camera } from "./scene.ts";
import { createStarAnchor, createStarLabel } from "./billboard.ts";
import { showSystemMembers } from "./interaction.ts";
import { setLabelsDirty, relinkAfterRebuild, getPinnedTile } from "./systemStore.ts";
import { registerMembers } from "./systemDispatch.ts";
import { untrackLabel } from "./labelCollision.ts";
import {
  BYTES_PER_STAR, createTileMesh, decodeTileBinary,
  magLimitUniform, DEFAULT_MAG_LIMIT, setMagLimit, apparentMag,
  selectedStarOverlay,
} from "./stars.ts";
import {
  initCatalog, getMeta, getNotable, getSystems, getTileLabels,
  loadTileLabels, evictTileLabels,
  onTileLabelsLoaded, onTileLabelsEvicted,
  type LabelRow, type TileMeta,
} from "./catalog.ts";

export { magLimitUniform, DEFAULT_MAG_LIMIT, setMagLimit, apparentMag };

const MAX_LOADED_TILES = 80;
const TILE_FADE_MS = 400;
let tier1LoadDist = 150;

interface LoadedTile {
  mesh: THREE.Mesh;
  starCount: number;
  positions: Float32Array;   // kept for anchor lookup on tile-label spawn
  lastUsed: number;
  labelsLoaded: boolean;
  opacityUniform: THREE.IUniform<number>;
  fadeStart: number;
  fadeFrom: number;
  fadeTo: number;
}

let tileMeshGroup: THREE.Group;
let anchorsGroup: THREE.Group;

const loadedTiles = new Map<string, LoadedTile>();
const fadingOutTiles = new Map<string, LoadedTile>();
const loadingTiles = new Set<string>();
interface TileStatic {
  sphere: THREE.Sphere;
  cullDist: number | null;  // null = always-loaded bucket (bright)
}
const tileStatic = new Map<string, TileStatic>();
let tileEntries: [string, TileMeta][] = [];

// Tier-0 (eager from notable.json) + tier-1 (streamed) anchors. Both
// are lightweight Object3Ds without geometry — all visuals render from
// the instanced mesh.
export const notableObjects: THREE.Object3D[] = [];
export const notableLabelMap = new WeakMap<THREE.Object3D, HTMLElement>();
export const notableLabelMeshMap = new WeakMap<HTMLElement, THREE.Object3D>();

export const streamedLabelMap = new WeakMap<THREE.Object3D, HTMLElement>();
const tier1DivToAnchor = new WeakMap<HTMLElement, THREE.Object3D>();

// Raycast target list for star clicks/hover.
export const allInteractiveStars: THREE.Object3D[] = [];
export const tier1Meshes: THREE.Object3D[] = [];

// (tile, index) → anchor, for system resolution.
const anchorByRef = new Map<string, THREE.Object3D>();
function refKey(tile: string, i: number): string { return `${tile}/${i}`; }

const spawnedByTile = new Map<string, THREE.Object3D[]>();

let labelSetDirty = false;

export const systemGroups: SystemGroup[] = [];
export const meshToSystem = new Map<THREE.Object3D, SystemGroup>();
export const clusterOf = new Map<THREE.Object3D, SystemGroup>();

export let initLabelDragFn: ((div: HTMLElement) => void) | null = null;
let labelChangeListeners: Array<() => void> = [];
export function onLabelsChanged(fn: () => void) { labelChangeListeners.push(fn); }
function notifyLabelsChanged() { for (const fn of labelChangeListeners) fn(); }

export function setInitLabelDrag(fn: (div: HTMLElement) => void) {
  initLabelDragFn = fn;
}

function spawnNotableAnchors() {
  const notable = getNotable();
  for (const n of notable) {
    const [sx, sy, sz] = n.pos;
    const anchor = createStarAnchor(n, sx, sy, sz);
    const { div } = createStarLabel(n, anchor, initLabelDragFn ?? (() => {}));
    anchorsGroup.add(anchor);
    notableObjects.push(anchor);
    notableLabelMap.set(anchor, div);
    notableLabelMeshMap.set(div, anchor);
    allInteractiveStars.push(anchor);
    anchorByRef.set(refKey(n.tile, n.i), anchor);
  }
}

function spawnTier1Anchor(row: LabelRow, path: string, sx: number, sy: number, sz: number): THREE.Object3D {
  const star: Star = { ...row, tile: path };
  const anchor = createStarAnchor(star, sx, sy, sz);
  const { div } = createStarLabel(star, anchor, initLabelDragFn ?? (() => {}));
  anchorsGroup.add(anchor);
  streamedLabelMap.set(anchor, div);
  tier1DivToAnchor.set(div, anchor);
  return anchor;
}

function spawnTileLabels(path: string, labels: LabelRow[]) {
  const tile = loadedTiles.get(path);
  if (!tile) return;
  if (tile.labelsLoaded) return;
  tile.labelsLoaded = true;
  const anchors: THREE.Object3D[] = [];
  for (const row of labels) {
    if (row.tier === 0) continue;  // tier-0 already spawned from notable.json
    const i = row.i;
    const sx = tile.positions[i * 3];
    const sy = tile.positions[i * 3 + 1];
    const sz = tile.positions[i * 3 + 2];
    const anchor = spawnTier1Anchor(row, path, sx, sy, sz);
    anchorByRef.set(refKey(path, i), anchor);
    allInteractiveStars.push(anchor);
    tier1Meshes.push(anchor);
    anchors.push(anchor);
  }
  spawnedByTile.set(path, anchors);
  if (anchors.length > 0) {
    labelSetDirty = true;
    setLabelsDirty(true);
  }

  if (pendingSelection && pendingSelection.tile === path) {
    const anchor = anchorByRef.get(refKey(path, pendingSelection.i));
    if (anchor) {
      const resolve = pendingSelection.onResolved;
      pendingSelection = null;
      forcedTiles.delete(path);
      resolve(anchor);
    }
  }
}

function despawnTileLabels(path: string) {
  const anchors = spawnedByTile.get(path);
  if (!anchors) return;
  for (const anchor of anchors) {
    anchorsGroup.remove(anchor);
    const idx = allInteractiveStars.indexOf(anchor);
    if (idx >= 0) allInteractiveStars.splice(idx, 1);

    const div = streamedLabelMap.get(anchor);
    if (div) {
      untrackLabel(div);
      div.remove();
      streamedLabelMap.delete(anchor);
      tier1DivToAnchor.delete(div);
    }
    const star = anchor.userData as Star & { tile?: string };
    if (star.tile !== undefined) anchorByRef.delete(refKey(star.tile, star.i));
    const t1idx = tier1Meshes.indexOf(anchor);
    if (t1idx >= 0) tier1Meshes.splice(t1idx, 1);
  }
  spawnedByTile.delete(path);
  labelSetDirty = true;
}

function rebuildSystems() {
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
    const members: THREE.Object3D[] = [];
    for (const m of data.members) {
      const anchor = anchorByRef.get(refKey(m.tile, m.i));
      if (anchor) members.push(anchor);
    }
    if (!isCluster && members.length < 2) continue;

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
      for (const m of members) centroid.add(m.position);
      centroid.divideScalar(members.length);
    }

    const avgDist = members.length > 0
      ? members.reduce((s, m) => s + ((m.userData as Star).dist ?? 0), 0) / members.length
      : centroid.length() / SCALE;

    const base = { name, meshes: members, label, anchor, centroid, avgDist, wikipedia: data.wikipedia, notes: data.notes };

    const group: SystemGroup = isCluster
      ? { ...base, kind: "cluster", defaultShadow: CLUSTER_DEFAULT_SHADOW, aliases: data.aliases } as ClusterGroup
      : { ...base, kind: "binary", collapsedMembers: [],
          screens: members.map(() => ({ x: 0, y: 0 })),
          parents: new Array(members.length) } as BinarySystem;

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
    tileStatic.set(path, {
      sphere: new THREE.Sphere(center, halfSize.length()),
      cullDist: meta.buckets[tile.bucket]?.cullDist ?? null,
    });
  }
}

const forcedTiles = new Set<string>();

function isTileForced(path: string): boolean {
  return forcedTiles.has(path) || path === getPinnedTile();
}
type PendingSelection = { tile: string; i: number; onResolved: (mesh: THREE.Object3D) => void };
let pendingSelection: PendingSelection | null = null;

export function requestTileFocus(
  tile: string,
  i: number,
  onResolved: (mesh: THREE.Object3D) => void,
) {
  const existing = anchorByRef.get(refKey(tile, i));
  if (existing) { onResolved(existing); return; }
  forcedTiles.add(tile);
  pendingSelection = { tile, i, onResolved };
}

function shouldLoadGeometry(path: string, frustum: THREE.Frustum, camPos: THREE.Vector3): boolean {
  if (isTileForced(path)) return true;
  const s = tileStatic.get(path);
  if (!s) return false;
  if (s.cullDist === null) return true;
  if (!frustum.intersectsSphere(s.sphere)) return false;
  return s.sphere.center.distanceTo(camPos) - s.sphere.radius < s.cullDist;
}

function shouldLoadLabels(path: string, camPos: THREE.Vector3): boolean {
  if (isTileForced(path)) return true;
  const sphere = tileStatic.get(path)?.sphere;
  if (!sphere) return false;
  return sphere.center.distanceTo(camPos) - sphere.radius < tier1LoadDist;
}

async function loadTile(path: string, tile: TileMeta) {
  if (loadedTiles.has(path) || loadingTiles.has(path)) return;
  loadingTiles.add(path);
  try {
    const response = await fetch(`${TILE_BASE_URL}${tile.bin}`);
    if (!response.ok) return;
    const buffer = await response.arrayBuffer();
    const data = decodeTileBinary(buffer);

    const opacityUniform: THREE.IUniform<number> = { value: 0.0 };
    const mesh = createTileMesh(data, opacityUniform);
    tileMeshGroup.add(mesh);

    const now = performance.now();
    loadedTiles.set(path, {
      mesh,
      starCount: data.count,
      positions: data.positions,
      lastUsed: now,
      labelsLoaded: false,
      opacityUniform,
      fadeStart: now, fadeFrom: 0, fadeTo: 1,
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
  tile.fadeStart = performance.now();
  tile.fadeFrom = tile.opacityUniform.value;
  tile.fadeTo = 0;
  fadingOutTiles.set(path, tile);
  loadedTiles.delete(path);
  setTimeout(() => {
    const fading = fadingOutTiles.get(path);
    if (fading) {
      tileMeshGroup.remove(fading.mesh);
      fading.mesh.geometry.dispose();
      (fading.mesh.material as THREE.Material).dispose();
      fadingOutTiles.delete(path);
    }
  }, TILE_FADE_MS);
}

function evictOldTiles() {
  if (loadedTiles.size <= MAX_LOADED_TILES) return;
  const evictable: [string, LoadedTile][] = [];
  for (const entry of loadedTiles) {
    const s = tileStatic.get(entry[0]);
    if (!s || s.cullDist === null) continue;  // always-loaded bucket
    if (isTileForced(entry[0])) continue;
    evictable.push(entry);
  }
  evictable.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const excess = loadedTiles.size - MAX_LOADED_TILES;
  for (let i = 0; i < excess && i < evictable.length; i++) evictGeometryTile(evictable[i]![0]);
}

const frustum = new THREE.Frustum();
const projScreenMatrix = new THREE.Matrix4();
let lastUpdateTime = 0;
const UPDATE_INTERVAL = 500;

export async function initStarfield() {
  tileMeshGroup = new THREE.Group();
  scene.add(tileMeshGroup);
  anchorsGroup = new THREE.Group();
  scene.add(anchorsGroup);
  scene.add(selectedStarOverlay);

  await initCatalog();
  const meta = getMeta();
  if (!meta) {
    console.warn("Catalog not loaded — run scripts/build-catalog.py to generate");
    return;
  }
  if (meta.bytesPerStar !== BYTES_PER_STAR) {
    console.error(
      `Tile format mismatch: meta reports ${meta.bytesPerStar} bytes/star, ` +
      `renderer expects ${BYTES_PER_STAR}. Rebuild tiles via build-catalog.py.`,
    );
  }
  tier1LoadDist = meta.labelTierVisibility["1"] ?? tier1LoadDist;
  precomputeTileSpheres();

  onTileLabelsLoaded((path, labels) => spawnTileLabels(path, labels));
  onTileLabelsEvicted((path) => despawnTileLabels(path));

  spawnNotableAnchors();
  rebuildSystems();
  notifyLabelsChanged();
}

// Fraction of cullDist over which the tile opacity fades 1 → 0. Keeps
// the tile's stars fully visible through 80% of their culling range and
// smoothly vanishes over the last 20% — so tiles no longer pop visible/
// invisible when crossing their hard cull boundary.
const TILE_DIST_FADE_BAND = 0.2;

function computeDistanceOpacity(path: string, camPos: THREE.Vector3): number {
  if (isTileForced(path)) return 1;
  const s = tileStatic.get(path);
  if (!s || s.cullDist == null) return 1;
  const d = s.sphere.center.distanceTo(camPos) - s.sphere.radius;
  const fadeStart = s.cullDist * (1 - TILE_DIST_FADE_BAND);
  if (d <= fadeStart) return 1;
  if (d >= s.cullDist) return 0;
  const u = (d - fadeStart) / (s.cullDist - fadeStart);
  return 1 - u * u * (3 - 2 * u);
}

function tickTileFades() {
  const now = performance.now();
  const camPos = camera.position;

  const applyFade = (path: string, tile: LoadedTile) => {
    const t = Math.min(1, (now - tile.fadeStart) / TILE_FADE_MS);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const loadOpacity = tile.fadeFrom + (tile.fadeTo - tile.fadeFrom) * ease;
    const distOpacity = computeDistanceOpacity(path, camPos);
    tile.opacityUniform.value = loadOpacity * distOpacity;
  };

  for (const [path, tile] of loadedTiles) applyFade(path, tile);
  for (const [path, tile] of fadingOutTiles) applyFade(path, tile);
}

export function updateStarfield() {
  tickTileFades();

  const meta = getMeta();
  if (!meta) return;

  const now = performance.now();
  if (now - lastUpdateTime < UPDATE_INTERVAL) return;
  lastUpdateTime = now;

  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreenMatrix);

  const camPos = camera.position;

  for (const [path, tile] of tileEntries) {
    const wantsGeometry = shouldLoadGeometry(path, frustum, camPos);
    const loaded = loadedTiles.get(path);
    if (wantsGeometry) {
      if (loaded) {
        loaded.lastUsed = now;
      } else {
        loadTile(path, tile);
      }
    }
    // Don't toggle mesh.visible — tickTileFades computes a distance-
    // based opacity multiplier that smoothly reaches 0 at the cull
    // boundary. LRU (evictOldTiles) eventually disposes tiles that
    // have been out of wantsGeometry range too long.

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

export const tier1LabelMeshFromDiv = (div: HTMLElement): THREE.Object3D | undefined =>
  tier1DivToAnchor.get(div);
export const tier1LabelDivFromMesh = (mesh: THREE.Object3D): HTMLElement | undefined =>
  streamedLabelMap.get(mesh);
