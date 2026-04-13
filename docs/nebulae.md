# Nebula & Interstellar Medium Rendering

## Overview

Drake renders illuminated molecular clouds within the local stellar
neighborhood using a 3D volumetric dust density field with physics-based
hot-star illumination. The dust positions are scientifically measured
from Gaia data; the emission colors are simulated from the real
positions and spectral types of O and B stars in the catalog.

The rendering is toggled with the **D** key, which shows both the
volumetric dust glow and the named molecular cloud labels.

## Scientific accuracy

| Layer | Source | Accuracy |
|---|---|---|
| **3D dust density** | Lallement/Vergely (2022), Gaia parallax + photometric reddening | Measured — the dust is where the data says |
| **Star positions & types** | AT-HYG / Gaia DR3 | Measured — we know which stars are O/B type |
| **Which dust is illuminated** | 1/r² UV flux from ~21k O/B stars, luminosity-weighted, 150 pc range | Physics-based — correct inputs, simplified radiative transfer |
| **Emission color** | HII red (ionizing O/early-B) vs reflection blue (scattering B) | Simplified — two broadband channels, not spectral lines |
| **Emission intensity** | Artistic tuning with magnitude-limit coupling | Not calibrated to real surface brightness |

### What the simulation gets right

- **Dust positions** are genuine observational data from Gaia stellar
  reddening measurements, not a model
- Dust near O-type stars glows red/pink (hydrogen Hα emission at 656 nm)
- Dust near B-type stars glows blue (Rayleigh scattering — same physics
  as Earth's blue sky)
- Dust with no nearby hot star produces no emission (correctly dark)
- Hot-star illumination is **luminosity-weighted** (`L^0.7` UV proxy
  from absolute magnitude), so a luminous O supergiant dominates over
  dozens of faint B dwarfs at the same distance
- The Orion Molecular Cloud glows because Hatysa (O9III) and other
  Trapezium-region O stars illuminate it
- **Distance attenuation** in the shader dims distant clouds relative
  to nearby ones, roughly matching how apparent surface brightness
  decreases with viewing distance for volumetric emitters
- The **magnitude limit** control (`-`/`=` keys) affects dust brightness
  alongside star visibility, simulating overall eye/camera sensitivity

### What the simulation simplifies or omits

- **Brightness is artistic** — the overall intensity multiplier and
  distance attenuation curve are hand-tuned for visual appeal, not
  calibrated to real surface brightness in mag/arcsec². Real nebulae
  are incredibly faint; most are invisible to the naked eye
- **Two-color only** — real nebulae emit in specific spectral lines:
  OIII green (495/501 nm), SII deep red (672 nm), NII red (658 nm),
  Hβ blue-green (486 nm). We only model Hα red + Rayleigh blue
- **No self-shielding** — dense cloud cores should block UV from
  reaching their interiors, creating dark cores with illuminated rims.
  Our model illuminates uniformly through dust
- **No extinction** — real dust dims and reddens background starlight.
  Stars render through clouds unaffected. See "Dark cloud rendering"
  under Planned Improvements
- **10 pc voxel resolution** — structures smaller than ~30 ly are blurred.
  No filaments, dark lanes, or sharp cloud edges at this scale
- **Isotropic scattering** — real interstellar dust has a
  forward-scattering asymmetry (Henyey-Greenstein phase function).
  We scatter uniformly in all directions
- **UV weighting is approximate** — `luminosity^0.7` is a rough proxy
  for UV output. Real UV flux depends on effective temperature, not
  just bolometric luminosity. A hot B0 star puts out proportionally
  more UV than a cooler but equally luminous B8 star
- **Coordinate epoch mismatch** — AT-HYG star positions are J2000.0;
  the dust cube is from Gaia DR3 (epoch ~2016). The ~0.01 pc offset
  over 16 years is negligible at 10 pc voxel resolution

## Rendered molecular clouds

19 labeled clouds, positions snapped to emission peaks in the baked volume
(`scripts/snap-nebula-labels.py`):

| Cloud | Distance | Type | Notes |
|---|---|---|---|
| Lupus Molecular Cloud | 560 ly | Star-forming | Nearest low-mass star-forming region |
| Taurus Molecular Cloud | 600 ly | Star-forming | HII + reflection from nearby B stars |
| Aquila Rift | 735 ly | Dark cloud | Nearest major dust beyond Local Bubble |
| Cepheus-Cassiopeia Cloud | 1070 ly | Star-forming | HII + reflection |
| Taurus-Perseus Cloud | 1160 ly | Molecular cloud | Reflection dominant |
| California Molecular Cloud | 1010 ly | Star-forming | Massive; rivals Orion |
| Cepheus Flare | 1100 ly | Star-forming | Weak HII; low-mass formation |
| Orion Molecular Cloud | 1595 ly | Star-forming | Strong HII from O-type Hatysa + Trapezium |
| W40 / Serpens South | 1555 ly | Star-forming | Closest OB star formation in Aquila |
| Lacerta Cloud | 1770 ly | Molecular cloud | Associated with Lacerta OB1 |
| Vulpecula Rift | 1780 ly | Dark cloud | Continuation of Aquila Rift |
| Cygnus Rift | 2490 ly | Dark cloud | Great Rift foreground clouds |
| Cepheus OB3 Cloud | 2490 ly | Star-forming | HII + reflection |
| Cassiopeia Cloud | 3015 ly | Star-forming | Near Perseus Arm |
| Vela Molecular Ridge | 2980 ly | Star-forming | Extensive southern complex |
| Vela Cloud | 2960 ly | Star-forming | Associated with Vela OB2 |
| Canis Major Cloud | 2775 ly | Star-forming | Associated with CMa OB1 |
| Camelopardalis Cloud | 3000 ly | Star-forming | Outer Local Arm |
| Cygnus X | 3075 ly | Star-forming | Massive complex with thousands of OB stars |

### Associated star clusters

Three Orion-region clusters co-located with the Orion Molecular Cloud:
- **Collinder 69** (Lambda Orionis) — ~394 pc, 753 Gaia DR3 members
- **NGC 1980** (Iota Orionis / Hatysa cluster) — ~378 pc, 364 members
- **Sigma Orionis Cluster** — ~396 pc, 181 members

### Tabled: dark clouds

11 galaxy-scale dark structures are identified in the dust data but not
rendered: Aquila Rift, Cygnus Rift, Scutum Cloud, Ophiuchus-Scorpius
Cloud, Cepheus Cloud, Vulpecula Rift, Cygnus X, Vulpecula OB1 Cloud,
Cygnus OB7 Cloud, Canis Major (dark), Lupus Far Cloud.

These require depth-aware extinction compositing (darkening only stars
behind the dust) and a larger camera zoom range for galaxy-scale
visualization. See "Planned improvements" below.

## Rendering pipeline

### Build time

Run `python3 scripts/bake-dust.py` (requires `astropy` and `numpy`).
The script downloads the source FITS automatically on first run.

1. **Download** Lallement/Vergely (2022) FITS cube from
   [CDS VizieR](https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/661/A147).
   Cached at `data/cache/cube_ext.fits.gz` (~100 MB, gitignored).
   License: CC-BY 4.0.

2. **Extract** ±1000 pc sub-cube (201×201×81 voxels at 10 pc/voxel).
   Threshold at 95th percentile to clear the Local Bubble (~50 pc
   around Sol is nearly zero density).

3. **Compute hot-star illumination**: for each non-zero dust voxel,
   accumulate luminosity-weighted UV flux from ~21k O/B stars within
   150 pc using 1/r² falloff. Flux weighted by `L^0.7` (absolute
   magnitude → luminosity → UV proxy). Separate ionizing flux
   (O + early-B, producing Hα) from scattering flux (late-B,
   producing blue reflection). Star positions converted from AT-HYG
   equatorial Cartesian to galactic Cartesian via the IAU rotation
   matrix.

4. **Bake** into RGBA uint8 binary (12.5 MB):
   - R = dust density (0-255, thresholded + normalized)
   - G = ionizing flux (0-255, log-scaled)
   - B = scattering flux (0-255, log-scaled)
   - A = 255 (padding)

### Runtime (`src/dust.ts`)

1. Load RGBA `Data3DTexture` (201×201×81, 12.5 MB GPU).

2. Render emission at **half resolution** into an offscreen
   `WebGLRenderTarget` via a ray-marching fragment shader on a
   BackSide box mesh:
   - 128 steps × 18 scene units (~6 pc) per pixel
   - Each step: sample the 3D texture, compute emission from
     ionizing + scattering flux channels
   - Accumulate with absorption (dense cores absorb their own
     emission, preventing runaway brightness)
   - Emission color: `hiiColor × accumHII + refColor × accumRef`

3. **Upscale blit**: render a fullscreen quad that samples the
   half-res texture with bilinear filtering, using additive blending
   to composite onto the post-bloom starfield. Volumetric glow is
   inherently smooth, so half-res is nearly indistinguishable.

4. Render order: stars → bloom compositor → dust emission blit →
   CSS2D labels.

### Labels (`src/nebulaeLabels.ts`)

- CSS2DObject labels at emission-weighted centroids (positions derived
  from the actual emission peaks in the baked data)
- Warm orange styling, distinct from blue cluster labels and white
  star labels
- Distance-from-Sol opacity fade (nearest = full, farthest = dim)
- Distance subtitle shown on hover/select (consistent with star and
  cluster labels)
- Registered with `labelRegistry.ts` for unified click, hover, search,
  and visibility toggling
- Searchable by name, alias, or "nebula" / "molecular cloud"

### Performance

| Component | Cost | Notes |
|---|---|---|
| 3D texture | 12.5 MB VRAM | Loaded once at boot |
| Emission ray march | 128 steps/pixel at half-res | Half-resolution reduces fragment count 4× |
| Upscale blit | Fullscreen quad, bilinear | Volumetric glow is smooth enough for half-res |
| Labels (12 CSS2D) | DOM update per frame | Distance text only updated when hovered |

## Data sources

### Lallement / Vergely (2022) — current dust data

| Property | Value |
|---|---|
| Paper | Lallement, Vergely & Cox, A&A 661, A147 (2022) |
| Coverage | 3 kpc in-plane, 400 pc above/below galactic plane |
| Resolution | 10 pc isotropic voxels |
| Full grid | 601 × 601 × 81 |
| Sub-cube used | 201 × 201 × 81 (±1000 pc from Sol) |
| Download | [CDS VizieR J/A+A/661/A147](https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/661/A147) |
| License | CC-BY 4.0 |

### Edenhofer et al. (2024) — planned upgrade

| Property | Value |
|---|---|
| Paper | Edenhofer et al., A&A 685, A82 (2024) |
| Coverage | 69–1250 pc from Sol, full sky |
| Resolution | ~0.4 pc (nearby) to ~7 pc (at 1250 pc) |
| Download | [Zenodo 8187943](https://zenodo.org/records/8187943) |

10× resolution improvement over Lallement. Would resolve cloud cores,
filaments, and sharp edges that are currently blurred into amorphous
blobs. Processing pipeline: sample onto 512³ grid via `dustmaps` Python
package, re-run hot-star illumination at higher resolution.

## Planned improvements

### Higher resolution (Edenhofer 2024)

The single highest-impact improvement. At ~1 pc resolution, molecular
cloud cores would be 10-30 voxels across instead of 1-3. Fine structure
(filaments, dark lanes within emission regions, sharp cloud boundaries)
would become visible. The build pipeline is the same — just a larger
input dataset.

### Dark cloud rendering

Requires two components:
1. **Depth-aware extinction**: a depth pre-pass renders star positions
   into a depth buffer. The dust shader reads this to only darken stars
   that are BEHIND the dust, not in front. Infrastructure was prototyped
   (depth material, star depth RT) but removed for performance. Would
   need to be re-added with careful optimization.
2. **Galaxy-scale camera**: dark structures like the Aquila Rift and
   Cygnus Rift span 1000-2000 ly — larger than the current max zoom
   (1076 ly from focus). Visualizing them requires the galaxy-scale
   camera tier described in `docs/vision.md`.

### Additional emission lines

Real nebulae emit in OIII green (495/501 nm), SII red (672 nm), NII
red (658 nm), and other lines beyond Hα and scattered blue. Adding
these would require:
- Classifying which stars produce each type of ionization
- Additional texture channels or a lookup table
- The visual payoff would be most dramatic for planetary nebulae
  (which are too small for the current data anyway)

### Planetary nebulae

Helix (NGC 7293), Ring (M57), Dumbbell (M27) are too small for the
10 pc dust maps (~0.3-1 pc extent vs 10 pc voxels). Published 3D
models from Doppler velocity mapping exist. These would need per-object
volumetric rendering at their catalog positions — similar to the
sub-scene concept for black holes in `docs/vision.md`.

### Per-cloud bounding boxes

Currently the dust ray march runs on a single enormous bounding box
covering the entire catalog volume (5000+ scene units). Most pixels
march through empty space. Creating individual bounding boxes per cloud
would skip the fragment shader entirely for pixels that don't intersect
any cloud — estimated 10-20× reduction in fragment cost. Deferred
because the half-resolution optimization already made performance
acceptable.

## References

### Dust data
- [Lallement/Vergely 2022 (A&A 661, A147)](https://www.aanda.org/articles/aa/full_html/2022/05/aa42846-21/aa42846-21.html)
- [Edenhofer et al. 2024 (A&A 685, A82)](https://www.aanda.org/articles/aa/full_html/2024/05/aa47628-23/aa47628-23.html)
- [Leike et al. 2020 (A&A 639, A138)](https://www.aanda.org/articles/aa/full_html/2020/07/aa38169-20/aa38169-20.html)
- [`dustmaps` Python package](https://dustmaps.readthedocs.io/)

### Rendering
- [Will Usher: WebGL Volume Rendering](https://www.willusher.io/webgl/2019/01/13/volume-rendering-with-webgl/)
- [Galactic Cartography Portal](https://galactic-cartography-portal.flute.hpccloud.mpg.de/) — browser-based 3D ISM viewer
- [SpaceEngine: Volumetric Nebulae](https://spaceengine.org/news/blog180916/)
