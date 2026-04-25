# Long-term vision: full-scale-range star viewer

## The goal

Drake should eventually support seamless zoom across **the full scale
range** of stellar visualization:

- **In**: an individual star system, with a detailed Sol-system view as
  the flagship case (planets, orbits, the Sun's surface).
- **Out**: the entire Milky Way galaxy, with arms, bulge, halo, and
  satellite galaxies.

The current viewer covers a single slice of this range: roughly 1 ly to
1 kpc.

## Why this is hard

Each scale jump is roughly **10³–10⁴×** in linear size, and at every
jump the rendering, data, and interaction model break:

| Scale | Linear range | Dominant primitive | Dominant data source |
|---|---|---|---|
| Planetary surface | km – 10⁵ km | Textured meshes, terrain | Mission data, hand authored |
| Orbital | 10⁶ – 10¹⁰ km | Planet meshes + orbit lines | JPL ephemerides |
| Stellar system | 10⁻³ – 1 ly | Single star + planet positions | Exoplanet archive |
| Solar neighborhood | 1 – 10² ly | Billboards + point cloud | **Current scope (AT-HYG)** |
| Local interstellar | 10² – 10³ ly | Point cloud only | AT-HYG |
| Disc / arm | 10³ – 10⁴ ly | Sparse Gaia + procedural fill | Gaia DR3 partial |
| Galaxy | 10⁴ – 10⁵ ly | Procedural arms, bulge, dust | All procedural |

## What "support this" probably means

### New rendering pipelines

- **Planet rendering**: oblate ellipsoid, atmosphere scattering,
  day/night terminator, surface texture LOD, terrain heightmaps.
- **Orbits**: Keplerian ellipses, animated bodies, time controls.
- **Galactic structure**: density-wave spiral arms, dust lanes, bulge
  as a triaxial bar, halo.

### Procedural fill

The catalog covers ~1.5% of the galaxy's stars. To make the galaxy look
full:

- **Density-following point sampling** matching the observed luminosity
  function and arm/bulge density model.
- **Spectral type sampling** by initial mass function.
- **Determinism**: stable seed → ID mapping.
- **Hand-off zone**: where catalog data ends, procedural stars blend in.
- **No false labels**: procedural stars are not nameable or searchable.

### Data acquisition

- **Solar System**: NASA SPICE / Horizons for ephemerides.
- **Exoplanets**: NASA Exoplanet Archive.
- **Extended Gaia**: full DR3 (~1.8B stars, ~600 GB) would need
  server-side tiling.

### Interaction and UX

- **Scale-aware navigation**: zoom by ratio, not by fixed delta.
- **Selection persistence across scales**.
- **Progressive disclosure**: detail depends on current scale.
- **Time controls**: proper-motion playback, orbital animation.

## Where today's architecture helps and hurts

**Helps:**
- Tile streaming separates "data we ship" from "data we render."
- Label tier system decouples classification from rendering.
- `catalog.ts` is a layered loader with eager + lazy paths.

**Hurts / would need replacement:**
- Single Three.js scene, single camera, single near/far frustum. Would
  need a multi-scene architecture per scale tier.
- Billboard shader hardcoded for "all stars look about the same."
- Scene coordinates pinned to a fixed origin (Sol) — though the
  per-tile floating origin now handles deep zoom within the current
  range.

## Pragmatic path forward (if attempted)

1. **Sol-system detail mode** as a separate sub-scene on star selection.
2. **Procedural galactic background** as a static shader-driven Milky
   Way disc visible from all angles.
3. **Galaxy zoom-out tier**: extend the camera's outer range, swap the
   point cloud for an arm-density shader past some distance.
4. **Stellar system tier for non-Sol systems**: for stars with confirmed
   exoplanets, render a basic orbital diagram on selection.
5. **Planet surface rendering**: ambitious, probably needs its own
   engine layer.

None of this is on the current roadmap; this document exists so future
sessions don't paint themselves into corners that would block eventual
sub-scene or LOD-tier retrofits.
