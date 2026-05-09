// Unified catalog data layer.
//
// At boot, fetches the small eager artifacts (meta + notable + systems) in
// parallel. After that, per-tile label files are streamed lazily through
// loadTileLabels() / evictTileLabels(). Geometry tiles remain owned by
// starfield.ts; this module is purely metadata.

export type BucketName = "bright" | "medium";

export interface BucketMeta {
  cullDist: number | null;
}

export interface CatalogMeta {
  tileCount: number;
  totalStars: number;
  bytesPerStar: number;
  format: string;
  labelTierVisibility: { "0": number; "1": number };
  buckets: Record<BucketName, BucketMeta>;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  tiles: Record<string, TileMeta>;
}

export interface TileMeta {
  bin: string;
  lbl: string | null;
  stars: number;
  min: [number, number, number];
  max: [number, number, number];
  depth: number;
  bucket: BucketName;
  labelCounts: { "0": number; "1": number };
}

export interface LabelRow {
  i: number;
  tier: 0 | 1;
  name: string;
  spect: string;
  mag: number;
  absmag: number;
  ci: number;
  lum: number;
  dist: number;
  aliases?: string[];
  wikipedia?: string;
  notes?: string;
  system?: string;
  synthetic?: boolean;
}

export interface NotableEntry extends LabelRow {
  tile: string;
  pos: [number, number, number];
}

export interface SystemMember {
  tile: string;
  i: number;
  name: string;
}

export interface SystemData {
  members: SystemMember[];
  kind?: "cluster";
  type?: string;
  aliases?: string[];
  wikipedia?: string;
  notes?: string;
  centroid?: [number, number, number];
  radius?: number;
  // Optional cluster arrival framing (light-years). When `arrivalRadiusLy`
  // is set, selectSystem uses it instead of the auto-derived spread.
  // `minOrbitRadiusLy` floors the zoom-in distance, so the user can't
  // dive past the cluster's framed view.
  arrivalRadiusLy?: number;
  minOrbitRadiusLy?: number;
}

// Global search entry. Short keys to minimize the JSON payload; see
// build-catalog.py for the producer. Covers every tier-0 and tier-1 star
// plus one synthetic entry per cluster.
export interface SearchEntry {
  n: string;                    // primary name
  t?: string;                   // tile path (absent for synthetic cluster entries)
  i?: number;                   // index in tile (absent for synthetic cluster entries)
  p: [number, number, number];  // scene-space position
  mg: number;                   // apparent mag
  M: number;                    // absolute mag
  d: number;                    // distance (pc)
  sp?: string;                  // spectral type
  a?: string[];                 // aliases
  sy?: string;                  // system name
  k?: "c" | "n" | "b" | "ns" | "x" | "s";  // kind: "c" cluster, "n" nebula, "b" black hole, "ns" neutron star, "x" constellation, "s" star system aggregate (synthesized at search time)
}

import { TILE_BASE_URL } from "./constants.ts";

let meta: CatalogMeta | null = null;
let notable: NotableEntry[] = [];
let systems: Record<string, SystemData> = {};
let searchIndex: SearchEntry[] = [];
let searchIndexReady: Promise<SearchEntry[]> = Promise.resolve(searchIndex);

const tileLabelCache = new Map<string, LabelRow[]>();
const tileLabelLoading = new Set<string>();

type TileLabelListener = (path: string, labels: LabelRow[]) => void;
type TileEvictListener = (path: string) => void;
const loadListeners: TileLabelListener[] = [];
const evictListeners: TileEvictListener[] = [];

export function onTileLabelsLoaded(fn: TileLabelListener) { loadListeners.push(fn); }
export function onTileLabelsEvicted(fn: TileEvictListener) { evictListeners.push(fn); }

export async function initCatalog(): Promise<void> {
  // names.json is the largest eager artifact (~307 KB gzip) and only
  // gates downstream consumers (constellations, planets, search, URL
  // focus restore) — not first paint. Kick it off in parallel but
  // don't block on it; consumers await whenSearchIndexReady().
  searchIndexReady = fetch(`${TILE_BASE_URL}names.json`)
    .then((r) => r.json() as Promise<SearchEntry[]>)
    .then((idx) => {
      searchIndex = idx;
      console.log(`Catalog: ${idx.length} searchable`);
      return idx;
    });

  const [m, n, s] = await Promise.all([
    fetch(`${TILE_BASE_URL}meta.json`).then((r) => r.json()),
    fetch(`${TILE_BASE_URL}notable.json`).then((r) => r.json()),
    fetch(`${TILE_BASE_URL}systems.json`).then((r) => r.json()),
  ]);
  meta = m;
  notable = n;
  systems = s;
  console.log(
    `Catalog: ${meta!.totalStars} stars, ${meta!.tileCount} tiles, ${notable.length} notable, ${Object.keys(systems).length} systems`,
  );
}

// Resolves once the global search index (names.json) is loaded. Use
// this in any code path that reads getSearchIndex() before the user
// has had a chance to interact — startup URL focus restore,
// constellation line rendering, planet position fixup. Pure search
// panel use can keep calling getSearchIndex() directly: by the time
// the panel opens, names.json is long since loaded.
export function whenSearchIndexReady(): Promise<SearchEntry[]> {
  return searchIndexReady;
}

export function getMeta(): CatalogMeta | null { return meta; }
export function getNotable(): NotableEntry[] { return notable; }
export function getSystems(): Record<string, SystemData> { return systems; }
export function getSearchIndex(): SearchEntry[] { return searchIndex; }
export function getTileLabels(path: string): LabelRow[] | undefined { return tileLabelCache.get(path); }

export function loadTileLabels(path: string): void {
  if (!meta) return;
  if (tileLabelCache.has(path) || tileLabelLoading.has(path)) return;
  const tile = meta.tiles[path];
  if (!tile || !tile.lbl) return;
  tileLabelLoading.add(path);
  fetch(`${TILE_BASE_URL}${tile.lbl}`)
    .then((r) => r.json())
    .then((data: { labels: LabelRow[] }) => {
      tileLabelCache.set(path, data.labels);
      for (const fn of loadListeners) fn(path, data.labels);
    })
    .catch((e) => console.warn(`Failed to load labels for ${path}:`, e))
    .finally(() => tileLabelLoading.delete(path));
}

export function evictTileLabels(path: string): void {
  if (!tileLabelCache.delete(path)) return;
  for (const fn of evictListeners) fn(path);
}
