# Data Corrections

This document tracks known issues in the HYG v4.2 source data and the
corrections applied via `data/augmentations.json`.

## Source Data

Originally used HYG Database v4.2 (Hipparcos, Yale Bright Star, Gliese catalogs).
Migrated to **HYGLike from AT-HYG v3.2** which uses the same column structure but
incorporates **Gaia DR3 distances** for 97.5% of stars, dramatically improving
parallax accuracy. This migration resolved several known distance errors.

### Stars removed by Gaia-corrected distances

These stars appeared nearby in HYG (bad Hipparcos parallax) but are actually far:

- **HIP 82724** ("36 Ophiuchi A"): HYG 3.70 pc → Gaia **62.8 pc** (not nearby)
- **HIP 82725** ("36 Ophiuchi B"): HYG 4.15 pc → Gaia **2413 pc** (not nearby)
- **HIP 85605**: HYG 6.8 pc → Gaia **530 pc** (previously flagged as erroneous)

These were not the real 36 Ophiuchi system — they were distant background stars
with coincidentally similar coordinates but wildly wrong Hipparcos parallaxes.
The real 36 Ophiuchi stars (Gl 663A/B, aka Guniibuu) remain at ~5.9 pc.

## Corrections

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

Then regenerate:
```sh
python3 scripts/extract-stars.py hyg_v42.csv src/stars.json data/augmentations.json
```
