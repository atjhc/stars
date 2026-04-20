## Drake - Stellar Neighborhood Viewer

3D visualization of nearby stars using Three.js, served with Bun.

### Dev

```sh
bun install
bun run dev     # starts dev server with HMR at http://localhost:3000
bun run build   # builds static site to dist/
```

#### Worktree setup

Git worktrees don't include submodules or build artifacts. Before running
the dev server from a worktree, symlink both into place:

```sh
mkdir -p vendor && ln -s /path/to/main/repo/vendor/athyg vendor/athyg
mkdir -p dist   && ln -s /path/to/main/repo/dist/tiles   dist/tiles
```

Without these the server returns 200 but the app fails at runtime (missing
tile data).

### Deploy

Configured for Vercel static deployment via `vercel.json`. Run `vercel` to deploy.

### Updating star data

AT-HYG v3.3 is vendored as a git submodule at `vendor/athyg/`. The full
catalog ships as two part-files (only part 1 has a header; the script
concatenates them into a single logical stream).

```sh
# Ensure submodule + LFS data are present
git submodule update --init
cd vendor/athyg && git lfs pull --include="data/athyg_v33-*.csv.gz" && cd ../..

# Download cluster member astrometry from VizieR (first time or when updating)
python3 scripts/fetch-hunt2023-astro.py

python3 scripts/build-catalog.py data/augmentations.json dist/tiles/ \
  vendor/athyg/data/athyg_v33-1.csv.gz vendor/athyg/data/athyg_v33-2.csv.gz
```

The build injects ~14k synthetic cluster members from Hunt & Reffert (2023)
astrometric data. These are faint Gaia-identified members not in AT-HYG's
Tycho-2-based catalog. If `hunt2023-astro.json` is missing, the build still
runs but clusters will have fewer visible members.

`.csv` and `.csv.gz` inputs are both accepted.

Output under `dist/tiles/`:

- `meta.json` — tile manifest, label tier visibility, bucket cull distances
- `notable.json` — all tier-0 (notable) labels, eager-loaded at runtime
- `systems.json` — system groupings
- `tile_bright.bin` — brightness bucket: M < 0 stars, always loaded, no cull
- `tile_<octree_path>.bin` — medium bucket (M ≥ 0), spatially tiled
- `tile_<path>.lbl.json` — sparse tier-0 + tier-1 label rows for the tile (lazy)

### Brightness buckets

Stars are split by absolute magnitude, each bucket with its own streaming
policy. This lets distant naked-eye stars render from any camera position
without needing to stream in their enormous distant tiles.

- **bright** (M < 0): ~40k stars, single always-loaded file (~620 KB). No
  distance cull — Vega, Deneb, Betelgeuse, etc. always render.
- **medium** (M ≥ 0): ~1.8M stars, octree-tiled and streamed. Cull distance
  is the apparent-mag m=6.5 limit for an M=0 star (~200 pc × SCALE).

Buckets are orthogonal to label tiers — a tier-0 notable lives in whichever
brightness bucket its absolute magnitude puts it in.

### Star clusters

Open star clusters are defined in `data/clusters.json` with hand-curated
metadata (name, aliases, wikipedia, notes) and `seed_stars` (bright members
that may be missing from automated catalogs).

**Membership** comes from [Hunt & Reffert (2023)](https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/A+A/673/A114)
(Gaia DR3, `J/A+A/673/A114/members`), stored as Gaia source ID lists in
`data/cluster-members/hunt2023.json`. At build time, these IDs are joined
against AT-HYG's `gaia` column. Bright stars often lack Gaia astrometry
(saturation), so `seed_stars` from `clusters.json` are always included
regardless of Gaia membership.

If `hunt2023.json` is missing, the build falls back to a spatial-radius
heuristic (all catalog stars within `radius_pc` of the seed centroid).

**To update cluster membership:**

**To add a new cluster:**

1. Add an entry to `data/clusters.json` with `aliases`, `seed_stars`,
   `wikipedia`, and `notes`.
2. Query Hunt & Reffert (2023) on VizieR for the cluster's Gaia DR3
   member IDs. VizieR uses Melotte/Collinder/NGC designations (e.g.
   `NGC_6124`, `Melotte_22`). Filter for `Prob > 0.5` and add the
   Gaia ID list to `data/cluster-members/hunt2023.json` under the
   display name used in `clusters.json`.
3. Fetch astrometry for the new members:
   `python3 scripts/fetch-hunt2023-astro.py`
4. Rebuild: `python3 scripts/build-catalog.py ...`

**Cluster data files:**

- `data/clusters.json` — Cluster metadata: name, aliases, seed stars,
  wikipedia, notes. Keyed by display name.
- `data/cluster-members/hunt2023.json` — Gaia DR3 source IDs per cluster
  from Hunt & Reffert (2023). Used at build time to assign AT-HYG stars
  to clusters via `gaia` column matching.
- `data/cluster-members/hunt2023-astro.json` — RA/Dec/parallax/Gmag/BP-RP
  per member, fetched from VizieR. Members not in AT-HYG (too faint for
  Tycho-2) are injected as synthetic tier-2 point-cloud stars so clusters
  appear visually complete. Also provides positions for centroid computation.

**Runtime behavior:** cluster labels render at a fixed centroid (computed
from all members), with a distinct style. Member star labels are hidden
when they collide with the cluster label on screen but reappear as you
zoom in. Selecting/hovering a cluster glows member star billboards without
glowing their individual labels. Clusters are searchable by name, alias,
or the term "cluster".

### Source modules

- `src/main.ts` — Entry point: input wiring, render loop, system label hooks
- `src/catalog.ts` — Eager catalog loader (meta + notable + systems) and lazy per-tile label fetch
- `src/starfield.ts` — Octree streaming for geometry + label tiles, billboard spawning, dynamic SystemGroups
- `src/billboard.ts` — Billboard mesh + label factories
- `src/types.ts` — `Star` is an alias for `LabelRow`; `SystemGroup` shape
- `src/constants.ts` — Magic numbers, thresholds, shared CSS
- `src/scene.ts` — Three.js setup, camera orbit, galactic grid, bloom, animation
- `src/interaction.ts` — Hover/select state, star/system highlighting
- `src/labels.ts` — Per-frame label visibility, fade thresholds, system collapse clustering
- `src/detail.ts` — Info panel rendering
- `src/search.ts` — Search UI
- `src/searchFilter.ts` — Pure search matching logic (testable without DOM)
- `src/labelVisibility.ts` — Pure highlight/visibility decision functions (testable)
- `src/labelRegistry.ts` — Unified label type registry for cross-type coordination
- `src/labelCanvas.ts` — 2D canvas label overlay; sole label renderer (replaced CSS2DRenderer)
- `src/nebulaeLabels.ts` — Nebula label registrations + selection handler
- `src/blackholes.ts` — Black hole labels + point rendering, registered via labelRegistry
- `src/dust.ts` — 3D dust volume ray marcher (Lallement/Vergely data + hot-star illumination)
- `src/systemStore.ts` — Centralized selection/hover state for stars, clusters, systems
- `src/systemDispatch.ts` — Polymorphic dispatch functions for SystemGroup variants

### Other files

- `server.ts` — Bun.serve() entry point with HTML imports; serves `/tiles/*` from `dist/tiles/`
- `build.ts` — Static build script (bundles to `dist/`)
- `index.html` — App shell (styles + markup + viewport wrapper)
- `scripts/build-catalog.py` — Builds the unified catalog from AT-HYG + augmentations
- `scripts/audit-notable.py` — Reports tier-0 stars missing wikipedia / notes / traditional aliases (`--json` for machine-readable output)
- `scripts/bake-dust.py` — Downloads Lallement/Vergely FITS cube, bakes RGBA dust texture with hot-star illumination
- `scripts/snap-nebula-labels.py` — Snaps nebula label positions to nearest emission peaks in the baked dust volume
- `scripts/fetch-hunt2023-astro.py` — Downloads RA/Dec/parallax/photometry from VizieR for Hunt & Reffert cluster members
- `scripts/merge-augmentations.py` — Merges research-batch JSON files into `data/augmentations.json`, preserving existing fields
- `data/augmentations.json` — Hand-curated overrides: Wikipedia links, names, notes, aliases, system groupings, synthetic companions. Keyable by Gliese ID / HIP / "Sol" OR by IAU proper name; both entries merge with proper-name winning on conflict.
- `data/clusters.json` — Star cluster definitions: name, aliases, seed stars, wikipedia, notes
- `data/cluster-members/hunt2023.json` — Gaia DR3 membership IDs from Hunt & Reffert (2023), keyed by cluster name
- `data/cluster-members/hunt2023-astro.json` — RA/Dec/parallax/Gmag/BP-RP for each member (fetched from VizieR)
- `data/constellations.json` — Constellation line definitions for the 37 rendered constellations
- `data/nebulae.json` — Molecular cloud definitions: positions (galactic Cartesian), metadata, wikipedia
- `data/blackholes.json` — Stellar-mass black holes: RA/Dec, distance, mass, metadata
- `data/cache/` — Downloaded source data (gitignored): FITS cubes, etc.
- `dist/tiles/dust_volume_rgba.bin` — Baked RGBA 3D texture (density + hot-star illumination)
- `dist/tiles/dust_meta.json` — Dust volume dimensions and format metadata
- `dist/tiles/nebulae.json` — Runtime nebula data with baked scene coordinates
- `.claude/skills/research/SKILL.md` — Documented workflow for filling tier-0 metadata gaps in batches via research subagents
- `docs/stars.md` — Star rendering documentation (shader, bloom, sizing)
- `docs/starfield.md` — Streaming pipeline + binary format + tier model + catalog scope rationale
- `docs/data-corrections.md` — Corrections applied on top of source data
- `docs/nebulae.md` — Nebula/ISM rendering: 3D dust volume with hot-star illumination, accuracy breakdown, planned improvements
- `docs/data-sources.md` — External data sources, what we extract, known issues, coordinate transforms
- `docs/vision.md` — Long-term vision: full-scale-range viewer (planet surface → galaxy). Not on the current roadmap; consult before making decisions that would foreclose floating-origin retrofits or LOD/sub-scene splits.
- `docs/profiling.md` — Perf measurement infrastructure (stats panel, P-key sampler, bench automation, phase timing) and a log of optimizations tried + what the bench said about each.
- `docs/canvas-labels-plan.md` — Canvas-labels migration (shipped): replaced CSS2DRenderer with a 2D canvas overlay. Documents the 5-stage rollout and measured outcome.
- `vendor/athyg/` — AT-HYG v3.3 star catalog (git submodule, LFS for CSV data)

### Label tiers

Classification is independent of curation metadata — augmentations (wikipedia, notes,
aliases) still merge onto whatever tier the star ends up in, so a tier-1 star's detail
panel can be rich without it being promoted to tier 0.

All stars render through the same instanced-quad shader (`src/stars.ts`)
— tiers differ only in labeling and interaction. Anchors are lightweight
`Object3D`s (no geometry); the instanced mesh draws every star.

- **Tier 0 (notable)** — IAU proper name AND apparent magnitude < 4.0,
  OR an explicit `"notable": true` in its augmentation. ~265 stars
  globally. Anchors loaded eagerly from `notable.json` with always-on
  CSS2D labels (subject to `NOTABLE_FADE_NEAR/FAR` distance fade).
- **Tier 1 (named)** — any catalog name (Bayer/Flamsteed/Gliese/HIP/HD/HR)
  AND either `mag < 6.0` OR an `aug.system` entry (to keep multi-star
  system companions like Sirius B selectable). Anchor + child CSS2D
  label spawn when the tile is within `meta.labelTierVisibility["1"]`
  of the camera and despawn on eviction.
- **Tier 2 (none)** — no name or too faint. Rendered by the instanced
  mesh like everything else, but no anchor / label / hit target.
- **Explicit `"notable": false`** — demotes a star to tier 2 regardless of
  brightness/name. Escape hatch; rarely used.

### Star naming (in build-catalog.py)

Priority order:

1. **IAU proper name** — "Sirius", "Proxima Centauri", "Sol"
2. **Bayer + constellation** — "Alp CMa"
3. **Flamsteed + constellation** — "9 CMa"
4. **Gliese catalog** — "Gl 65A"
5. **Hipparcos** — "HIP 82724"
6. **Henry Draper** — "HD 265866"
7. **Harvard Revised** — "HR 2491"

Augmentations (keyed by Gliese / HIP / "Sol") can override the primary name and
attach Wikipedia links, notes, and system groupings. Synthetic companion blocks
inject stars that don't exist in the source catalog (e.g. Sirius B).

### Stack

- **Runtime/bundler:** Bun (HTML imports, HMR)
- **3D:** Three.js with custom GLSL shaders, 2D canvas overlay for labels, UnrealBloomPass
- **Data:** [AT-HYG v3.3](https://codeberg.org/astronexus/athyg) with Gaia DR3 distances (CC-BY-SA 4.0); cluster membership from [Hunt & Reffert 2023](https://vizier.cds.unistra.fr/viz-bin/VizieR?-source=J/A+A/673/A114) (Gaia DR3); 3D dust from [Lallement/Vergely 2022](https://cdsarc.cds.unistra.fr/viz-bin/cat/J/A+A/661/A147) (CC-BY 4.0)
- **Hosting:** Vercel (static)
