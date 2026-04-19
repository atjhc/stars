export const SCALE = 3;
export const ANIM_DURATION = 600;
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
export const GRID_SIZE = 300;
export const GRID_DIVISIONS = 65;
export const GRID_FADE_RADIUS = 30.0;
export const HIT_SCREEN_FRACTION = 0.02;

export const LY_PER_PARSEC = 3.26156;
export const AU_PER_LY = 63241;
export const KM_PER_AU = 1.496e8;

// Minimum orbit radius for black-hole selection. BH rendering is pure
// screen-space, so precision holds down to the Float32 floor and the
// user can zoom arbitrarily close to the event horizon. Per-star and
// per-cluster selections set their own, much larger, floors based on
// the target's physical extent.
export const DEEP_ZOOM_MIN_ORBIT = 1e-20;

// Shared label-subtitle / detail-panel distance formatter. Takes scene units
// and cascades km → AU → ly with commas on large values. Used by label
// subtitles, black-hole and star detail panels.
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
export const BLOOM_THRESHOLD = 0.1;

export const LABEL_CSS = `
  color: rgba(255,255,255,0.7); font-size: 10px;
  pointer-events: auto; white-space: nowrap; text-shadow: 0 0 4px #000;
  transform: translateZ(0); -webkit-transform: translateZ(0);
  margin-top: 16px; user-select: none; text-align: center; cursor: pointer;
`;

export const CLUSTER_DEFAULT_SHADOW = "0 0 8px rgba(100,150,220,0.6), 0 0 3px #000";

export const NEBULA_DEFAULT_SHADOW = "0 0 8px rgba(200,120,60,0.5), 0 0 3px #000";

export const NEBULA_LABEL_CSS = `
  color: rgba(255,180,120,0.85); font-size: 13px;
  letter-spacing: 0.5px;
  pointer-events: auto; white-space: nowrap;
  text-shadow: ${NEBULA_DEFAULT_SHADOW};
  transform: translateZ(0); -webkit-transform: translateZ(0);
  -webkit-user-select: none; user-select: none; text-align: center; cursor: pointer;
`;

export const CLUSTER_LABEL_CSS = `
  color: rgba(180,210,255,0.85); font-size: 14px;
  letter-spacing: 1px;
  pointer-events: auto; white-space: nowrap;
  text-shadow: ${CLUSTER_DEFAULT_SHADOW};
  transform: translateZ(0); -webkit-transform: translateZ(0);
  -webkit-user-select: none; user-select: none; text-align: center; cursor: pointer;
`;
