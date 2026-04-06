# Starfield Streaming

## Overview

The viewer displays 1.86 million stars from the AT-HYG v3.3 catalog, streamed
on demand from binary octree tiles. This provides a dense, realistic star field
without loading the entire dataset upfront.

## Architecture

```
AT-HYG v3.3 CSV (2.55M rows)
  → scripts/build-tiles.py
  → dist/tiles/meta.json + 183 binary tiles (28.3 MB total)
  → src/starfield.ts loads tiles at runtime based on camera position
  → THREE.Points renders each tile as a single draw call
```

## Rendering Pipeline

All stars — from Sol's nearest neighbors to stars 3,260 light-years away — are
rendered through the same point cloud pipeline for visual consistency.

### Two layers, one appearance

| Layer | Stars | Purpose |
|---|---|---|
| **Point cloud** (starfield.ts) | 1.86M | All visual rendering — uniform glow via `gl_PointCoord` |
| **Billboard meshes** (main.ts, notable.ts) | ~1,170 | Interaction only (raycasting, labels, detail panel). Adds detailed colored glow when camera is within ~40 scene units via `proximityFade` |

The billboard layer uses `smoothstep(40.0, 10.0, camDist)` to fade its
contribution. At close range both layers render (additive blending makes the
star richer). At distance only the point cloud is visible, so all stars look
identical regardless of whether they have names or interaction.

### Anti-aliasing

Stars that would be smaller than ~4px get their brightness faded to zero via
`smoothstep(4.0, 8.0, rawSize)` to prevent sub-pixel flickering during camera
rotation. Stars below 4px are discarded entirely (`gl_Position` moved off-screen).

## Binary Tile Format

Each tile is a flat binary file with no header. Stars are packed contiguously
at **16 bytes per star**, little-endian:

```
Offset  Size    Type      Field
──────  ──────  ────────  ─────────────────────────
0       4       float32   x (scene-space, parsecs × 3)
4       4       float32   y (scene-space, catalog z × 3)
8       4       float32   z (scene-space, -catalog y × 3)
12      1       uint8     brightness (0–255)
13      1       uint8     r (red channel, 0–255)
14      1       uint8     g (green channel, 0–255)
15      1       uint8     b (blue channel, 0–255)
```

A tile with N stars is exactly `N × 16` bytes. The format is designed for
direct upload to GPU buffers with minimal client-side processing.

### Coordinate system

Scene-space coordinates are derived from the catalog's equatorial J2000
Cartesian coordinates:

```
scene_x =  catalog_x × SCALE
scene_y =  catalog_z × SCALE
scene_z = -catalog_y × SCALE
```

Where `SCALE = 3` (parsecs to scene units).

### Brightness encoding

Brightness is derived from absolute magnitude via luminosity:

```
lum = 10^((4.74 - absMag) / 2.5)
raw = max(0.8, min(2.5, 0.9 + 0.35 × log10(lum)))
byte = raw / 2.5 × 255
```

This matches the billboard star brightness formula. The shader recovers
the original value as `byte / 255.0` and multiplies by 2.5.

### Color encoding

RGB bytes are derived from the B-V color index using Ballesteros' formula
(B-V → temperature) and Tanner Helland's algorithm (temperature → RGB),
with 1.8× saturation exaggeration. Same algorithm as the billboard stars.

## Octree Tiling

Stars are spatially partitioned into an adaptive octree:

- **Max stars per tile**: 50,000
- **Max depth**: 6 levels
- **Total tiles**: 183
- **Size range**: 28 – 47,470 stars per tile

### meta.json

The metadata file describes the octree structure:

```json
{
  "tileCount": 183,
  "totalStars": 1855430,
  "bytesPerStar": 16,
  "format": "x:f32, y:f32, z:f32, brightness:u8, r:u8, g:u8, b:u8",
  "bounds": {
    "min": [-3000, -3000, -3000],
    "max": [3000, 3000, 3000]
  },
  "tiles": {
    "0_0": {
      "file": "tile_0_0.bin",
      "stars": 12345,
      "min": [-3000, -3000, -3000],
      "max": [0, 0, 0],
      "depth": 2
    }
  }
}
```

Each tile entry includes its bounding box (`min`/`max`), enabling the client
to do frustum culling and distance-based loading without opening the binary.

## Streaming Strategy

The tile loader (`src/starfield.ts`) runs every 500ms:

1. **Frustum test**: compute camera frustum, test each tile's bounding sphere
2. **Distance test**: skip tiles whose center is beyond 800 scene units
3. **Fetch**: request visible tiles that aren't already loaded (`fetch()`)
4. **Decode**: parse binary buffer → Float32Array positions + Float32Array
   brightness + Float32Array colors
5. **Upload**: create `THREE.BufferGeometry` with attributes, wrap in
   `THREE.Points`, add to scene
6. **Evict**: when more than 80 tiles are loaded, remove least-recently-used

### Performance characteristics

- **Fetch**: each tile is 0.5–750 KB, loads in <100ms on broadband
- **Decode**: parsing 50K stars takes ~2ms
- **Render**: one draw call per loaded tile (~80 max = 80 draw calls)
- **Memory**: ~80 tiles × ~800KB GPU buffer = ~64MB GPU memory peak

## Building Tiles

```sh
# Download AT-HYG v3.3
curl -sL -o athyg1.csv.gz \
  "https://codeberg.org/astronexus/athyg/media/branch/main/data/athyg_v33-1.csv.gz"
curl -sL -o athyg2.csv.gz \
  "https://codeberg.org/astronexus/athyg/media/branch/main/data/athyg_v33-2.csv.gz"
gunzip athyg1.csv.gz athyg2.csv.gz
head -1 athyg1.csv > athyg_v33.csv
tail -n +2 athyg1.csv >> athyg_v33.csv
tail -n +2 athyg2.csv >> athyg_v33.csv

# Build tiles
python3 scripts/build-tiles.py athyg_v33.csv dist/tiles/
```

## References

- [AT-HYG Database](https://codeberg.org/astronexus/athyg) (CC-BY-SA 4.0)
- [Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3) — source for 97.5% of distances
- [Three.js Points](https://threejs.org/docs/#api/en/objects/Points)
