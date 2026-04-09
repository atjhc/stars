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

const TILE_BASE_URL = "/tiles/";

let meta: CatalogMeta | null = null;
let notable: NotableEntry[] = [];
let systems: Record<string, SystemMember[]> = {};

const tileLabelCache = new Map<string, LabelRow[]>();
const tileLabelLoading = new Set<string>();

type TileLabelListener = (path: string, labels: LabelRow[]) => void;
type TileEvictListener = (path: string) => void;
const loadListeners: TileLabelListener[] = [];
const evictListeners: TileEvictListener[] = [];

export function onTileLabelsLoaded(fn: TileLabelListener) { loadListeners.push(fn); }
export function onTileLabelsEvicted(fn: TileEvictListener) { evictListeners.push(fn); }

export async function initCatalog(): Promise<void> {
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

export function getMeta(): CatalogMeta | null { return meta; }
export function getNotable(): NotableEntry[] { return notable; }
export function getSystems(): Record<string, SystemMember[]> { return systems; }
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
