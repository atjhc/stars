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

Bodies with a `parent` field (currently just Luna → Earth) carry
*geocentric* Keplerian elements rather than heliocentric. Init runs
in two passes: parentless bodies first, recording each body's
heliocentric ecliptic position; then parented bodies, summing the
parent's heliocentric position with the moon's geocentric Keplerian
output to get the moon's heliocentric position. From there everything
else (scene transform, mesh, orbit ring, rotation) is identical to a
heliocentric body — `createOrbitLine` is frame-agnostic since it
walks ν relative to whatever focus the elements describe.

Moon orbital elements use mean values from Brown's lunar theory at
J2000 with secular rates per Julian century. Apsidal precession
(8.85-year cycle, ~4069°/cy) and node regression (18.6-year cycle,
~−1934°/cy) are large enough that the Keplerian approximation drifts
by ~1° over months — fine for visual placement, not for occultation
prediction.

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

Currently triaxial: Haumea (`1161 × 569 × 852` km — fast spin
flattens it), 433 Eros (`17.2 × 5.6 × 5.6` km — peanut), Phobos and
Deimos (~13×9×11 and ~7.5×5.2×6.1 km). For these last three the
ellipsoid is still an approximation — the actual NEAR/Viking shape
models live in the [PDS Small Bodies Node](https://sbn.psi.edu/pds/)
and the [Small Body Mapping Tool](https://sbmt.jhuapl.edu) as PDS-
format `.tab/.dat` archives. Loading those would require an OBJ/PLY
converter and a Three.js mesh loader; the ellipsoid fit captures the
overall elongation cheaply.

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
  (Public Domain), downsampled from 4000×2000 to 2048×1024.
- **Eris, Haumea, Makemake** use SSS "fictional" maps —
  plausible-looking but not real surface data, since no spacecraft has
  resolved them.
- **Eros** has no published equirectangular map; the runtime falls
  back to a 1×1 grey `DataTexture`.

The runtime calls
`THREE.TextureLoader.load("tiles/planets/${name.toLowerCase()}.<ext>")`
per body and falls back to grey if the file is missing.

Loading is async and non-blocking: planets render grey on the first
frame and swap to their textured material when the load resolves
(`kick()` wakes the wake-on-demand render loop). The shader is
identical for textured and untextured bodies — both sample
`uTexture`, just bound to a 1×1 grey for fallbacks — so swapping in
a real texture is a uniform mutation rather than a shader recompile.

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
