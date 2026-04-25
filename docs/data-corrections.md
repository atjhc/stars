# Data Corrections

This document tracks known issues in the AT-HYG source data and the
corrections applied via `data/augmentations.json`.

## Source Data

Uses **AT-HYG v3.3** (Tycho-2 + Hipparcos + Yale Bright Star + Gliese catalogs,
augmented with Gaia DR3 parallax for 97.5% of stars). Vendored as a git
submodule at `vendor/athyg/`.

### Stars removed by Gaia-corrected distances

These stars appeared nearby in HYG (bad Hipparcos parallax) but are actually far:

- **HIP 82724** ("36 Ophiuchi A"): HYG 3.70 pc → Gaia **62.8 pc** (not nearby)
- **HIP 82725** ("36 Ophiuchi B"): HYG 4.15 pc → Gaia **2413 pc** (not nearby)
- **HIP 85605**: HYG 6.8 pc → Gaia **530 pc** (previously flagged as erroneous)

These were not the real 36 Ophiuchi system — they were distant background stars
with coincidentally similar coordinates but wildly wrong Hipparcos parallaxes.
The real 36 Ophiuchi stars (Gl 663A/B, aka Guniibuu) remain at ~5.9 pc.

## Corrections

### Sol position offset

- **Source**: AT-HYG stores Sol at `x0=0.000005, y0=0, z0=0` parsecs (a ~1 AU
  offset from the heliocentric origin, possibly SSB-origin related)
- **Problem**: At deep-zoom distances (≤ 1 AU from Sol), the 1 AU offset
  between Sol's point-cloud position (from tile binary) and its notable
  billboard position (rounded to 4 decimals → 0) becomes visible as two
  separate renderings of the same star
- **Fix**: Force `Sol` to `(0, 0, 0)` in `build-catalog.py`

### Cartesian positions derived from ra/dec (not AT-HYG's x0/y0/z0)

- **Source**: AT-HYG's pre-computed `x0`/`y0`/`z0` columns are rounded to
  3 decimals of parsec (~4.8 AU resolution at 1 pc). The `ra` and `dec`
  columns are preserved at 8-decimal precision.
- **Problem**: For tight binaries, the 4.8 AU rounding is coarser than
  their actual separation, collapsing both components to the identical
  cartesian coordinate. Example: Rigil Kentaurus (HIP 71683) and
  Toliman (HIP 71681) have distinct RA/Dec but both round to
  `(-0.495, -0.414, -1.157) pc` even though their real 3D separation at
  that epoch is 25.3 AU.
- **Fix**: `build-catalog.py` now derives equatorial cartesian directly
  from `ra`/`dec`/`dist` at full precision. This uses the same real
  Hipparcos astrometry AT-HYG used when producing `x0`/`y0`/`z0` — we
  just skip the intermediate rounding. Relative positions for well-
  separated stars are unaffected (the per-component shift is well under
  the original rounding error).
- **Notes**: Gaia doesn't help for Alpha Cen A/B — they're too bright
  (mag 0 and 1.35) for Gaia's detectors, which saturate around mag 3.
  Only Proxima (mag 11) has a Gaia ID in AT-HYG.

### `pos_offset_au` augmentation field

Augmentations accept an optional `pos_offset_au: [dx, dy, dz]` field
(equatorial-cartesian AU) to nudge a catalog star's final position.
Escape hatch for cases where the derived RA/Dec cartesian still needs
a manual correction; currently unused by any curated entry.

### Synthetic companion entries with parent + offset

Some well-known multi-star systems are absent from AT-HYG because the
companions are too faint for Hipparcos, too bright for Gaia, or simply
not catalogued under a Gliese/HD/HIP identifier that AT-HYG includes.
The `synthetic` block in an augmentation now supports three position
forms:

```
synthetic:
  parent:    "Sirius"         # name of an existing primary
  offset_au: [14, 14, 0]      # equatorial-cartesian AU, relative to parent
# — OR —
  ra:   6.752767              # hours
  dec: -16.711650             # degrees
  dist: 2.6371                # parsecs
# — OR —
  x: -0.495, y: 2.477, z: -0.758  # equatorial cartesian, parsecs (legacy)
```

`parent + offset_au` is preferred for companions whose position is
naturally specified as "N AU from the primary." The offset uses
equatorial cartesian coordinates; magnitude matches real linear
separation, direction is approximated (true orbital orientation isn't
reconstructible from a static render).

Companions currently added this way:

- **Sirius B** (white dwarf): 20 AU from Sirius A. Orbital semi-major
  axis 19.8 AU; current separation ~29 AU widening toward apastron.
- **40 Eridani B** (white dwarf): 415 AU from Keid. AT-HYG has only
  Keid (HIP 19849); B is absent. 83" apparent separation from A at PA
  ~104°.
- **40 Eridani C** (red dwarf, DY Eri): 415 AU from Keid, 20 AU from
  B (230-year inner B+C orbit).

### System Misattributions

#### Gl 664 assigned to wrong system
- **Source**: HYG lists Gl 664 with `base="Gl 664"` and our augmentation initially
  tagged it as "36 Ophiuchi C" based on catalog notes
- **Problem**: Gl 664 is at 5.97 pc, co-located with Guniibuu (Gl 663A, 5.93 pc)
  and Guniibuu B (Gl 663B, 5.99 pc). Meanwhile 36 Ophiuchi A/B (HIP 82724/82725)
  are at 3.70/4.15 pc in a completely different part of the sky
- **Fix**: Moved Gl 664 to the Guniibuu system
- **Impact**: Without this fix, selecting Gl 664 would fly the camera to the
  centroid of 36 Ophiuchi A/B, far from Gl 664's actual position

#### 36 Ophiuchi A/B distance discrepancy
- **Source**: HIP 82724 (36 Ophiuchi A) at 3.70 pc, HIP 82725 (B) at 4.15 pc
- **Problem**: Wikipedia places 36 Ophiuchi at ~6.0 pc (19.5 ly). The Hipparcos
  parallax measurements for these stars may be inaccurate. They also lack Gliese
  catalog IDs, making cross-referencing difficult
- **Status**: Not corrected. Displayed at their HYG positions

### Inconsistent System Tagging in HYG

#### GJ 3192 / GJ 3193B (LTT 1445)
- **Source**: GJ 3193B has `base="GJ 3193"` and `comp=2`, but GJ 3192 (the
  primary) has `base=""` — no system tag at all
- **Problem**: The pair appears as two overlapping labels with no system grouping
- **Fix**: Added system "LTT 1445" with members LTT 1445 A (GJ 3192) and
  LTT 1445 BC (GJ 3193B). This is a well-known triple system hosting transiting
  exoplanets
- **Note**: GJ 3193B is actually an unresolved BC binary pair in the HYG data

#### Guniibuu / Gl 663 naming confusion
- **Source**: Gl 663A has `proper="Guniibuu"`, Gl 663B has `proper="Guniibuu B"`.
  Separately, HIP 82724/82725 are named "36 Ophiuchi A/B" in our augmentations
- **Problem**: The Gliese and HIP entries appear to be different stars at different
  distances, despite the Wikipedia article for 36 Ophiuchi covering all of them as
  one system. The HYG data does not cross-reference these entries
- **Fix**: Treat as two separate systems: "Guniibuu" (Gl 663A, Gl 663B, Gl 664)
  and "36 Ophiuchi" (HIP 82724, HIP 82725)

### Catalog ID Gaps

#### Stars with only HIP IDs
16 stars in the nearest 300 have no proper name, Bayer/Flamsteed designation,
or Gliese catalog number. They are displayed as "HIP NNNNN":

- HIP 82724, HIP 82725 (36 Ophiuchi A/B — named via augmentation)
- HIP 67593 (SCR 1845-6357 — named via augmentation)
- HIP 58910 (Beta Comae Berenices — named via augmentation)
- HIP 33226 (Gliese 251 — named via augmentation)
- HIP 83609, HIP 103039, HIP 85605, HIP 62951, HIP 18899, HIP 31292,
  HIP 94223, HIP 31293, HIP 27604, HIP 14101, HIP 84581

#### HIP 85605 spurious parallax
- **Source**: HYG lists HIP 85605 at ~6.8 pc (22 ly)
- **Problem**: Gaia DR2 places it at ~530 pc (~1,730 ly). The Hipparcos parallax
  is erroneous. This star should not be in the nearby star list
- **Status**: Not removed. Displayed at its HYG position with a note in the
  augmentation data

### Missing System Members

#### Proxima Centauri not in Alpha Centauri system
- **Source**: HYG lists Proxima Centauri (Gl 551) with no `base` field, separate
  from Gl 559A/B (Rigil Kentaurus/Toliman)
- **Fix**: Added to "Alpha Centauri" system via augmentation. Proxima is
  gravitationally bound to the A/B pair at ~13,000 AU separation

#### EZ Aquarii single member
- **Source**: Only Gl 866A appears in our 300 nearest stars with a system tag.
  EZ Aquarii is actually a triple system (A, B, C) but B and C are not in the
  HYG top-300 by distance
- **Status**: Tagged as "EZ Aquarii" system with one member. Will collapse
  correctly if additional members are added

### Naming Issues

#### Duplicate proper names
- **Source**: Some multi-star systems have the same `proper` field on multiple
  components (e.g., "p Eridani" on both Gl 66A and Gl 66B)
- **Fix**: The extraction script detects these and appends component letters
  ("p Eridani A", "p Eridani B")

#### Name overrides via augmentation
90 stars have name overrides where the research-derived common name differs
from what the HYG naming hierarchy produces. Examples:
- Gl 65A → "Luyten 726-8 A" (the system is better known as Luyten 726-8)
- Gl 144 → "Epsilon Eridani" (the IAU name "Ran" is less widely known)
- GJ 1111 → "DX Cancri" (variable star designation is more common)
- GJ 3192 → "LTT 1445 A" (the LTT designation is standard in the literature)

### Questionable System Groupings

#### Gliese 831 (Gl 831A + Gl 831B)
- **Source**: HYG groups these with the same `base` field
- **Problem**: 0.86 scene units apart (~0.29 pc), no Wikipedia article, no
  confirmation of binary status found
- **Fix**: Removed system tag. Treated as independent stars

### Missing Companions in AT-HYG

#### Sirius B (Gl 244B) and Procyon B (Gl 280B)
- **Source**: AT-HYG does not include these white dwarf companions —
  they lack independent Gaia/Hipparcos parallax measurements
- **Fix**: Added as synthetic entries in `augmentations.json` with coordinates
  matching their primaries and known photometric data. The build script
  injects synthetic stars into the output when a `synthetic` field is present
  in the augmentation entry

#### Gaia BH1/BH2/BH3 luminous companions
- **Source**: AT-HYG omits these stars (sub-Tycho brightness, Gaia-only
  identifications) and the BH JSON has no slot for the visible component
- **Fix**: Added each as a synthetic star in `augmentations.json` keyed
  `Gaia BH1 A` / `Gaia BH2 A` / `Gaia BH3 A`, co-located with the BH and
  tagged with `system: "Gaia BHn"`. Stellar parameters (Teff, mass,
  radius, [Fe/H], orbital period) sourced from El-Badry et al. 2023
  (BH1, BH2) and Gaia Collaboration / Panuzzo et al. 2024 (BH3)

### Black Hole Coordinates

#### Canonical positions for Gaia BH1/BH2/BH3
- **Convention**: `data/blackholes.json` RA/Dec are the Gaia DR3 ICRS
  coordinates of each system's luminous component. Companion `synthetic`
  entries reuse the same coords (the orbital separation is sub-AU at
  parsec distances and unresolvable from this viewer's viewpoint), so
  the BH and its companion render co-located

## How to Add Corrections

Add entries to `data/augmentations.json` keyed by Gliese catalog ID (or
`HIP NNNNN` for stars without one). Available fields:

```json
{
  "Gl 551": {
    "name": "Override display name",
    "system": "System name for grouping",
    "wikipedia": "https://en.wikipedia.org/wiki/...",
    "notes": "Contextual information shown in detail panel"
  }
}
```

For stars missing from the source catalog, add a `synthetic` field with full data:

```json
{
  "Gl 244B": {
    "name": "Sirius B",
    "system": "Sirius",
    "synthetic": {
      "x": -0.494, "y": 2.477, "z": -0.758,
      "dist": 2.6371,
      "mag": 8.44, "absmag": 11.18,
      "ci": -0.03, "spect": "DA2",
      "lum": 0.026
    }
  }
}
```

Then rebuild:
```sh
python3 scripts/build-catalog.py data/augmentations.json dist/tiles/ \
  vendor/athyg/data/athyg_v33-1.csv.gz vendor/athyg/data/athyg_v33-2.csv.gz
```

### Synthetic Cluster Members

AT-HYG is based on Tycho-2 (complete to V ≈ 11.5), but most cluster members
identified by Hunt & Reffert (2023) via Gaia DR3 astrometric clustering are
fainter (Gmag 12–20). The build script injects ~14k unmatched members as
tier-2 synthetic stars using RA/Dec/parallax/Gmag/BP-RP from VizieR.

- **Gmag vs V-band**: Gaia Gmag ≈ Johnson V for solar-type stars, differs by
  up to ~0.3 mag for very red/blue stars. Acceptable for tier-2 point cloud.
- **BP-RP → B-V**: Converted via Riello et al. (2021) polynomial (~0.05 mag
  accuracy).
- **Epoch**: VizieR positions are Gaia epoch 2016.0 vs AT-HYG's J2000.0.
  The ~0.01 pc offset over 16 years at typical proper motions is negligible.
