# Black Holes

## Overview

Drake renders stellar-mass black holes as selectable objects with
gravitational lensing effects at close zoom. Black holes are defined in
`data/blackholes.json` and rendered at runtime by `src/blackholes.ts`.

There are currently 5 black holes in the catalog, all discovered via
Gaia astrometry:

| Name | Distance | Mass | Notes |
|---|---|---|---|
| Gaia BH1 | 480 pc | 9.62 M☉ | Nearest known BH to Sol |
| Gaia BH3 | 590 pc | 32.7 M☉ | Most massive stellar-mass BH in the Milky Way |
| Gaia BH2 | 1160 pc | 8.9 M☉ | Wide-orbit system |
| A0620-00 | 1060 pc | 6.6 M☉ | Classic X-ray nova |
| V616 Mon | 1060 pc | 6.6 M☉ | A0620-00 companion designation |

## Data format

`data/blackholes.json` is keyed by display name:

```json
{
  "Gaia BH1": {
    "aliases": ["Nearest Black Hole"],
    "ra": 262.171,
    "dec": -0.581,
    "dist_pc": 480,
    "mass_msun": 9.62,
    "wikipedia": "https://en.wikipedia.org/wiki/Gaia_BH1",
    "notes": "..."
  }
}
```

At build time, `build-catalog.py` converts RA/Dec to scene-space
coordinates and writes `scene_pos` into the runtime
`dist/tiles/blackholes.json`.

## Rendering

Black holes have no visible geometry of their own — they are invisible
objects whose only visual effect is gravitational lensing of background
starlight. At neighborhood scale they are represented by a label only.

### Gravitational lensing

When a black hole is selected and the camera zooms close, the
`lensingPass` shader in `scene.ts` activates. This is a screen-space
post-process that bends the background starfield around the black hole's
position:

1. The BH handler calls `requestLensing()` each frame with the BH's
   position, shadow radius (2.6 × Schwarzschild radius), mass, and
   camera distance.
2. The lensing pass computes a deflection angle per pixel based on the
   Schwarzschild metric, then samples the pre-lensing scene at the
   deflected UV.
3. Inside the photon sphere, the BH draws a solid black shadow — this
   *is* the BH's visual representation.

The photon-ring factor `BH_SHADOW_TO_RS = 2.6` accounts for the fact
that a distant observer sees a BH shadow ~2.6× the event horizon
radius due to gravitational lensing of the event-horizon edge through
the photon sphere.

### Schwarzschild radius

```
rs = RS_KM_PER_MSUN × mass_msun  (in km)
rs_scene = (rs / KM_PER_PC) × SCALE  (in scene units)
shadow_radius = 2.6 × rs_scene
```

A 10 M☉ BH has an event horizon of ~30 km ≈ 10⁻¹⁸ pc — far below
any pixel at neighborhood scale. The lensing effect is what makes BHs
visible, not any geometric rendering.

### Deep zoom

Black holes use `DEEP_ZOOM_MIN_ORBIT = 1e-20`, allowing the camera to
zoom arbitrarily close to the event horizon. The lensing pass is pure
screen-space (a UV transform, no world-space position subtraction), so
Float32 precision holds at any zoom level.

The arrival orbit radius is computed so the shadow disc fills ~15% of
the viewport.

### Departing lensing

When the user selects a new target while a BH is focused, the BH
handler keeps requesting lensing for the departing BH during the
transit animation. This lets the lensing effect fade naturally as the
camera recedes rather than popping off instantly.

## Labels

BH labels use a purple color scheme (`rgba(180,140,220,0.85)`) to
distinguish them from stars, clusters, and nebulae. They are registered
with the canvas label system via `registerCanvasLabel` and participate
in the unified collision, hover, and selection system.

Labels have distance-from-Sol opacity fade — nearer BHs display at
full opacity, farther ones dim proportionally.

## Selection and interaction

Selection is handled through the `LabelTypeHandler` interface
registered with `labelRegistry.ts`. Selecting a BH:

1. Clears any prior BH selection (keeping it as a departing lensing
   source if mid-transit).
2. Sets `DEEP_ZOOM_MIN_ORBIT` as the orbit floor.
3. Animates to the BH position with an arrival distance where the
   shadow fills ~15% of the viewport.
4. Shows the detail panel with distance, mass, type, notes, and
   Wikipedia link.

## Files

- `data/blackholes.json` — source data
- `dist/tiles/blackholes.json` — runtime data with baked scene coordinates
- `src/blackholes.ts` — labels, selection, hover, lensing requests
- `src/scene.ts` — `lensingPass` shader and `requestLensing()` API
