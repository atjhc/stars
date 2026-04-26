export const SCALE = 3;
export const ANIM_DURATION = 1400;
export const MIN_ORBIT_RADIUS = 0.5;
export const MAX_ORBIT_RADIUS = 1000; // ~330 pc — enough to see cloud structure
export const CLICK_THRESHOLD = 5;
export const ORBIT_SENSITIVITY = 0.005;
export const MAX_SEARCH_RESULTS = 20;
export const LABEL_DISC_BUFFER_PX = 24;

export const LABEL_FADE_NEAR = 8;
export const LABEL_FADE_FAR = 50;
export const LABEL_HIDE_DIST = 55;
export const COLLAPSE_PX = 45;
export const COLLAPSE_PX_SQ = COLLAPSE_PX * COLLAPSE_PX;
// Extra screen pixels added around each star's rendered disc radius
// to give small / faint stars a clickable target. Stars with bigger
// discs keep their generous hit area; tiny 1-2 px discs become a
// ~8 px circle, enough to grab comfortably.
export const HIT_PX_PADDING = 6;

export const LY_PER_PARSEC = 3.26156;
export const AU_PER_LY = 63241;
export const AU_PER_PC = AU_PER_LY * LY_PER_PARSEC;
export const KM_PER_AU = 1.496e8;
export const KM_PER_PC = 3.086e13;

// Inside this camera-to-destination distance, projected label positions
// barely shift frame-to-frame, so the collision pass re-engages during
// the final deceleration of a transit instead of waiting for the
// animation to fully end. ~1 ly in scene units.
export const ARRIVAL_COLLISION_DIST = SCALE / LY_PER_PARSEC;
// Schwarzschild radius in km for a 1 M☉ body.
export const RS_KM_PER_MSUN = 2.953;

// Minimum orbit radius for black-hole selection. BH rendering is pure
// screen-space, so precision holds down to the Float32 floor and the
// user can zoom arbitrarily close to the event horizon. Per-star and
// per-cluster selections set their own, much larger, floors based on
// the target's physical extent.
export const DEEP_ZOOM_MIN_ORBIT = 1e-20;

// THE canonical distance formatter for on-screen label subtitles. Takes
// scene units (what distanceFromCamera / orbitRadius return) and
// cascades km → AU → ly with thousands-separator commas on large values.
//
// Any new label type that surfaces a distance in a subtitle MUST call
// this — do not add a local variant. Detail panels have their own
// formatter (formatDist in detail.ts) since they intentionally surface
// both ly and pc.
export function formatAstroDistance(sceneUnits: number): string {
  const ly = (sceneUnits / SCALE) * LY_PER_PARSEC;
  const au = ly * AU_PER_LY;
  const km = au * KM_PER_AU;
  // Switch to km before AU rounds to "0.0 AU"
  if (au < 0.05) return `${km.toLocaleString("en-US", { maximumFractionDigits: 0 })} km`;
  if (au < 1000) return `${au.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} AU`;
  if (ly < 1) return `${ly.toFixed(3)} ly`;
  if (ly < 10) return `${ly.toFixed(2)} ly`;
  return `${ly.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ly`;
}

export function solDistanceFade(solDist: number, maxSolDist: number): number {
  if (maxSolDist <= 0) return 1.0;
  return 1.0 - (solDist / maxSolDist) * 0.75;
}

export const COLLISION_PAD_PX = 2;
export const COLLISION_ALPHA_CUTOFF = 0.15;

export const TILE_BASE_URL = "/tiles/";

export const BLOOM_STRENGTH = 0.3;
export const BLOOM_RADIUS = 0.4;
// Threshold sits above any SDR material output (planets/moons peak
// around linear 0.7) so the per-pixel bright-pass cutoff doesn't
// fall mid-gradient on a planet's lit hemisphere — that crossing
// produced a visible "step" in the Lambertian falloff on uniform
// bodies (Uranus, Saturn). Stars/BHs/etc. still bloom because they
// output HDR luma well above 1.0.
export const BLOOM_THRESHOLD = 1.0;

