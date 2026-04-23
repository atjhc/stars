# Neutron-star feature post-mortem

This doc captures the friction encountered while adding neutron stars as a
new kind of selectable, 3D-rendered, gravitationally-lensed celestial
object. The symptoms are useful on their own — many rounds of confusing
rendering bugs and per-turn fixes — but the underlying cause is an
architectural one: **"adding a new type of thing" currently means
touching ~10 files because the existing types are per-kind copies of the
same cross-cutting concerns, not instances of shared abstractions.**

The shape of the work, expressed as "what did a new celestial type
actually have to provide?", was this:

- A **label** with selection, hover, a detail panel, search participation,
  a focus-restore hook.
- A **3D visual** at a world position: disc + halo with depth-safe
  precision and bloom.
- A **gravitational-lensing** effect at close zoom.

Each of those already exists in the codebase for at least one prior
type. We rebuilt every one of them from scratch for NS, re-discovering
the same edge cases along the way.

## Where we spent time that we shouldn't have

### 1. Per-kind plumbing that should come with `registerLabelType`

Adding `kind: "neutronstar"` required touching every one of these:

- `labelCanvas.ts` — the `LabelKind` union.
- `main.ts::dispatchCanvasLabelClick` — new `case "neutronstar"`.
- `main.ts::dispatchCanvasLabelHover` — new case + new cross-type
  hover clearing line (`if (label?.kind !== "neutronstar") setNeutronStarHoverByName(null)`).
- `main.ts::currentFocusName` — another `getSelectedX() ?? undefined`
  in the fallback chain.
- `main.ts::handleSearchSelect` — new `if (entry.k === "ns") { ... }` branch.
- `main.ts` — new `initNeutronStarLabels()` and `renderNeutronStars()`
  import + boot call.
- `searchFilter.ts` — new `nsMatch` helper and two new branches in the
  pass loops (pass 1 and the pass-2/3 exclude lists).
- `search.ts` — new `else if (entry.k === "ns")` render branch.
- `build-catalog.py` — new RA/Dec → scene conversion branch.
- `catalog.ts::SearchEntry.k` — add `"ns"` to the union.

Every one of these is structural cost a label type pays just to exist.
None of it is NS-specific logic.

**The fix shape:** `registerLabelType` already exists in
`labelRegistry.ts`. Promote it to own every cross-cutting concern a
label type has:

```ts
interface LabelTypeHandler {
  readonly type: string;
  readonly searchKind: string;        // "ns", "b", "n", "c"
  readonly searchSecondaryText: string; // "Neutron Star"
  readonly searchKeywords: string[];   // ["neutron star", "pulsar"]

  // Lifecycle
  init(): Promise<void>;

  // Per-frame
  update(): void;
  setVisible(v: boolean): void;

  // Selection
  selectByName(name: string): boolean;
  clearSelection(): void;
  getSelectedName(): string | null;

  // Hover
  setHoverByName(name: string | null): void;

  // Search
  handleSearchSelect(entry: SearchEntry): void;

  // Canvas label click
  handleClick(label: CanvasLabel): boolean;

  // Detail panel
  detailHtml(): string | null;
}
```

Then `main.ts::dispatchCanvasLabelClick`, `dispatchCanvasLabelHover`,
`currentFocusName`, `handleSearchSelect`, and the boot sequence
iterate `handlers[]` instead of switching on kind strings. A new
label kind is added by writing ONE handler and calling
`registerLabelType(h)`. No other file needs editing.

### 2. Star-like 3D rendering rebuilt from scratch

The NS billboard needed disc + halo rendering, precision-safe at deep
zoom, with bloom. Every one of these is already implemented in
`stars.ts` for the instanced star mesh and the selected-star overlay:

- Target-relative view math to survive Float32 at deep zoom.
- Physical angular radius → pixel radius conversion.
- Disc + halo shader with a halo pixel floor so sub-pixel stars stay
  visible.
- Selected-star overlay that renders in screen space with no matrix
  math at all (precision exact at the orbit target).
- Bloom integration via the main composer.

For NS we rebuilt a simpler version of all of it, and re-encountered:

- Float32 precision for distant-NS marker jitter (round 1 of
  target-relative math).
- Float32 precision for the orbit-target marker's xy jitter (round 2:
  a dedicated `uIsOrbitTarget` flag that bypasses the rotation
  multiplication entirely — essentially a miniature selected-star
  overlay).
- Near-plane clipping at close zoom (pin `gl_Position.z = 0`).
- Bloom integration (initially hand-rolled Gaussian halo, later a
  second `EffectComposer`).

**The fix shape:** a `CelestialBody` primitive that a NS/star/"small
thing at a position" can instantiate by providing just `{ pos,
sceneRadius, color, intensity, isOrbitTarget }`. It owns:

- The billboard geometry and the shared target-relative vertex shader.
- The disc + halo fragment shader with consistent edge / core math.
- The "this is the orbit target" precision path.
- The Z-pin for near-plane safety.
- A registered hook into the renderer for bloom (a per-body entry in
  the bloom pipeline, not a new composer per type).

The per-type code reduces to "here's my body color; here's my physical
radius." The 3D-rendering concern is owned once.

### 3. Lensing pass owned body rendering AND background bending

The `lensingPass` in `scene.ts` started as BH-only, so its inside-body
code drew a solid-black event horizon. When NS inherited the same pass,
multiple rounds of symptom-chasing followed:

1. Inside-body = emissive body color (white/blue) with limb darkening
   and a `coreGlare` term. → Center clipped to white.
2. `uBodyColor` gradient adjustments to keep the hue. → Thin bright ring
   at disc edge (boundary between emissive color and bent-background).
3. Continuous limb-darkening across the boundary. → Still bright ring.
4. Rim halo Gaussian beyond the disc. → Dominant Einstein ring of the
   body's own bright pixels.
5. Einstein-ring guard (null out bent samples that fall inside the
   body region). → Dark ring around the disc.
6. Cross-fade between marker and lensing-body. → "Fades, then disc
   grows from a point" timing complaint.

Every one of these was the symptom of the same architectural mistake:
**the lensing pass was doing two jobs — drawing the body AND bending
the background — and they leaked into each other.** The bent-UV sample
from `tDiffuse` included the body (because the billboard wrote there),
so the body replicated into an Einstein ring.

The actual fix was architectural: split the two jobs.

- `lensingPass` now bends background only. BH still draws its shadow
  (because BHs have no body to draw elsewhere — the lensing pass IS
  the BH visual).
- NS body renders in a separate `nsMarkerScene` composed AFTER the
  lensing pass, so the body isn't in `tDiffuse` and can't be bent.
- NS body gets bloom via a dedicated `EffectComposer` pipeline.

**The fix shape:** rendered objects should declare which render phase
they belong to. For a "phase graph" something like:

```
background: tile stars, dust
gravitational lenses: BH shadow, NS lensing (background-bending only)
foreground bodies: selected-star overlay, NS billboard (with own bloom)
overlays: canvas labels, debug overlays
```

— the lensing phase operates on the output of the background phase,
and the foreground-bodies phase renders on top of lensing output. No
object is shared between phases.

This is exactly the separation the current code now has for NS, but it
was reached by trial and error instead of being the default shape.

### 4. Selection / hover state is per-type and repeated

Each type maintains its own `selectedX`, `hoveredX`, `getSelectedXName()`,
`setXHoverByName()`, etc. `currentFocusName()` is a long `??` chain
through all of them. Cross-type hover-clearing in the canvas-label
hover dispatch is a switch-case that has to name every type.

**The fix shape:** a single `selection` and `hover` registry that label
handlers opt in to. Reading "what's currently focused" is one call;
clearing all hovers except the matching type is one line that iterates
handlers.

### 5. Shared floats + uniforms versus per-type reinvention

Half a dozen uniforms already exist for precision-safe coordinate
work (`starTargetUniform`, `starCameraOffsetUniform`,
`starViewRotationUniform`, `halfViewportPxUniform`). They're informally
"shared" but not documented as a contract. Each new shader has to
learn about them independently.

**The fix shape:** an explicit helper / shader include that says
"here's the target-relative view transform; include this and get
`vec3 viewPos_target_relative()` for free," plus a documented list of
uniforms every body shader should consume. Similar to how the star
shader's existing chunk is structured, but as a reusable vertex module.

## Anti-patterns that kept burning us

- **Two code paths for the same body at different zooms.** Floor-pixel
  dot + fading + lensing-drawn disc → three visual states, three
  transition bands, compounding bugs. Fix: one visual primitive that
  scales naturally, as the star shader already does.
- **Post-process shaders reading an input that includes the object
  they're supposed to affect.** Lensing sampled `tDiffuse` which held
  the body, so bending bent the body into itself. Fix: render-phase
  separation (see above).
- **Additive blending for an opaque object.** The NS billboard was
  additive, so bent-background streaks leaked through the body disc.
  Fix: NormalBlending with `alpha = 1` inside the disc.
- **`needsSwap = false` on UnrealBloomPass.** After the pass, the final
  content is in `composer.readBuffer`, not in the RT passed to the
  composer constructor. Easy to blit the wrong buffer (we did). Fix:
  always read `composer.readBuffer.texture` in the blit step.
- **Hand-rolled Gaussian halos in shaders.** They look synthetic next
  to real multi-scale bloom. If bloom is available downstream, draw a
  hard disc and let bloom make the halo.
- **Fading / crossfading between two rendering modes.** Invariably
  mis-timed and adds knobs. Fix: pick one mode that scales, don't
  crossfade.

## Concrete things to address before the next "new thing" type

If we stay on the current architecture and add another celestial type
(say, a white dwarf or globular-cluster-center), the same friction
will recur. The highest-leverage refactors, ordered by blast radius:

1. **Unify label-type registration** — the `LabelTypeHandler` surface
   described in §1. Retrofits stars, systems, clusters, nebulae, BH,
   NS all going through one registry. Deletes the per-kind switches in
   `main.ts`, `search.ts`, `searchFilter.ts`, `catalog.ts`. Probably
   the single best payoff and moderately scoped.
2. **Extract a `CelestialBody` render primitive** — the billboard +
   halo + precision + near-plane + bloom-aware pipeline described in
   §2. Stars already have this logic; the goal is to factor it into a
   reusable module that a star tile, a selected-star overlay, a NS
   body, and future bodies all use.
3. **Make the lensing pass single-purpose** — already done for NS via
   the separate-scene workaround. The principled version is a
   render-phase graph (§3), which is more invasive.
4. **Unify selection/hover state** — not blocking new work, but would
   clean up the `??` chains and per-type hover boilerplate (§4).

## Notes for the next session

- The current on-screen artifact under debugging (at
  `?r=7.0473e-12&focus=Geminga`) is the billboard disappearing after
  the bloom-composer fix. The fix made `renderNeutronStars` blit the
  wrong RT; now blits `nsComposer.readBuffer.texture` each frame.
  Next step: verify visually that the disc + bloom is back.
- The correct post-fix visual target is: a cool-blue disc (not
  saturated white) with a soft bloom halo produced by the dedicated
  `UnrealBloomPass`, and gentle background-star bending around it from
  the main `lensingPass`. No Einstein ring of the body's own light.
- The NS billboard currently uses `NormalBlending` with `alpha = 1`
  inside the disc. Do not revert to `AdditiveBlending` for the body
  — it was the cause of the bent-background-leaking-through symptom.

## One-line summary

We built NS by copying each cross-cutting concern (label, body render,
lensing) once per new type instead of having any of them as an
abstraction, so every concern had to be re-debugged end-to-end. The
fix-pattern in all three cases was the same: **separate the
per-instance data from the cross-cutting behavior, own the behavior
once, and let a new type be a short config object.**
