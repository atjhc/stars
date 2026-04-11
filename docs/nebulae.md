# Nebula & Interstellar Medium Rendering

## Overview

Drake renders the local interstellar medium as a 3D volumetric dust
density field with hot-star illumination, producing physically motivated
emission colors. Named molecular clouds are labeled at the positions of
their brightest emission peaks. The dust data is scientifically measured;
the illumination is simulated from known star positions using real physics.

## Scientific accuracy breakdown

### Scientifically measured (ground truth)

- **3D dust density** — Lallement/Vergely (2022), derived from Gaia
  stellar parallaxes and photometric reddening. The dust IS where the
  data says it is.
- **Star positions, spectral types, luminosities** — AT-HYG / Gaia DR3.
  We know which stars are hot enough to ionize hydrogen or scatter light.

### Physics-based simulation (from measured inputs)

- **Hot-star illumination** — at build time, for each dust voxel,
  UV flux from all O and B type stars (9,139 in the catalog) is
  accumulated using 1/r² falloff with a 150 pc max range. This
  classifies each voxel as:
  - **HII** (ionized by O or early-B stars, T > 25,000 K) → red/pink
  - **Reflection** (scattered by late-B stars) → blue
  - **Dark** (no nearby hot star) → no emission
- The illumination is baked into a 4-channel 3D texture (RGBA: density,
  ionizing flux, scattering flux, padding) at build time.

### Artistic choices

- Emission intensity scaling (the `uOpacity` multiplier) is tuned for
  visual appeal, not calibrated to physical surface brightness.
- The two-color model (Hα red + Rayleigh blue) omits OIII green, SII,
  and NII emission lines that produce more nuanced real nebula colors.
- No radiative transfer through intervening dust (self-shielding).

## Current state

### What renders

12 illuminated molecular clouds are labeled and visible when toggled
with the **D key**:

| Cloud | Distance | Illumination | Notes |
|---|---|---|---|
| Taurus Molecular Cloud | ~184 pc | HII + reflection | Nearest star-forming region |
| Cepheus-Cassiopeia Cloud | ~338 pc | HII + reflection | Local Bubble boundary |
| Taurus-Perseus Cloud | ~356 pc | Reflection dominant | Between Taurus and Perseus |
| California Molecular Cloud | ~446 pc | HII + reflection | Massive, rivals Orion |
| Cepheus Flare | ~450 pc | Weak HII | Low-mass star formation |
| Orion Molecular Cloud | ~501 pc | Strong HII | Contains M42, Horsehead, Trapezium |
| Cepheus OB3 Cloud | ~770 pc | HII + reflection | Sequential star formation |
| Cassiopeia Cloud | ~727 pc | HII + reflection | Near Perseus Arm |
| Vela Molecular Ridge | ~872 pc | HII + reflection | Extensive southern complex |
| Vela Cloud | ~750 pc | HII + reflection | Associated with Vela OB2 |
| Canis Major Cloud | ~832 pc | HII + reflection | Associated with CMa OB1 |
| Camelopardalis Cloud | ~918 pc | HII + reflection | Outer Local Arm |

### What doesn't render (tabled)

11 dark nebulae (Aquila Rift, Cygnus Rift, Scutum Cloud, etc.) are
identified in the data but not rendered. These are galaxy-scale
structures (1000-2000 ly across) that require:
- Depth-aware extinction compositing (only darken stars behind the dust)
- Galaxy-scale camera zoom (beyond current 1000 ly max)

A depth pre-pass pipeline exists in the code (`renderStarDepth` in
`dust.ts`) but is not active for emission-only rendering.

### Rendering pipeline

1. **Build time** (`data/dust/`):
   - Download Lallement/Vergely FITS cube from VizieR
   - Extract ±1000 pc sub-cube, threshold at 95th percentile
   - Compute hot-star illumination (O/B type UV flux per voxel)
   - Bake into RGBA uint8 binary: R=density, G=ionizing, B=scattering

2. **Runtime** (`src/dust.ts`):
   - Load 12.5 MB RGBA `Data3DTexture` (201×201×81)
   - Render via fragment shader on BackSide box mesh in separate scene
   - Ray march 128 steps × 18 scene units (~6 pc) from camera
   - Accumulate emission weighted by ionizing/scattering flux channels
   - Additive blending post-bloom

3. **Labels** (`src/nebulaeLabels.ts`):
   - CSS2DObject labels at emission-weighted centroids
   - Orange styling, Sol-distance opacity fade
   - Registered with `labelRegistry.ts` for unified click/hover/search
   - Toggle with D key alongside dust volume

### Performance

- 3D texture: 12.5 MB GPU memory
- Ray march: 128 steps per pixel, two full-screen passes (extinction
  disabled, emission active). GPU-bound on fragment shader.
- Depth pre-pass: renders pointsGroup with depth-only material (cheap,
  currently only used when extinction is enabled)
- Max orbit radius: 1000 scene units (~330 pc = 1076 ly)

### Associated star clusters

Three Orion-region clusters added alongside the Orion Molecular Cloud:
- **Collinder 69** (Lambda Orionis) — 753 Gaia members, ~394 pc
- **NGC 1980** (Iota Orionis / Hatysa cluster) — 364 members, ~378 pc
- **Sigma Orionis Cluster** — 181 members, ~396 pc

Total: 25 open clusters with Gaia DR3 membership.

## Available 3D dust datasets

### Lallement / Vergely (2022) — current

| Property | Value |
|---|---|
| Paper | Lallement, Vergely & Cox, A&A 661, A147 (2022) |
| Coverage | 3 kpc in-plane, 400 pc above/below |
| Resolution | 10 pc isotropic voxels |
| Grid | 601 × 601 × 81 (sub-cube: 201 × 201 × 81) |
| Format | FITS cube → RGBA uint8 binary for WebGL |
| Download | [CDS VizieR J/A+A/661/A147](https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/661/A147) |
| License | CC-BY 4.0 |

### Edenhofer et al. (2024) — planned upgrade

| Property | Value |
|---|---|
| Paper | Edenhofer et al., A&A 685, A82 (2024) |
| Resolution | ~0.4 pc (nearby) to ~7 pc (at 1250 pc) |
| Download | [Zenodo 8187943](https://zenodo.org/records/8187943) |

10× resolution improvement. Would resolve cloud cores, filaments, and
edges that are blurred at the current 10 pc scale.

## Planned improvements

### Dark cloud rendering

Requires depth-aware extinction compositing — only darken screen pixels
whose stars are behind the dust. Infrastructure exists (`renderStarDepth`,
depth pre-pass, `uStarDepth` uniform) but visual quality needs work:
- Galaxy-scale structures (Aquila/Cygnus Rift) need larger zoom range
- Need to distinguish compact dark nebulae (Horsehead) from diffuse ISM

### Higher resolution (Edenhofer 2024)

Sample onto 512³ or 1024³ grid for ~1-4 pc resolution. Re-run hot-star
illumination. Would make clouds look like recognizable shapes instead
of amorphous blobs.

### Planetary nebulae

Too small for dust maps (~0.3-1 pc). Published 3D models from Doppler
velocity mapping exist for Ring and Helix nebulae. Would need per-object
volumetric rendering (see `docs/vision.md` sub-scene concept).

## References

- [Lallement/Vergely 2022](https://www.aanda.org/articles/aa/full_html/2022/05/aa42846-21/aa42846-21.html)
- [Edenhofer et al. 2024](https://www.aanda.org/articles/aa/full_html/2024/05/aa47628-23/aa47628-23.html)
- [Leike et al. 2020](https://www.aanda.org/articles/aa/full_html/2020/07/aa38169-20/aa38169-20.html)
- [`dustmaps` Python package](https://dustmaps.readthedocs.io/)
- [Will Usher: WebGL Volume Rendering](https://www.willusher.io/webgl/2019/01/13/volume-rendering-with-webgl/)
- [Galactic Cartography Portal](https://galactic-cartography-portal.flute.hpccloud.mpg.de/)
