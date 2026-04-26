# Constellations

Constellations in Drake are **topological**: each constellation is a list of star-pair lines, and the runtime draws line segments between the actual 3D positions of those stars. As the camera moves through space, the visual shape changes naturally via parallax — viewing Orion from Sol shows the familiar hunter, but jumping to Betelgeuse and looking back gives a completely different arrangement.

## Data file: `data/constellations.json`

```json
{
  "Orion": {
    "iau": "Ori",
    "description": "The Hunter. Anchored by Betelgeuse and Rigel.",
    "wikipedia": "https://en.wikipedia.org/wiki/Orion_(constellation)",
    "lines": [
      ["Meissa", "Betelgeuse"],
      ["Betelgeuse", "Bellatrix"]
    ],
    "stars": {
      "Meissa": [107.72, 174.26, -989.11],
      "Betelgeuse": [9.57, 59.05, -454.09]
    }
  }
}
```

| Field | Required | Notes |
|---|---|---|
| top-level key | yes | Display name (canonical IAU name, e.g. "Ursa Minor" not "Lesser Bear"). |
| `iau` | yes | 3-letter IAU abbreviation (`Ori`, `UMa`, `Cas`, ...). |
| `description` | optional | 1-3 sentences for the detail panel. Includes English meaning. |
| `asterism` | optional | `true` for sub-patterns like Big Dipper and Northern Cross. |
| `wikipedia` | optional | URL to the Wikipedia article. |
| `lines` | yes | Array of `[starA, starB]` pairs. Names must match catalog entries or `stars` keys. |
| `stars` | optional | Embedded `[x, y, z]` scene-space positions for stars not in the main catalog. Fallback for tier-1+ stars sourced from HYG v38 / AT-HYG. |

### Star resolution

Stars are resolved in priority order:
1. **Tier-0 notable anchors** — scene objects from `notable.json` (271 stars, precise positions)
2. **Tier-1 named stars** — search index from `names.json` (~5k stars)
3. **Embedded positions** — the `stars` field in the constellation entry (fallback for stars not in the catalog)

This three-tier approach means constellation lines can reference any star, even those too faint for the named catalog. The embedded positions were sourced from the HYG v38 database with the AT-HYG coordinate transform (`sx = x*SCALE, sy = z*SCALE, sz = -y*SCALE`).

### Data source

Line patterns are from Stellarium's `modern_iau` sky culture, which uses Hipparcos (HIP) star identifiers. A generation script resolved HIP numbers to positions via HYG v38 and AT-HYG catalogs. Display names follow the canonical IAU constellation names per Wikipedia's IAU designated constellations list.

### Coverage

All 88 IAU constellations plus two asterisms (Big Dipper, Northern Cross). 766 unique line segments across 744 unique stars. Every constellation has at least one line.

## Runtime: `src/constellations.ts`

### Architecture

Each constellation gets:
- A **separate `THREE.LineSegments` mesh** with its own material for independent hover/selection color control
- A **canvas label** at the sky-projected centroid (unit-vector average of star directions, scaled to representative distance)
- A **search index entry** (kind `"x"`) injected at runtime

### Sol-distance fading

Constellations are a Sol-centric 2D projection — from far away the lines become chaotic. All lines and labels fade based on camera distance from Sol:
- Full opacity within 5 ly
- Linear fade to zero by 30 ly

### Visual style

- **Base lines**: `0xaabbdd`, opacity 0.22, additive blending, no depth write
- **Hover**: shifts to `0xddeeff`, opacity 0.5
- **Selected**: shifts to `0xddeeff`, opacity 0.7
- **Labels**: 14px, `rgba(180,210,255,0.85)` — bold blue to stand out

### Overlay selection

Constellation selection uses the `overlay` flag on `LabelTypeHandler`. This means:
- Selecting a constellation **keeps the current star/system focus** — the camera stays anchored
- The camera **rotates to face** the constellation centroid (same `lookToward` as search preview)
- The constellation detail panel shows **on top of** the star info
- Selecting a star or clicking empty space clears the constellation selection

### Label priority

When constellations are visible:
1. **Constellation labels** — rank 3000 (highest)
2. **Constellation member stars** — rank boosted by +2500
3. **Other labels** — normal rank

Toggling constellations off removes the star rank boost and triggers collision recalculation.

### Detail panel

Shows: constellation name, IAU abbreviation, type (Constellation/Asterism), line and star counts, description with English meaning, Wikipedia link, and clickable member star names. Clicking a star name navigates to that star.

### Search

Typing "constellation" or "asterism" returns all entries. Typing a name (e.g. "orion") or IAU code (e.g. "ori") matches directly. Results show with a "Constellation" badge.

### Keyboard / URL

- `c` key toggles constellation visibility
- URL param: `?c=0` (hidden) or `?c=1` (shown), default on
