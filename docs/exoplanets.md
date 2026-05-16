# Exoplanets

Confirmed exoplanet rendering for host stars in the AT-HYG catalog.
Data flows: NASA Exoplanet Archive → join against AT-HYG by Gaia DR3
ID → `dist/tiles/exoplanets.json` → lazy-load when the user selects a
host star.

## Data pipeline

`scripts/fetch-exoplanets.py` queries the Archive's `pscomppars` view
(one row per planet, "best of" aggregated values) for everything with
both `pl_rade` (Earth-radii) and `pl_orbsmax` (semi-major axis, AU).
Of ~5,400 such planets, ~1,170 join to AT-HYG host stars that have at
least one recognisable name (HD / HIP / Gliese / Bayer / Flamsteed /
IAU proper). Of those, ~194 sit on stars that the runtime's search
index actually surfaces — the rest are around faint Kepler/TESS
targets the user can't reach in Drake anyway.

Mass cap: entries with `pl_bmasse > 13 M_jup` (the deuterium-burning
limit, IAU 2003 definition of "planet") are dropped. The Archive
includes a tail of substellar companions — HN Peg b at 22 M_jup /
773 AU, nu Oph b/c, HR 8799 e, etc. — which are brown dwarfs by mass,
not planets. They also tend to have unphysical derived densities
(20+ g/cm³, denser than osmium) because the underlying objects are
degenerate, not rocky.

Fields pulled per planet:

- `pl_rade` — radius (Earth radii)
- `pl_bmasse` — best-mass estimate (Earth masses)
- `pl_dens` — bulk density (g/cm³), Archive-preferred value
- `pl_orbsmax` / `pl_orbeccen` / `pl_orbper` / `pl_orbincl` / `pl_orblper` — orbital geometry
- `pl_eqt` — equilibrium temperature (K)
- `disc_year` / `discoverymethod` — discovery provenance

If `pl_dens` is missing but mass and radius are both present, density
is reconstructed as `ρ = M / R³ × ρ⊕` so the classification step can
use it. Every planet in the output ends up with either an Archive
density, a reconstructed density, or a null density (which forces the
ambiguous middle bins into the `unknown` class).

Output shape, keyed by Gaia DR3 source ID:

```json
{
  "by_gaia": {
    "777254360337133312": {
      "host": "47 UMa",
      "planets": [
        {
          "name": "47 UMa b",
          "radius_re": 13.2,
          "mass_me": 804.08,
          "density_gcm3": 1.82,
          "a_au": 2.10, "e": 0.032,
          "incl_deg": null, "lper_deg": 334.0,
          "period_days": 1078, "eqt_k": null,
          "class": "gasGiant",
          "disc_year": 1996, "disc_method": "Radial Velocity"
        }
      ]
    }
  },
  "aliases": { "Chalawan": "777254360337133312", "47 UMa": "...", ... }
}
```

`aliases` maps every name the runtime might see on a host (per
`build-catalog.py`'s `get_names` priority) to its Gaia DR3 ID. The
runtime walks `star.name` + `star.aliases` against this table to find
a system — no separate runtime catalog Gaia ID field needed.

Re-run after the Archive updates:

```sh
python3 scripts/fetch-exoplanets.py
```

## Composition classes

The class is a *cautious* call from radius and (when available)
density. Only the regimes that radius + density can pin down get a
class colour; the famous "sub-Neptune ambiguity" between rocky
super-Earths, water worlds, and mini-Neptunes is left explicitly as
`unknown` rather than guessed.

| Class | Criteria | Tint | Real-world analogue |
| --- | --- | --- | --- |
| `rocky` | radius < 1.6 R⊕, **or** density ≥ 4 g/cm³ | dusty rust | Earth, Mars, dense super-Earths (55 Cnc e, Kepler-10 b) |
| `neptune` | 3.5 ≤ radius < 8 R⊕ **and** 1 ≤ density < 4 g/cm³ | pale blue | Neptune, Uranus (ice giants) |
| `gasGiant` | radius ≥ 8 R⊕, **or** density < 1 g/cm³ and radius ≥ 3.5 R⊕ | warm tan | Jupiter, Saturn, hot Jupiters |
| `unknown` | everything else (mostly middle radii in the volatile-rich band) | neutral gray | K2-18 b, GJ 1214 b, water/atmosphere candidates |

The boundaries are physically motivated:

- **radius < 1.6 R⊕** sits below the Fulton gap, where almost no
  planets retain a hydrogen envelope. Rocky inference is safe.
- **radius ≥ 8 R⊕** can't be supported by anything other than an H/He
  envelope — even a pure-iron core would compress below this size.
- **density ≥ 4 g/cm³** is unambiguously dense enough to rule out a
  substantial volatile envelope at all radii we care about.
- **density < 1 g/cm³** at non-trivial radius means the bulk is H/He
  envelope; the body must be a gas giant.
- The middle (1 ≤ ρ < 4, 1.6 < R < 8) is the genuine ambiguity zone —
  could be water world, mini-Neptune, or sub-Neptune with thick H/He
  envelope. Without atmospheric spectroscopy we can't choose, so we
  render gray and label "Composition unclear" in the detail panel.

Surface textures are out of scope for v1: no spacecraft has imaged
any of these bodies, so a textured render would be artistic license.
The tint is a single sun-lit colour from `makeFallbackTexture` in
`src/planets.ts`.

## Runtime

`src/exoplanets.ts` keeps a single "currently mounted" system. Every
frame `updateExoplanets()` checks `getSelectedMesh()`; when the
selected star changes, the previous group is torn down and (if the
new host has matched planets) a new group is built at the host's
scene position.

Planet bodies share Sol's shader: `createPlanetMesh` (exported from
`src/planets.ts`) builds the sphere geometry, attaches the same
`planetFragment` shader, and wires the uniforms exoplanets don't use
(`uNightTexture`, `uAtmosphere`, `uParentDir`, occluder array, ring
shadow) to their no-op defaults. The class tint is delivered through
a 1×1 `uTexture` built by `makeFallbackTexture`, cached per-class.

Orbit ellipses reuse Sol's comet-trail line — `buildOrbitTrail` in
`src/orbitLine.ts` is the shared 16k-segment walker, parameterised on
a `(ν, out) => void` position callback so Sol plugs in its Keplerian
state + ecliptic→equatorial transform while exoplanets plug in their
quaternion-based position math.

The host star is the local origin of the group, so
`uSunDir = -normalize(localPos)` is the correct per-planet sun
bearing.

### Orbit orientation

Each system gets a single random invariable-plane normal (seeded by
the host name); every planet's orbital plane is that normal tilted by
a small Gaussian perturbation (σ ≈ 2.5°, clamped at ±20°) — modelled
on Sol's planetary dispersion, where most bodies sit within a few
degrees of the invariable plane and a single outlier (Pluto-class
~17°) reaches further. Argument of periastron uses the measured
`pl_orblper` when available, per-planet seeded random otherwise.

The composition is implemented as a quaternion chain
`plane × tilt × peri` so the orbit's local frame (periapsis +X, normal
+Y) lifts directly into world space without separate i/Ω/ω
bookkeeping.

### Sizes

Earth-radii are converted to scene units via `EARTH_RADIUS_KM /
KM_PER_PC × SCALE`. The result is *tiny* compared to the host star's
arrival distance — an Earth at 1 AU is sub-pixel from the default
star-focus camera. Mounting the system therefore lowers the
minimum-orbit-radius override (`setMinOrbitOverride`) to twice the
smallest planet's scene radius. The user can then scroll-zoom in or
click an entry in the detail panel's "Confirmed planets" list —
`focusExoplanetByName` animates the camera to a few planet radii out.

### Labels

Each mounted planet registers a canvas label (`kind: "exoplanet"`)
anchored at the planet's world position. Opacity fades over the same
900–1000 AU camera-to-host band that gates Sol's planet labels, so
labels appear naturally as the user scroll-zooms into the system and
hide once they've receded into interstellar view. An `exoplanet`
label-type handler routes canvas-label clicks to
`focusExoplanetByName` — same animation as clicking the detail-panel
row.

Hover-glow is per the standard handler pattern (cool blue
`rgba(170,200,235,1.0)` halo, blur 12) and yields collision pinning
to a selected planet, so the host star's label drops to normal
collision when a planet is selected — without this both pinned labels
would stack.

### Detail panel

Selecting a host star with planets adds a "Confirmed planets (N)"
section listing each planet's class, semi-major axis, and Earth-radii.
Each row is a click target; the click delegate in `src/detail.ts`
routes to `focusExoplanetByName`.

When a specific planet is selected (via canvas label, detail-panel
row, or search), the exoplanet handler's `detailHtml()` returns a
full-planet detail card (class, radius, mass, density, semi-major
axis, period, eccentricity, equilibrium temperature, discovery
year + method) plus a `.favorite-toggle` for the planet itself. The
label-registry overlay priority puts this above the host's panel.
Deselecting the planet reverts to the host-star panel.

### Search

Every planet emits its own `SearchEntry` with `k: "ep"`, injected
into the runtime index after `dist/tiles/exoplanets.json` loads. The
entry uses the host star's position / magnitudes / distance — at
search-select time `handleSearchSelect` recurses on the host entry
first (which selects the host and triggers `mountFor`), awaits
`whenExoplanetMounted(hostName)`, then dispatches the exoplanet
handler's `selectByName` to retarget the camera at the planet.
Recent-search entries record the planet name, not the host.

The search panel renders the planet's bookmark suffix from the
planet name (not the host's `sy`) so a favourited host doesn't drag
every planet of that system into the favourites tab.

`filterSearch` lifts the 20-result cap when the query matches a kind
keyword (`"exoplanet"`, `"cluster"`, `"nebula"`, …) so category
searches return the full set.

## Current visual representation

Five surfaces, four palettes:

| Surface | Style | Source |
| --- | --- | --- |
| Body | 1×1 tinted texture per class on the Sol planet shader | `CLASS_TINT` in `src/exoplanets.ts` |
| Orbit line | Steely blue `(0x4d, 0x7f, 0xc4)` comet trail, 0.7 opacity | shared `buildOrbitTrail` in `src/orbitLine.ts` |
| Canvas label | Cool light-blue `rgba(170,200,235,0.9)`, 12 px Helvetica | `EXO_LABEL_*` in `src/exoplanets.ts` |
| Hover/selected glow | `rgba(170,200,235,1.0)` blur 12 | `EXO_CANVAS_GLOW` |
| Detail panel | Standard `.star-name` / `.star-aliases` / `.star-detail` CSS | `buildPlanetDetailHtml` |

This diverges from Sol planets (warm cream label + amber glow) by
design — the cool palette is meant as a "this isn't your home system"
visual cue.

## Possible styling directions

The current scheme works but has some unresolved tensions. Sketch
options if we want to push further:

**1. Class-driven palette across all surfaces.** Today only the body
takes the class tint; the orbit line and label are class-agnostic
cool blue. Coloring the orbit and the label tint to match the body's
class would visually group siblings in a multi-planet system and turn
the gray-coded `unknown` planets into a strong "we don't know" cue
that propagates beyond the body.

**2. Temperature axis.** The Archive's `pl_eqt` (equilibrium
temperature) is present for roughly half the catalog and gives a
strong, intuitive visual axis — hot vs. cold. Tinting the body
warmer or colder along this dimension, *on top of* the composition
class, lets a single look distinguish hot Jupiters from cold
Jupiters, hot Neptunes from cold Neptunes, etc. Implementation could
be a shader uniform that blends from the class tint toward a hot/red
or cold/blue extreme. Risk: doubles the dimensionality of the visual
language, and the bulk of the catalog is hot (close-in detection
bias), so the user mostly sees red.

**3. Atmospheric detection flag.** The Archive's atmospheric
spectroscopy table (separate from `pscomppars`) lists planets with
confirmed molecular detections from JWST / Hubble — a small set
(~60 planets, dominated by hot Jupiters and a handful of
sub-Neptunes like K2-18 b, GJ 1214 b). Annotating these in the panel
("Atmospheric spectroscopy: H₂O, CO₂") gives the user a real story
on a handful of bodies. The data is reliable; the fetch is a
separate TAP query. Worth doing if we want to surface "what we
actually know" vs. "what we infer."

**4. Align with Sol planets.** Drop the cool-blue label palette in
favour of Sol's warm tan, relying on the `Exoplanet` sublabel +
search kind to differentiate. This kills the "alien" cue but gains
visual consistency across all planet types. Probably the right call
if the long-term plan is to treat exoplanets as first-class peers of
Sol planets rather than a separate category.

**5. Per-class shader, not per-class colour.** Gas giants get bands
(noise-driven), ice giants get a smooth pale tint, rocky bodies get
fractal terrain noise, unknown stays smooth gray. More visual
distinction without claiming surface features we don't know about —
gas-giant band structure is generic enough across Jupiter, Saturn,
Neptune that some banding is a safe inference. Bigger lift than (1).

## Precision: custom orbit-line shader

Three.js's MVP pipeline routes vertex positions through `matrixWorld`
matrices whose translation components are stored Float32. For an
exoplanet host at world magnitude ~16 (HN Peg, Chalawan, b Cen AB) the
ULP is ~1.5e-6, and the same ~1.5e-6 quantization shows up on
`camera.position`. The `modelViewMatrix` precompute cancels these
large translations in Float64, but the input ULP noise survives — and
the perspective projection divides view-space x/y by view-space z, so
the orbit-line vertex that sits next to the camera (right next to the
selected planet) gets its screen position amplified by 1/view.z. The
result is visibly-many-pixel screen wobble as the camera moves.

`buildPrecisionOrbitLine()` in `src/orbitLine.ts` is a custom
`ShaderMaterial` that bypasses `modelMatrix` and `viewMatrix`
entirely. Vertex positions stay in host-local coords; the camera is
reached in shader via two Float64-CPU uniforms, both small in
magnitude:

- `uHostFromTarget` — host's world position minus the camera's orbit
  target, computed each frame in `updateExoplanets()`. Small because
  when a planet is selected the target sits next to its host.
- `uStarCameraOffset` — camera offset from target. Already exported
  by `scene.ts` (this is the same uniform the star tile shader uses).

The shader composes them as `targetToView(uHostFromTarget + position)`
— exactly the camera-relative transform `src/stars.ts` uses for
billboards. Float32 storage is precise at the small target-relative
magnitudes, the perspective projection has no large-number cancellation
to lose, and the orbit line sits rock-still as the camera moves.

Sol's orbit lines stay on the standard pipeline: Sol is at origin so
the Float32 ULP of `matrixWorld.t` is zero.

Planet bodies still use the standard pipeline — their radius-scaled
vertex offsets are small enough relative to the host distance that the
same noise is sub-pixel in practice. If we ever want extreme close-up
views of distant exoplanets, the same uniform approach could be
applied to the body shader.

## What v1 does not do

- No surface textures or visual differentiation beyond class tint.
- No atmospheric haze, rings, or moons (the Archive ships a handful
  of confirmed exomoons, but mass/orbit data is too noisy for v1).
- No axial rotation — rotational periods are known for fewer than a
  dozen planets, all from spectroscopy of hot Jupiters.
- No selection / click on the planet body itself in the scene —
  canvas labels, the search index, and the detail-panel list are the
  navigation surfaces.
- No use of the Archive's atmospheric spectroscopy table (mentioned
  as a possible direction above).
- Hosts whose AT-HYG entry has no traditional identifier (HD / HIP /
  Gliese / Bayer / Flamsteed / IAU proper) are skipped. Most are
  Kepler / TESS targets that the user can't reach in Drake anyway.
