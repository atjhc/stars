# Starfield + Catalog Architecture

## Overview

Drake displays 1.86 million stars from the AT-HYG v3.3 catalog. The data layer
is a unified streaming pipeline: geometry streams as binary octree tiles for
fast GPU upload, while metadata (labels, systems) streams in parallel as
JSON, lazily, only where it's needed.

## Catalog scope: why ≤ 1000 parsecs?

`build-catalog.py` filters AT-HYG to stars with a valid distance ≤ `MAX_DIST_PC = 1000` (about 3260 ly). This is a deliberate cutoff and not the entire AT-HYG dataset:

| Bucket | Rows |
|---|---|
| AT-HYG v3.3 raw rows | 2,552,164 |
| With parseable distance < 100 kpc (sentinel for "unmeasured") | 2,491,331 |
| **Currently imported (≤ 1000 pc)** | **1,855,430** |
| Skipped: between 1 and ~100 kpc | ~636,000 |
| Skipped: no distance / sentinel value | ~61,000 |

The cutoff is chosen for three reasons:

1. **Distance accuracy degrades fast beyond ~1 kpc.** Most AT-HYG distances come from Gaia parallax. Parallax error scales with distance squared: a star at 100 pc has a typical 0.1 % distance error; at 1000 pc that error climbs to ~10 %; beyond a few kpc it becomes unreliable enough that putting the star at a single 3D position is misleading. The dataset includes far-away stars but their positions are essentially educated guesses.

2. **The visualization is a *neighborhood* viewer, not a galaxy map.** Going from 1 kpc to the disc/bulge scale (~10 kpc) is a 1000× volume expansion, but the human eye / camera frustum can't simultaneously meaningfully render both Sirius at ~3 units and a bulge star at ~30,000 units. A galaxy-scale view needs a logarithmic radial scale or LOD-tiered camera, which is a different product. The 1000 pc box keeps every star at a comparable visual scale and lets the camera orbit freely without having to switch coordinate systems.

3. **Download budget**. The 16 byte/star binary format means the imported set is 28 MB of geometry tiles. Doubling the radius to 2 kpc roughly 8× the volume, so ~80 MB; going to the full ~100 kpc range would be ~28 GB and dominated by stars the user would never zoom in on. The 1 kpc cutoff sits at a knee where the geometry download is small enough to ship as static assets without CDN tricks.

### Constraints if you wanted to extend the cutoff

- **Tile bounds**: octree currently fits in a ~6000-unit cube. Doubling the radius means 8× the volume; the tile count and binary size grow linearly with star count. Build script needs no changes — just bump `MAX_DIST_PC`.
- **Camera far plane**: scene.ts uses a far plane of 20000 scene units (~6500 ly). Already comfortably contains the 1 kpc cutoff. A 2 kpc cutoff would put the farthest stars at ~6000 scene units, still inside the frustum.
- **Point shader fade**: `smoothstep(4.0, 8.0, rawSize)` already culls sub-pixel points so visual cost is bounded by *what's on screen*, not raw catalog size. Memory cost grows linearly though.
- **Tier-1 magnitude filter** is the real lever for label clutter. If the catalog grew, the tier-1 mag<6 cutoff would still keep the label layer small.

In short: 1 kpc is the largest box that stays accurate, stays visually meaningful, and stays a reasonable static-site download. Anything larger is a different product.

## Pipeline

```
AT-HYG v3.3 CSV (2.55M rows)  +  data/augmentations.json
                       │
                       ▼
            scripts/build-catalog.py
                       │
   ┌──────────┬────────┴────────┬────────────────┬─────────────────┐
   ▼          ▼                 ▼                ▼                 ▼
meta.json   notable.json    systems.json    tile_*.bin      tile_*.lbl.json
 (49 KB)     (179 KB,         (5 KB,         (28 MB,            (940 KB
             607 stars)       59 groups)      183 tiles)       across 125 files)
```

A single Python script (`scripts/build-catalog.py`) consumes both the catalog
CSV and human-edited augmentations to emit every runtime artifact in one pass.

## Label tiers

Stars are partitioned into three tiers at build time. The tier determines
what runtime resources a star consumes. Classification is **independent of
curation metadata** — augmentations (wikipedia, notes, aliases) merge onto
whatever tier the star ends up in, so a tier-1 star's detail panel can still
be rich without being promoted to tier 0.

| Tier | Selection criteria | Runtime cost | Visible at |
|---|---|---|---|
| **0 — notable** | `(has_proper AND mag < 4.0)` OR `aug.notable === true` | Eager: persistent `Object3D` anchor + always-on CSS2D label at boot. Billboard mesh spawns/despawns with its tile for close-range visual glow. | All distances (subject to `NOTABLE_FADE_NEAR/FAR`) |
| **1 — named** | Has a catalog name (Bayer/Flamsteed/Gliese/HIP/HD/HR) AND (`mag < 6.0` OR `aug.system` present) | Lazy: billboard + child CSS2D label spawn when tile enters tier-1 range; despawn on eviction | Only when its tile is within `meta.labelTierVisibility["1"]` (~50 ly) |
| **2 — none** | No name, too faint, or `aug.notable === false` | Pure point cloud, no billboard, no label, not interactive | Never has a label |

The tier-0 magnitude cutoff gives ~265 globally-labeled stars — mostly the
bright naked-eye IAU names (Sirius, Vega, Deneb, …). Dim-but-famous nearby
stars (Proxima, Barnard's, Wolf 359) drop to tier 1 but still carry all their
augmentation data when selected. Use `"notable": true` in an augmentation
entry to promote such a star back to tier 0; use `"notable": false` to demote
a bright star (rarely needed).

The tier-1 magnitude filter is the single biggest reason the label layer is
only ~1 MB instead of ~40 MB. AT-HYG includes catalog identifiers for hundreds
of thousands of stars far below naked-eye visibility — they render in the
point cloud but don't get individual labels.

The `aug.system` exception in tier-1 ensures multi-star system companions like
Sirius B (mag ~8) stay selectable so the system clustering still works.

## Rendering model: anchors vs billboards

Tier-0 stars use a two-object model that decouples label persistence from
visual cost:

- An **anchor** (`Object3D`, no geometry, no shader) is created once at boot
  from `notable.json` and lives in the scene forever. It carries the
  `CSS2DObject` label and the star's `userData`.
- A **billboard mesh** (`Mesh` with the billboard shader + screen-space hit
  sphere) is spawned *alongside* the anchor at boot — also from `notable.json`,
  which bakes the scene-space position, luminosity, and color index needed
  for the shader. This means canvas hover works for every notable star
  regardless of whether its octree tile is currently streamed. The billboard
  shader fades its visible glow out past `camDist ≈ 40`, so distant tier-0
  billboards are visually invisible; the point cloud handles their appearance
  while the eager billboard provides only the raycast hit target.

Raycast hits on a tier-0 billboard are normalized back to the anchor via
`canonicalTarget()` so hover/select identity is consistent regardless of
how the user interacted (canvas click or label click). A ripple-highlight
via `setCompanionResolver()` mirrors `uHighlight` between anchor and
billboard so the shader glow still fires when the user hovers.

Tier-1 stars use a single-object model: the billboard mesh *is* the
label-bearing target, with the `CSS2DObject` as a child. Lifecycle is bound
to the tile.

When system clustering collapses nearby members in screen space, `labels.ts`
hides the individual labels via `cssLabelChild.visible = false` (the child
`CSS2DObject`), keeping the parent mesh/anchor visible and raycastable so
clicking a collapsed star's orb still routes to the system via
`meshToSystem`.

## Runtime artifacts

### `tile_<path>.bin` (geometry, lazy)

Flat binary, no header. Stars packed contiguously at 16 bytes each, little-endian:

```
Offset  Size    Type      Field
──────  ──────  ────────  ─────────────────────────
0       4       float32   x (scene-space)
4       4       float32   y (scene-space)
8       4       float32   z (scene-space)
12      1       uint8     brightness (0–255)
13      1       uint8     r
14      1       uint8     g
15      1       uint8     b
```

A tile with N stars is exactly `N × 16` bytes. Designed for direct upload to
GPU buffers with minimal client-side processing.

Scene-space coordinates apply a Y/Z swap on top of the catalog's galactic
Cartesian frame:

```
scene_x =  catalog_x × SCALE
scene_y =  catalog_z × SCALE
scene_z = -catalog_y × SCALE
```

`SCALE = 3` (parsecs to scene units), so 1 ly ≈ 0.92 units.

Brightness encoding mirrors the billboard formula:

```
lum = 10^((4.74 - absMag) / 2.5)
raw = max(0.8, min(2.5, 0.9 + 0.35 × log10(lum)))
byte = raw / 2.5 × 255
```

Color bytes come from B-V via Ballesteros + Tanner Helland with 1.8× saturation.

### `tile_<path>.lbl.json` (labels, lazy)

Sparse — only stars with tier 0 or tier 1 in this tile, not all stars. Each row
references the binary by index:

```json
{
  "labels": [
    {
      "i": 38,
      "tier": 1,
      "name": "Tau Ceti",
      "spect": "G8V",
      "mag": 3.49,
      "absmag": 5.69,
      "ci": 0.727,
      "lum": 0.52,
      "dist": 3.65,
      "aliases": ["HIP 8102", "HD 10700"],
      "wikipedia": "https://en.wikipedia.org/wiki/Tau_Ceti",
      "system": "tau-ceti"
    }
  ]
}
```

`i` is the index into `tile_<path>.bin`. The runtime looks up the position
(and color, brightness) from the binary array and creates a billboard mesh
at that location.

### `meta.json` (catalog manifest, eager)

```json
{
  "tileCount": 183,
  "totalStars": 1855430,
  "bytesPerStar": 16,
  "labelTierVisibility": { "0": 100000, "1": 150 },
  "bounds": { "min": [...], "max": [...] },
  "tiles": {
    "0_3_5_2": {
      "bin": "tile_0_3_5_2.bin",
      "lbl": "tile_0_3_5_2.lbl.json",
      "stars": 12043,
      "min": [...], "max": [...],
      "depth": 4,
      "labelCounts": { "0": 4, "1": 38 }
    }
  }
}
```

`labelTierVisibility[T]` is the camera-distance threshold (in scene units) at
which tier-T labels stop being relevant. The runtime uses this to decide
whether to fetch each tile's label JSON.

### `notable.json` (eager, ~180 KB)

All tier-0 labels across the entire catalog, in one file. Each entry has the
full label row plus baked scene-space `pos` and a `(tile, i)` back-reference
for cross-linking. Loaded immediately at boot so notable labels appear before
any tile streams in.

### `systems.json` (eager, ~5 KB)

Pre-computed system groupings. Members are referenced by `(tile, i)`:

```json
{
  "Alpha Centauri": [
    { "tile": "0_0_0_0", "i": 12, "name": "Alpha Centauri A" },
    { "tile": "0_0_0_0", "i": 13, "name": "Alpha Centauri B" },
    { "tile": "0_0_0_0", "i": 47, "name": "Proxima Centauri" }
  ]
}
```

The runtime rebuilds `SystemGroup` objects whenever the set of currently-spawned
billboards changes; only systems whose members are all present render their
collapsing-cluster label.

## Brightness buckets

Stars are split by absolute magnitude into two buckets with independent
streaming policies. This is what lets distant naked-eye stars render from
any camera position without streaming in their (otherwise far-out-of-range)
spatial tiles.

| Bucket | Criteria | Stars | Tileset | Cull distance |
|---|---|---|---|---|
| **bright** | `absmag < 0` | ~40k | single `tile_bright.bin` (~620 KB), no octree | none — always loaded |
| **medium** | `absmag ≥ 0` | ~1.82M | octree (~180 tiles) | scene-unit distance chosen from the m=6.5 naked-eye limit for an M=0 star (~200 pc × SCALE) |

Physical basis: apparent magnitude `m = M + 5·log₁₀(d/10pc)`, so for a fixed
naked-eye cutoff (m ≈ 6.5), each absolute-magnitude bucket has a well-defined
max distance at which its stars become invisible. The bucket boundary at
M = 0 puts anything visible beyond ~200 pc into the bright bucket, which is
rare enough (~2% of the catalog) to ship as a single always-loaded file.

Buckets are orthogonal to **label tiers** — a tier-0 notable lives in
whichever brightness bucket its absolute magnitude puts it in. About 60% of
notables are in the bright bucket (Vega, Deneb, Betelgeuse, …); the rest
(Sun-like and dimmer nearby stars) are in medium and stream in with their
tiles as before.

### Meta.json schema addition

```json
"buckets": {
  "bright": { "cullDist": null },
  "medium": { "cullDist": 598 }
}
```

Each tile entry gains a `bucket: "bright" | "medium"` field. Runtime code
in `starfield.ts` looks up `meta.buckets[tile.bucket].cullDist` per tile;
`null` means "always load, never evict".

## Octree tiling

Stars are spatially partitioned into an adaptive octree:

- **Max stars per tile**: 50,000
- **Max depth**: 6 levels
- **Total tiles**: 183 (typical)
- **Size range**: 28 – 47,470 stars per tile

## Runtime modules

### `src/catalog.ts`

Pure data layer. Boots by fetching `meta.json`, `notable.json`, and
`systems.json` in parallel. Exposes a lazy `loadTileLabels(path)` /
`evictTileLabels(path)` API plus listener hooks (`onTileLabelsLoaded`,
`onTileLabelsEvicted`). No Three.js dependency.

### `src/starfield.ts`

Owns all tile lifecycle: geometry tiles, label tiles, billboard meshes, and
dynamic `SystemGroup` rebuilding. Per-frame (every 500 ms it):

1. Computes the camera frustum and tests each tile's bounding sphere.
2. For each tile, looks up its bucket's cull distance from
   `meta.buckets[tile.bucket].cullDist`. If `null` (the `bright` bucket),
   the tile is always loaded regardless of camera position. Otherwise the
   tile loads when its center is within the bucket cull distance and in
   the frustum, via `fetch()` → `DataView` → `BufferGeometry` → `THREE.Points`.
3. Independently triggers `loadTileLabels(path)` for any tile whose center is
   within `meta.labelTierVisibility["1"]` (default 150 units, ~50 ly).
4. When a label tile arrives **and** its geometry tile is loaded, walks the
   label rows and spawns a billboard mesh + CSS2D label for each tier-1 entry,
   reading positions from the binary geometry buffer. Tier-0 entries are
   skipped here — they were spawned eagerly from `notable.json` at boot.
5. When a tile is evicted (LRU past 80 loaded tiles, or it leaves the tier-1
   radius), despawns its billboards, disposes their materials/geometries, and
   removes their entries from the global interactive list. Always-loaded
   buckets (`cullDist === null`) are exempt from LRU eviction.
6. Rebuilds `SystemGroup` objects whenever the membership of the spawned-set
   changes — only systems with all members currently present become groups.

### `src/main.ts`

Slimmed down to wire-up only: input events, render loop, system label
event handlers (re-attached via `onLabelsChanged`), Sol selection on boot.
Does not own any star data.

### Two-layer rendering

Every star renders through the point cloud (`THREE.Points`) for visual
consistency. Tier-0 and tier-1 stars *additionally* render as billboard meshes
when in close range, providing the colored glow + click target. The billboard
shader uses `proximityFade = smoothstep(40.0, 10.0, camDist)` to fade out at
distance, so far-away billboards don't visually overpower the point cloud.

## Streaming performance

- **Fetch**: each geometry tile is 0.5–750 KB; each label tile is typically 1–50 KB
- **Decode**: parsing 50 K stars takes ~2 ms
- **Render**: one point-cloud draw call per loaded tile (~80 max)
- **Billboards**: tens to a few hundred at a time when zoomed in close
- **Memory**: ~80 tiles × ~800 KB GPU buffer ≈ 64 MB GPU peak

## Anti-aliasing

Stars that would render smaller than 4 px get their brightness faded to zero
via `smoothstep(4.0, 8.0, rawSize)` to prevent sub-pixel flickering during
camera rotation. Stars below 4 px are discarded entirely (`gl_Position` moved
off-screen).

## Building

```sh
# Ensure submodule + LFS data are present
git submodule update --init
cd vendor/athyg && git lfs pull --include="data/athyg_v33-*.csv.gz" && cd ../..

# Download cluster member astrometry from VizieR (first time or when updating)
python3 scripts/fetch-hunt2023-astro.py

# Build tiles
python3 scripts/build-catalog.py data/augmentations.json dist/tiles/ \
  vendor/athyg/data/athyg_v33-1.csv.gz vendor/athyg/data/athyg_v33-2.csv.gz
```

AT-HYG v3.3 is vendored as a git submodule at `vendor/athyg/` (LFS for the
CSV data). The catalog ships as two files with only part 1 carrying a header
row; the build script concatenates them transparently.

The build also injects ~14k synthetic cluster members from Hunt & Reffert
(2023) astrometric data (`data/cluster-members/hunt2023-astro.json`). These
are faint stars (Gmag 12–20) not in AT-HYG's Tycho-2-based catalog but
identified as cluster members via Gaia DR3 astrometric clustering. They
render as tier-2 point-cloud stars, making clusters visually complete.

## Curating tier-0 metadata

After changing the tier-0 selection (magnitude threshold or `notable` flags),
the set shifts and new entries may need research. See
`.claude/skills/research/SKILL.md` for the full workflow. The short version:

```sh
python3 scripts/audit-notable.py          # human-readable gap report
python3 scripts/audit-notable.py --json   # machine-readable for batch research
python3 scripts/merge-augmentations.py /tmp/drake-batch-*.results.json
python3 scripts/build-catalog.py ...      # rebuild to apply
```

`audit-notable.py` flags tier-0 stars that have no augmentation entry. Once
an entry exists with wikipedia + notes it's considered curated, even if
`aliases` is empty (some stars legitimately have no traditional names beyond
their catalog designation).

## References

- [AT-HYG Database](https://codeberg.org/astronexus/athyg) (CC-BY-SA 4.0)
- [Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3) — source for 97.5% of distances
- [Three.js Points](https://threejs.org/docs/#api/en/objects/Points)
