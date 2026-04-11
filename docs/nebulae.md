# Nebula & Interstellar Medium Rendering

## Overview

Rather than rendering individual nebulae as hand-authored assets, Drake
can render the **entire interstellar medium** as a scientifically-measured
3D dust density field. Gaia-era surveys have produced parsec-resolution
3D extinction maps of the local ISM out to ~1250 pc — covering our full
catalog volume. Individual named nebulae (Orion, Horsehead, Coal Sack)
emerge naturally as high-density or high-extinction features within this
volume, with labels placed at their known positions.

This approach is:
- **Scientifically accurate** — real measured extinction densities, not
  fabricated 3D shapes.
- **Comprehensive** — every molecular cloud, dust lane, and cavity in the
  local volume appears, not just the famous named ones.
- **Honest** — we show what's actually measured rather than inventing
  3D structure we don't know.

## Available 3D dust datasets

### Edenhofer et al. (2024) — recommended primary

The most recent and highest-resolution 3D dust map for our volume.

| Property | Value |
|---|---|
| Paper | Edenhofer et al., A&A 685, A82 (2024) |
| Coverage | 69 pc to 1250 pc from Sol (full sky) |
| Resolution | ~0.4 pc (nearby) to ~7 pc (at 1250 pc) |
| Format | FITS (HEALPix native + pre-interpolated Cartesian grid) |
| Cartesian file | `mean_and_std_xyz.fits` — 15.7 GB |
| Coordinates | Heliocentric Galactic Cartesian |
| License | CC-BY 4.0 |
| Download | [Zenodo 8187943](https://zenodo.org/records/8187943) |
| Python API | `dustmaps` package (`dustmaps.edenhofer2024`) |

Clearly resolves: Taurus molecular cloud, Ophiuchus cloud complex,
Scorpius-Centaurus association, Orion molecular cloud, Chamaeleon,
Lupus, Perseus molecular cloud.

**Caveat:** 69 pc inner hole — no data within ~69 pc of Sol. The Local
Bubble interior is unmapped.

### Leike et al. (2020) — fill the inner hole

| Property | Value |
|---|---|
| Paper | Leike et al., A&A 639, A138 (2020) |
| Coverage | 370 pc radius from Sol |
| Resolution | 1 pc isotropic voxels |
| Grid | 740 × 740 × 540 = ~296 M voxels |
| Format | HDF5 on [Zenodo 3993082](https://zenodo.org/records/3993082) |
| Coordinates | Heliocentric Galactic Cartesian |

Best for the inner 370 pc at 1 pc resolution. Overlaps with Edenhofer
from 69–370 pc where the two can be blended.

### Lallement / Vergely (2022) — simpler alternative

| Property | Value |
|---|---|
| Paper | Lallement, Vergely & Cox, A&A 661, A147 (2022) |
| Coverage | 3 kpc in-plane, 400 pc above/below |
| Resolution | 5 pc isotropic voxels |
| Grid | 1200 × 1200 × 160 regular Cartesian |
| Format | Single FITS cube (`cube_ext.fits`) |
| Download | [CDS VizieR J/A+A/661/A147](https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/661/A147) |
| License | CC-BY 4.0 |

Simplest plug-and-play option — a regular Cartesian grid that maps
directly to a WebGL 3D texture. Lower resolution than Edenhofer but
covers a much larger volume and has no inner hole.

### Zucker / Pelgrims (2022) — Local Bubble surface

| Property | Value |
|---|---|
| Paper | Zucker et al., Nature 601, 334 (2022) |
| Data | 3D surface of the Local Bubble inner wall |
| Format | Spherical harmonic expansion coefficients |
| Download | [Harvard Dataverse DOI:10.7910/DVN/RHPVNC](https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/RHPVNC) |

Not a density field — a surface/shell model. Could render the Local
Bubble boundary as a translucent mesh, complementing the volumetric dust.

## Rendering approach: volumetric ray marching

### Pipeline

1. **Build time**: sample the dust map onto a regular 3D Cartesian grid
   (e.g., 512³ covering 1000 pc radius at ~4 pc/voxel). Export as raw
   float16 or uint8 normalized binary (~256 MB or ~134 MB).

2. **Runtime**: load as a `THREE.Data3DTexture`. Render via a custom
   fragment shader on a scene-filling bounding box mesh:
   - Cast a ray from the camera through each pixel.
   - Step through the 3D texture, accumulating opacity and emission
     color based on the dust density at each sample point.
   - Composite over the existing star field (rendered to a framebuffer
     first).

3. **Color mapping**: dust density → visual appearance. Options:
   - **Extinction only** (subtractive): high-density regions darken
     background stars. Gives dark nebulae (Coal Sack, Horsehead) for
     free. Scientifically straightforward.
   - **Emission** (additive): map density to a warm glow where the dust
     is illuminated by nearby hot stars. More visually striking but
     requires knowing which stars illuminate which gas.
   - **Combined**: extinction everywhere, emission only near known HII
     regions / illuminating stars. Most realistic.

### Performance

A 512³ 3D texture fits in ~256 MB GPU memory (float16) or ~134 MB
(uint8). Ray marching with 64–128 steps per pixel at 1080p is
well within budget for desktop GPUs. Mobile would need a lower-res
texture (256³ = ~32 MB) and fewer steps.

The ray march runs as a single full-screen post-processing pass, similar
to the existing bloom pipeline. It does NOT need per-nebula geometry.

### Blending with the star field

The dust volume sits between the camera and the stars. Render order:

1. Render stars (point cloud + billboards) to a framebuffer.
2. Render the dust volume as a full-screen pass that reads both the
   3D dust texture and the star framebuffer.
3. At each ray step, accumulate extinction (darken the star colors
   behind) and optionally add emission.
4. Output the composited result.

This naturally handles dark nebulae (extinction without emission) and
emission nebulae (density regions near hot stars that both absorb
background and emit their own light).

## Named nebulae as labels

Individual named nebulae are not separate rendered objects — they're
labels placed at known positions within the dust volume. The visual
appearance comes from the data; the label gives it a name.

Data model in `data/nebulae.json`:

```json
{
  "Orion Nebula": {
    "aliases": ["M42", "NGC 1976"],
    "type": "emission",
    "pos_pc": [-134.5, -217.8, -88.3],
    "wikipedia": "https://en.wikipedia.org/wiki/Orion_Nebula",
    "notes": "..."
  },
  "Coal Sack": {
    "aliases": [],
    "type": "dark",
    "pos_pc": [53.2, -147.8, -30.5],
    "wikipedia": "https://en.wikipedia.org/wiki/Coalsack_Nebula",
    "notes": "..."
  }
}
```

Runtime: labels render as CSS2DObjects (like clusters), searchable and
selectable with info panels. No special rendering per nebula.

## Nearby nebulae (within 1000 pc)

| Nebula | Distance | Extent | Type | Notes |
|---|---|---|---|---|
| Coal Sack | ~190 pc | ~20 pc | Dark | Prominent naked-eye dark patch in Crux |
| Helix Nebula (NGC 7293) | ~200 pc | ~1 pc | Planetary | Nearest large planetary nebula |
| Witch Head (IC 2118) | ~275 pc | ~25 pc | Reflection | Illuminated by Rigel |
| Barnard's Loop | ~400 pc | ~100 pc | Emission | Giant arc around Orion |
| Orion Nebula (M42) | ~412 pc | ~7 pc | Emission | Most famous; embedded star formation |
| Horsehead Nebula (B33) | ~400 pc | ~1 pc | Dark | Silhouetted against IC 434 |
| Dumbbell Nebula (M27) | ~417 pc | ~0.5 pc | Planetary | Large planetary nebula in Vulpecula |
| North America Nebula (NGC 7000) | ~520 pc | ~30 pc | Emission | Near Deneb |
| Ring Nebula (M57) | ~700 pc | ~0.3 pc | Planetary | Iconic ring in Lyra |
| Veil Nebula / Cygnus Loop | ~740 pc | ~36 pc | SNR | Supernova remnant |

Note: planetary nebulae (Helix, Ring, Dumbbell) are too small to appear
in the dust maps (~0.3–1 pc vs ~4 pc/voxel). These would need individual
treatment — either a billboard or the 3D velocity-mapped models that
exist for Helix and Ring (see "Future: planetary nebulae" below).

## Prototype plan

### Phase 1: Lallement/Vergely cube (simplest path to visual)

1. Download the Lallement/Vergely (2022) FITS cube.
2. Extract the 1200×1200×160 grid, crop/downsample to ~400³ covering
   our 1000 pc radius.
3. Convert to a raw binary suitable for `THREE.Data3DTexture`.
4. Write a ray-marching fragment shader as a post-processing pass.
5. Start with **extinction only** (darken stars behind dense dust).
6. Verify that the Taurus cloud, Ophiuchus complex, Orion molecular
   cloud, and Coal Sack are visually identifiable.

### Phase 2: Add emission

1. Identify hot illuminating stars in our catalog near dense dust
   regions (Trapezium in Orion, σ Sco in Ophiuchus, etc.).
2. At each ray step, compute approximate illumination from nearby hot
   stars and add emission glow (Hα-red for HII, blue for reflection).
3. This makes emission nebulae (Orion, North America) glow while dark
   nebulae (Coal Sack) remain purely absorptive.

### Phase 3: Higher resolution with Edenhofer

1. Sample Edenhofer (2024) onto a 512³ or 1024³ grid.
2. Blend with Leike (2020) for the inner 69 pc hole.
3. Replace the Lallement cube.
4. Evaluate whether the resolution improvement is visible at Drake's
   typical viewing distances.

### Phase 4: Named nebulae + labels

1. Create `data/nebulae.json` with positions and metadata.
2. Render labels at centroid positions (same as cluster labels).
3. Add to search index.

### Future: planetary nebulae

Planetary nebulae (Helix, Ring, Dumbbell) are too small for the dust
maps but have well-constrained 3D structure from Doppler velocity mapping.
Published 3D models exist for the Ring Nebula (O'Dell et al. 2013) and
Helix Nebula (Meaburn et al. 2008). These could be rendered as individual
small-scale volumetric objects at their catalog positions, similar to the
black hole sub-scene concept in `docs/vision.md`.

## References

### Dust map data
- [Edenhofer et al. 2024 (A&A)](https://www.aanda.org/articles/aa/full_html/2024/05/aa47628-23/aa47628-23.html)
- [Edenhofer Zenodo dataset](https://zenodo.org/records/8187943)
- [Leike et al. 2020 (A&A)](https://www.aanda.org/articles/aa/full_html/2020/07/aa38169-20/aa38169-20.html)
- [Leike Zenodo dataset](https://zenodo.org/records/3993082)
- [Lallement/Vergely 2022 (A&A)](https://www.aanda.org/articles/aa/full_html/2022/05/aa42846-21/aa42846-21.html)
- [Lallement/Vergely VizieR data](https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/661/A147)
- [Zucker et al. 2022 Local Bubble (Nature)](https://www.nature.com/articles/s41586-021-04286-5)
- [Pelgrims Local Bubble shell model](https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/RHPVNC)
- [`dustmaps` Python package](https://dustmaps.readthedocs.io/en/latest/maps.html)

### Rendering techniques
- [Will Usher: WebGL Volume Rendering](https://www.willusher.io/webgl/2019/01/13/volume-rendering-with-webgl/)
- [Observable: 3D Volume Rendering with Three.js](https://observablehq.com/@mroehlig/3d-volume-rendering-with-webgl-three-js)
- [SpaceEngine: Volumetric Nebulae](https://spaceengine.org/news/blog180916/)
- [Galactic Cartography Portal](https://galactic-cartography-portal.flute.hpccloud.mpg.de/) — browser-based 3D ISM viewer using Leike/ICECONE data

### Planetary nebula 3D models
- O'Dell et al. 2013 — Ring Nebula 3D structure
- Meaburn et al. 2008 — Helix Nebula 3D kinematics
