# Camera System

## Coordinate System

Stars live in a scene-space coordinate system centered on Sol:

- **1 scene unit = 1/3 parsec ≈ 1.087 light-years** (`SCALE = 3`)
- Y-axis points toward galactic north
- The galactic plane lies roughly in XZ

Typical star positions are ~0–300 scene units from the origin. The full
catalog extends to ~3000 scene units (~1 kpc).

## Orbit Model

The camera orbits a **target** point using spherical coordinates in a
galactic-aligned basis (`galX`, `galZ`, `galUp`):

| Parameter     | Description                                    |
|---------------|------------------------------------------------|
| `target`      | Orbit focus — a world-space Vector3 (Float64)  |
| `orbitRadius` | Distance from target to camera                 |
| `orbitPhi`    | Polar angle (0 = galactic north, π = south)    |
| `orbitTheta`  | Azimuthal angle (accumulates freely, no wrap)  |

Camera position = `target + orbitRadius × sphericalDirection(phi, theta)`,
computed in Float64 in `updateCamera()`.

## Floating-Origin Precision

### The problem

Star instance positions (`instancePos`) are baked Float32 in the GPU
buffer. At magnitude ~300, Float32 ULP is ~2×10⁻⁵ scene units. When the
camera is zoomed in close (orbit radius < 0.01), the shader subtraction
`instancePos - cameraTarget` loses precision — the result jitters by
~2×10⁻⁵, which at close zoom can be 2–20% of the viewport.

### Per-tile rebasing

Each tile's instance buffer can be **rebased** to a local origin. When
the user selects a star, the tile containing that star is rebased:

```
newPositions[i] = Float32(Float64(worldPos[i]) - Float64(origin))
```

After rebasing, stars near the origin have small `instancePos` values.
The shader subtracts a per-tile `uLocalTarget` uniform (= `target − origin`,
computed on the CPU in Float64). Both operands are small, so the Float32
subtraction is precise.

**Key files:**
- `src/starfield.ts` — `rebaseTileToOrigin()`, `rebaseForTarget()`,
  `updateTileTargets()`
- `src/stars.ts` — vertex shader uses `uLocalTarget` (per-tile) instead
  of a global target uniform

**Invariants:**
- Only one tile is rebased at a time (the one containing the focused star)
- Non-rebased tiles have `origin = (0,0,0)` and `uLocalTarget = target`
  (same as the old global-uniform behavior)
- Rebasing is visually invisible — the buffer and uniform change in the
  same frame, so screen positions don't shift
- `worldPositions` (the immutable original Float32Array) is kept for
  un-rebasing and for spawning label anchors (which stay in world coords)

### Label projection

Label positions are projected on the CPU via `projectToScreenUV()`. This
uses the same two-part decomposition in Float64:

```typescript
dx = (pos.x - target.x) - cameraOffset[0]
```

Direct `pos - camera.position` would lose the orbit offset's low bits
when added to the large target magnitude (~300). The two-part form keeps
both subtractions in their precision regime.

### View rotation

The view rotation matrix is built from orbit angles entirely in Float64
(`viewRotation`, a `Float64Array(9)` in `scene.ts`), bypassing Three.js's
internal `matrixWorldInverse` which would truncate to Float32. The star
shader receives a Float32 copy (`uStarViewRotation`), but the Float32
error (~10⁻⁷) is multiplied by the small rebased positions, keeping the
screen-space error negligible.

## Transit Animation

When the user selects a new star, `animateTo()` initiates a transit with
three interpolations running in parallel:

### 1. Position (full duration)

`D` (camera-to-destination distance) interpolates in **log-space** from
`D0` to `toRadius`:

```
D = exp(log(D0) × (1−ease) + log(toRadius) × ease)
```

`target` is positioned along the transit line at `animation.to − remaining × dir`
where `remaining = D − orbitRadius`. Log-space interpolation gives the
camera enough frames at every scale — the approach through parsecs,
light-years, AU, and stellar radii each get proportional screen time.

### 2. Orbit radius (delayed)

`orbitRadius` interpolation is **delayed by 30%** of the ease curve:

```
rEase = max(0, (ease − 0.3) / 0.7)
orbitRadius = min(exp(log(fromR)×(1−rEase) + log(toR)×rEase), D)
```

The delay prevents a visible zoom-in at the departure when the camera
hasn't moved yet. The `min(…, D)` clamp ensures `remaining ≥ 0` — if the
position reaches the destination before the radius finishes shrinking,
the radius tracks D until its own interpolation catches up.

### 3. Camera rotation (first half)

Orbit angles (`theta`, `phi`) interpolate from departure orientation to
destination-facing over the **first 50%** of the timeline using
smoothstep. By the midpoint the camera is fully facing the destination;
the second half is a straight-line approach.

Theta uses shortest-path normalization (`shortestAngleTo`) to handle
accumulated drift from orbit drags.

### Easing

The position ease is `easeInOutExpoRest` — asymmetric exponential with
the midpoint at t=0.45. The first 45% is acceleration, the last 55% is
deceleration. This gives a "glide to rest" feel at the destination.

Duration scales with the log range of the transit:
`max(600ms, 600ms + (logRange − 6) × 120ms)`. A 6-order-of-magnitude
transit (typical star-to-star) takes 600ms; each additional order adds
120ms.

Hold **Shift** to slow any transit 10×.

### Tile rebasing during transit

The destination tile is rebased at transit start (via `rebaseForTarget`
called from the selection handler). Since the destination is far away at
that point, the rebasing is visually invisible. By the time the camera
arrives, the tile's `instancePos` values are already small and precise.

## Per-Frame Update Order

```
tickAnimation          — advance transit position + rotation + radius
updateTileTargets      — set per-tile uLocalTarget = target − tileOrigin (Float64)
updateCamera           — compute camera.position, orbit offset, view rotation
updateStarfield        — tile streaming, LOD, fade
updateDust             — set dust camera position uniform
updateAllLabels        — NS/BH/nebula label handlers (update uNSLocalTarget, etc.)
updateLabels           — star label visibility, collision, margin
── scene render ──
renderLabelCanvas      — project + paint all canvas labels
```

## Other Shaders

| Shader | Precision approach |
|--------|-------------------|
| **Stars** | Per-tile `uLocalTarget` + `uStarCameraOffset` (both small after rebasing) |
| **Neutron stars** | `uNSLocalTarget = nsWorldPos − target` computed on CPU in Float64 |
| **Dust** | Single `uCamWorldPos = camera.position` — Float32 is adequate at dust scale (~6000 units) |
| **Black holes** | Screen-space lensing pass, no world-space position subtraction |
