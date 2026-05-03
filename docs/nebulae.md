# Nebula & Interstellar Medium Rendering

## Overview

Drake renders illuminated molecular clouds within the local stellar
neighborhood using a 3D volumetric dust density field with physics-based
hot-star illumination. The dust positions are scientifically measured
from Gaia data; the emission colors are simulated from the real
positions and spectral types of O and B stars in the catalog.

Behind that local volume, a single all-sky panorama provides the
distant galactic backdrop — the unresolved Milky Way star band and its
far-galactic dust lanes that the local Edenhofer cube doesn't cover
(the cube ends at ~1.25 kpc; most of the visible Milky Way arch is at
2–10 kpc). Local dust then extincts the backdrop along the line of
sight, so dense molecular clouds silhouette against the distant
galactic light. See "Galactic backdrop" below.

The rendering is toggled with the **D** key, which shows both the
volumetric dust glow and the named molecular cloud labels.

## Scientific accuracy

| Layer | Source | Accuracy |
|---|---|---|
| **3D dust density** | Edenhofer et al. (2024), Gaia parallax + photometric reddening | Measured — the dust is where the data says |
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
- **Partial extinction** — the dust now darkens the galactic backdrop
  panorama via integrated optical depth, so dense clouds silhouette
  against distant galactic light. Drake's resolved foreground stars
  still render through clouds unaffected (no per-star extinction).
  See "Per-star extinction" under Planned Improvements
- **6 pc voxel resolution** — structures smaller than ~20 ly remain blurred.
  The native Edenhofer data is 2 pc, but we downsample to keep the baked
  texture under ~25 MB gzipped; fine filaments still smear together
- **Isotropic scattering** — real interstellar dust has a
  forward-scattering asymmetry (Henyey-Greenstein phase function).
  We scatter uniformly in all directions
- **UV weighting is approximate** — `luminosity^0.7` is a rough proxy
  for UV output. Real UV flux depends on effective temperature, not
  just bolometric luminosity. A hot B0 star puts out proportionally
  more UV than a cooler but equally luminous B8 star
- **Coordinate epoch mismatch** — AT-HYG star positions are J2000.0;
  the dust cube is from Gaia DR3 (epoch ~2016). The ~0.01 pc offset
  over 16 years is negligible at 6 pc voxel resolution

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

Visualizing these as silhouettes against the galactic backdrop is
now possible (the skybox is extincted by the dust volume), but
properly *appreciating* their galaxy-scale extent requires the camera
zoom range described in `docs/vision.md`. Per-star extinction —
darkening only resolved foreground stars behind the dust — is still
the missing piece for a fully depth-correct render. See "Planned
improvements" below.

## Rendering pipeline

### Build time

Run `python3 scripts/bake-dust.py` (requires `astropy` and `numpy`).
The script downloads the source FITS automatically on first run.

1. **Download** Edenhofer et al. (2024) HEALPix reconstruction from
   [Zenodo record 8187943](https://zenodo.org/records/8187943) —
   specifically `mean_and_std_healpix.fits` (~3.25 GB, one-time download
   cached at `data/cache/edenhofer2023_healpix.fits`, gitignored). The
   map covers 69–1250 pc from Sol as HEALPix angular spheres × log-spaced
   radial bins. License: CC-BY 4.0.

2. **Resample** onto a 6 pc Cartesian grid at ±996 pc XY / ±396 pc Z
   (333×333×133 voxels) using 4-neighbor angular bilinear + 2-neighbor
   radial linear interpolation. Each output voxel averages 3³ intra-voxel
   supersamples to damp aliasing. Only the posterior mean channel is
   kept. Threshold low voxels at the 5th percentile of non-zero values
   to clear Local Bubble residuals.

3. **Compute hot-star illumination**: for each non-zero dust voxel,
   accumulate luminosity-weighted UV flux from ~21k O/B stars within
   150 pc using 1/r² falloff. Flux weighted by `L^0.7` (absolute
   magnitude → luminosity → UV proxy). Separate ionizing flux
   (O + early-B, producing Hα) from scattering flux (late-B,
   producing blue reflection). Star positions converted from AT-HYG
   equatorial Cartesian to galactic Cartesian via the IAU rotation
   matrix.

4. **Bake** into RGB uint8 binary (~44 MB, ~21 MB gzipped):
   - R = dust density (0-255, thresholded + normalized)
   - G = ionizing flux (0-255, log-scaled)
   - B = scattering flux (0-255, log-scaled)

### Runtime (`src/dust.ts`)

1. Load RGB `Data3DTexture` (333×333×133, ~44 MB GPU). Sized
   internalFormat `RGB8` is required for WebGL2 3D textures, and
   `unpackAlignment = 1` because 333 × 3 = 999 bytes/row isn't a
   multiple of the default 4.

2. Render emission **and** integrated optical depth at **half
   resolution** into an offscreen `WebGLRenderTarget` (RGBA) via a
   ray-marching fragment shader on a BackSide box mesh:
   - 128 steps × 18 scene units (~6 pc) per pixel
   - Each step: sample the 3D texture, compute emission from
     ionizing + scattering flux channels
   - Accumulate emission with absorption (dense cores absorb their
     own emission, preventing runaway brightness)
   - Accumulate raw integrated density into a separate channel for
     backdrop extinction — decoupled from the emission opacity knob,
     so emission brightness and dust-lane darkness can be tuned
     independently
   - Output `RGBA = (premultiplied emission, optical depth)` with
     `AdditiveBlending` into the zero-cleared RT (premultiplying RGB
     by the emission alpha in-shader matches what the previous
     `NormalBlending(non-premul)` path produced, while freeing alpha
     to carry optical depth)
   - The RT is cleared every frame regardless of dust visibility, so
     toggling nebulae off cleanly removes both emission and extinction

3. **Upscale blit**: render a fullscreen quad that samples the
   half-res texture's RGB with bilinear filtering, using additive
   blending to composite emission onto the post-bloom starfield.
   Volumetric glow is inherently smooth, so half-res is nearly
   indistinguishable.

4. Render order: skybox (samples halfResRT.a as `exp(-τ)` extinction
   over the panorama) → stars → bloom compositor → dust emission
   blit → canvas labels.

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
| 3D texture | ~44 MB VRAM | Loaded once at boot |
| Emission ray march | 128 steps/pixel at half-res | Half-resolution reduces fragment count 4× |
| Upscale blit | Fullscreen quad, bilinear | Volumetric glow is smooth enough for half-res |
| Labels (12 CSS2D) | DOM update per frame | Distance text only updated when hovered |

## Galactic backdrop (skybox)

A single 4096×2048 equirectangular Milky Way panorama (ESO/S. Brunier
*eso0932a*, CC-BY 4.0) is rendered as the deepest layer of the scene
to provide the distant galactic context the Edenhofer volume can't
reach.

### Asset (`scripts/fetch-skybox.py`)

- Downloads from Wikimedia Commons, downsamples to 4096×2048
- Wrap-padded **9-pixel median filter** to erase resolved-star
  pinpoints (Drake renders its own catalog stars over this; without
  the median we'd get visible double-stars wherever the panorama and
  catalog overlap). Padding the image horizontally before filtering
  and cropping back keeps the longitude=±180° meridian wrap continuous
  — without it PIL's edge clamping leaves a visible seam at runtime
- Final pass: feather-blend the leftmost and rightmost 16 columns
  to enforce wrap continuity (the source ESO panorama has a residual
  ~0.9/255 column-to-column step at the meridian after the median)
- Saved at JPEG q=95 (~600 KB). Lower q reintroduces DCT quantization
  noise that undoes the seam blend at the boundary; q=95 keeps the
  delta below the interior pixel-to-pixel baseline

### Runtime (`src/skybox.ts`)

A back-side unit sphere with a custom shader. Vertex shader strips
translation from the view matrix and uses `.xyww` so the sphere always
surrounds the camera and renders at the far plane regardless of
camera position. Fragment shader:

- Rotates the scene-space view direction into galactic coordinates
  via the transpose of the same `GAL_TO_SCENE` matrix in `src/dust.ts`
  (orthonormal — transpose = inverse). Galactic equator therefore
  registers exactly with the dust volume's frame
- Samples the equirect panorama: `lon = atan2(g.y, g.x)`,
  `lat = asin(g.z)`, `u = 0.5 - lon/(2π)`, `v = 0.5 - lat/π`. ESO
  Brunier convention puts galactic east on the LEFT (standard
  astronomical sky-map mirror of an Earth map)
- **Backdrop extinction**: samples halfResRT.a (the dust pass's
  optical-depth output) at the matching screen UV — with bloom-
  overscan FOV correction since the composer renders into a 1.1×
  oversized buffer — and multiplies the panorama by `exp(-τ)`. Local
  dust silhouettes the backdrop without affecting Drake's foreground
  stars (those render over the extincted skybox)
- **Brightness scaling**: half-rate Pogson curve
  `pow(2.512, (uMagLimit - 7.5) * 0.5)`. The user's mag-limit knob
  also controls resolved-star and dust-emission visibility; the
  skybox follows at half rate so it doesn't overpower the stars and
  amplify pole / seam artifacts at high mag levels
- **Polar attenuation**: `sqrt(cos(lat))` fades to zero at the poles.
  Equirect projection collapses each polar circle to a single texture
  row, so |lat|→90° has no real signal — just a smeared average that
  brightness scaling makes ugly without the fade
- Texture wrapS = `RepeatWrapping` so the bilinear filter blends
  across the meridian instead of clamping to edge

### Tuning constants

| Constant | Location | Purpose |
|---|---|---|
| `uIntensity` | `src/skybox.ts` | Overall backdrop brightness (default 0.09) |
| `uExtinctionStrength` | `src/dust.ts` | How dark dust lanes silhouette (default 0.025) |
| `TARGET_OPACITY` | `src/dust.ts` | Local emission brightness (default 0.025) |
| Median kernel size | `scripts/fetch-skybox.py` | How aggressive the de-starring is (default 9 px) |

## Data sources

### Edenhofer et al. (2024) — current dust data

| Property | Value |
|---|---|
| Paper | Edenhofer et al., A&A 685, A82 (2024) |
| Coverage | 69–1250 pc from Sol, full sky |
| Source format | HEALPix × log-distance sphere stack |
| Source file | `mean_and_std_healpix.fits` (~3.25 GB) |
| Baked sub-cube | 333 × 333 × 133 (±996 pc XY, ±396 pc Z) at 6 pc voxels |
| Download | [Zenodo 8187943](https://zenodo.org/records/8187943) |
| License | CC-BY 4.0 |

### Lallement / Vergely (2022) — previous dust data

| Property | Value |
|---|---|
| Paper | Lallement, Vergely & Cox, A&A 661, A147 (2022) |
| Coverage | 3 kpc in-plane, 400 pc above/below galactic plane |
| Resolution | 10 pc isotropic voxels |
| Download | [CDS VizieR J/A+A/661/A147](https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/661/A147) |

Retired in favor of Edenhofer. Lallement covered a wider footprint but
its 10 pc voxels blurred every cloud into an amorphous blob. Edenhofer's
finer reconstruction is the higher-impact dataset for the volumes Drake
actually renders.

## Planned improvements

### Finer downsample

The Edenhofer source is 2 pc native; we bake at 6 pc to keep the RGB
texture under ~25 MB gzipped. Dropping to 4 pc (~150 MB) or 2 pc (~1.2 GB)
would resolve more filament and cloud-edge structure at real bandwidth /
VRAM cost. 4 pc is the realistic next step. 8 pc (~19 MB) is the cheap
mobile-bandwidth lever in the other direction.

### Per-star extinction

Backdrop extinction is in place (the skybox is darkened by the dust
volume's integrated optical depth — see "Galactic backdrop"). The
remaining piece is letting local dust *also* darken the resolved
catalog stars Drake renders. Requires:

1. **Depth-aware extinction**: a depth pre-pass renders star
   positions into a depth buffer; the dust shader reads this to only
   darken stars that are behind the dust, not in front. Infrastructure
   was prototyped (depth material, star depth RT) but removed for
   performance. Would need to be re-added with careful optimization.
2. **Galaxy-scale camera**: dark structures like the Aquila Rift and
   Cygnus Rift span 1000-2000 ly — larger than the current max zoom
   (1076 ly from focus). Fully appreciating them requires the
   galaxy-scale camera tier described in `docs/vision.md`.

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
dust maps (~0.3-1 pc extent vs 6 pc voxels). Published 3D
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

### Backdrop
- [ESO eso0932a — The Milky Way panorama](https://www.eso.org/public/images/eso0932a/) (S. Brunier, CC-BY 4.0)

### Rendering
- [Will Usher: WebGL Volume Rendering](https://www.willusher.io/webgl/2019/01/13/volume-rendering-with-webgl/)
- [Galactic Cartography Portal](https://galactic-cartography-portal.flute.hpccloud.mpg.de/) — browser-based 3D ISM viewer
- [SpaceEngine: Volumetric Nebulae](https://spaceengine.org/news/blog180916/)
