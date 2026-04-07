## Drake - Stellar Neighborhood Viewer

3D visualization of nearby stars using Three.js, served with Bun.

### Dev

```sh
bun install
bun run dev     # starts dev server with HMR at http://localhost:3000
bun run build   # builds static site to dist/
```

### Deploy

Configured for Vercel static deployment via `vercel.json`. Run `vercel` to deploy.

### Updating star data

```sh
curl -L -O "https://codeberg.org/astronexus/hyg/media/branch/main/data/athyg_v3/athyg_v33.csv.gz"
gunzip athyg_v33.csv.gz
python3 scripts/build-catalog.py athyg_v33.csv data/augmentations.json dist/tiles/
```

This produces the unified catalog under `dist/tiles/`:

- `meta.json` — tile manifest, label tier visibility radii
- `notable.json` — all tier-0 (notable) labels, eager-loaded at runtime
- `systems.json` — system groupings
- `tile_<path>.bin` — geometry tile (16 bytes/star, streams to GPU)
- `tile_<path>.lbl.json` — sparse tier-0 + tier-1 label rows for the tile (lazy)

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

### Other files

- `server.ts` — Bun.serve() entry point with HTML imports; serves `/tiles/*` from `dist/tiles/`
- `build.ts` — Static build script (bundles to `dist/`)
- `index.html` — App shell (styles + markup + viewport wrapper)
- `scripts/build-catalog.py` — Builds the unified catalog from AT-HYG + augmentations
- `scripts/audit-notable.py` — Reports tier-0 stars missing wikipedia / notes / traditional aliases (`--json` for machine-readable output)
- `scripts/merge-augmentations.py` — Merges research-batch JSON files into `data/augmentations.json`, preserving existing fields
- `data/augmentations.json` — Hand-curated overrides: Wikipedia links, names, notes, aliases, system groupings, synthetic companions. Keyable by Gliese ID / HIP / "Sol" OR by IAU proper name; both entries merge with proper-name winning on conflict.
- `.claude/skills/research/SKILL.md` — Documented workflow for filling tier-0 metadata gaps in batches via research subagents
- `docs/stars.md` — Star rendering documentation (shader, bloom, sizing)
- `docs/starfield.md` — Streaming pipeline + binary format
- `docs/data-corrections.md` — Corrections applied on top of source data

### Label tiers

Classification is independent of curation metadata — augmentations (wikipedia, notes,
aliases) still merge onto whatever tier the star ends up in, so a tier-1 star's detail
panel can be rich without it being promoted to tier 0.

- **Tier 0 (notable)** — IAU proper name AND apparent magnitude < 4.0, OR an
  explicit `"notable": true` in its augmentation. ~265 stars globally. Loaded
  eagerly from `notable.json` as persistent `Object3D` anchors with always-on
  CSS2D labels (subject to `NOTABLE_FADE_NEAR/FAR` distance fade). When their
  tile streams in at close range, a visual billboard mesh spawns alongside the
  anchor; canvas raycast hits route through `canonicalTarget()` back to the
  anchor so identity stays consistent.
- **Tier 1 (named)** — any catalog name (Bayer/Flamsteed/Gliese/HIP/HD/HR) AND
  either `mag < 6.0` OR an `aug.system` entry (to keep multi-star system
  companions like Sirius B selectable). Billboard + child CSS2D label spawn
  when the tile is within `meta.labelTierVisibility["1"]` of the camera and
  despawn on eviction.
- **Tier 2 (none)** — no name or too faint. Pure point cloud, not interactive.
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
- **3D:** Three.js with custom GLSL shaders, CSS2DRenderer for labels, UnrealBloomPass
- **Data:** [AT-HYG v3.3](https://codeberg.org/astronexus/hyg) with Gaia DR3 distances (CC-BY-SA 4.0)
- **Hosting:** Vercel (static)
