# Star Rendering

## Overview

Every star — every tier, every LOD — is a single instance of a unit quad
drawn by one shader. The same formula covers sub-pixel points, resolved
discs with limb darkening, and glowing coronas. No point cloud, no
per-star billboard mesh, no post-bloom overlay.

The one exception is the *selected* star, which gets rendered a second
time by a screen-space overlay (clip-space, BH-lensing-pass style) so
its position is precision-exact at any zoom level — see the
[Selected-star overlay](#selected-star-overlay) section below.

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

## Architecture

```
Tile binary (20 bytes/star)
  ├── position (vec3, 12 B)
  ├── brightness byte (1 B)         ← absMag encoded linearly as (M+10)·10
  ├── color rgb (3 B)
  └── radius float32 (4 B)          ← physical radius in scene units

Per-tile mesh (InstancedBufferGeometry)
  ├── shared unit-quad geometry (4 verts, 2 tris)
  ├── instance attributes from the tile binary
  └── one ShaderMaterial with additive blending

Per-labeled-star anchor (Object3D)
  ├── position — star's scene coordinate
  ├── CSS2DObject child — the label
  └── custom raycast — screen-space hit sphere

Selected-star overlay (single Mesh in the main scene)
  ├── PlaneGeometry(1,1)
  └── screen-space shader; uniforms set per-frame from TS
```

The tile binary format is authoritative; the renderer and
`scripts/build-catalog.py` both reference the same 20-byte layout. The
manifest (`meta.json`) reports `bytesPerStar: 20`; the renderer logs a
loud error at startup if the format drifts. `notable.json` and
`names.json` store positions Float32-quantized
(`build-catalog.py#f32`) so anchors match tile instances bit-for-bit —
without this, labels jitter as the camera orbits far-from-origin stars.

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
absMag, camDist)` in `src/stars.ts`. The overlay driver
(`main.ts#updateStarDeepZoom`), label margin
(`starOcclusion.ts#getStarDiscPx`), and occluder
(`starOcclusion.ts#getStarVisualPx`) all call it so the CPU can't drift
from the shader. `HALO_FLOOR_PX` is similarly exported once from
`stars.ts` and injected into the GLSL template.

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
relPos     = instancePos − uStarTarget          // star in target frame
camRelPos  = relPos − uStarCameraOffset          // star relative to camera
viewPos    = uStarViewRotation · camRelPos       // rotate into view space
```

`uStarCameraOffset` is computed from the *unclamped* orbit radius and
orbit angles, not from the clamped `camera.position`. All subtractions
stay near zero, so Float32 precision holds even tens of AU from stars
hundreds of scene units from world origin (Betelgeuse, etc.).

## Selected-star overlay

A selected star is always at the orbit target, which is always at
screen center (the camera looks at the target). The instanced pass
*skips* that one instance (via `uSkipSelected` + `uStarTarget`
comparison) and a separate overlay mesh draws it in pure clip space:

```glsl
// overlay vertex shader — no world math at all.
viewPos = vec4(position.xy · worldScale · 2.0, -OVERLAY_DEPTH, 1.0);
gl_Position = projectionMatrix · viewPos;
```

Using `projectionMatrix` (rather than raw `gl_Position = NDC`) is
required: `beginBloomRender` widens `camera.fov` by `BLOOM_OVERSCAN =
1.2×` and the composer RT also widens 1.2×, and those factors only
cancel for geometry that goes through the projection matrix. A
raw-NDC output would render 1.2× too big on screen.

The overlay is immune to Float32 precision loss at any zoom level, for
any star's world position — this is the same trick the black-hole
lensing pass uses. Because it lives in the main scene, the composer's
bloom still picks up its HDR output and the corona's glare is
preserved.

## Anchor / label split

Visuals come from the instanced mesh. Interaction comes from
`Object3D` anchors — one per labeled star (tier-0 + tier-1):

- `src/billboard.ts#createStarAnchor` — invisible `Object3D` with a
  custom `raycast` that intersects against a screen-space hit sphere
  (`HIT_SCREEN_FRACTION` of the camera distance).
- `src/billboard.ts#createStarLabel` — a CSS2D label child attached to
  the anchor.

Tier-0 anchors are spawned eagerly at boot from `notable.json`. Tier-1
anchors spawn when their containing tile's `.lbl.json` streams in and
despawn when it evicts.

`starOcclusion.ts#getStarDiscPx` returns the shader's `discPx`
(physical disc radius) — the label margin pins to that. `getStarVisualPx`
returns `halfBillPx` (disc + corona) — used by the screen-space
occluder to hide background labels behind the bright star region.

## Hover affordance

`uHoveredPos` / `uHoveredActive` are shared uniforms. When the user
hovers a star, `interaction.ts#showHover` publishes its world position;
the shader matches the instance against that position and multiplies
`vIntensity` by `HOVER_BOOST = 1.6`. The disc's physical size stays
honest — only brightness bumps. Label glow (CSS `text-shadow`) is still
the primary affordance; the intensity bump complements it.

## Per-target zoom floors

`setMinOrbitOverride(value)` sets a per-target orbit-radius floor. The
value is the actual minimum — `applyZoom` clamps to it. Each selection
type computes its own appropriate floor:

- **Stars**: `computeStarMinOrbit(radius)` = `R · DISC_SCALE ·
  F_HALF_TAN_INV / 0.5` — disc fills half the viewport height at
  maximum zoom.
- **Clusters / binaries**: max member distance from centroid × 1.5, with
  a 3-scene-unit (≈1 pc) minimum so tight binaries still have a
  reasonable floor.
- **Nebulae**: fixed 15 scene units (≈5 pc). Nebulae are volumetric —
  closer zooms put the camera inside the dust cube with nothing
  interesting to see.
- **Black holes**: `DEEP_ZOOM_MIN_ORBIT = 1e-20`. BH rendering is pure
  screen-space (schwarzschild radius is a UV transform in
  `scene.ts#lensingPass`), so precision holds down to the Float32 floor
  and the user can zoom arbitrarily close to the event horizon.

`animateTo`'s default `toRadius` reads `getEffectiveMinOrbit()`, which
returns the current override (or `MIN_ORBIT_RADIUS` if none). Callers
must set the override *before* `animateTo` so the animation settles at
the new target's appropriate viewing distance.

## Tile streaming

- Tiles are octree-spatialized. `bright` bucket (M < 0) is a single
  always-loaded file; `medium` bucket streams by distance.
- `precomputeTileSpheres` caches each tile's bounding sphere and
  bucket `cullDist` at init. Per-frame tile iteration reads from this
  cache — no `meta.tiles[path]` / `meta.buckets[...]` hash lookups
  in the hot path.
- Per-tile `opacityUniform` fades geometry in/out over `TILE_FADE_MS`
  (400 ms) on load/evict.
- **Distance fade**: `computeDistanceOpacity` multiplies in a smooth
  1 → 0 ramp over the last `TILE_DIST_FADE_BAND = 20%` of `cullDist`.
  Tiles cross the cull boundary at opacity 0, so there's no hard pop
  on tile load/unload.
- `MAX_LOADED_TILES = 80` — LRU eviction by `lastUsed` timestamp
  keeps the active set bounded.

## Bloom

`UnrealBloomPass` applies to the final image. Since each star has
exactly one shader emitting its pixels (no stacking of point cloud +
billboard + overlay), bloom bleeds from one coherent HDR source. Disc
intensity stays near LDR saturation so the disc edge stays crisp; the
corona's apparent-mag-driven intensity can go well above 1 and
produces the bright bleeding halo that reads as "star glare."

Composer overscan (`BLOOM_OVERSCAN = 1.2`) widens the render target
and camera fov by the same factor so bloom blur samples have valid
data past the visible viewport edge; a final crop pass takes the
center `1 / OVERSCAN` portion back to display. The instanced shader
and selected-star overlay both render through `projectionMatrix`, so
the widening self-compensates automatically.

## References

- [Tanner Helland: Temperature to RGB](https://tannerhelland.com/2012/09/18/convert-temperature-rgb-algorithm-code.html)
- [tiffnix: Rendering Star Fields in 3D](https://tiffnix.com/star-rendering)
- [LearnOpenGL: Bloom](https://learnopengl.com/Advanced-Lighting/Bloom)
