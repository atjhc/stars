# Neutron Stars

## Overview

Drake renders nearby neutron stars and pulsars as selectable objects
with dedicated 3D billboards, bloom effects, and gravitational lensing
at close zoom. Neutron stars are defined in `data/neutronstars.json`
and rendered at runtime by `src/neutronstars.ts`.

The catalog includes the Magnificent Seven (nearby isolated neutron
stars discovered in X-rays) and several notable pulsars within 1 kpc.

## Data format

`data/neutronstars.json` is keyed by display name:

```json
{
  "RX J1856.5-3754": {
    "aliases": ["Nearest Neutron Star"],
    "kind": "ins",
    "ra": 284.1462,
    "dec": -37.9057,
    "dist_pc": 123,
    "mass_msun": 1.4,
    "radius_km": 12,
    "wikipedia": "...",
    "notes": "..."
  }
}
```

`kind` is either `"ins"` (isolated neutron star) or `"pulsar"`. At
build time, RA/Dec is converted to scene-space coordinates and written
as `scene_pos` into the runtime `dist/tiles/neutronstars.json`.

## 3D rendering

Each neutron star gets a billboard mesh — a camera-facing quad with a
custom shader that renders a limb-darkened disc. This is structurally
similar to the star shader but runs as a single mesh per NS rather than
an instanced draw.

### Billboard shader

The vertex shader uses target-relative view math (matching `stars.ts`)
for Float32 precision at deep zoom:

```glsl
vec3 camRelPos = uNSLocalTarget - uStarCameraOffset;
vec3 viewPos = uStarViewRotation * camRelPos;
```

`uNSLocalTarget` is computed on the CPU each frame as
`Float64(nsWorldPos - target)`, avoiding the large-number GPU
subtraction that would lose precision.

The fragment shader draws:

- A **limb-darkened disc** with a cool-blue color (saturated for INS,
  slightly warmer for pulsars). The limb-darkening coefficient (0.6)
  matches the star shader.
- A **core brighten** effect — the center is ~40% brighter than the
  limb, giving a natural hot-core appearance.
- A **soft disc edge** — ±1.5 px smoothstep so the border blends into
  the bloom halo rather than reading as a hard circle.

### Disc floor

Far away, the NS's physical size is sub-pixel. The shader floors the
disc at `DISC_FLOOR_PX = 1.2` so the bloom pass has something to
spread into a glow. This keeps distant NSes visible as faint dots of
light.

### Scene routing

Non-focused NSes live in the main `scene`. Their pixels appear in
`tDiffuse` when the lensing pass runs, so a focused NS's gravity
bends their light like any other background object.

The *focused* NS is moved into a separate `nsMarkerScene`, rendered
*after* the main composer. This prevents the lensing pass from bending
the NS's own body into an Einstein ring of itself.

### Bloom pipeline

The focused NS gets its own `EffectComposer` pipeline:

1. `RenderPass` renders `nsMarkerScene` (just the one focused NS mesh).
2. `UnrealBloomPass` (strength 0.8, radius 0.6, threshold 0) adds a
   soft glow — low strength and zero threshold so even the dimmest disc
   pixels get a subtle halo.
3. A fullscreen blit quad normal-blends the result over the main
   composer's on-screen output.

The bloom pipeline is lazily initialized on first NS selection to avoid
allocating render targets that may never be used.

### NormalBlending, not Additive

The NS billboard uses `NormalBlending` with `alpha = 1` inside the
disc. This ensures the opaque disc fully covers whatever the lensing
pass put in the body region. Additive blending would let
bent-background streaks show through inside the body — this was a
discovered anti-pattern during development.

## Gravitational lensing

When a neutron star is selected, the shared `lensingPass` in `scene.ts`
activates with mode `"bodyElsewhere"`. Unlike black holes (which draw
their shadow *inside* the lensing pass), NS lensing only bends the
background — the NS body is drawn separately by the billboard.

Lensing activates when:
- During transit: always (scales naturally with distance)
- At rest: only when in deep zoom and orbit radius < 10⁻⁶ scene units

### Departing lensing

Like black holes, a departing NS keeps requesting lensing during transit
so the effect fades naturally as the camera recedes.

## Labels

NS labels use a saturated cyan-teal color (`rgba(110,220,225,0.9)`)
with italic serif font to distinguish them from stars. The label
margin tracks the disc size plus bloom spread, dynamically updating
each frame as the camera distance changes.

Labels have distance-from-Sol opacity fade and participate in the
unified canvas label collision system.

## Deep zoom

Neutron stars use `DEEP_ZOOM_MIN_ORBIT = 1e-20`, the same as black
holes. The arrival orbit radius is computed so the disc fills ~15% of
the viewport. A 12 km radius NS at 123 pc has a scene radius of
~1.2×10⁻¹⁵ scene units — the exponential zoom handles this smoothly.

## Files

- `data/neutronstars.json` — source data
- `dist/tiles/neutronstars.json` — runtime data with baked scene coordinates
- `src/neutronstars.ts` — billboard mesh, bloom pipeline, labels, selection
- `src/scene.ts` — shared `lensingPass` and `requestLensing()` API
