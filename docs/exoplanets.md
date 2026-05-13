# Exoplanets

Confirmed exoplanet rendering for host stars in the AT-HYG catalog. Data
flows: NASA Exoplanet Archive → `data/`-side join against AT-HYG by
Gaia DR3 ID → `dist/tiles/exoplanets.json` → lazy load when the user
selects a host star.

## Data pipeline

`scripts/fetch-exoplanets.py` queries the Archive's `pscomppars` view
(one row per planet, "best of" aggregated values) for everything with
both `pl_rade` (Earth radii) and `pl_orbsmax` (semi-major axis, AU). Of
~5,800 such planets, ~1,200 join to AT-HYG host stars that have at
least one recognizable name (HD / HIP / Gliese / Bayer / Flamsteed /
IAU proper) — the rest are around faint Kepler/TESS hosts that AT-HYG
doesn't catalog. Output keyed by Gaia DR3 source ID:

```json
{
  "by_gaia": {
    "777254360337133312": {
      "host": "47 UMa",
      "planets": [
        {
          "name": "47 UMa b",
          "radius_re": 13.2, "mass_me": null,
          "a_au": 2.1, "e": 0.03,
          "incl_deg": null, "lper_deg": null,
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

Loose mass-radius bins driving render colour. Boundaries follow the
Fulton-gap / Neptune-desert convention rather than atmospheric
spectra:

| Class       | Earth-radii  | Tint         |
| ----------- | ------------ | ------------ |
| rocky       | < 1.6        | dusty rust   |
| superEarth  | 1.6 – 3.5    | water-grey   |
| neptune     | 3.5 – 8      | pale blue    |
| gasGiant    | ≥ 8          | warm tan     |

Surface textures are out of scope — they're artistic license for
bodies whose visible appearance we have no data on, and v1 ships
purely shaded colour spheres.

## Runtime

`src/exoplanets.ts` keeps a single "currently mounted" system. On
every frame `updateExoplanets()` checks `getSelectedMesh()`; when the
selected star changes, the previous group is torn down and (if the new
host has matched planets) a new group is built at the host's scene
position.

Each planet renders as a `SphereGeometry(radius)` with a tiny sun-lit
shader — no `SHADOW_GLSL`, no atmosphere shell, no surface texture, no
night side. Orbit ellipses render as `LineBasicMaterial`. The host
star is the local origin of the group, so `uSunDir = -normalize(localPos)`
is the correct per-planet sun bearing.

### Orbit orientation

Inclination, longitude of node, and argument of periastron are random
when not measured — but **seeded random** from the planet name, so the
geometry is stable across reloads. Most exoplanets only have a
semi-major axis and eccentricity; inclination is constrained for
transiting planets but unknown for RV detections, and node is almost
always unknown. The seeded random expresses "we don't know" rather
than locking everything to the same arbitrary plane.

### Sizes

Earth-radii are converted to scene units via `EARTH_RADIUS_KM /
KM_PER_PC × SCALE`. The result is *tiny* compared to the host star's
arrival distance — an Earth at 1 AU is sub-pixel from the default
star-focus camera. To make planets reachable, mounting the system
also lowers the minimum-orbit-radius override (`setMinOrbitOverride`)
to twice the smallest planet's scene radius. The user can then
scroll-zoom in or click an entry in the detail panel's "Confirmed
planets" list — `focusExoplanetByName` animates the camera to a few
planet radii out.

### Labels

Each mounted planet also registers a canvas label (`kind: "exoplanet"`)
anchored at the planet's world position. Opacity fades over the same
900–1000 AU camera-to-host band that gates Sol's planet labels, so
labels appear naturally as the user scroll-zooms into the system and
hide once they've receded into interstellar view. An `exoplanet`
label-type handler routes canvas-label clicks to `focusExoplanetByName`
— same animation as clicking the detail-panel row.

### Detail panel

Selecting a host star with planets adds a "Confirmed planets (N)"
section listing each planet's class, semi-major axis, and Earth-radii.
Each row is a click target; the click delegate in `src/detail.ts`
routes to `focusExoplanetByName`.

## What v1 does not do

- No surface textures or visual differentiation beyond class tint.
- No atmospheric haze, rings, or moons (the Archive ships a handful
  of confirmed exomoons, but mass/orbit data is too noisy for v1).
- No axial rotation — rotational periods are known for fewer than a
  dozen planets, all from spectroscopy of hot Jupiters.
- No selection / click on the planet body itself in the scene —
  canvas labels and the detail-panel list are the navigation surfaces.
- Hosts whose AT-HYG entry has no traditional identifier (HD / HIP /
  Gliese / Bayer / Flamsteed / IAU proper) are skipped. Most are
  Kepler / TESS targets that the user can't reach in Drake anyway.
