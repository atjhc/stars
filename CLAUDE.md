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
curl -L -o hyglike.csv.gz \
  "https://codeberg.org/astronexus/hyg/media/branch/main/data/athyg_v3/hyglike_from_athyg_v32.csv.gz"
gunzip hyglike.csv.gz
python3 scripts/extract-stars.py hyglike.csv src/stars.json data/augmentations.json
```

### Source modules

- `src/main.ts` — Entry point: star/system creation, input event wiring, render loop
- `src/types.ts` — Star and SystemGroup interfaces
- `src/constants.ts` — All magic numbers, thresholds, and shared CSS
- `src/scene.ts` — Three.js setup, camera orbit, galactic grid, bloom, animation
- `src/interaction.ts` — Hover/select state, star/system highlighting, system members
- `src/labels.ts` — Per-frame label visibility, opacity fading, screen-space collapse clustering
- `src/detail.ts` — Info panel rendering (star and system detail)
- `src/search.ts` — Search UI, query filtering, result rendering
- `src/stars.json` — 750 nearest stars extracted from HYGLike with augmentations

### Other files

- `server.ts` — Bun.serve() entry point with HTML imports
- `build.ts` — Static build script (bundles to dist/)
- `index.html` — App shell (styles + markup + viewport wrapper)
- `scripts/extract-stars.py` — Extracts and names stars from the HYGLike CSV
- `data/augmentations.json` — Hand-curated overrides: Wikipedia links, name fixes, notes, system groupings, synthetic companions (keyed by Gliese ID)
- `docs/stars.md` — Star rendering documentation (shader, bloom, sizing)
- `docs/data-corrections.md` — Corrections applied on top of source data

### Star naming

Names are assigned by `extract-stars.py` in priority order:

1. **IAU proper name** — "Sirius A", "Proxima Centauri"
2. **Inherited proper name + component** — "Sirius B", "Ross 614 B"
3. **Bayer/Flamsteed** (parsed to readable form) — "61 Cygni A", "Tau Ceti"
4. **Gliese catalog** — "Gl 65A", "GJ 1061"
5. **Hipparcos** — "HIP 82724"
6. **Henry Draper** — "HD 265866"

Component letters (A/B/C) are appended for multi-star systems. Proper names
only get suffixed when the same name appears on multiple components in a system.

### Stack

- **Runtime/bundler:** Bun (HTML imports, HMR)
- **3D:** Three.js with custom GLSL shaders, CSS2DRenderer for labels, UnrealBloomPass
- **Data:** [HYGLike from AT-HYG v3.2](https://codeberg.org/astronexus/hyg) with Gaia DR3 distances (CC-BY-SA 4.0)
- **Hosting:** Vercel (static)
