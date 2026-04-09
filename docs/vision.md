# Long-term vision: full-scale-range star viewer

## The goal

Drake should eventually support seamless zoom across **the full scale range** of stellar visualization:

- **In**: an individual star system, with a detailed Sol-system view as the
  flagship case (planets, orbits, the Sun's surface, scale of the inner and
  outer system).
- **Out**: the entire Milky Way galaxy, with arms, bulge, halo, satellite
  galaxies — looking the way the Milky Way is *expected* to look, not just
  the way the catalog data lets us draw it.

The current viewer covers a single slice of this range: roughly 1 ly to 1 kpc,
with stars treated as point + billboard glow with no internal structure and
no extragalactic context.

## Why this is hard

Each scale jump is roughly **10³–10⁴×** in linear size, and at every jump the
rendering, data, and interaction model that worked at the previous scale
fall apart:

| Scale | Linear range | Dominant primitive | Dominant data source |
|---|---|---|---|
| Planetary surface | km – 10⁵ km | Textured meshes, terrain | Mission data, hand authored |
| Orbital | 10⁶ – 10¹⁰ km | Planet meshes + orbit lines | JPL ephemerides |
| Stellar system | 10⁻³ – 1 ly | Single star + planet positions | Exoplanet archive, NASA |
| Solar neighborhood | 1 – 10² ly | Billboards + point cloud | **Current scope (AT-HYG)** |
| Local interstellar | 10² – 10³ ly | Point cloud only | AT-HYG |
| Disc / arm | 10³ – 10⁴ ly | Sparse Gaia + procedural fill | Gaia DR3 partial |
| Galaxy | 10⁴ – 10⁵ ly | Procedural arms, bulge, dust | All procedural |

A single coordinate system, single camera projection, and single rendering
technique cannot span all these scales — for the inner ones, IEEE 754 float
precision runs out around 10⁷ m from the origin; for the outer ones, the
catalog is empty.

## What "support this" probably means

A non-exhaustive list of pieces this would require:

### LOD camera and coordinate system

- **Floating origin**: re-center scene coordinates on the camera target so
  precision is always best where the user is looking. Already a known pattern
  for space sims (Outerra, Kerbal Space Program scaled space).
- **Logarithmic depth buffer or split-frustum rendering**: lets a single
  camera see both a 1 m crater and a 10⁹ m planet without z-fighting. Three.js
  has `logarithmicDepthBuffer`, which is a starting point but not sufficient
  for true planetary scale.
- **Scale tiers**: distinct "sub-scenes" for surface / orbital / system /
  neighborhood / galaxy that the camera transitions between, each with its own
  origin, units, and culling. The camera animation crosses tiers smoothly.

### New rendering pipelines

- **Planet rendering**: oblate ellipsoid with proper tessellation, atmosphere
  scattering shader, day/night terminator, surface texture LOD (probably
  quadtree on the cube-sphere), city lights, terrain heightmaps where we
  have them (Mars, Moon).
- **Orbits**: ellipses parameterized by Keplerian elements, animated bodies
  along them, optional time controls.
- **Stellar surface**: limb-darkened disc, granulation noise, flares for
  active stars, accurate angular diameter so e.g. Betelgeuse looks huge next
  to Sirius.
- **Galactic structure**: density-wave spiral arms, dust lanes, bulge as a
  triaxial bar, halo as a thick sparse cloud, all driven by an SED-aware
  shader so the Milky Way "looks right" against an actual external view.
- **Compact objects (black holes, neutron stars)**: a dedicated sub-scene
  per target that ray-marches null geodesics through a Schwarzschild (or
  Kerr) metric in a GLSL fragment shader, sampling a cubemap captured from
  the object's position. Produces real gravitational lensing, photon ring,
  Einstein ring, and — with an added procedural emission model — a
  Doppler-beamed accretion disk. This is the same sub-scene coordinate
  problem planets have (a stellar-mass event horizon is ~10⁻¹⁸ pc, 18
  orders of magnitude below neighborhood pixel scale) so it can't be a
  shader pass in the main scene; it has to be its own scale tier, entered
  on selection. See "Compact-object rendering" below for more detail.

### Procedural fill

The catalog only has stars Gaia could measure parallaxes for — about 1.5 % of
the ~100–400 billion stars in the galaxy. To make the galaxy look full, we'd
need to generate the rest:

- **Density-following point sampling** matching the observed luminosity
  function and arm/bulge density model.
- **Spectral type sampling** by initial mass function so the procedural stars
  have realistic color/brightness distribution.
- **Determinism**: each procedural star should have a stable (seed → ID)
  mapping so revisiting a region shows the same stars.
- **Hand-off zone**: where catalog data ends (~3 kpc with current scope, ~10
  kpc if we extend), procedural stars should blend in without a visible
  density seam.
- **No false labels**: procedural stars must be visually indistinguishable
  but explicitly *not* nameable / selectable / searchable, since they don't
  represent specific real objects.

### Data acquisition

- **Solar System**: NASA SPICE / Horizons for ephemerides; planetary texture
  archives for the bodies themselves.
- **Exoplanets**: NASA Exoplanet Archive — already has confirmed planet
  parameters for the systems we'd render in detail.
- **Extended Gaia**: full Gaia DR3 source catalog (~1.8 billion stars) is
  ~600 GB and would need server-side tiling, or selective import beyond the
  current 1 kpc cutoff.
- **Galactic dust**: Lallement / Vergely 3D extinction maps to make the
  Milky Way's dark lanes visible from outside.

### Interaction and UX

- **Scale-aware navigation**: pinch / scroll should zoom by ratio, not by
  fixed delta, so 10 kpc → 10 km feels continuous instead of taking a
  thousand wheel ticks.
- **Selection persistence across scales**: selecting a star at neighborhood
  scale should let you smoothly fly down to its planets without losing the
  selection.
- **Progressive disclosure**: detail panel content depends on scale — at
  galaxy scale a star shows "K2V dwarf"; at system scale it shows planets;
  at planet scale it shows surface features.
- **Time controls**: at orbital and surface scales, time is meaningful;
  proper-motion-accurate playback at neighborhood scale would let users see
  Barnard's Star drift.

## Where today's architecture helps and hurts

**Helps:**
- The tile streaming model already separates "data we ship" from "data we
  render". Adding more scales = adding more tile types, not redoing the
  rendering loop.
- The tier-based label system already decouples classification from
  rendering, so introducing new tiers ("planet", "spacecraft", "procedural")
  is additive rather than rewrites.
- The augmentations.json + curate workflow scales naturally to new entity
  types.
- `catalog.ts` is already a layered loader with eager + lazy paths. New
  layers (planets, galactic structure) can plug in alongside.

**Hurts / would need replacement:**
- Single Three.js scene, single camera, single near/far frustum. Would need
  a multi-scene architecture or a custom render pass per scale tier.
- Scene-space coordinates pinned to a fixed origin (Sol). Floating origin
  is invasive — every position-using subsystem (raycast, labels, system
  centroids) would need to consume a "current origin" instead of world-space.
- Billboard shader is hardcoded for "all stars look about the same". Star
  surface rendering is a wholly different shader.
- The point cloud's `gl_PointSize` clamp [4, 16] is a stopgap for sub-pixel
  flicker; at galactic scale we'd want true GPU-friendly density rendering
  (e.g. an instanced impostor pass per density tile, or a stylized arm-glow
  shader rather than per-star points).

## Pragmatic path forward (if attempted)

The natural staged sequence, biggest payoff first:

1. **Sol-system detail mode** as a separate sub-scene the camera transitions
   into when selecting Sol (or any star with planet data). Reuses Three.js
   but with new geometry and a new camera. This is the dogfooded use case
   and the first place LOD discipline gets enforced.
2. **Floating origin** retrofit to the existing neighborhood scene. Once
   this exists, the planetary sub-scene can render in real-world meters
   without dragging the rest of the viewer's precision down.
3. **Procedural galactic background** as a static "skybox-like" layer
   first — a textured/shader-driven Milky Way disc visible from all angles
   inside the neighborhood scene. No interactivity, just context.
4. **Galaxy zoom-out tier**: extend the camera's outer range, swap the
   neighborhood point cloud for an arm-density shader past some distance.
   Procedural stars appear as a *visual* layer with no individual identity.
5. **Stellar system tier for non-Sol systems**: for stars with confirmed
   exoplanets in the NASA archive, render a basic orbital diagram on
   selection.
6. **Planet surface rendering**: ambitious. Probably needs its own engine
   layer or a second renderer entirely.

None of this is on the current roadmap; this document exists so future
sessions remember the destination when making short-term architectural
decisions, and so we don't paint ourselves into corners that would block
the eventual sub-scene / floating-origin retrofit.

## Compact-object rendering (black holes, neutron stars)

Drake's catalog radius contains a handful of confirmed stellar-mass black
holes — Gaia BH1 (~480 pc), Gaia BH3 (~590 pc), A0620-00 (~1,000 pc) —
and the neutron-star population is considerably larger. These deserve a
dedicated rendering tier because gravitational lensing is the one
visualization where general relativity is actually *visible* instead of
just a footnote.

### Rendering approach

The state of the art for real-time GR visualization is per-pixel geodesic
ray tracing in a fragment shader. SpaceEngine's implementation (see
https://spaceengine.org/articles/visualizing-general-relativity/) uses a
Hamiltonian formulation that avoids computing all 64 Christoffel symbols
— you only need 4 gradient components of `H = ½·gⁱʲ·pᵢpⱼ`, obtained by
numerical differentiation of the metric tensor function:

```
dp_i/dτ = -∂H/∂x^i
dx^i/dτ =  g^ij · p_j
```

Ray initialization for null geodesics: `p = Metric(x) · vec4(1, normalize(dir))`.
Typical cost ~256 integration steps per pixel with adaptive timestep
proportional to local curvature. The metric is pluggable: Schwarzschild is
5 lines, Kerr-Newman in Kerr-Schild coordinates is ~20. Reference
implementation: https://github.com/The-Order-of-the-Simulation/SpaceTimePathTracer.

### Why it needs a sub-scene

A ~10 M☉ stellar black hole has an event horizon of ~30 km ≈ 10⁻¹⁸ pc. At
Drake's neighborhood scale (SCALE = 3 units/pc), every BH is more than 15
orders of magnitude below one pixel — there's literally no geometry to
render *at* its catalog position in the main scene. Entering the object
has to transition the camera into a local coordinate frame where the
event horizon is a few scene units and the external neighborhood is
compressed onto a captured environment map.

This is structurally the same sub-scene problem planets have, and the
solutions line up:

- Floating origin centered on the compact object.
- Transition animation from main-scene scale into local scale.
- A background environment captured on entry (either a one-time cubemap
  snapshotted from the BH's position, or — if the user moves inside the
  sub-scene — a per-frame re-render of the distant starfield into the 6
  cubemap faces).
- On exit, reverse the transition.

### Background sampling strategies (trade-offs)

1. **Static cubemap captured on entry** — simplest. Render the neighborhood
   point cloud once into a cubemap from the BH's position, never update.
   Camera can orbit the BH inside the sub-scene; lensing samples the
   cubemap. Fails to update parallax if the user moves off the BH's
   position, but that can be prevented UX-wise (orbit only).
2. **Per-frame cubemap refresh** — 6× the cost of the main scene's star
   render, but handles arbitrary camera motion in the sub-scene. Mobile
   would probably cap this.
3. **Ray-trace directly against the catalog** — not viable for 1.8 M
   points per ray.

Start with (1).

### Minimum viable BH mode

1. **Catalog entries** for the known nearby compact objects (Gaia BH1,
   Gaia BH3, A0620-00, some neutron stars from ATNF or similar). They
   live alongside stars in `notable.json` with a `kind: "blackhole"` or
   `kind: "neutron_star"` discriminator.
2. **Clickable marker** at the catalog position using an existing
   billboard + special shader (glow with a dark core and photon ring
   stylized, no real lensing) so the object is visible and selectable
   at neighborhood scale.
3. **Sub-scene entry on selection**: camera fade, mode switch, capture
   the cubemap, instantiate the geodesic shader on a screen-filling quad
   (or better, a bounding sphere mesh).
4. **Schwarzschild integrator** as the first metric. Accretion disk
   optional but cheap to add as a procedural texture sampled when the
   ray crosses the equatorial plane inside some r_max.
5. **Exit affordance**: ESC or "back" button restores the main scene.

### Performance sanity check

A screen-space Schwarzschild integrator at 1080p over a 400 × 400 pixel
bounding region is ~160k pixels × 256 steps = ~40M integration steps per
frame. A modern desktop GPU does this comfortably; mobile may need 128
steps or a Newtonian-approximation fast path (see the Starless reference
linked from the SpaceEngine article).

### Why this fits the sub-scene work already on the list

The blocker for BH rendering isn't the integrator — it's the coordinate
frame, camera transition, and environment capture, which are exactly the
pieces needed for the Sol-system and per-star-system tiers above. Done in
that order, BH rendering falls out as one more sub-scene consumer of the
LOD infrastructure, not a separate system.
