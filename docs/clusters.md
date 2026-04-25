# Star Clusters

## Overview

Drake renders 27 open star clusters within 1000 pc. Clusters are
defined in `data/clusters.json` with hand-curated metadata and
membership sourced from Hunt & Reffert (2023) via Gaia DR3
astrometric clustering.

At runtime, cluster labels render at the membership-weighted centroid
with a distinct pale blue style. Individual member star labels are
hidden when they collide with the cluster label on screen but reappear
as you zoom in. Selecting or hovering a cluster glows member star
billboards without glowing their individual labels.

## Data files

### `data/clusters.json`

Hand-curated metadata keyed by display name:

```json
{
  "Pleiades": {
    "aliases": ["M45", "Messier 45", "Seven Sisters", "Melotte 22"],
    "type": "open",
    "seed_stars": ["Alcyone", "Atlas", "Electra", "Maia", ...],
    "radius_pc": 20,
    "wikipedia": "https://en.wikipedia.org/wiki/Pleiades",
    "notes": "Young open cluster in Taurus, ~100 Myr old, ..."
  }
}
```

| Field | Purpose |
|---|---|
| `aliases` | Alternative names (Messier, Melotte, Collinder). Searchable at runtime. |
| `type` | Always `"open"` currently. |
| `seed_stars` | Bright members that may be missing from Gaia membership lists. Referenced by IAU proper name. Always included regardless of Gaia matching. |
| `radius_pc` | Fallback radius for spatial-heuristic membership when Gaia data is unavailable. |
| `wikipedia` | Detail panel link. |
| `notes` | Contextual description shown in the detail panel. |

### `data/cluster-members/hunt2023.json`

Gaia DR3 source IDs per cluster from Hunt & Reffert (2023), keyed by
cluster display name. Members filtered for membership probability
> 0.5.

### `data/cluster-members/hunt2023-astro.json`

RA/Dec/parallax/Gmag/BP-RP per member, fetched from VizieR via
`scripts/fetch-hunt2023-astro.py`. Used at build time to:

- Inject faint members (not in AT-HYG) as synthetic tier-2 stars
- Compute accurate cluster centroids from all members

## Build pipeline

At build time, `build-catalog.py` processes clusters in several steps:

1. **Gaia matching**: join Hunt & Reffert Gaia source IDs against
   AT-HYG's `gaia` column. Match rates are poor (1-6%) because AT-HYG
   is Tycho-2-based (complete to V ≈ 11.5) while cluster members are
   typically fainter.

2. **Seed star inclusion**: bright stars listed in `seed_stars` are
   always included regardless of Gaia membership. These are often too
   bright for Gaia (detector saturation around mag 3).

3. **Synthetic member injection**: ~14k members from
   `hunt2023-astro.json` that don't match any AT-HYG entry are injected
   as tier-2 point-cloud stars using their Gaia astrometry. This makes
   clusters visually complete — the Pleiades shows ~1000 members instead
   of ~11.

4. **Centroid computation**: membership-weighted centroid from all
   members (both AT-HYG matches and synthetic injections).

### Photometric conversions

Synthetic members use Gaia photometry, not Johnson:

- **Gmag → V-band**: Gmag ≈ V for solar-type stars, differs by up to
  ~0.3 mag for very red/blue stars. Acceptable for tier-2 rendering.
- **BP-RP → B-V**: converted via Riello et al. (2021) polynomial
  (~0.05 mag accuracy).
- **Epoch**: Gaia epoch 2016.0 vs AT-HYG J2000.0. The ~0.01 pc offset
  over 16 years is negligible at 3 scene units per parsec.

## Runtime behavior

### System groups

Clusters are a variant of `SystemGroup` in the runtime. When a tile
containing cluster members loads and its label JSON arrives,
`starfield.ts` rebuilds `SystemGroup` objects. A cluster group includes
all members whose anchors are currently spawned.

### Label rendering

Cluster labels:
- Render at the membership-weighted centroid (recomputed when the
  spawned-member set changes).
- Use a pale powder-blue color, distinct from star labels (white),
  nebula labels (warm orange), NS labels (cyan), and BH labels (purple).
- Are searchable by name, alias, or the term "cluster".

### Member collapse

When cluster members are close together in screen space (within
`COLLAPSE_PX` pixels), their individual labels hide behind the cluster
label. This uses a union-find algorithm in `labels.ts`:

1. Project all member positions to screen coordinates.
2. Union members within `COLLAPSE_PX_SQ` distance.
3. If the largest connected component has ≥ 2 members, those members'
   labels are hidden and the cluster label shows instead.
4. When focus is on a member of the group, collapse is disabled — the
   user explicitly asked for individual members.

As you zoom in, members spread apart in screen space and their
individual labels reappear naturally.

### Selection

Selecting a cluster:
- Animates to the centroid position.
- Sets the orbit floor to max member distance from centroid × 1.5
  (minimum 3 scene units).
- Highlights all member star billboards with a glow effect.
- Shows the cluster detail panel with notes, Wikipedia, and member list.
- Member names appear as subtitle lines on the cluster label.

### Hover

Hovering a cluster glows member star billboards (increased
`vIntensity` in the star shader) without glowing their individual
labels.

## Adding a new cluster

1. Add an entry to `data/clusters.json` with `aliases`, `seed_stars`,
   `wikipedia`, and `notes`.
2. Query Hunt & Reffert (2023) on VizieR for the cluster's Gaia DR3
   member IDs. VizieR uses Melotte/Collinder/NGC designations. Filter
   for `Prob > 0.5`.
3. Add the Gaia ID list to `data/cluster-members/hunt2023.json`.
4. Fetch astrometry: `python3 scripts/fetch-hunt2023-astro.py`
5. Rebuild: `python3 scripts/build-catalog.py ...`

## References

- [Hunt & Reffert (2023)](https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/A+A/673/A114) — Gaia DR3 cluster membership (CC-BY 4.0)
- [Riello et al. (2021)](https://www.aanda.org/articles/aa/full_html/2021/05/aa39587-20/aa39587-20.html) — Gaia BP-RP to Johnson B-V conversion
