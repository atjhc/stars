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
curl -L -o hyg_v42.csv.gz \
  "https://codeberg.org/astronexus/hyg/media/branch/main/data/hyg/CURRENT/hyg_v42.csv.gz"
gunzip hyg_v42.csv.gz
python3 scripts/extract-stars.py hyg_v42.csv src/stars.json
```

### Structure

- `server.ts` — Bun.serve() entry point with HTML imports
- `build.ts` — Static build script (bundles to dist/)
- `index.html` — App shell (styles + markup)
- `src/main.ts` — Three.js scene, camera, interaction logic
- `src/stars.json` — 300 nearest stars extracted from HYG v4.2 database
- `scripts/extract-stars.py` — Extracts and names stars from the HYG CSV

### Star naming

Names are assigned by `extract-stars.py` in priority order:

1. **IAU proper name** — "Sirius", "Proxima Centauri"
2. **Inherited proper name + component** — "Sirius B", "Ross 614 B"
3. **Bayer/Flamsteed** (parsed to readable form) — "61 Cygni A", "Tau Ceti"
4. **Gliese catalog** — "Gl 65A", "GJ 1061"
5. **Hipparcos** — "HIP 82724"
6. **Henry Draper** — "HD 265866"

Component letters (A/B/C) are appended for multi-star systems. Proper names
only get suffixed when the same name appears on multiple components in a system.

### Stack

- **Runtime/bundler:** Bun (HTML imports, HMR)
- **3D:** Three.js with CSS2DRenderer for labels, custom ShaderMaterial for grid fade
- **Data:** [HYG v4.2](https://codeberg.org/astronexus/hyg) star catalog (CC-BY-SA 4.0)
