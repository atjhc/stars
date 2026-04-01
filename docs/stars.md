# Star Rendering

## Overview

Stars are rendered as camera-facing billboard quads using a custom GLSL shader
material with instanced rendering. Each star's appearance is computed entirely in
the fragment shader — no textures are used.

## Architecture

```
InstancedMesh (PlaneGeometry, ShaderMaterial)
  ├── 300 instances
  ├── Per-instance attributes: color (vec3), brightness (float)
  ├── Additive blending, no depth write
  ├── Vertex shader: billboard + magnitude-based sizing
  └── Fragment shader: multi-layer procedural glow
```

## Visual Model

The shader combines multiple radial falloff functions to approximate how a point
light source appears to the human eye and through optical systems. Each layer
serves a distinct visual purpose:

### Layer 1: Gaussian Core

```glsl
float core = exp(-d * d * 30.0);
```

A tight, bright center that appears nearly white regardless of the star's actual
color. This mimics how the eye perceives the brightest part of a star — photoreceptors
saturate, losing color information. The Gaussian shape (bell curve) falls off
smoothly without the singularity of 1/r functions.

### Layer 2: Inverse-Square Halo

```glsl
float halo = 1.0 / (1.0 + pow(d * 6.0, 2.0));
```

A physically-motivated halo using inverse-square falloff. This is where the star's
color becomes visible. The `1.0 +` in the denominator prevents infinity at the
center. This layer has heavier tails than the Gaussian, creating the characteristic
"spread" seen in long-exposure astrophotography.

### Layer 3: Exponential Outer Glow

```glsl
float outerGlow = exp(-d * 4.0) * 0.3;
```

A wide, soft atmospheric glow using exponential (not Gaussian) decay. This extends
further than the other layers and gives bright stars their sense of presence against
the dark background. The linear exponent (`-d` vs `-d²`) produces a longer tail.

### Color Mapping

Star color is derived from the [B-V color index](https://en.wikipedia.org/wiki/Color_index),
a measure of a star's temperature based on the difference between blue and visual
magnitude measurements:

| B-V   | Temperature | Color        | Example         |
|-------|-------------|--------------|-----------------|
| -0.33 | 30,000K+    | Blue-white   | O-type stars    |
| 0.00  | 9,500K      | White        | Vega (A0V)      |
| 0.65  | 5,800K      | Yellow-white | Sol (G2V)       |
| 1.15  | 4,400K      | Orange       | K-type stars    |
| 1.50  | 3,200K      | Red-orange   | Proxima (M5.5V) |

The conversion uses Ballesteros' formula for B-V → temperature, then Tanner
Helland's algorithm for temperature → RGB. Both are implemented directly in the
vertex shader.

At high brightness, the color is desaturated toward white:

```glsl
vec3 color = mix(starColor, vec3(1.0), smoothstep(0.3, 1.0, intensity));
```

This matches the visual principle: only the halo shows color, the core appears white.

## Brightness and Sizing

Star brightness spans many orders of magnitude. The shader handles this with
two-dimensional scaling — brighter stars get both larger billboards and higher
fragment intensity:

- **Billboard size**: Derived from luminosity on a log scale, so a 1000× brighter
  star appears ~3× larger (not 1000×).
- **Fragment intensity**: A per-instance `brightness` attribute multiplies the
  computed glow pattern, controlling how bright the core and halo appear.

## Blending

Stars use `THREE.AdditiveBlending` with `depthWrite: false`. Additive blending
means stars only add light — they never occlude each other, and overlapping halos
naturally combine. Disabling depth write prevents z-fighting between transparent
halos.

## Post-Processing Bloom

An `UnrealBloomPass` is applied as post-processing to create natural light
bleeding from bright stars. The bloom pipeline:

1. **Brightness extraction**: Pixels above a luminance threshold are isolated
2. **Multi-pass Gaussian blur**: Separable horizontal/vertical blur at reduced
   resolution for efficiency
3. **Additive composite**: Blurred brightness is added back to the original scene

Selective bloom via `THREE.Layers` ensures only stars contribute to the bloom —
the grid, labels, and UI elements are excluded.

## References

- [Tanner Helland: Temperature to RGB](https://tannerhelland.com/2012/09/18/convert-temperature-rgb-algorithm-code.html)
- [tiffnix: Rendering Star Fields in 3D](https://tiffnix.com/star-rendering)
- [LearnOpenGL: Bloom](https://learnopengl.com/Advanced-Lighting/Bloom)
- [Three.js UnrealBloomPass](https://threejs.org/docs/pages/UnrealBloomPass.html)
- [Shadertoy: Glow Shader Tutorial](https://inspirnathan.com/posts/65-glow-shader-in-shadertoy/)
- [SpaceEngine: Better Looking Stars](https://spaceengine.org/news/blog141015/)
