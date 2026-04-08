# Constellations

Constellations in Drake are **topological**, not coordinate-based: each constellation is a list of star-pair lines, and the runtime draws line segments between the actual 3D positions of those stars in the catalog. As the camera moves through space, the visual shape of a constellation changes naturally via parallax — viewing Orion from Sol shows the familiar hunter, but jumping to Betelgeuse and looking back gives a completely different arrangement of the same stars.

This is the right model because constellations are *defined by which stars belong together*, not by the angular pattern Earth observers happen to see. Storing the pattern as star pairs makes the same data correct from any viewpoint.

## Data file: `data/constellations.json`

```json
{
  "Orion": {
    "iau": "Ori",
    "description": "The Hunter, anchored by Betelgeuse and Rigel.",
    "lines": [
      ["Meissa", "Betelgeuse"],
      ["Betelgeuse", "Bellatrix"],
      ["Mintaka", "Alnilam"]
    ]
  }
}
```

| Field | Required | Notes |
|---|---|---|
| top-level key | yes | Display name. Also the lookup key inside the runtime. |
| `iau` | yes | 3-letter IAU constellation abbreviation (`Ori`, `UMa`, `Cas`, …). Stable identifier independent of display name; useful for cross-referencing external sources. |
| `description` | optional | 1–3 sentences for the detail panel when the constellation is selected. Plain text. |
| `lines` | yes | Array of `[starA, starB]` pairs. Star names must match a catalog primary `name` exactly (e.g. `"Betelgeuse"`, not `"Alpha Orionis"`). |

### Star naming

Lines reference stars by their **catalog primary name** — the same string that ends up in the `name` field of `notable.json` / per-tile label rows. For tier-0 stars this is the IAU proper name; for tier-1 stars it falls back to the Bayer/Flamsteed/Gliese/HIP/HD form. In practice, every star you'd want in a constellation is tier-0 and has a proper name.

If a constellation references a name that the build can't resolve, the build script should warn (TBD: add this check). Until then, keep an eye on the count when rendering.

### Asterisms vs IAU constellations

The IAU defines 88 official constellations, but the famous *visual* shapes are often asterisms — sub-patterns within (or spanning) IAU constellations. Drake treats them uniformly:

- **Big Dipper** — asterism inside Ursa Major. We use the asterism rather than the full IAU constellation because the seven Dipper stars are universally recognized.
- **Northern Cross** — asterism inside Cygnus.
- **Summer Triangle**, **Winter Hexagon**, **Great Square of Pegasus** — could be added the same way.

For an asterism, set `iau` to the IAU constellation it lives inside (or the dominant one if it spans several).

## Runtime contract (not yet implemented)

The viewer should:

1. **Load eagerly** at boot via `catalog.ts`, alongside `notable.json` and `systems.json`. Constellations are small (~tens of KB), all referenced stars are tier-0, and they're a global feature.

2. **Resolve star names** to the runtime targets used elsewhere (notable anchors / tier-1 billboards). For tier-0 stars, the lookup is via `notableObjects` filtered by `userData.name`. Cache this lookup once at boot.

3. **Render lines** as `THREE.LineSegments` (one big buffer for all constellations is fine — line counts are tiny). Use a thin, semi-transparent shader so lines don't overpower the star field. Color either uniform (e.g. dim blue-grey) or per-constellation.

4. **Update positions** when the underlying anchor positions change. For tier-0 anchors this is never (positions are baked from `notable.json`), so the line buffer can be built once. For tier-1, lines should hide / partially-render until the tile is loaded.

5. **Visibility toggle**: bind a key (suggest `c`) to show/hide all constellation lines. Off by default? Or on? TBD.

6. **Selection / hover**: clicking a constellation line could select the constellation (showing its description in the detail panel and listing member stars). This is a stretch goal — the first cut should just render the lines.

7. **Per-viewer parallax**: nothing special needed. Lines connect 3D positions; perspective is automatic. The user-visible *feature* is being able to fly to another star and see the constellation shape distort or invert — but this happens for free.

## Source for line patterns

The lines in `data/constellations.json` use a mix of conventional / textbook patterns:

- **H. A. Rey patterns** ("The Stars: A New Way to See Them") for Orion's body and Leo's full shape. These are more anatomically suggestive than the bare-IAU patterns.
- **Stellarium asterism set** for the simpler patterns (Cassiopeia W, Northern Cross).
- **Best-judgment hybrid** for Scorpius and Canis Major where multiple traditions disagree.

When adding new constellations, prefer recognizable popular patterns over esoteric historical ones — the goal is "user thinks: yes that's Cygnus", not bibliographic completeness.

## Adding new constellations

1. Pick a constellation. Confirm its star names exist in `data/augmentations.json` or are tier-0 in `dist/tiles/notable.json`.
2. Sketch the line pattern. Two heuristics:
   - Use the brightest stars first.
   - Prefer 5–15 lines per constellation. Fewer feels sparse; more clutters and obscures the underlying stars.
3. Add an entry to `data/constellations.json` keyed by display name.
4. (Once runtime exists) reload, toggle `c`, verify the shape looks right from Sol.
5. (Once runtime exists) fly to a star inside the constellation and verify the lines render at the new perspective.

## Current set

Starter constellations in the file:

- **Orion** — Hunter
- **Big Dipper** — Ursa Major asterism
- **Cassiopeia** — Queen
- **Crux** — Southern Cross
- **Northern Cross** — Cygnus asterism
- **Lyra** — Lyre
- **Leo** — Lion
- **Scorpius** — Scorpion
- **Canis Major** — Greater Dog

All reference only tier-0 stars, so they'll render reliably from any camera position once the runtime feature lands.
