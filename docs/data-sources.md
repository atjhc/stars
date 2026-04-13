# Data Sources

Drake combines several astronomical catalogs and datasets at build time to
produce the static tile set served at runtime. This document records each
source, what we extract from it, and known issues or assumptions.

## Primary star catalog

### AT-HYG v3.3

- **Source:** [Codeberg: astronexus/athyg](https://codeberg.org/astronexus/athyg)
  (vendored as a git submodule at `vendor/athyg/`)
- **License:** CC-BY-SA 4.0
- **Scope:** ~2.5 M stars from Tycho-2 + Hipparcos + Yale Bright Star + Gliese,
  augmented with Gaia DR3 parallax for 97.5 % of entries
- **Files:** `data/athyg_v33-1.csv.gz` + `data/athyg_v33-2.csv.gz` (part 2 has
  no header; concatenated by `iter_concatenated_rows` in the build script)

**Fields we use:**

| Column   | Purpose |
|----------|---------|
| `x0 y0 z0` | Equatorial Cartesian position (pc from Sol) |
| `dist`   | Distance (pc) — Gaia DR3 parallax when available |
| `mag`    | Apparent magnitude V |
| `absmag` | Absolute magnitude M |
| `ci`     | B−V color index (star color via Ballesteros formula) |
| `spect`  | Spectral type |
| `proper` | IAU proper name |
| `bayer` `flam` `con` | Bayer/Flamsteed designation + constellation |
| `gl` `hip` `hd` `hr` | Catalog cross-references |
| `gaia`   | Gaia DR3 source ID (for cluster membership matching) |

**Known issues:**

- Bright stars (V < ~3) often lack Gaia DR3 entries due to detector saturation.
  Their positions come from Hipparcos parallax.
- Some Hipparcos parallaxes are erroneous: HIP 82724/82725 show 3.7 pc but
  Gaia DR2 places them at 63–2400 pc.
- White dwarf companions (Sirius B, Procyon B) are missing entirely; we inject
  them as synthetic entries via `augmentations.json`.
- The `gaia` column is empty for a significant fraction of stars, limiting our
  ability to join against Gaia-based datasets like Hunt & Reffert. See
  [Cluster membership matching](#cluster-membership-matching) below.

---

## Gaia DR3

- **Source:** ESA Gaia mission, Data Release 3 (June 2022)
- **License:** CC-BY-SA 3.0
- **How it enters:** Indirectly, via AT-HYG (which incorporates Gaia DR3
  parallax and astrometry) and via Hunt & Reffert cluster membership lists
  (which use Gaia DR3 source IDs)

We do not query the Gaia archive directly. All Gaia data reaches Drake through
AT-HYG or through the cluster membership file.

---

## Cluster membership

### Hunt & Reffert (2023)

- **Citation:** Hunt, E. & Reffert, S. (2023), "Improving the open cluster
  census. II", A&A 673, A114
- **VizieR catalog:** `J/A+A/673/A114`
- **License:** CC-BY 4.0 (CDS)
- **Local files:**
  - `data/cluster-members/hunt2023.json` — Gaia DR3 source IDs per cluster
  - `data/cluster-members/hunt2023-astro.json` — RA/Dec/parallax/Gmag/BP-RP
    per member (fetched via `scripts/fetch-hunt2023-astro.py`)

We download the `members` table from VizieR, extracting `Name`, `GaiaDR3`,
and `Prob` fields. After filtering for `Prob > 0.5`, we store the Gaia DR3
source IDs keyed by cluster name in `hunt2023.json`.

A separate fetch (`scripts/fetch-hunt2023-astro.py`) downloads positional
and photometric data for each member. This data is used at build time to:
- Inject faint members (not in AT-HYG) as synthetic tier-2 point-cloud stars
- Compute accurate cluster centroids from all members, not just AT-HYG matches

### Cluster membership matching

At build time, `build-catalog.py` joins Hunt & Reffert Gaia source IDs
against the AT-HYG `gaia` column. The match rate is poor:

| Cluster | Hunt members | AT-HYG matches | Rate |
|---------|-------------|----------------|------|
| Pleiades | 1,014 | 11 | 1.1 % |
| Hyades | 386 | 25 | 6.5 % |
| Beehive | 793 | 0 | 0 % |
| ASCC 125 | 114 | 0–1 | <1 % |

**Root cause:** AT-HYG is based on Tycho-2, which is complete to V ≈ 11.5.
The `gaia` column is well-populated (99 % of stars have Gaia DR3 source IDs),
but the *catalog itself* simply doesn't contain the faint stars that dominate
cluster membership lists. Hunt & Reffert's members at 800 pc are typically
V > 15 — well beyond Tycho-2's completeness limit.

Tested against AT-HYG subsets:

| Subset | Stars | Gaia coverage | Hunt matches (of 15,279) |
|--------|-------|---------------|--------------------------|
| HYG-like (V ≤ ~9) | 119 k | 98.8 % | 367 (2.4 %) |
| Classic IDs | 317 k | 99.3 % | 643 (4.2 %) |
| Reduced m10 (V ≤ 10) | 330 k | 99.4 % | 885 (5.8 %) |

The full 2.5 M catalog (V ≤ 11.5) would match more, but still a small
fraction. The mismatch is not a format issue — it's a depth issue.

**Impact:** Clusters with no seed stars and no Gaia matches (like ASCC 125,
Beehive, Blanco 1) get zero members in the build output. Their centroids
are either hand-placed or zeroed. Clusters with seed stars (Pleiades, Hyades)
still work because the bright seed stars provide membership and centroids,
but many fainter members are missed.

**Fix:** We download positional data (RA/Dec/parallax/Gmag/BP-RP) from
VizieR for all cluster members and inject them as synthetic tier-2 stars
at build time. This makes clusters visually complete regardless of AT-HYG
coverage, and produces accurate membership-weighted centroids.

Run `python3 scripts/fetch-hunt2023-astro.py` to refresh the astrometric
data. The output is stored in `data/cluster-members/hunt2023-astro.json`.

**Coordinate epoch:** VizieR positions are Gaia epoch 2016.0; AT-HYG uses
J2000.0. The 16-year baseline at typical proper motions introduces offsets
of ~0.01 pc — negligible at our scale (3 scene units per parsec).

**Gmag vs V-band:** Injected stars use Gaia G-band magnitude rather than
Johnson V. For solar-type stars Gmag ≈ V; for very red/blue stars the
difference can reach ~0.3 mag. Acceptable for tier-2 point-cloud rendering.

**BP-RP to B-V:** Gaia BP-RP color is converted to Johnson B-V using the
Riello et al. (2021) polynomial fit, which is accurate to ~0.05 mag.

---

## Hand-curated data

### `data/augmentations.json`

- **Scope:** ~2,600 entries keyed by Gliese ID, HIP number, or IAU proper name
- **Fields:** `wikipedia`, `notes`, `aliases`, `system`, `name` (override),
  `notable` (tier override), `synthetic` (injected stars)
- **Curation:** Manual research from Wikipedia, SIMBAD, and academic literature.
  Gaps tracked by `scripts/audit-notable.py`.

### `data/clusters.json`

- **Scope:** 27 open star clusters within 1,000 pc
- **Fields:** `aliases`, `type`, `seed_stars`, `radius_pc`, `wikipedia`, `notes`
- **Source:** Hand-curated from multiple references

### `data/constellations.json`

- **Scope:** 37 constellation line figures
- **Fields:** `iau` abbreviation, `description`, `lines` (star name pairs)
- **Sources:** H.A. Rey patterns, Stellarium asterism set, hybrid for disputed
  constellations

### `data/nebulae.json`

- **Scope:** 19 labeled molecular clouds and dark cloud regions
- **Fields:** `pos_pc` (galactic Cartesian), `type`, `aliases`, `wikipedia`, `notes`
- **Source:** Positions derived from emission-weighted peaks in the Lallement/Vergely
  dust volume; metadata from Wikipedia and literature

---

## 3D dust extinction

### Lallement & Vergely (2022)

- **Citation:** Lallement, R., Vergely, J.-L., & Cox, N.J. (2022), A&A 661, A147
- **VizieR catalog:** `J/A+A/661/A147`
- **License:** CC-BY 4.0
- **Source file:** `data/cache/cube_ext.fits.gz` (~100 MB FITS, auto-downloaded)
- **Output:** `dist/tiles/dust_volume_rgba.bin` (12.5 MB baked RGBA 3D texture)

The source FITS contains a 601×601×81 extinction cube at 10 pc resolution.
We extract a 201×201×81 sub-cube (±1,000 pc from Sol), bake hot-star
illumination into the RGB channels, and ship the result as a binary texture.

```sh
# Requires: pip3 install astropy numpy
python3 scripts/bake-dust.py
```

The script downloads the FITS file automatically on first run and caches it
at `data/cache/cube_ext.fits.gz` (gitignored). It reads hot-star positions
from the AT-HYG submodule for the illumination pass.

**Illumination model:** For each non-zero dust voxel, UV flux from all O and
B-type stars within 150 pc is accumulated (1/r² falloff). Ionizing flux
(O/early-B) produces Hα red emission; scattering flux (late-B) produces blue
reflection nebulosity.

**Limitations:**

- 10 pc voxel resolution blurs structures smaller than ~30 ly
- No self-shielding (dense cores don't shadow their outer layers)
- Only two emission colors (Hα red + Rayleigh blue)
- Dark clouds (foreground extinction) not rendered

**Planned upgrade:** Edenhofer et al. (2024) offers ~10× resolution
improvement but is not yet integrated.

---

## Coordinate transforms

AT-HYG provides equatorial Cartesian coordinates (`x0 y0 z0`) which are
mapped to Three.js scene space as:

```
scene_x = x0 × SCALE
scene_y = z0 × SCALE
scene_z = −y0 × SCALE
```

where `SCALE = 3` (scene units per parsec).

Nebulae use galactic Cartesian coordinates, converted through the IAU galactic
pole rotation matrix (RA_NGP = 192.85948°, Dec_NGP = 27.12835°, l_NCP = 122.93192°)
before applying the same SCALE and axis swap.

---

## Runtime data loading

Drake is a static site. All catalog data is pre-processed at build time into
binary/JSON artifacts served from `dist/tiles/`. There are no runtime API
calls to external data sources.

| File | Size | Loading |
|------|------|---------|
| `meta.json` | 49 KB | Eager |
| `notable.json` | 131 KB | Eager |
| `systems.json` | 19 KB | Eager |
| `names.json` | 752 KB | Eager |
| `nebulae.json` | 3.8 KB | Eager |
| `constellations.json` | 11 KB | Eager |
| `dust_meta.json` | 436 B | Eager |
| `dust_volume_rgba.bin` | 12 MB | Eager |
| `tile_*.bin` | ~28 MB total | Lazy (distance/frustum) |
| `tile_*.lbl.json` | ~940 KB total | Lazy (distance) |
