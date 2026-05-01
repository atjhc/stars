// Display-quality knobs that don't depend on Three.js state.
// Lives in its own module (zero internal imports) so files inside
// the renderLoop ↔ scene import chain can read these values eagerly
// without hitting a TDZ on either side of the cycle.

const RENDER_DPR_CAP_DEFAULT = 2;

const _dprCapQuery = new URLSearchParams(window.location.search).get("dprCap");
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
  return Math.min(window.devicePixelRatio, _dprCap);
}

// True when the cap actually reduced the render resolution — a proxy
// for "high-DPR mobile device". Used to gate further mobile-specific
// quality reductions (MSAA samples, dust RT resolution, label filter,
// fps cap, …). `?dprCap=99` disables both the cap and this gate, so
// a single URL toggle is enough to A/B the full mobile-quality
// pathway against full-quality rendering on the same device.
export function isMobileQuality(): boolean {
  return getRenderPixelRatio() < window.devicePixelRatio;
}
