# Planets

Solar System planets rendered as simple sun-lit globes with canvas
labels and faint elliptical orbit rings. Positions come from JPL's
"Approximate Positions of the Planets" Keplerian elements (Table 1,
valid 1800–2050 AD), propagated to *the page-load date* in the
browser.

## Data

`data/planets.json`: keyed by planet name, each entry holds
`radius_km` (physical radius), `wikipedia`, `notes`, optional
`aliases`, and an `elements` block with the six Keplerian orbital
elements per JPL — `a_au`, `e`, `i_deg`, `L_deg`, `long_peri_deg`,
`long_node_deg` — each as `[value at J2000, rate per Julian century]`.
Earth uses Earth–Moon barycenter elements (~5000 km offset from the
true geocenter, negligible at viewer scale).

## Position computation

`src/keplerian.ts` does the propagation:

1. `T` = Julian centuries since J2000.0, computed from `new Date()`.
2. Roll each element forward: `X = X₀ + Ẋ · T`.
3. Mean anomaly `M = L − ϖ`, wrapped into [-π, π].
4. Solve Kepler's equation `E − e · sin E = M` with Newton's method
   (a handful of iterations even for Mercury at e=0.21).
5. True anomaly `ν` and current radius `r = a(1 − e cos E)`.
6. Heliocentric ecliptic Cartesian via the standard rotation chain
   (`ω`, `Ω`, `i`).

## Moons (parented bodies)

Bodies with a `parent` field (Luna, Phobos, Deimos, the four Galileans,
six Saturnian moons + Titan, Triton, Charon — 16 in total) carry
*planet-centric* Keplerian elements rather than heliocentric. Init
runs in two passes: parentless bodies first, recording each body's
heliocentric ecliptic position; then parented bodies, summing the
parent's heliocentric position with the moon's planet-centric
Keplerian output to get the moon's heliocentric position. From there
everything else (scene transform, mesh, orbit ring, rotation) is
identical to a heliocentric body — `createOrbitLine` is frame-agnostic
since it walks ν relative to whatever focus the elements describe.

Luna's elements come from Brown's lunar theory mean values at J2000
with secular rates per Julian century. Apsidal precession (8.85-year
cycle, ~4069°/cy) and node regression (18.6-year cycle, ~−1934°/cy)
are large enough that the Keplerian approximation drifts by ~1° over
months — fine for visual placement, not for occultation prediction.

The other 13 moons (Galileans, Saturnians, Triton, Charon) use
[JPL approximate satellite elements](https://ssd.jpl.nasa.gov/sats/elem/)
from the J2000.5 epoch. JPL publishes those in the satellite's *Laplace
plane* — close to the parent's equator for inner moons, intermediate
for outer ones — but the Keplerian solver in `keplerian.ts` interprets
inclinations as ecliptic-referenced. Rather than implement a
parent-equator → ecliptic rotation matrix, we apply the same
approximation Phobos / Deimos already use: bake the parent's axial
tilt directly into `i_deg`. Galileans get `i = 3.13°` (Jupiter's
obliquity), Saturnians get `26.73°`, Triton uses its actual ECL value
of `156.865°` (retrograde), Charon uses `119.59°` (matches Pluto's
pole tilt). This is visually correct — moons appear in roughly their
parent's equatorial plane, agreeing with Saturn's rings — but ascending
node and mean-anomaly phases at the current epoch may be off by up to
a few degrees vs. true ECL elements. Sub-pixel at typical zoom; only a
problem for moons whose Laplace plane diverges substantially from the
parent's equator (Iapetus, where we override to its measured ECL
inclination of `17.28°` instead of summing).

Mean motion (`L_dot`) for these moons is taken directly from the IAU
2015 rotation rate `Ẇ` × 36525 — every moon in this set is tidally
locked, so orbital period equals rotation period in inertial frame.

Search results sublabel moons as "Moon" rather than "Planet" via a
distinct `k="m"` search kind in the catalog. Both kinds dispatch to
the same handler (`registerSearchKindAlias("m", "planet", …)`); the
split exists purely so `getSearchKindLabel` can return different
display strings.

The orbit ring code takes an explicit `orbitFocusScene` parameter:
`(0,0,0)` for heliocentric bodies, the parent's scene position for
moons. Without that, the moon's orbit ring would be drawn around Sol
(at the moon's geocentric distance from there) rather than around
Earth.

`src/planets.ts::eclipticToScene` then rotates ecliptic → equatorial
about +X by the obliquity (~23.44°), applies the equatorial → scene
swap, and scales AU → scene units (`SCALE / AU_PER_PC`).

`scripts/build-catalog.py` runs the same algorithm at build time so
the search index has a baked starting position. The runtime overrides
each planet's `entry.p` with the live position in `initPlanetLabels`,
so URL focus restore via `setTargetImmediate` lands on the same
point the planet handler flies to.

## Rendering

`src/planets.ts` builds one `THREE.SphereGeometry(1, 128, 64)` per
planet and scales it by `(radius_km / KM_PER_PC) · SCALE`. Lighting
takes the sun direction as a uniform — the body's diameter is many
orders of magnitude smaller than its heliocentric distance, so the
sun's bearing is effectively constant across the surface, and a single
`uSunDir = -normalize(scenePos)` per body is exact.

### Triaxial bodies

Bodies with an `axes_km: [a, c, b]` field render as ellipsoids rather
than spheres. The mesh keeps a uniform `mesh.scale = sceneRadius` so
the world matrix stays orthogonal-uniform (the lighting shader
continues to use the simple `mat3(modelMatrix) · normal` path); the
ellipsoid is *baked* into the unit-sphere geometry's vertex positions
and normals at init time. Each vertex `(x, y, z)` on the unit sphere
gets scaled to `(x · a/r, y · c/r, z · b/r)` and its normal recomputed
as the gradient of the ellipsoid `x²/a² + y²/c² + z²/b² = 1`,
i.e. `normalize(x/a, y/c, z/b)`. `radius_km` stays the volumetric mean
(used for orbit-arrival distance and search-distance display).

Currently triaxial-only: Haumea (`1161 × 569 × 852` km — fast spin
flattens it). For 433 Eros, Phobos, and Deimos the ellipsoid is the
*startup* fall-back; the runtime swaps in a real shape model on first
visibility (see "Shape models" below). The ellipsoid still defines
`mesh.scale` so when the swap happens, the body keeps the correct
scene size — only its surface detail changes.

### Shape models

Three irregular bodies ship with real spacecraft-derived shape models:

- **433 Eros** — Gaskell (2008) NEAR MSI stereophotoclinometric model,
  `ver64q` resolution (25,350 vertices / 49,152 facets). PDS bundle
  `urn:nasa:pds:gaskell.ast-eros.shape-model` (CC0 / Public Domain).
- **Phobos** — Gaskell (2011) Viking + Phobos-2 model, `ver64q`
  (25,350 / 49,152). PDS `gaskell.phobos.shape-model` (Public Domain).
- **Deimos** — Thomas (2000) Viking limb/control-point lat/lon/r grid
  on a 5° lattice (2,701 vertices / 5,184 triangles). PDS
  `ast-sat.thomas.shape-models` (Public Domain).

`scripts/fetch-planet-meshes.py` downloads the source `.tab` files,
parses the Gaskell vertex/facet format and the Thomas lat/lon/radius
grid, and emits a tiny Drake-specific binary (`'DSHP'` magic) with
just `[positions in km] + [uint32 triangle indices]`. Total ship
weight: ~1.85 MB across the three (~570 KB gzipped).

The runtime loader (`loadShapeMesh` in `src/planets.ts`) fetches the
binary, normalises positions to mean radius (so `mesh.scale` stays
the existing `sceneRadius` and the lighting path is untouched),
applies a fixed `R_x(-90°)` so the body's pole (body +Z) maps to
mesh-local +Y to match `qBase`, fills a spherical equirectangular UV
attribute (so a future texture map could wrap correctly), and
recomputes vertex normals via Three.js `computeVertexNormals()`. The
old sphere geometry is disposed in place — no shader or material
recompile, just a geometry swap.

Loading is gated on first visibility (same `pendingTextures`
mechanism — `pendingMeshUrl` drains the same frame `fade > 0`),
adding ~1.85 MB to the deferred Solar-System payload.

A second uniform `uIllumination` attenuates the result by `1/r^0.3`
(in AU), clamped to `[0, 1]`. Real solar flux falls off as `1/r²` but
the eye can't compress that without auto-exposure — Pluto would be
~1200× dimmer than Earth, effectively black. A soft `1/r^0.3` curve
keeps inner planets near full brightness (Mars ~88%), reads gas
giants as distinctly dimmer (Jupiter ~62%, Saturn ~51%), and lands
trans-Neptunian dwarfs below 35% (Pluto ~34%, Eris ~27%) without
going invisibly dark. Saturn's rings reuse the body's illumination
value so they fade with distance the same way.

## Surface textures

Equirectangular surface maps come from a mix of sources, all fetched
by `python3 scripts/fetch-planet-textures.py` into
`dist/tiles/planets/`:

- The eight planets, the Moon, and Saturn's rings come from
  [Solar System Scope](https://www.solarsystemscope.com/textures)
  (CC-BY 4.0).
- **Pluto** uses the [New Horizons global mosaic on Wikimedia
  Commons](https://commons.wikimedia.org/wiki/File:Pluto-map-sept-16-2015.jpg)
  (CC-BY-SA 4.0), downsampled from 8192×4096 to 2048×1024 via the
  Wikimedia thumb URL.
- **Ceres** uses the [NASA/JPL Dawn HAMO global map](https://commons.wikimedia.org/wiki/File:PIA20354-Ceres-DwarfPlanet-MercatorMap-HAMO-20160322.jpg)
  (Public Domain), downsampled from 4000×2000 to 2048×1024 and
  desaturated to luminance at fetch time. The Wikimedia source is the
  *colour-enhanced* HAMO product where low-sun-angle filter compositing
  produces strong green/yellow chrominance artifacts at the poles that
  aren't real surface colour — Ceres is essentially monochromatic. The
  fix lives in `scripts/fetch-planet-textures.py`: each `TEXTURES`
  entry carries an optional `post` tag, and `"desaturate"` runs the
  downloaded JPEG through `PIL.Image.convert("L").convert("RGB")` and
  rewrites it in place before it lands in `dist/tiles/planets/`. The
  shipped asset is therefore already grayscale; the runtime loader
  treats it like any other RGB texture (R=G=B per pixel) and pays no
  per-frame cost. Re-running the fetch script regenerates it; deleting
  `ceres.jpg` first is enough to force the refresh since the script
  skips already-present files.
- **Eris, Haumea, Makemake** use SSS "fictional" maps —
  plausible-looking but not real surface data, since no spacecraft has
  resolved them.
- **Eros, Phobos, Deimos** use the Stooke/Askaniy spacecraft-derived
  grayscale equirectangular maps on Wikimedia
  ([Eros](https://commons.wikimedia.org/wiki/File:Eros_map_by_Askaniy.png),
  [Phobos](https://commons.wikimedia.org/wiki/File:Phobos_map_by_Askaniy.png),
  [Deimos](https://commons.wikimedia.org/wiki/File:Deimos_map_by_Askaniy.png)),
  all CC-BY-SA 3.0. 1920px-wide thumbs (~0.8–2 MB each), kept as PNG
  to avoid JPEG ringing on the high-contrast crater terminator. The
  shape-model loader bakes spherical equirectangular UVs at the
  Y↔Z swap so these wrap correctly.

### Major moons

The 11 major moons (excluding Earth's Luna and Mars's Phobos / Deimos,
which are covered above) come from a mix of Wikimedia hosts and
USGS Astrogeology — Solar System Scope ships only planets, not moons.
All are equirectangular (or labelled "simple cylindrical", which for
sphere-mapping purposes is the same projection):

- **Io** — [USGS Galileo SSI simple-cylindrical mosaic on Wikimedia](https://commons.wikimedia.org/wiki/File:Io_modest_scale_map_Io_SSI-only_color_SIMP0_med.cub.jpg)
  (PD), 1920px JPEG. The "SIMP0" suffix is the ISIS3 short code for
  the simple-cylindrical projection.
- **Ganymede, Callisto** — [Stooke/Askaniy](https://commons.wikimedia.org/wiki/File:Ganymede_map_by_Askaniy.png)
  spacecraft-derived maps on Wikimedia (CC-BY-SA 3.0), 1920px PNG.
  Same author/source as the Mars-moon maps above.
- **Enceladus, Tethys, Dione, Rhea, Iapetus, Titan** — USGS
  Astrogeology Cassini-Voyager simple-cylindrical global mosaics
  (PD), 1024×512 grayscale JPEG previews bundled with each dataset
  (~100 KB each). All clean equirectangular without labels. Sources:
  [Enceladus 110m](https://astrogeology.usgs.gov/search/map/enceladus_cassini_global_mosaic_110m)
  (the non-HPF variant — the HPF/high-pass-filtered version flattens
  brightness for geological analysis and renders as a uniform grey
  ball at our scale),
  [Tethys 293m](https://astrogeology.usgs.gov/search/map/tethys_cassini_global_mosaic_293m),
  [Dione 154m](https://astrogeology.usgs.gov/search/map/dione_cassini_voyager_global_mosaic_154m),
  [Rhea 417m](https://astrogeology.usgs.gov/search/map/rhea_cassini_voyager_global_mosaic_417m),
  [Iapetus 803m](https://astrogeology.usgs.gov/search/map/iapetus_cassini_voyager_global_mosaic_803m).
- **Titan** — [NASA PIA22770 (2018)](https://science.nasa.gov/resource/titan-mosaic-the-surface-under-the-haze/)
  photometrically-corrected ISS global mosaic (PD), 5760×2880 source
  downsampled to 2048×1024 *and tinted* at fetch via `"tint_titan"`.
  PIA22770 is the seamless update to PIA19658 (2015): both stack the
  same 9,873 ISS images, but PIA19658 left visible seams between
  flybys because no proper haze model was applied — neighbouring
  images had different atmospheric / illumination conditions over
  the 13-year Cassini mission and were brightness-mismatched at
  their borders. PIA22770 fits a radiative-transfer haze model per
  image and blends to calibrated normal albedos, removing the seams.

  The underlying mosaic is grayscale near-IR — what Cassini sees
  through the methane window, *not* what human eyes would see. In
  visible light Titan is an opaque orange globe (the haze is fully
  obscuring; see Cassini PIA06230). To strike a balance between
  realism and visual interest, `tint_titan` multiplies the grayscale
  surface map by an orange tint sampled from PIA06230's bright
  sunlit pixels (multiplier `(1.000, 0.827, 0.330)`). The result
  reads as Titan's actual colour while preserving stylised surface
  detail through the wash — clearly artistic licence, but the
  alternative is a featureless orange ball.
- **Mimas** — [NASA PIA14926](https://science.nasa.gov/photojournal/map-of-mimas-june-2012/)
  unlabeled simple-cylindrical 5760×2880 mosaic (PD), downsampled at
  fetch time to 2048×1024 via `"downsample_2k"`. USGS Astrogeology
  doesn't catalogue a Mimas global mosaic, so we go straight to the
  NASA Photojournal source.
- **Europa** — [USGS Astrogeology Voyager-Galileo SSI 500 m simple-
  cylindrical mosaic](https://astrogeology.usgs.gov/search/map/Europa/Voyager-Galileo/Europa_Voyager_GalileoSSI_global_mosaic_500m)
  (PD). Only a 1024×512 preview JPEG is published alongside the
  184 MB GeoTIFF, so we ship that lower-res version directly. Europa's
  smooth ice plains are dominated by linear cracks at scales much
  coarser than 500 m, so the preview reads as real surface detail.
  Voyager + Galileo SSI imaged through a clear filter, so this is
  real luminance, not desaturated. The source has a feathered black
  band at the south pole (Voyager and Galileo never imaged it); the
  `"fill_polar_gaps"` post-process replaces sub-luminance-20 pixels
  with uniform medium grey `(128, 128, 128)` so the wrapped sphere
  shows a slightly dimmer polar cap rather than a black hole.
- **Triton** — [USGS Voyager 2 600m global color mosaic](https://astrogeology.usgs.gov/search/map/triton_voyager_2_global_color_mosaic_600m)
  (PD), 1024×512 JPEG preview. Voyager 2 imaged during Triton's
  southern summer in 1989, so the northern hemisphere is in the
  source as black no-coverage pixels; `"fill_polar_gaps"` replaces
  them with uniform medium grey.
- **Charon** — [USGS Astrogeology LORRI+MVIC 300 m mosaic](https://astrogeology.usgs.gov/search/map/charon_new_horizons_lorri_mvic_global_mosaic_300m)
  (PD). The dataset only publishes the 80 MB 8-bit GeoTIFF — no
  smaller preview JPEG — so the fetch script downloads the TIFF and
  the `"downsample_2k"` post-process step (PIL Lanczos resample → JPEG
  q=88) shrinks it to a 2048×1024 ~300 KB asset before anything
  reaches `dist/tiles/planets/`. Re-running the fetch regenerates it
  from the cached TIFF; on first run the 80 MB download is one-time.
  New Horizons only mapped the encounter hemisphere — the trailing
  side appears as the source's fill colour.

The runtime calls
`THREE.TextureLoader.load("tiles/planets/${name.toLowerCase()}.<ext>")`
per body and falls back to grey if the file is missing.

Loading is async, non-blocking, *and* lazy: each body's texture URL
goes into a per-body `pendingTextures` list at init but only gets
enqueued when the body becomes potentially visible — `fade > 0`
(camera within 1000 AU of Sol) or the body is selected/hovered. On
first-visibility frame the handler drains the list into the global
texture queue and clears it. Users who never enter the Solar System
pay zero texture bandwidth (~25 MB saved across 25 textures + the
Saturn ring PNG + 3 shape-model binaries).

The shader is identical for textured and untextured bodies — both
sample `uTexture`, just bound to a 1×1 grey for fallbacks — so
swapping in a real texture is a uniform mutation rather than a
shader recompile. `kick()` wakes the wake-on-demand render loop
when a load resolves so the new pixels show without waiting for
the next input event.

Textures are tagged `colorSpace = SRGBColorSpace` (SSS ships sRGB
JPEGs) and `anisotropy = 4` to keep grazing-angle sampling sharp at
min orbit, where the planet fills ~70% of the FOV. Dwarf-planet maps
(Ceres, Eris, Haumea, Makemake) are flagged "fictional" by SSS — they
look plausible but aren't actual surface data.

## Axis tilt and rotation phase

Each body's `rotation` field in `planets.json` is `[α₀, δ₀, W₀, Ẇ]`
per the IAU Working Group on Cartographic Coordinates and Rotational
Elements (Archinal et al. 2018, the 2015 report values):

- `α₀, δ₀` — pole right ascension and declination at J2000 in ICRS,
  degrees.
- `W₀` — prime meridian angle from `Q` (the ascending node of the
  body equator on the J2000 equator) at J2000.0, degrees.
- `Ẇ` — daily rate, degrees per day. Negative for retrograde
  rotators (Venus, Uranus, Pluto).

The small T-dependent precession terms and periodic nutation
corrections from the IAU report are dropped — sub-degree on 25-year
horizons, well below visual relevance. Bodies without IAU entries
(Eros, Eris, Haumea, Makemake) leave the field absent and stay at
identity orientation; their textures are fictional or absent so
alignment is meaningless.

A note on extreme tilts: Pluto's obliquity is 119.6° (its IAU pole
points nearly *opposite* the orbit normal) and the IAU convention
flipped in 2009, swapping "north" and "south" relative to older
literature. The viewer follows the post-2009 IAU convention, so the
top of the texture (Tombaugh Regio, ~20°N) is the modern IAU north.
Around 2030 Pluto reaches its northern solstice with sub-solar
latitude near +60°N, so for years either side of that the IAU
southern hemisphere is in deep polar night — that's the geometry, not
a bug. Uranus is the same story rotated 90°: pole at +97.77° from
orbit normal, so one hemisphere is in night for ~42 Earth years at a
time.

`buildOrientationBase(α₀, δ₀)` produces a time-independent quaternion
`qBase` that maps mesh-local +Y to the pole `P` and mesh-local +X to
`Q`. Each frame the handler computes
`W = (W₀ + Ẇ · days_since_J2000) mod 2π`, makes `qSpin` from an
axis-angle around mesh-local +Y by `W`, and writes
`mesh.quaternion = qBase · qSpin`. Wrapping into `[0, 2π)` keeps the
angle small — Earth's raw `W_rad` would grow to ~1.6×10⁶ by 2050,
poor for quaternion conditioning.

A `registerKeepFrame` predicate keeps the wake-on-demand render loop
alive whenever a planet is selected, so the rotation visibly
progresses while you watch. With no selection the loop sleeps and the
phase only re-evaluates on the next wake — but it's always correct
when a frame is actually drawn.

## Saturn's rings

A flat alpha-textured annulus from the D-ring inner edge (66,900 km,
1.110 R_Saturn) to the A-ring outer edge (136,800 km, 2.270 R_Saturn).
Built as a `THREE.RingGeometry` rotated 90° about X so mesh-local +Y
becomes the face normal — that lets us reuse Saturn's `qBase` directly
to tilt the ring into Saturn's equatorial plane.

The shader samples Solar System Scope's `2k_saturn_ring_alpha.png`
(2048×125 RGBA) using only the radial component of the vertex
position: `vec2((r − inner) / (outer − inner), 0.5)`. The PNG's alpha
channel encodes gap structure (Cassini Division and friends), so
fragments with alpha < 0.01 `discard` and don't write depth. Lighting
is two-sided Lambertian — `gl_FrontFacing` flips the normal so each
visible face is correctly lit when the sun is on its side.

The ring mesh is hidden until the texture loads (the 1×1 grey
fallback would render as an opaque grey disc, worse than nothing). A
`userData.onTextureLoaded` callback set on the mesh is invoked by the
texture queue when its load resolves, which flips `mesh.visible` on.
No spin is applied — the texture is rotationally symmetric, so
Saturn's `qSpin` would be invisible anyway.

## Labels and orbit rings

Each body registers a canvas label and a faint elliptical ring
traced from its current orbital state (16k segments, vertex 0
anchored on the planet so the ring touches the body without chord
offset). Both fade smoothly in `solarSystemFade(distance)` between
900 AU and 1000 AU of camera–Sol distance — past that, the labels
would pile up on Sol's pixel during interstellar views; an active
selection or hover keeps its own label visible regardless.

Selecting a body sets `minOrbit = sceneRadius * 3` (planet fills
~70% of the vertical FOV — a recognisable globe with surrounding
context, the closest zoom that doesn't have it wrapping around the
camera) and animates to `arrivalOrbit = sceneRadius * 6` (~35% of
the vertical FOV). The star formula `computeStarMinOrbit` folds in
`DISC_SCALE=8` for the stellar corona — too distant for a planet,
which has no halo, so we use the physical radius directly.

`scene.ts::updateCamera` floors `camera.near` only at `1e-30`
(positive but effectively zero) so the practical near plane is just
`orbitRadius * 0.1`. The earlier `1e-8` floor was ~100,000 km and
would have clipped a planet entirely at close orbits.

## Precision

Both the planet sphere and the orbit ring rebase their geometry
relative to the planet's scene position (and set the mesh's own
`position` to match). Three.js folds the offset back via
`modelViewMatrix` on the CPU in Float64, so the GPU's view transform
sees a small camera-to-planet delta instead of subtracting two
~1.4e-5-magnitude vectors and losing the per-vertex offset to
Float32 ULP — Eros's radius (~8e-13) would otherwise round below
the noise floor of its world position.
