// Approximate Keplerian propagation (JPL "Approximate Positions of the
// Planets", Table 1, valid 1800–2050). Good to a few arcminutes over
// the validity range — plenty for visual placement, and a small enough
// formula to mirror cleanly in build-catalog.py for the search index.

export interface ElementPair { 0: number; 1: number }

export interface PlanetElements {
  a_au: ElementPair;          // semi-major axis (AU), rate per Julian century
  e: ElementPair;             // eccentricity
  i_deg: ElementPair;         // inclination
  L_deg: ElementPair;         // mean longitude
  long_peri_deg: ElementPair; // longitude of perihelion (ϖ)
  long_node_deg: ElementPair; // longitude of ascending node (Ω)
}

const J2000_JD = 2451545.0;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);  // Jan 1.5, 2000 UTC
const DAYS_PER_CENTURY = 36525;

export function julianCenturiesSinceJ2000(date: Date = new Date()): number {
  return julianDaysSinceJ2000(date) / DAYS_PER_CENTURY;
}

export function julianDaysSinceJ2000(date: Date = new Date()): number {
  return (date.getTime() - J2000_MS) / 86400000;
}

const DEG = Math.PI / 180;

// Wrap into [-π, π]; the Kepler iteration converges fastest there.
function wrapPi(angle: number): number {
  const TAU = Math.PI * 2;
  let a = angle % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}

// Newton's method on E - e·sin(E) = M. Converges in a handful of
// iterations for any planetary eccentricity (Mercury, e=0.21, is the
// worst we see).
function solveKepler(M: number, e: number): number {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 30; i++) {
    const dE = (M + e * Math.sin(E) - E) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

export interface OrbitState {
  a: number;           // semi-major axis (AU)
  e: number;
  i: number;           // radians
  long_peri: number;   // radians
  long_node: number;   // radians
  M: number;           // mean anomaly (radians, wrapped)
  E: number;           // eccentric anomaly (radians)
  nu: number;          // true anomaly (radians)
  r: number;           // current distance (AU)
}

// Roll the J2000 base + per-century rate forward to time T, then solve
// Kepler. Cheap; called once per planet at init and once per orbit
// vertex when we generate the ring.
export function orbitState(el: PlanetElements, T: number): OrbitState {
  const a = el.a_au[0] + el.a_au[1] * T;
  const e = el.e[0] + el.e[1] * T;
  const i = (el.i_deg[0] + el.i_deg[1] * T) * DEG;
  const L = (el.L_deg[0] + el.L_deg[1] * T) * DEG;
  const long_peri = (el.long_peri_deg[0] + el.long_peri_deg[1] * T) * DEG;
  const long_node = (el.long_node_deg[0] + el.long_node_deg[1] * T) * DEG;
  const M = wrapPi(L - long_peri);
  const E = solveKepler(M, e);
  const nu = 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2),
  );
  const r = a * (1 - e * Math.cos(E));
  return { a, e, i, long_peri, long_node, M, E, nu, r };
}

// Heliocentric ecliptic Cartesian (AU) from an orbit state.
export interface Vec3 { x: number; y: number; z: number }
export function helioEcliptic(s: OrbitState): Vec3 {
  return helioEclipticAt(s, s.nu, s.r);
}

// Same rotation chain as helioEcliptic but with caller-supplied true
// anomaly + radius — used by the orbit-ring generator to walk the
// full ellipse without re-solving Kepler at each sample.
export function helioEclipticAt(s: OrbitState, nu: number, r: number): Vec3 {
  const omega = s.long_peri - s.long_node;
  const angle = nu + omega;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const cn = Math.cos(s.long_node), sn = Math.sin(s.long_node);
  const ci = Math.cos(s.i), si = Math.sin(s.i);
  return {
    x: r * (cn * ca - sn * sa * ci),
    y: r * (sn * ca + cn * sa * ci),
    z: r * sa * si,
  };
}
