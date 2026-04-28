# Profiling

How to measure Drake's rendering performance, and a log of what's been tried.

## Quick start

```sh
bun run bench            # Sample current working tree
bun run bench:compare    # A/B: sample current, stash, sample baseline, pop, print delta
```

Both commands spawn a temporary dev server on port 3030, launch headless
Chrome via `puppeteer-core` (system Chrome at `/Applications/Google
Chrome.app/...`), navigate to `?bench=1`, wait for the deterministic
15-second camera trajectory to finish, and print a summary.

In the browser, `?debug=1` shows a live FPS/MS/MB overlay at the bottom
of the debug panel. Pressing `P` toggles sampling (same output as the
automated bench, printed to the console on stop).

### Why headless Chrome for benching

Safari's `performance.now()` resolution is 1ms (Spectre mitigation).
Every MS sample quantizes to whole milliseconds, which makes sub-ms
optimizations indistinguishable from noise. Chrome (headless or not)
gives 100µs resolution without a cross-origin-isolated context. When
you run `bun run bench` you get usable numbers; when you run the page
manually in Safari for visual testing, the live graph is only useful
for spotting large spikes.

## The sampler

### Stats kit

Every frame of the `animate()` loop in `src/main.ts` is bracketed by
`statsBegin()` and `statsEnd()`:

```ts
function animate(now) {
  requestAnimationFrame(animate);
  statsBegin();
  // ...all frame work...
  statsEnd();
}
```

`statsBegin` snapshots `performance.now()`; `statsEnd` subtracts to get
the frame's JS+render ms, updates the MS graph, increments a per-second
FPS counter, and — if memory timing is available — the MB graph.

Bracketing the rAF body (not rAF-to-rAF wall time) gives a **headroom**
reading: 5 ms means 70% of the 16.7 ms budget is unused; 15 ms means
you're on the edge of dropping frames. Wall-clock between rAF
callbacks includes browser idle time and isn't useful for knowing
where your perf budget is going.

### P-key sampling

While the live graph shows the current instant, the sampler captures
every frame's MS reading into an array. Toggle with `P`; stop with `P`
again. On stop, the kit computes percentiles and logs:

```
[stats sample] 982 frames / 15.01s — fps=65.4 mean=13.24ms p50=13.1ms
p95=14.9ms p99=16.0ms min=6.2ms max=17.9ms
```

**Why percentiles matter.** p50 is the typical frame. p95 tells you
whether the app jitters. p99 / max show tile-streaming and GC spikes.
mean lies — a single 90ms stall skews it and masks the steady state.
Look at p50 for "did this change help?"; look at p99 for "did this
change cause new spikes?".

## Phase timing

The sampler also accumulates per-phase totals. Each tracked block in
`main.ts` is wrapped with `statsPhase(name, fn)`:

```ts
statsPhase("updateLabels", () => updateLabels(...));
statsPhase("sceneRender", () => composer.render());
statsPhase("labelRenderer", () => labelRenderer.render(scene, labelCamera));
```

The wrapper measures `performance.now()` before/after `fn()`,
accumulates into a Map keyed by `name`, and reports per-frame averages
on sample stop. **When sampling is off, the wrapper is a passthrough**
— single branch, no timing overhead. It's safe to leave in the hot
path permanently.

Current phase breakdown on a typical 15s trajectory (post idle-hidden
fast-path — see `docs/labels.md`):

| phase             | per-frame ms | notes                                    |
| ----------------- | ------------ | ---------------------------------------- |
| sceneRender       | 1.46         | composer (bloom + scene pass + lensing)  |
| labelCanvas       | 1.23         | project + measure + collide + paint      |
| ↳ lc.paint        | 0.75         | fillText + glow per visible label        |
| ↳ lc.project      | 0.27         | inlined view·proj per non-faded label    |
| ↳ lc.collide      | 0.19         | sort + spatial-grid overlap (when dirty) |
| ↳ lc.fade         | 0.01         | step visibleFactor toward target         |
| updateLabels      | 1.22         | processLabel × ~5k anchors (bench: dirty every frame; production: ~3 Hz) |
| ↳ ul.interactive  | 0.87         | tier-1 anchors (~4.6k); fast-path skips idle-hidden |
| ↳ ul.notables     | 0.20         | tier-0 anchors (~270)                    |
| ↳ ul.systems      | 0.14         | binary collapse + cluster centroids      |
| updateAllLabels   | 0.08         | registered handlers (nebula / BH / NS)   |
| updateStarfield   | 0.02         | tile stream (throttled to 500ms)         |
| updateDust        | 0.001        | dust uniform updates                     |

Total mean: ~4.0 ms p50. Pre-migration baseline was ~13.3 ms p50 — the
`labelRenderer` (CSS2DRenderer) and `flushCollisions` (DOM rect reads
+ collision grid) phases were ~5 ms together and are both gone now.

Note: `updateLabels` is bench-inflated. The bench (`src/bench.ts`)
calls `setLabelsDirty(true)` every frame to exercise the path; in
production `checkCameraMoved` throttles dirties to ~3 Hz, and the
function early-returns on the other ~57 frames. The 1.22 ms figure is
peak (dirty-frame) cost, not the every-frame cost.

### Architecture

Lives in `src/debug.ts`:

- `createStatsKit()` owns a `phaseTotals: Map<string, {calls, totalMs}>`.
- `phase(name, fn)` wraps a block, accumulates into the map. Zero-cost
  passthrough when sampling is off.
- `toggleSampling()` clears `phaseTotals` on start, reads it on stop
  to build a `phases` record in the `SampleSummary`.
- `statsPhase(name, fn)` is the exported wrapper; no-op when `statsKit`
  is null (debug mode off).

`scripts/bench.ts` reads the full summary from `window.__benchResults`
and prints a formatted phase table.

## Bench automation

`scripts/bench.ts` is a small puppeteer-core driver:

1. Spawns `bun server.ts` on port 3030 (isolated from dev server on 3000).
2. Launches system Chrome headless, navigates to `localhost:3030/?bench=1`.
3. Waits for `window.__benchDone === true`.
4. Reads `window.__benchResults` and prints a summary table.

`src/bench.ts` drives the in-page camera through a deterministic path
when `?bench=1` is present: 15 seconds split into four phases (rotate
theta, zoom in/out, tilt phi, combined motion). Because the trajectory
is time-driven rather than input-driven, results are reproducible
across runs — the whole point of automation.

`bun run bench:compare` adds a second pass: after sampling current,
`git stash -u` the working tree, run baseline, `git stash pop`, and
print a delta table. Requires uncommitted changes to stash.

## Optimization log

A record of what's been tried, and what the bench said. Most
speculative optimizations turn out to be regressions. Measure first,
always.

### Landed

**Fast-path for idle-hidden tier-1 labels** (`processLabel` in
`src/labels.ts`). With ~4.6k tier-1 anchors active and most far beyond
`LABEL_HIDE_DIST` (~180 ly) at any given camera position, every dirty
frame paid ~340 ns × 4.6k = 1.6 ms re-rewriting `{hidden:true,pinned:false}`
on labels whose state hadn't actually changed. Track a `WeakSet`
`idleHiddenTier1` that an anchor enters when its slow-path call took
the far-hide branch and exits at the top of every other branch
(optimistic clear; the far branch re-adds). `processLabel`'s fast
path: if the anchor is in the set AND the cheap selection / system /
distance / collapse checks still pass, the slow path would just
rewrite the same hidden state — skip the metrics + Map lookups +
canvas write. Skipping the disc-occluder push along with it is safe
because at `camDist > LABEL_HIDE_DIST` no catalogued star has a disc
that reaches the 2 px threshold (`R_SUN_SCENE` × max real radius is
several orders of magnitude below the cutoff). Bench: p50 4.8 → 4.0
ms (-17%); `updateLabels` 1.95 → 1.22 ms (-38%); `ul.interactive`
1.60 → 0.87 ms (-45%). In production, the `300ms` throttle on
`checkCameraMoved` means this path runs on ~3 frames/sec — the
optimization mainly improves spike control during tile-stream
events that re-dirty.

**Skip projection for steady-state-invisible labels** (`renderLabelCanvas`
in `src/labelCanvas.ts`). Phase-1 used to project + measure every entry
in the `labels` map every frame — ~500 anchors × ~3 µs = ~1.5 ms,
regardless of how few were actually visible. Most labels are
distance-faded out at any given camera position (orbit lines past 3000
AU, far constellations, distant clusters). Add a guard that skips
projection when `visibleFactor === 0 && opacityTarget < COLLISION_ALPHA_CUTOFF`
— meaning paint alpha is already 0 *and* the next collide pass would
keep it at 0. Mid-fade labels (visibleFactor > 0) still project so
their fade-out renders at the correct screen position; freshly-
registered labels (visibleFactor 0 but opacityTarget 1) still project
so they can fade in. p50 6.4 → 4.8 ms (-25%); `labelCanvas` 2.83 →
1.25 ms (-56%); `lc.project` itself 1.47 → 0.25 ms (-82%). `collide`
and `paint` also drop because frameBuf is smaller. Inner `lc.*` phase
markers retained for future regression-spotting (zero cost when
sampling is off).

**Sub-phase timing inside `renderLabelCanvas`** (instrumentation, not
an optimization). Wrapped each of the four phases (project, occluders,
collide, fade, paint) with `statsPhase("lc.<name>", ...)` so the bench
attributes labelCanvas's cost. Required extracting `statsPhase` from
`debug.ts` into a tiny `src/statsPhase.ts` shim — `labelCanvas → debug
→ starfield → labelCanvas` would otherwise reintroduce the import
cycle that the file's existing comments already call out.

**Skip tile-stream sweep when camera is still** (`updateStarfield`
in `src/starfield.ts`). The 500 ms tile-streaming check ran the full
~184-tile frustum + distance loop unconditionally, producing a
periodic ~1 ms spike every half-second visible in the bench / debug
overlay whenever the loop stayed awake (transit, label fades,
always-on debug mode). Cache the camera position + target from each
sweep; bail before the iteration when both are unchanged. Spike is
gone in the still-camera case; sweep still runs every frame the
camera moves.

**Thrashing fix — collision pass after `labelRenderer.render`** (commit `e189451`).
`updateLabels` used to call `resolveCollisions` *before* CSS2DRenderer
had positioned the label divs, so collision decisions were based on
previous-frame DOM coordinates. During rapid orbit the one-frame lag
caused labels to pop in and out. Fix: split `updateLabels` into a work
phase and a `flushLabelCollisions()` call that runs after the CSS2D
render. Cost: +0.5ms frame time (collision now forces a post-transform
layout flush). Benefit: labels stable under motion.

**Phase timing** (commit `1ba6ae2`).
Instrumentation, not an optimization. Added `statsPhase` wrapper and
instrumented the animate loop so samples include a per-phase
breakdown. Enabled everything below.

### Reverted (regressions)

**Memoize `starRadiusScene` via WeakMap** (from reverted commit `24aa81c`).
Cached `sqrt(lum) / pow(temp/T_SUN, 2)` on a `WeakMap<Star, number>`.
Bench showed -3% p50 (+0.4ms). Root cause: WeakMap lookup (~100ns) is
slower than the hardware sqrt+pow (~50ns) it replaces. Lesson:
memoization only pays when the memoized computation is expensive.

**Guard margin-top writes** (same reverted commit).
Tracked last-written margin per div in a WeakMap, skipped writes when
unchanged. No measurable change — Chrome already short-circuits
redundant style writes internally. Added overhead offset any savings.

**Guard `showLabel`/`hideLabel` DOM writes** (not committed).
Added early-return in `labelCollision.ts` when the label was already
in the target state. Bench showed no improvement — the Map lookups
cost about the same as the saves.

**Object pool for frame occluders** (not committed).
Replaced per-call `{ cx, cy, radius }` allocation with a reusable
pool. V8's young-generation GC handles 500 allocs/frame invisibly;
bench delta was within noise. Not worth the added complexity.

**Bounds caching + synthesized collision rects** (not committed).
Plan: cache each label's first-line dimensions, pre-project
`(screenX, screenY)` in `updateLabels`, synthesize collision rects
from cached dims + position. Expected: skip the forced layout flush
that follows CSS2DRenderer's transform writes. Result: -0.06ms in
`flushCollisions`, +0.9ms in `updateLabels` (extra projection work per
star). Net regression of 4-5%. Root cause: the layout flush turned
out to be only ~0.1ms, not the 1-2ms I'd estimated — `flushCollisions`
is dominated by the collision *algorithm* (sort + grid + overlap
checks), not DOM reads. The extra per-label work in `updateLabels` far
outweighed the savings.

### On the shelf

**Canvas-rendered labels.**
Replace CSS2DRenderer with a custom canvas layer. Would eliminate
`labelRenderer` (~2.9ms) and most of `updateLabels`' DOM writes. Big
change — hit testing, glow, fade, text measurement caching all need
reimplementing. Estimated ~4-5ms potential win, but uncertain until
prototyped, and high regression surface. Not worth the effort at
current 13ms p50 with 3ms of headroom at 60fps; revisit if the app
starts dropping frames on target hardware.

**GPU timing via `EXT_disjoint_timer_query_webgl2`.**
Would let us attribute the ~1.8ms `sceneRender` between composer
passes (bloom vs scene vs dust vs lensing). Not instrumented because
the scene phase is already small; would matter more if the composer
started dominating.

## Rules learned

1. **Measure before optimizing.** Our intuition was wrong more often
   than right. The sampler + bench infra paid for itself three times
   over by catching regressions before they shipped.
2. **Headless Chrome for measurement, Safari for visual QA.** Timer
   resolution determines what we can measure.
3. **WeakMap / Map lookup is not free.** ~100ns per call. Don't
   memoize anything cheaper than that.
4. **The browser is not stupid.** Redundant style writes, repeated
   `getBoundingClientRect` calls on already-dirty layouts — all
   already handled efficiently. Guards usually cost more than they
   save.
5. **p50, not mean.** Spikes (tile load, GC) dominate mean; p50 shows
   whether the steady state actually changed.
6. **Run each A/B at least twice.** Noise is real even at 100µs
   resolution. A 0.2ms delta in one run isn't trustworthy; a
   consistent 0.2ms across two runs probably is.
