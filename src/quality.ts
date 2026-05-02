// Display-quality knobs that don't depend on Three.js state.
// Lives in its own module (zero internal imports) so files inside
// the renderLoop ↔ scene import chain can read these values eagerly
// without hitting a TDZ on either side of the cycle.

const RENDER_DPR_CAP_DEFAULT = 2;

// `typeof window` guard so this module is importable in non-DOM
// contexts (bun test). All consumers behave as if on desktop in that
// case — qualityProfile resolves to DESKTOP, which is what tests want.
const _hasWindow = typeof window !== "undefined";
const _dprCapQuery = _hasWindow
  ? new URLSearchParams(window.location.search).get("dprCap")
  : null;
const _dprCap = _dprCapQuery === null
  ? RENDER_DPR_CAP_DEFAULT
  : Math.max(1, parseFloat(_dprCapQuery) || RENDER_DPR_CAP_DEFAULT);

// iPhones report devicePixelRatio = 3, which means every full-screen
// pass shades 9× the pixels of a logical 1× render — and the composer
// chain has several. Capping to 2× keeps rendering above the human-eye
// "retina" threshold (~300 DPI at typical viewing distance) while
// cutting fragment work by ~55% on 3×-DPR devices.
// `?dprCap=99` effectively disables the cap for A/B testing.
export function getRenderPixelRatio(): number {
  return Math.min(_hasWindow ? window.devicePixelRatio : 1, _dprCap);
}

// True when the cap actually reduced the render resolution — a proxy
// for "high-DPR mobile device". Used to gate further mobile-specific
// quality reductions (MSAA samples, dust RT resolution, label filter,
// fps cap, …). `?dprCap=99` disables both the cap and this gate, so
// a single URL toggle is enough to A/B the full mobile-quality
// pathway against full-quality rendering on the same device.
export function isMobileQuality(): boolean {
  return _hasWindow && getRenderPixelRatio() < window.devicePixelRatio;
}

export interface QualityProfile {
  // EffectComposer RT MSAA sample count.
  msaa: number;
  // Bloom-input resolution divisor (UnrealBloomPass).
  bloomDiv: number;
  // Dust ray-march RT resolution divisor (relative to render resolution).
  dustDiv: number;
  // Cap of streamed octree tiles kept in memory (geometry + tier-1 anchors).
  tileBudget: number;
  // Multiplier on the meta-derived tier-1 label load distance.
  tier1LoadDistMult: number;
  // Apparent magnitude (from Sol) above which tier-1 stars get no canvas
  // label. `Infinity` means no filter.
  tier1LabelMaxMag: number;
  // Render-loop frame budget in ms. 0 = uncapped.
  fpsCapMs: number;
  // Initial value of the shader-side apparent-mag billboard cutoff
  // (camera-relative; `?mag=` URL param + the −/= keys still override).
  // Lower on mobile to thin the background field — the small screen
  // is for finding/observing specific targets, not surveying broadly.
  magLimit: number;
}

const MOBILE: QualityProfile = {
  msaa: 4,
  bloomDiv: 2,
  dustDiv: 4,
  tileBudget: 40,
  tier1LoadDistMult: 0.8,
  tier1LabelMaxMag: 3.5,
  // 32 ms (not 33.33) keeps the cap safely under the 60Hz 2-vsync
  // boundary — exactly-at-boundary float jitter pushed some frames to
  // the 3rd vsync (50 ms = 20 fps), tanking the average. The cap
  // itself is also engaged *dynamically* (see renderLoop.ts): only
  // active while the device's natural rate is clearly faster than
  // the cap. When the scene is heavy enough that frames run >cap
  // anyway, the cap can only add overhead, so it disengages.
  fpsCapMs: 32,
  magLimit: 6.5,
};

const DESKTOP: QualityProfile = {
  msaa: 8,
  bloomDiv: 1,
  dustDiv: 2,
  tileBudget: 80,
  tier1LoadDistMult: 1.0,
  tier1LabelMaxMag: Infinity,
  fpsCapMs: 0,
  magLimit: 7.5,
};

// Frozen at module load. Toggling DPR cap requires a reload anyway
// (window.devicePixelRatio doesn't change during a session, and the
// composer / RT sizes are baked at scene init).
export const qualityProfile: QualityProfile = isMobileQuality() ? MOBILE : DESKTOP;
