export const SCALE = 3;
export const HIGHLIGHT_BOOST = 2.5;
export const ANIM_DURATION = 600;
export const MIN_ORBIT_RADIUS = 0.5;
export const MAX_ORBIT_RADIUS = 300;
export const CLICK_THRESHOLD = 5;
export const ORBIT_SENSITIVITY = 0.005;
export const MAX_SEARCH_RESULTS = 20;
export const LABEL_FADE_NEAR = 8;
export const LABEL_FADE_FAR = 50;
export const LABEL_HIDE_DIST = 55;
export const COLLAPSE_PX = 45;
export const COLLAPSE_PX_SQ = COLLAPSE_PX * COLLAPSE_PX;
export const GRID_SIZE = 300;
export const GRID_DIVISIONS = 65;
export const GRID_FADE_RADIUS = 30.0;
export const HIT_SCREEN_FRACTION = 0.02;

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

export const CLUSTER_LABEL_CSS = `
  color: rgba(180,210,255,0.85); font-size: 14px;
  letter-spacing: 1px;
  pointer-events: auto; white-space: nowrap;
  text-shadow: ${CLUSTER_DEFAULT_SHADOW};
  transform: translateZ(0); -webkit-transform: translateZ(0);
  user-select: none; text-align: center; cursor: pointer;
`;
