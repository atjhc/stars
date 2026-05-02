# Labels

## Overview

Drake uses a single 2D canvas overlay to render all text labels — star
names, system/cluster labels, nebula names, black hole names, and
neutron star names. This replaced the Three.js `CSS2DRenderer` + DOM
`<div>` approach, cutting frame time by ~65% (13.3 ms → 4.7 ms p50).

Related files:

- `src/labelCanvas.ts` — canvas layer, text measurement cache, pointer
  handling, collision grid, per-frame paint.
- `src/labels.ts` — per-frame star label visibility, system collapse,
  disc occluder registration.
- `src/labelRegistry.ts` — unified label type registry for cross-type
  coordination (visibility toggle, selection clearing, detail panel).
- `src/labelVisibility.ts` — pure highlight/visibility decision functions.
- `src/starOcclusion.ts` — CPU helpers for label-margin placement and
  occlusion sizing.

## Architecture

### Data model

Each label is a `CanvasLabelDescriptor` record, not a DOM node:

```typescript
interface CanvasLabelDescriptor {
  id: string;           // stable across frames (e.g. "star:Sirius", "blackhole:Gaia BH1")
  kind: LabelKind;      // "star" | "system" | "nebula" | "blackhole" | "neutronstar"
  anchor: Vector3;      // world position for projection
  text: string;         // primary text (name)
  subtitles?: string[]; // optional extra lines (distance, member names)
  font: string;
  color: string;
  shadowColor?: string;
  shadowBlur?: number;
  rank: number;         // collision priority (higher wins)
  pinned: boolean;      // exempt from collision hiding
  marginTop: number;    // px offset below the projected anchor
  centered?: boolean;   // vertically centered on anchor (clusters, nebulae, BH)
  opacityTarget: number;
  hidden?: boolean;     // force-hidden by caller (distinct from collision)
}
```

Labels register/unregister through `registerCanvasLabel` and
`unregisterCanvasLabel`. Updates flow through `updateCanvasLabel(id, patch)`.

Internally the renderer keeps two parallel structures: a `Map<string,
CanvasLabel>` for id-keyed lookups (selection, hit testing, update)
and a `CanvasLabel[]` array iterated by the per-frame project pass.
Each label carries a `_listIdx` field so `unregisterCanvasLabel` can
swap-and-pop in O(1). Array iteration is meaningfully faster than
`Map.values()` at the thousands-of-labels working set.

### Frame pipeline

Every frame, inside `animate()`:

1. **Project** all active labels using `projectToLabelScreen` (Float64
   two-part decomposition from the camera origin — matches the star
   shader's precision). Skip labels where `behind === true`. Also
   skip steady-state-invisible labels (`visibleFactor === 0` AND
   either `hidden` or `opacityTarget < COLLISION_ALPHA_CUTOFF`) —
   their next collide pass would keep them at 0, so projection is
   wasted. Mid-fade labels still project so their fade-out renders
   at the correct screen position.

2. **Measure** text via an offscreen canvas `measureText`, cached by
   `font|text` key. Unique combinations are bounded (few hundred names
   × ~3 font variants).

3. **Fade**: interpolate `visibleFactor` toward the collision decision
   (0 or 1) over ~400 ms. Painted alpha = `opacityTarget × visibleFactor`.

4. **Collision** (batched, not every frame): sort by `(pinned desc,
   rank desc)`. Labels that overlap a higher-priority placed rect, or
   fall inside a screen occluder, get `collisionVisible = false`.

5. **Paint**: clear the canvas, set `devicePixelRatio` transform, draw
   each non-hidden label with `fillText`. Optional subtitle lines
   painted below. Shadow/glow applied via `ctx.shadowColor` /
   `ctx.shadowBlur`.

6. **Hit regions**: publish a flat array of `{ labelId, rect }` for
   non-hidden labels, used by the pointer handler.

### Collision system

Collision is batched — not re-run every frame — so fade animations
play out smoothly. `markCanvasCollisionDirty()` triggers a re-evaluation
on the next frame.

Labels are sorted by priority:
- **Pinned labels** (selected/hovered) always win.
- **Rank** determines priority among non-pinned labels. Rank values
  by type: notable stars ~500 + apparent-mag bonus, tier-1 stars ~0,
  systems ~1000, clusters ~1500, neutron stars ~1700, black holes ~1800.
  Favorited labels get a +5000 bonus.

The collision grid detects overlap between label bounding rects with
`COLLISION_PAD_PX` padding. Labels below `COLLISION_ALPHA_CUTOFF`
opacity are excluded from collision checks.

### Mobile label filter

`spawnTier1Anchor` skips `registerCanvasLabel` for tier-1 stars whose
`mag` (apparent magnitude from Sol) exceeds
`qualityProfile.tier1LabelMaxMag` (3.5 on mobile — keeps only the
brightest ~180 tier-1 named stars; `Infinity` on desktop — no
filter). The billboard mesh still spawns and the anchor still goes
into `allInteractiveStars` / `tier1Meshes` (so selection, hover, and
shader-gated rendering are unchanged); just no canvas label. The
philosophy split: desktop is a survey tool, mobile is for finding
and observing specific targets in a sky that's too small to clutter.

Filtering by apparent-mag rather than absolute-mag because the streamed
catalog is already apparent-mag-bounded — most tier-1 stars have absMag
≤ 7, so an absMag filter barely cuts. Apparent-mag is the actual
"would the user notice this from Earth" signal. The known limitation
is that an intrinsically-bright distant star (high apparent mag from
Sol but bright at close approach) won't have a label even when you
navigate to it.

### Screen occluders

`labelRegistry.ts` collects screen-space circular occluders — one per
rendered star disc larger than 2 pixels. Labels whose anchor projects
inside an occluder are hidden. This prevents text from rendering on top
of bright star discs.

### Pointer handling

A single `window` mousemove/mouseup listener scans the per-frame
hit-region list for the first rect containing the cursor. Hits dispatch
into the label type's handler (`selectByName`, `setHoverByName`).
O(n) scan with n ≈ 100-300 visible labels, ~0.1 ms on mousemove only.

## Label type registry

`labelRegistry.ts` provides the `LabelTypeHandler` interface:

```typescript
interface LabelTypeHandler {
  readonly type: string;
  readonly overlay?: boolean;
  setVisible(visible: boolean): void;
  update(): void;
  selectByName(name: string): boolean;
  clearSelection(): void;
  getSelectedName(): string | null;
  setHoverByName(name: string | null): void;
  handleClick(div: HTMLElement): boolean;
  detailHtml(): string | null;
}
```

Each label type (nebulae, BH, NS, constellations) registers a handler.
The registry coordinates cross-type concerns:

- `setAllLabelsVisible(v)` — toggles all label types.
- `clearAllSelections(except?)` — clears all types except the one being
  selected.
- `selectByType(type, name)` — clears others, selects by name. For
  `overlay` handlers, keeps the star/system focus intact.
- `getActiveDetailHtml()` — returns detail HTML; overlay handlers
  take priority (constellation info shows on top of star selection).
- `clearHoverExcept(type)` — clears hover on all handlers except
  the given type.

## Star label visibility

`labels.ts#updateLabels` runs each dirty frame and manages per-star
label state:

### Tier-0 (notable) stars

- Opacity fades based on apparent magnitude: full opacity until the star
  is within 0.5 mag of the render cutoff, then smooth fade to zero.
- Additional distance-from-Sol fade: nearer notables are brighter.
- Rank based on apparent magnitude (brighter = higher priority).
- Sol gets a +3000 rank bonus.

### Tier-1 (named) stars

- Simple distance fade: full opacity nearby, smooth fade over
  `LABEL_FADE_NEAR` to `LABEL_FADE_FAR`, hidden past `LABEL_HIDE_DIST`.
- Lower rank than tier-0 — they yield in collisions.

### Highlighted stars

Selected and hovered stars get:
- `pinned = true` (exempt from collision).
- `opacityTarget = 1` (full brightness).
- Colored glow matching the star's B-V color index.
- Distance subtitle line.

### System member collapse

Binary/trinary systems use a union-find algorithm in screen space.
When members are within `COLLAPSE_PX` pixels of each other, individual
labels hide and a system label appears at the centroid. When focus is
on a member, collapse is disabled. See [clusters.md](clusters.md) for
the cluster variant.

### Transit behavior

During transit animation, the full collision/visibility pass is skipped.
Only the destination star's label is updated — its margin and subtitle
track the disc as it grows on approach. Other labels resume normal
updates near arrival (within `ARRIVAL_COLLISION_DIST`).

## Label styling by type

| Type | Color | Font | Shadow |
|---|---|---|---|
| Star (tier-0/1) | white | 12px sans-serif | black, blur 4 |
| Star (highlighted) | white | 12px sans-serif | star-color glow, blur 10 |
| System (binary) | white | 12px sans-serif | varies with state |
| Cluster | pale powder-blue | 12px sans-serif | black / blue glow |
| Nebula | warm orange | 12px sans-serif | orange glow |
| Black hole | purple | 12px sans-serif | purple glow |
| Neutron star | cyan-teal | italic 12px sans-serif | teal glow |

## Performance

Canvas labels reduced frame time from 13.3 ms to 4.7 ms p50 by
eliminating the CSS2DRenderer (~3 ms), DOM style writes in
updateLabels (~4.5 ms), and the post-transform layout flush in
flushCollisions (~2 ms). The canvas pipeline costs ~1.6 ms for
projection + measurement + collision + painting.

See `docs/profiling.md` for measurement methodology.
