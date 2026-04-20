# Canvas Labels — Implementation

Replaces the Three.js `CSS2DRenderer` + ~500 `<div>`s with a single
2D canvas layer that paints all labels each frame.

Status: **Shipped.** Migrated in 5 stages, each a commit behind the
`?labelsMode=canvas` flag. Stage 4 removed the flag and
`CSS2DRenderer`.

Measured outcome (headless Chrome, 15s trajectory, 1280×800):

| metric              | before | after | Δ        |
| ------------------- | ------ | ----- | -------- |
| p50 frame ms        | 13.3   | 4.7   | −65%     |
| fps (avg)           | 69     | 120   | +74%     |
| updateLabels ms     | 6.56   | 1.99  | −70%     |
| labelRenderer ms    | 3.00   | —     | removed  |
| flushCollisions ms  | 1.95   | —     | removed  |
| labelCanvas ms      | —      | 1.63  | new      |

See `docs/profiling.md` for the measurement tooling.

## Why

Phase timing on the 15s bench trajectory:

| phase           | per-frame ms | what                                      |
| --------------- | ------------ | ----------------------------------------- |
| updateLabels    | 6.66         | processLabel × ~500 labeled stars         |
| labelRenderer   | 2.90         | CSS2DRenderer transform writes × ~500     |
| flushCollisions | 2.02         | sort + grid + some DOM rect reads         |
| sceneRender     | 1.76         | composer (scene + bloom + lensing)        |

Canvas labels can in principle eliminate all of `labelRenderer`, most
of `updateLabels`' DOM style writes (opacity / marginTop / innerHTML /
textShadow / zIndex / visibility), and the DOM-rect reads in
`flushCollisions`. Conservative estimate: **3-5 ms per frame**. That
takes us from 13ms p50 to ~8-10ms, roughly doubling the headroom at
60fps.

## Constraints

**What stays HTML.** The detail panel, info panel, search UI, debug
panel, favorite buttons, Wikipedia links, and all popups are not in
scope. Only the labels that currently render through `CSS2DRenderer`
move to canvas:

- Tier-0 notable star names (~265 anchors).
- Tier-1 streamed star names (~few hundred at any time).
- System labels (binary/trinary collapse labels, cluster labels).
- Nebula labels.
- Black hole labels.

**What must look the same.**

- Text style per label type (color, font, size, weight).
- Glow / text-shadow effect that currently matches the star color.
- Opacity / fade animations (especially the 400ms
  `labelCollision.ts::setLabelOpacity` transitions).
- Selection and hover highlights (bold glow on selected/hovered).
- Subtitle lines (distance / member names) for active labels.
- Z-order consistent with current `zIndex = f(camDist)`.

**What must still work.**

- Hover: mouse within a label's bounds triggers hover.
- Click / mouseup: selects the underlying star / system / nebula / BH.
- `isLabelInteractive(div)` semantics — labels hidden by collision or
  fade don't receive pointer events.
- URL / focus restore (labels don't own this state, should be fine).

## Architecture

Single `LabelCanvas` module. Owns a `<canvas>` sized to the viewport
(at `window.devicePixelRatio`), positioned fixed + fullscreen,
`pointer-events: none` until we wire clicks. Draws every frame on the
same rAF cadence as the rest of the app.

### Data model

Each label is a record, not a DOM node:

```ts
interface Label {
  id: string;                     // stable across frames for diffing
  kind: "star" | "system" | "nebula" | "blackhole";
  anchor: THREE.Vector3;          // world position for projection
  text: string;                   // primary text (name)
  subtitle?: string;              // optional subtitle (distance, members)
  font: string;                   // resolved at construction
  color: string;                  // base text color
  shadowColor?: string;           // glow / text-shadow
  shadowBlur?: number;
  rank: number;                   // collision priority
  pinned: boolean;                // exempt from collision hiding
  marginTop: number;              // px gap below the projected anchor

  // Per-frame derived (computed by the renderer pass, not stored long-term):
  //   screen: { x, y, behind }
  //   width, height (from cached text metrics)
  //   opacityTarget, opacityCurrent (for fade animation)
}
```

Labels register/unregister through a small API (parallel to the
current `labelRegistry`):

```ts
const labelCanvas = createLabelCanvas();
labelCanvas.register(star.id, labelDescriptor);
labelCanvas.unregister(star.id);          // on tile despawn
labelCanvas.update(star.id, patch);       // mutate fields without re-register
```

### Frame pipeline

Every frame (inside `animate()`, replacing the current
`updateLabels` + `labelRenderer.render` + `flushCollisions`):

1. **Project** all active labels using `labelCamera` (same math as the
   current `projectToScreen`). Skip labels where `behind === true`.
   Populate each label's frame-local `screen.x, screen.y`.

2. **Measure** (cache-hit path). Look up each label's cached
   `(width, height)` from a `Map<string, TextMetrics>` keyed by
   `font|text`. Cache miss: use an offscreen canvas's
   `measureText` — no DOM, no layout flush.

3. **Style / fade** resolution. Compute each label's current opacity
   by interpolating toward `opacityTarget` at a fixed rate (e.g. 1.0 /
   400ms). Skip labels whose final opacity falls below
   `COLLISION_ALPHA_CUTOFF`.

4. **Collision.** Sort by `(pinned desc, rank desc)`. Use the same
   spatial grid as today, but with computed rects from step 2. Labels
   that overlap a higher-priority placed rect, or fall inside a
   screen occluder, get `opacityTarget = 0`.

5. **Paint.** Clear the canvas, set `devicePixelRatio` transform, draw
   each non-hidden label:

   ```ts
   ctx.font = label.font;
   ctx.fillStyle = label.color;
   ctx.globalAlpha = label.opacityCurrent;
   if (label.shadowBlur) {
     ctx.shadowColor = label.shadowColor!;
     ctx.shadowBlur = label.shadowBlur;
   }
   ctx.fillText(label.text, label.screen.x, label.screen.y + label.marginTop);
   if (label.subtitle) ctx.fillText(label.subtitle, ...);
   ```

6. **Publish hit regions** for the pointer handler (a flat array of
   `{ labelId, rect }` records for non-hidden labels this frame).

### Pointer handling

Install once: `window` mousemove / mouseup listeners. On event, ignore
if `lastInputWasTouch` / dragging / alt-orbit (matches current). Else,
linearly scan the per-frame hit-region list for the first rect
containing the event coordinates. Hits dispatch into the same label
handlers that currently live on each div (`hoverTarget`,
`selectStar`, `selectSystem`, nebula/BH `handleClick`).

Scan is O(n) with n ≈ 100-300 visible labels per frame — ~0.1ms and
only runs on mousemove, not rAF.

### Text metrics cache

Built once, reused for every re-draw:

```ts
const measureCanvas = new OffscreenCanvas(1, 1).getContext("2d")!;
const metricsCache = new Map<string, { width: number; height: number }>();
function measure(font: string, text: string) {
  const key = `${font}|${text}`;
  let m = metricsCache.get(key);
  if (m) return m;
  measureCanvas.font = font;
  const tm = measureCanvas.measureText(text);
  const height = tm.actualBoundingBoxAscent + tm.actualBoundingBoxDescent;
  m = { width: tm.width, height };
  metricsCache.set(key, m);
  return m;
}
```

Unique `(font, text)` combinations are small (few hundred distinct
names × ~3 font/style variants). Cache size is bounded.

### Occluders

`labelRegistry::collectScreenOccluders` is already CPU-side — circles
in screen-space pixels. Drops in unchanged.

## Migration plan

Four stages. Each is an independent commit / PR. Each runs alongside
the existing DOM labels so we can A/B with the bench and roll back if
any stage regresses.

### Stage 0: infrastructure

- New `src/labelCanvas.ts` with the canvas layer, metrics cache,
  pointer handler skeleton. Not wired to any label source yet.
- New `?labelsMode=canvas` URL toggle. Default is existing DOM path.
- `docs/profiling.md` already covers the measurement side — no
  changes needed there.

Land with zero visual change. Verify that the canvas overlay sits in
the right place with `pointer-events: none` when empty.

### Stage 1: tier-1 streamed labels

Smallest rendering variety — just a name in the default star font.
Hundreds at a time. Best coverage for the "does 2D canvas text on macOS
hold up" question.

- On tile label load, register into `labelCanvas` instead of creating
  a `<div>` + `CSS2DObject`.
- Feature-flag the swap so with `?labelsMode=canvas` all tier-1s go
  through canvas and tier-0 / systems / nebulae / BH stay on DOM.
- Run the bench with and without the flag. We're looking for an
  obvious win in the `labelRenderer` phase (fewer CSS2DObjects for
  it to iterate).

**Exit criteria:** tier-1 labels visually indistinguishable from DOM,
hover/click still work, bench shows a measurable reduction in
`labelRenderer` proportional to the fraction of labels moved.

### Stage 2: tier-0 notables

Add glow handling (per-star colored text-shadow via `shadowColor` +
`shadowBlur`). Add favoriteicon placement (if it stays — may simplify).
Add selection highlight visual (bolder / brighter).

**Exit criteria:** all 265 notable labels render through canvas.
`labelRenderer` should drop sharply at this point.

### Stage 3: system / nebula / BH labels

Multi-line layouts (name + subtitle), cluster-label sizing, nebula
font (different color / spacing). Full migration — at this point all
label sources route through `labelCanvas`.

### Stage 4: remove CSS2DRenderer

- Delete `labelRenderer` and its `render()` call.
- Remove `scene`-attached `CSS2DObject` creation in
  `src/billboard.ts`, `src/nebulaeLabels.ts`, `src/blackholes.ts`,
  `src/starfield.ts`.
- Delete `scene.ts::labelCamera` if it's not needed elsewhere
  (currently it's only for `CSS2DRenderer`; `labelCamOffset` moves
  to `labelCanvas`).
- Drop the `?labelsMode=canvas` flag — canvas becomes the only path.

## Risks and mitigations

**Font rendering inconsistency.** Canvas `fillText` uses the
platform's font rasterizer. macOS, Windows, and Linux all sub-pixel
differently; the DOM did too but we were less aware. **Mitigation:**
stage 1 is the cheap probe. If the rendering looks bad on any
platform, abort before touching tier-0.

**Glow quality.** CSS `text-shadow` supports multiple comma-separated
shadows (we use that today: inner sharp + outer soft + black
stroke). Canvas `shadowColor`/`shadowBlur` applies one shadow per
draw. **Mitigation:** either do multiple `fillText` passes per label
(inner stroke, outer glow, main fill — 3 passes), or accept a
slightly simpler glow look. Prototype before committing.

**Hit-testing edge cases.** DOM pointer events bubble through
`z-index`; linear hit-test scan picks the first match. Edge cases:
labels that overlap, labels near the cursor that are collision-hidden
but still in the list. **Mitigation:** hit-test respects `opacity <
cutoff` the same way `isLabelInteractive` does today.

**Drag ergonomics.** Current system lets you drag a label to rotate
the camera (the `initLabelDrag` handler on each div sets
`isDragging`). With canvas labels pointer-events are on the parent
canvas, not individual labels. **Mitigation:** the global mousemove
handler already handles dragging; no change needed. The label hit-
test just chooses whether the mouseup is a "click" vs a "drag
release."

**Fade animation parity.** Today's fades use the Web Animations API
with 400ms ease-in-out on `opacity`. Canvas implementation is a per-
frame interpolation toward target opacity. **Mitigation:** linear
interpolation with the same duration is visually close; if it's
noticeably worse we can apply an ease function to the progress fraction.

**Regression surface.** Lots of code changes. **Mitigation:** staged
migration behind a flag lets us run both paths until each stage is
confidently shipped; bench + user testing gates each stage.

## Rollback

Each stage is a commit. Any stage can be reverted independently.
Because stages 1-3 are flag-gated, rolling back a single stage means
clearing that stage's flag path and the `labelCanvas.register` call
for that label type — no architectural undo needed.

Stage 0 (the canvas layer itself) is inert when no labels register;
safe to leave in even if we abandon the migration.

## Open questions

- **Offscreen worker?** Could we move canvas painting to a
  `Worker` + `OffscreenCanvas`? Would take painting off the main
  thread entirely. Adds complexity (postMessage per frame for label
  updates). Probably premature; evaluate only if main-thread paint
  time is still the bottleneck post-migration.

- **CSS2DRenderer for non-map labels?** We use CSS2DRenderer only for
  map labels. If we kept it for something future (3D in-scene
  annotation), we'd keep the renderer but with zero CSS2DObjects
  attached. Currently: no such use case.

- **Accessibility.** DOM labels are screen-reader-reachable. Canvas
  labels are not without ARIA attestation. Drake is visual by nature
  so this is unlikely to block us, but worth noting.

## Estimated effort

Rough estimate, no guarantees:

| stage           | LOC added / removed | time    |
| --------------- | ------------------- | ------- |
| 0: canvas layer | ~250 added          | 2-3 hrs |
| 1: tier-1       | ~80 added, ~40 rm   | 1-2 hrs |
| 2: tier-0       | ~120 added, ~60 rm  | 2-3 hrs |
| 3: systems etc. | ~150 added, ~100 rm | 2-3 hrs |
| 4: cleanup      | ~20 rm              | 30 min  |
| **total**       | ~620 / ~220         | 8-12 hrs|

Plus bench time between stages.

## Go / no-go

Do this if:

- The app is dropping frames on target hardware (mobile, older Macs).
- A new feature (more labels, higher label density) would push us
  over budget.

Skip this if:

- Current 13ms p50 remains comfortable.
- Other features are higher-value (more important than +4ms headroom).

The infrastructure (bench + sampler + phase timing) is ready to
answer "is this actually needed yet?" at any time.
