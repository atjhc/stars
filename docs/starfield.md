# Starfield

## Overview

Drake displays 1.86 million stars from the AT-HYG v3.3 catalog as a
unified streaming pipeline: geometry streams as binary octree tiles for
fast GPU upload, while metadata (labels, systems) streams in parallel as
JSON, lazily, only where it's needed.

Every star — every tier, every LOD — is a single instance of a unit quad
drawn by one shader. The same formula covers sub-pixel points, resolved
discs with limb darkening, and glowing coronas. No point cloud, no
per-star billboard mesh, no post-bloom overlay.

Precision at deep zoom is handled by **per-tile floating-origin rebasing**
— see [camera.md](camera.md) for the full precision architecture.

Related files:

- `src/stars.ts` — unified shader, tile-binary decoder, InstancedMesh
  builder, screen-space overlay, shared uniforms, and the single
  CPU-side source of truth for pixel-space metrics
  (`computeStarScreenMetrics`).
- `src/starfield.ts` — tile streaming, anchor spawning, label rebuild.
- `src/billboard.ts` — `createStarAnchor` / `createStarLabel` helpers.
  Anchors are invisible `Object3D`s that carry labels and a screen-space
  raycast hit sphere; they have no geometry.
- `src/shaderUniforms.ts` — shared GPU uniforms referenced by multiple
  materials (viewport size, target-relative coordinate frame).
- `src/starOcclusion.ts` — CPU helpers for label-margin placement and
  occlusion sizing; reads from `computeStarScreenMetrics`.

## Catalog scope: why 1000 parsecs?

`build-catalog.py` filters AT-HYG to stars with a valid distance
≤ `MAX_DIST_PC = 1000` (about 3260 ly).

| Bucket | Rows |
|---|---|
| AT-HYG v3.3 raw rows | 2,552,164 |
| With parseable distance < 100 kpc | 2,491,331 |
| **Currently imported (≤ 1000 pc)** | **1,855,430** |
| Skipped: between 1 and ~100 kpc | ~636,000 |
| Skipped: no distance / sentinel value | ~61,000 |

The cutoff is chosen for three reasons:

1. **Distance accuracy degrades fast beyond ~1 kpc.** Most AT-HYG
   distances come from Gaia parallax. Error scales with distance squared:
   ~0.1% at 100 pc, ~10% at 1000 pc, unreliable beyond a few kpc.

2. **Neighborhood viewer, not a galaxy map.** Going from 1 kpc to disc
   scale (~10 kpc) is a 1000x volume expansion. The camera frustum can't
   meaningfully render both Sirius at ~3 units and a bulge star at ~30,000
   units simultaneously.

3. **Download budget.** The 20 byte/star binary format means the imported
   set is ~28 MB of geometry tiles. Doubling the radius to 2 kpc
   roughly 8x the volume.

## Shader math

Two physical quantities drive everything the instanced shader does:

```glsl
angRadius = instanceRadius · DISC_SCALE / camDist   // screen-angle of disc
discPx    = angRadius · F_HALF_TAN_INV · halfHeight // pixel radius
appMag    = absMag + 5·log10(camDist / 10pc)        // distance modulus
```

`DISC_SCALE = 8.0` is the one artistic multiplier: it scales every
star's rendered disc uniformly, so relative sizes (Sol vs. Betelgeuse)
stay physically proportional while the Sun at 1 AU feels thumb-sized
instead of the geometrically correct ~10 pixels.

The same math also lives in TS as `computeStarScreenMetrics(radius,
absMag, camDist)` in `src/stars.ts`. The overlay driver, label margin,
and occluder all call it so the CPU can't drift from the shader.

### Billboard size

```glsl
coronaPx    = HALO_FLOOR_PX · clamp(0.5 + 0.3·rawBrightness, 1.0, 2.5)
halfBillPx  = discPx + coronaPx
```

Additive, not multiplicative: the corona is a fixed-thickness rim
around the disc. Total size is strictly monotonic in `1/camDist` —
nothing shrinks as you zoom in. For a sub-pixel star the disc
contribution is zero and the entire visible element is the corona.

### Disc

```glsl
discMask  = smoothstep(discPx + 0.5, discPx - 0.5, rPx)   // 1 px AA edge
limbDark  = 1 - 0.6·(1 - sqrt(1 - r²))                    // u = 0.6
discColor = vColor · limbDark                             // LDR-saturated
```

Disc intensity stays at LDR saturation (~1.0 per channel). The bloom
pass extracts only `(1.0 − 0.1) = 0.9` per disc pixel, so the disc's
contribution to bloom is modest — the edge reads as crisp in the final
image rather than smeared into a fuzzy blob.

### Corona

The shared `GLOW_GLSL` radial profile (Gaussian core + inverse-square
halo + soft exponential tail) is sampled across the rim, normalized so
`coronaT = 0` at the disc edge and `coronaT = 1` at the outer billboard
edge. A constant `CORONA_PEAK_OFFSET = 0.15` lifts the sample slightly
past the profile's peak — gives a soft falloff rather than a bright
rim of light at the disc edge.

Corona brightness scales with apparent magnitude (`vIntensity`), so
bright stars get large bloomy halos and faint ones don't. A `tierFade`
zeros the contribution as `appMag` crosses the magnitude-limit cutoff,
so distant faint stars vanish cleanly.

### Quad-corner edge fade

```glsl
edgeFade = 1 - smoothstep(0.95, 1.0, rUv)
```

Cuts alpha past the inscribed circle of the square quad so the corners
don't leak a visible rectangular edge.

## Target-relative coordinate frame

`scene.updateCamera` clamps `camera.position` during deep zoom so the
view matrix stays Float32-safe. That clamp would normally prevent a
star's `mvCenter.z` from dropping past the clamp threshold, capping
effective `discPx`. Instead, the star shader recomposes camera-space
from three uniforms published each frame by `updateCamera`:

```glsl
relPos     = instancePos − uLocalTarget          // star in target frame
camRelPos  = relPos − uStarCameraOffset          // star relative to camera
viewPos    = uStarViewRotation · camRelPos       // rotate into view space
```

`uStarCameraOffset` is computed from the *unclamped* orbit radius and
orbit angles, not from the clamped `camera.position`. All subtractions
stay near zero, so Float32 precision holds even tens of AU from stars
hundreds of scene units from world origin.

## Selected-star overlay

A selected star is always at the orbit target, which is always at
screen center (the camera looks at the target). The instanced pass
*skips* that one instance (via `uSkipSelected` + `uStarTarget`
comparison) and a separate overlay mesh draws it in pure clip space:

```glsl
viewPos = vec4(position.xy · worldScale · 2.0, -OVERLAY_DEPTH, 1.0);
gl_Position = projectionMatrix · viewPos;
```

Using `projectionMatrix` (rather than raw `gl_Position = NDC`) is
required: `beginBloomRender` widens `camera.fov` by `BLOOM_OVERSCAN =
1.2×` and the composer RT also widens 1.2×, and those factors only
cancel for geometry that goes through the projection matrix.

The overlay is immune to Float32 precision loss at any zoom level, for
any star's world position. Because it lives in the main scene, the
composer's bloom still picks up its HDR output.

## Tile binary format

Flat binary, no header. Stars packed contiguously at 20 bytes each,
little-endian:

```
Offset  Size    Type      Field
──────  ──────  ────────  ─────────────────────────
0       4       float32   x (scene-space)
4       4       float32   y (scene-space)
8       4       float32   z (scene-space)
12      1       uint8     brightness byte (absmag encoded linearly)
13      1       uint8     r
14      1       uint8     g
15      1       uint8     b
16      4       float32   physical radius (scene units)
```

A tile with N stars is exactly `N × 20` bytes. The per-star record maps
directly to the instanced shader's attribute layout.

Scene-space coordinates apply a Y/Z swap on top of the catalog's
galactic Cartesian frame:

```
scene_x =  catalog_x × SCALE
scene_y =  catalog_z × SCALE
scene_z = -catalog_y × SCALE
```

`SCALE = 3` (parsecs to scene units), so 1 ly ≈ 0.92 units.

Brightness byte encodes absolute magnitude linearly:

```
byte = clamp(round((absmag + 10) × 10), 0, 255)   // M ∈ [-10, +15.5]
```

## Brightness buckets

Stars are split by absolute magnitude into two buckets with independent
streaming policies.

| Bucket | Criteria | Stars | Tileset | Cull distance |
|---|---|---|---|---|
| **bright** | `absmag < 0` | ~40k | single `tile_bright.bin` (~620 KB) | none — always loaded |
| **medium** | `absmag ≥ 0` | ~1.82M | octree (~180 tiles) | m=6.5 naked-eye limit for M=0 star (~200 pc × SCALE) |

Buckets are orthogonal to label tiers — a tier-0 notable lives in
whichever brightness bucket its absolute magnitude puts it in.

## Octree tiling

Stars are spatially partitioned into an adaptive octree:

- **Max stars per tile**: 50,000
- **Max depth**: 6 levels
- **Total tiles**: 183 (typical)
- **Size range**: 28 – 47,470 stars per tile

## Label tiers

Stars are partitioned into three tiers at build time. Classification is
**independent of curation metadata** — augmentations merge onto whatever
tier the star ends up in.

| Tier | Selection criteria | Runtime cost | Visible at |
|---|---|---|---|
| **0 — notable** | `(has_proper AND mag < 4.0)` OR `aug.notable === true` | Eager: `Object3D` anchor + always-on label at boot | All distances (subject to `NOTABLE_FADE_NEAR/FAR`) |
| **1 — named** | Has a catalog name AND (`mag < 6.0` OR `aug.system` present) | Lazy: anchor + label spawn when tile enters tier-1 range | Only when within `meta.labelTierVisibility["1"]` (~50 ly) |
| **2 — none** | No name or too faint | Rendered by the instanced mesh; no anchor, no label | Never has a label |

The `aug.system` exception in tier-1 ensures multi-star system
companions like Sirius B stay selectable.

See [labels.md](labels.md) for the rendering pipeline and collision system.

## Anchor / label split

Visuals come from the instanced mesh. Interaction comes from
`Object3D` anchors — one per labeled star (tier-0 + tier-1):

- `src/billboard.ts#createStarAnchor` — invisible `Object3D` with a
  custom `raycast` that intersects against a screen-space hit sphere.
- Labels are registered with the canvas label system for rendering —
  see [labels.md](labels.md).

Tier-0 anchors are spawned eagerly at boot from `notable.json`. Tier-1
anchors spawn when their containing tile's `.lbl.json` streams in and
despawn when it evicts.

## Hover affordance

`uHoveredPos` / `uHoveredActive` are shared uniforms. When the user
hovers a star, `interaction.ts#showHover` publishes its world position;
the shader matches the instance against that position and multiplies
`vIntensity` by `HOVER_BOOST = 1.6`. The disc's physical size stays
honest — only brightness bumps.

## Tile streaming

- Tiles are octree-spatialized. `bright` bucket is a single
  always-loaded file; `medium` bucket streams by distance.
- `precomputeTileSpheres` caches each tile's bounding sphere and
  bucket `cullDist` at init.
- Per-tile `opacityUniform` fades geometry in/out over `TILE_FADE_MS`
  (400 ms) on load/evict.
- **Distance fade**: `computeDistanceOpacity` multiplies a smooth
  1 → 0 ramp over the last `TILE_DIST_FADE_BAND = 20%` of `cullDist`.
- `qualityProfile.tileBudget` — LRU eviction by `lastUsed` timestamp.
  80 on desktop, 40 on mobile; each tile carries geometry + materials
  + tier-1 anchors + their canvas labels, so the smaller cap matches
  mobile texture-cache budgets.
- `tier1LoadDist` — radius beyond which tile labels (and their tier-1
  anchors / canvas labels) are despawned. Driven by
  `meta.labelTierVisibility["1"]`, multiplied by
  `qualityProfile.tier1LoadDistMult` (1.0 desktop / 0.8 mobile).
- `requestTileFocus(tile, i, onResolved)` flags a tile as `forced`
  (immune from frustum / distance culling and LRU eviction) and
  immediately kicks off `loadTile` + `loadTileLabels`. The callback
  fires once the target anchor exists. Used by `?focus=` URL restore
  and by search-panel selection of off-screen targets — the URL
  restore path awaits the callback before `startRenderLoop`, so the
  first painted frame already shows the focused star rather than a
  default-Sol view followed by a flyby.

## Startup / search index

`initCatalog` fetches `meta.json`, `notable.json`, `systems.json` in
parallel via `Promise.all`. `names.json` (~307 KB gzip — the global
search index) kicks off in the same tick but is *not* awaited, so
it doesn't gate first paint. Downstream consumers — constellation
init, planet position fixup, URL `?focus=` restore — call
`whenSearchIndexReady()` to await it.

## Star naming (in build-catalog.py)

Priority order:

1. **IAU proper name** — "Sirius", "Proxima Centauri", "Sol"
2. **Bayer + constellation** — "Alp CMa"
3. **Flamsteed + constellation** — "9 CMa"
4. **Gliese catalog** — "Gl 65A"
5. **Hipparcos** — "HIP 82724"
6. **Henry Draper** — "HD 265866"
7. **Harvard Revised** — "HR 2491"

Augmentations (keyed by Gliese / HIP / "Sol") can override the primary
name and attach Wikipedia links, notes, and system groupings.

## Per-target zoom floors

`setMinOrbitOverride(value)` sets a per-target orbit-radius floor:

- **Stars**: `computeStarMinOrbit(radius)` — disc fills 15% of the
  viewport height at maximum zoom.
- **Clusters / binaries**: max member distance from centroid × 1.5,
  with a 3-scene-unit minimum.
- **Nebulae**: fixed 15 scene units (~5 pc).
- **Black holes**: `DEEP_ZOOM_MIN_ORBIT = 1e-20`. BH rendering is pure
  screen-space, so precision holds to the Float32 floor.

## Bloom

`UnrealBloomPass` applies to the final image. Each star has exactly one
shader emitting its pixels (no stacking), so bloom bleeds from one
coherent HDR source.

Composer overscan (`BLOOM_OVERSCAN = 1.1`) widens the render target and
camera fov by the same factor; a combined crop + linear→sRGB pass takes
the center `1 / OVERSCAN` portion back to display. The crop pass sits
*before* lensing in the chain, so lensing distorts gamma-encoded sRGB
samples (correct) and operates in viewport-UV space without overscan
scaling. On mobile, bloom runs at half its input resolution
(`qualityProfile.bloomDiv = 2`), MSAA drops from 8× to 4×, and the
dust RT drops from half-res to quarter-res — see `docs/profiling.md`
for the mobile quality profile.

## Runtime artifacts

### `tile_<path>.lbl.json` (labels, lazy)

Sparse — only stars with tier 0 or tier 1 in this tile:

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

### `meta.json` (catalog manifest, eager)

```json
{
  "tileCount": 183,
  "totalStars": 1855430,
  "bytesPerStar": 20,
  "labelTierVisibility": { "0": 100000, "1": 150 },
  "tiles": { ... },
  "buckets": {
    "bright": { "cullDist": null },
    "medium": { "cullDist": 598 }
  }
}
```

### `notable.json` (eager, ~180 KB)

All tier-0 labels across the entire catalog. Loaded at boot so notable
labels appear before any tile streams in.

### `systems.json` (eager, ~5 KB)

Pre-computed system groupings. Members are referenced by `(tile, i)`.

## Building

```sh
git submodule update --init
cd vendor/athyg && git lfs pull --include="data/athyg_v33-*.csv.gz" && cd ../..
python3 scripts/fetch-hunt2023-astro.py
python3 scripts/build-catalog.py data/augmentations.json dist/tiles/ \
  vendor/athyg/data/athyg_v33-1.csv.gz vendor/athyg/data/athyg_v33-2.csv.gz
```

## References

- [AT-HYG Database](https://codeberg.org/astronexus/athyg) (CC-BY-SA 4.0)
- [Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3) — source for 97.5% of distances
- [Tanner Helland: Temperature to RGB](https://tannerhelland.com/2012/09/18/convert-temperature-rgb-algorithm-code.html)
- [tiffnix: Rendering Star Fields in 3D](https://tiffnix.com/star-rendering)
- [LearnOpenGL: Bloom](https://learnopengl.com/Advanced-Lighting/Bloom)
