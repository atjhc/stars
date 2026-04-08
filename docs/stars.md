# Star Rendering

## Overview

Stars are rendered in two complementary paths:

1. **Streamed point cloud** (`THREE.Points`) — every star in a loaded tile
   renders as a single `GL_POINTS` primitive sized in the vertex shader.
   This is the baseline always-on path.
2. **Billboard quad** — spawned alongside tier-0 and in-range tier-1 stars
   for detailed glow at close range.

Both paths share the same radial glow profile (`src/starShader.ts`
`GLOW_GLSL`): a Gaussian core + inverse-square halo + soft exponential outer
glow. The point path samples that profile from a pre-baked mipmapped
texture by default (`StarMode.texture`), which is critical for flicker-free
bloom — see "Sub-pixel flicker" below.

## Architecture

```
Per-star Mesh (PlaneGeometry 0.4×0.4, ShaderMaterial)
  ├── Per-instance attributes: starColor (vec3), starBrightness (float)
  ├── Uniform: uHighlight (float, 1.0 normal / 1.6 highlighted)
  ├── Additive blending, no depth write
  ├── Vertex shader: billboard + distance-based scaling
  └── Fragment shader: multi-layer procedural glow
```

## Vertex Shader: Billboarding and Distance Scaling

The vertex shader positions each quad to always face the camera (billboarding)
and scales it logarithmically based on camera distance:

```glsl
vec4 mvCenter = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
float dist = -mvCenter.z;
float scale = clamp(log(1.0 + dist * 0.5) * 0.2, 0.05, 0.3);
mvCenter.xy += position.xy * scale;
```

### Why logarithmic scaling?

Stars need to be small when zoomed in (so binary/trinary systems are
distinguishable) but maintain visual presence when zoomed out. A linear scale
would either be too large up close or too small far away. The logarithmic curve
grows quickly at first then flattens, hitting the cap at moderate distances:

```
scale
0.30 |                               ·····························  ← cap
     |                         ·····
0.20 |                   ·····
     |              ····
0.10 |         ···
     |     ··
0.05 |·····                                                         ← floor
     +---+---+---+---+---+---+---+---+---+---+---→ camera distance
     0   1   2   3   4   5  10  15  20  30  40
```

| Camera distance | Raw `ln(1+d*0.5)*0.2` | Clamped scale | Effect |
|---|---|---|---|
| 0.5 (min zoom) | 0.045 | **0.05** (floor) | All stars same tiny size |
| 1 | 0.081 | 0.081 | Starting to grow |
| 2 | 0.139 | 0.139 | Mid-range |
| 4 | 0.200 | 0.200 | Approaching cap |
| 6+ | >0.3 | **0.30** (cap) | Max screen size |

The uniform base quad size (0.4 units for all stars) ensures that when zoomed in,
every star — from Vega to Wolf 359 — appears the same size. Brightness, not
geometry, conveys luminosity differences.

## Fragment Shader: Multi-Layer Glow

The shader combines multiple radial falloff functions to approximate how a point
light source appears. Each layer serves a distinct visual purpose:

### Layer 1: Gaussian Core

```glsl
float core = exp(-d * d * 30.0);
```

A tight, bright center that appears nearly white regardless of the star's actual
color. This mimics how the eye perceives the brightest part of a star —
photoreceptors saturate, losing color information.

### Layer 2: Inverse-Square Halo

```glsl
float halo = 1.0 / (1.0 + pow(d * 6.0, 2.0));
```

A physically-motivated halo where the star's color becomes visible. The `1.0 +`
in the denominator prevents infinity at the center. This layer has heavier tails
than the Gaussian, creating the characteristic "spread" seen in astrophotography.

### Layer 3: Exponential Outer Glow

```glsl
float outerGlow = exp(-d * 4.0) * 0.3;
```

A wide, soft atmospheric glow. The linear exponent (`-d` vs `-d²`) produces a
longer tail than the Gaussian, giving bright stars their sense of presence.

### Combined Intensity

```glsl
float intensity = (core + halo * 0.4 + outerGlow) * vBrightness;
```

The `vBrightness` varying comes from the per-instance `starBrightness` attribute
multiplied by the `uHighlight` uniform (1.0 normally, 1.6 when hovered/selected).

## Brightness Calculation

Per-star brightness is derived from luminosity on a logarithmic scale with a
floor to ensure even the dimmest stars have visible halos:

```javascript
brightness = max(0.6, min(2.0, 0.7 + 0.3 * log10(max(lum, 0.001))))
```

| Star | Luminosity (L☉) | Brightness | Visual effect |
|---|---|---|---|
| Vega | 49.93 | 1.21 | Bright with prominent halo |
| Sirius | 22.82 | 1.11 | Bright |
| Sol | 1.00 | 0.70 | Moderate |
| Proxima | 0.0001 | 0.60 | Floor — still visible |
| Wolf 359 | 0.00002 | 0.60 | Floor — still visible |

## Color Mapping

Star color is derived from the [B-V color index](https://en.wikipedia.org/wiki/Color_index)
using Ballesteros' formula for B-V → temperature, then Tanner Helland's algorithm
for temperature → RGB. This is computed in JavaScript at initialization.

| B-V   | Temperature | Color        | Example         |
|-------|-------------|--------------|-----------------|
| -0.33 | 30,000K+    | Blue-white   | O-type stars    |
| 0.00  | 9,500K      | White        | Vega (A0V)      |
| 0.65  | 5,800K      | Yellow-white | Sol (G2V)       |
| 1.15  | 4,400K      | Orange       | K-type stars    |
| 1.50  | 3,200K      | Red-orange   | Proxima (M5.5V) |

At high intensity, the fragment shader desaturates toward white:

```glsl
vec3 color = mix(vColor, vec3(1.0), smoothstep(0.3, 1.0, core * vBrightness));
```

Only the halo shows color; the core appears white — matching how bright stars
actually look to the eye.

## Hover and Selection

Stars highlight on hover and selection via the `uHighlight` uniform (1.6x
brightness boost). Labels get a CSS glow effect (white text with blue
text-shadow, 150ms transition). Hovered/selected labels maintain full opacity
regardless of distance.

## Label Distance Fade

Labels fade with camera distance using `smoothstep` for a gradual transition:

```javascript
opacity = 1.0 - smoothstep(dist, 5, 40)  // clamped to min 0.1
```

Hovered and selected star labels override this to full opacity.

## Hitbox

Each star uses a custom `raycast` with a sphere whose radius scales with camera
distance, giving a consistent screen-space hit area:

```javascript
hitSphere.radius = cameraDistance * 0.02;
```

## Blending

Stars use `THREE.AdditiveBlending` with `depthWrite: false`. Additive blending
means stars only add light — they never occlude each other, and overlapping halos
naturally combine.

## Point cloud sizing

The `THREE.Points` vertex shader (`src/starfield.ts`) computes
`gl_PointSize` from per-star brightness and camera distance, clamped to
`[10, 32]` px:

```glsl
float rawSize = max(2.0, vBrightness * 4.0) * (500.0 / dist);
gl_PointSize = clamp(rawSize * 2.0, 10.0, 32.0);
```

The 10 px minimum is deliberately large. Smaller points have almost every
pixel on the rasterized edge, where MSAA coverage fraction flickers as the
point moves sub-pixel. Bloom amplifies that step into visible halo wobble.
A 10 px minimum gives enough interior "fully-covered" pixels that the
intensity stays stable across frames.

## Sub-pixel flicker and the texture-sampled glow

The natural implementation — evaluate the glow profile in the fragment
shader — produces visible halo flicker under bloom on slowly-moving stars.
Root cause: the core is `exp(-d² · 30)`, a very steep gradient. Under
sub-pixel sample jitter, neighboring frames land on different points of
the gradient, changing fragment output. Bloom's Gaussian blur propagates
that change outward, making it visible as a wobbling halo.

The fix is to bake the glow profile once into a mipmapped `CanvasTexture`
(`createStarGlowTexture` in `src/starShader.ts`) and sample it with
trilinear filtering. The mipmap chain pre-filters the steep core across
pixel footprints, so sub-pixel jitter produces bounded, smooth output.

`StarMode.math` (evaluate in shader) and `StarMode.flat` (flat disc) are
still available via the debug panel for visual comparison.

## Post-Processing Bloom

An `UnrealBloomPass` is applied to create light bleeding from bright stars:

1. **Brightness extraction**: pixels above a luminance threshold are isolated
2. **Multi-pass Gaussian blur**: separable horizontal/vertical blur on a mip chain
3. **Additive composite**: blurred brightness is added back to the scene

Current tuned parameters (`src/constants.ts`): `strength = 0.3`,
`radius = 0.4`, `threshold = 0.1`.

### HDR + MSAA composer render target

The composer renders into a custom `WebGLRenderTarget` with
`{ samples: 8, type: HalfFloatType }`:

- **8× MSAA** eliminates geometry-edge coverage aliasing that would
  otherwise accumulate into bloom flicker alongside the shader-gradient
  flicker described above.
- **HalfFloat** precision avoids the posterized contour banding visible
  on bright-star halos when the composer RT is the default 8-bit type —
  bloom blur accumulates many small contributions whose quantization
  error shows up as visible step contours.

The bloom pass's internal horizontal/vertical blur targets are also
flipped to `HalfFloatType` for the same reason.

### Bloom overscan

`UnrealBloomPass` clamps blur samples to the edge of its render target.
At screen edges that biases the kernel sum upward, making stars at the
edge of the viewport bloom brighter than stars in the middle.

Fix: render into a target ~1.2× larger than the viewport
(`BLOOM_OVERSCAN = 1.2` in `src/scene.ts`) by temporarily widening the
camera FOV in `beginBloomRender()`. Bloom runs on the oversized buffer
with real scene data in the gutter. A final `ShaderPass` crops the
center `1/OVERSCAN` region back to viewport size for display.

## References

- [Tanner Helland: Temperature to RGB](https://tannerhelland.com/2012/09/18/convert-temperature-rgb-algorithm-code.html)
- [tiffnix: Rendering Star Fields in 3D](https://tiffnix.com/star-rendering)
- [LearnOpenGL: Bloom](https://learnopengl.com/Advanced-Lighting/Bloom)
- [Three.js UnrealBloomPass](https://threejs.org/docs/pages/UnrealBloomPass.html)
- [Shadertoy: Glow Shader Tutorial](https://inspirnathan.com/posts/65-glow-shader-in-shadertoy/)
- [SpaceEngine: Better Looking Stars](https://spaceengine.org/news/blog141015/)
