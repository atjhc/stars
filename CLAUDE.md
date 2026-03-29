## Drake - Stellar Neighborhood Viewer

3D visualization of nearby stars using Three.js, served with Bun.

### Dev

```sh
bun install
bun run dev     # starts dev server with HMR at http://localhost:3000
```

### Structure

- `server.ts` — Bun.serve() entry point with HTML imports
- `index.html` — App shell (styles + markup)
- `src/main.ts` — Three.js scene, camera, interaction logic
- `src/stars.json` — 300 nearest stars extracted from HYG v4.2 database

### Stack

- **Runtime/bundler:** Bun (HTML imports, HMR)
- **3D:** Three.js with CSS2DRenderer for labels
- **Data:** HYG v4.2 star catalog (parsec coordinates, B-V color index)
