import type { SearchEntry } from "./catalog.ts";
import { MAX_SEARCH_RESULTS } from "./constants.ts";

// Per-kind keyword and display label lists. Kinds not registered here
// fall through to name/alias matching only. Registered via
// registerSearchKindKeywords from modules that own each kind.
const kindKeywords = new Map<string, string[]>();
const kindLabels = new Map<string, string>();

export function registerSearchKindKeywords(kind: string, keywords: string[], label?: string): void {
  kindKeywords.set(kind, keywords);
  if (label) kindLabels.set(kind, label);
}

export function getSearchKindLabel(kind: string): string | undefined {
  return kindLabels.get(kind);
}

// Cluster keywords are built-in since clusters are managed by the star
// system infrastructure, not the label registry.
kindKeywords.set("c", ["star cluster", "cluster"]);
kindLabels.set("c", "Star Cluster");

// Names of systems already covered by a built-in cluster/nebula/BH/NS
// aggregate row in the index. Memoized by index identity — the index is
// loaded once at boot and reassigned only on full reload, so this Set
// is rebuilt at most once per session.
const kindedSystemsByIndex = new WeakMap<SearchEntry[], Set<string>>();
function getKindedSystems(index: SearchEntry[]): Set<string> {
  let set = kindedSystemsByIndex.get(index);
  if (set) return set;
  set = new Set();
  for (const e of index) if (e.k && e.k !== "s") set.add(e.n);
  kindedSystemsByIndex.set(index, set);
  return set;
}

export function filterSearch(query: string, index: SearchEntry[], excludeKinds?: Set<string>): SearchEntry[] {
  const q = query.toLowerCase().trim();
  if (q.length === 0) return [];

  const results: SearchEntry[] = [];
  const seen = new Set<SearchEntry>();
  const seenSystems = new Set<string>();

  function add(entry: SearchEntry, uncapped = false): boolean {
    if (seen.has(entry)) return false;
    if (entry.sy && seenSystems.has(entry.sy)) return false;
    // Cluster / nebula / black-hole / neutron-star entries aggregate
    // their members into one search row — so only they dedupe later
    // star members sharing their sy. Multi-star systems (binary/
    // trinary) have no such aggregate entry, so every member stays
    // visible and renders as "System · Member" in the result list.
    // Exoplanets ("ep") use sy to link a planet back to its host star
    // (for the search-select two-step), not to aggregate siblings, so
    // they're excluded from the dedup.
    if (entry.sy && entry.k && entry.k !== "ep") seenSystems.add(entry.sy);
    seen.add(entry);
    results.push(entry);
    return !uncapped && results.length >= MAX_SEARCH_RESULTS;
  }

  const nameOrSysMatch = (e: SearchEntry) =>
    e.n.toLowerCase().includes(q) || e.sy?.toLowerCase().includes(q);

  const aliasMatch = (e: SearchEntry) =>
    e.a?.some((a) => a.toLowerCase().includes(q)) ?? false;

  // Pre-compute which kinds match the query via keywords, so the
  // per-entry loop only checks set membership.
  const kindKeywordHit = new Set<string>();
  for (const [k, kw] of kindKeywords) {
    if (kw.some((w) => w.startsWith(q))) kindKeywordHit.add(k);
  }

  // Rank: 0 = exact name, 1 = name prefix, 2 = name/sys substring, 3 = alias
  function rank(e: SearchEntry): number {
    const nl = e.n.toLowerCase();
    if (nl === q) return 0;
    if (nl.startsWith(q)) return 1;
    if (nl.includes(q) || e.sy?.toLowerCase().includes(q)) return 2;
    return 3;
  }

  // Pass 1: kinded entries (cluster, nebula, BH, NS, exoplanet).
  // Kind-keyword matches bypass the result cap so category searches
  // ("exoplanet", "cluster", …) return the full list; name/alias
  // matches in this pass still respect the cap.
  for (const entry of index) {
    if (!entry.k) continue;
    if (excludeKinds?.has(entry.k)) continue;
    const isKindHit = kindKeywordHit.has(entry.k);
    if (!isKindHit && !nameOrSysMatch(entry) && !aliasMatch(entry)) continue;
    if (add(entry, isKindHit)) break;
  }

  // Pass 2: star primary name / system match.
  for (const entry of index) {
    if (entry.k) continue;
    if (!nameOrSysMatch(entry)) continue;
    if (add(entry)) break;
  }

  // Pass 3: star alias match.
  for (const entry of index) {
    if (entry.k) continue;
    if (seen.has(entry)) continue;
    if (!aliasMatch(entry)) continue;
    if (add(entry)) break;
  }

  // Pass 4: synthesize a system-aggregate entry for any system whose
  // starlike (no-kind) members appear at least twice in the results.
  // Selecting it focuses the SystemGroup as a whole rather than a
  // specific component. Skipped for systems that already have a
  // cluster/nebula/black-hole/neutron-star aggregate entry in the
  // index, since selecting that entry already focuses the system.
  const membersBySystem = new Map<string, SearchEntry[]>();
  for (const e of results) {
    if (e.k || !e.sy) continue;
    const list = membersBySystem.get(e.sy);
    if (list) list.push(e); else membersBySystem.set(e.sy, [e]);
  }
  const kindedSystems = getKindedSystems(index);
  for (const [sy, members] of membersBySystem) {
    if (members.length < 2) continue;
    if (kindedSystems.has(sy)) continue;
    const inv = 1 / members.length;
    let px = 0, py = 0, pz = 0, mg = members[0].mg, M = members[0].M, d = 0;
    for (const m of members) {
      px += m.p[0]; py += m.p[1]; pz += m.p[2]; d += m.d;
      if (m.mg < mg) mg = m.mg;
      if (m.M < M) M = m.M;
    }
    if (add({ n: sy, sy, p: [px * inv, py * inv, pz * inv], mg, M, d: d * inv, k: "s" })) break;
  }

  // Sort by: aggregate-before-component for the same system, then exact
  // match > prefix > substring > alias, then by name length. The system
  // tiebreaker keeps "Alpha Centauri" above "Alpha Centauri A/B/C" even
  // when both share the same query rank (e.g. substring match on
  // "centauri").
  results.sort((a, b) => {
    if (a.sy && a.sy === b.sy) {
      const aAgg = a.k === "s" ? 0 : 1;
      const bAgg = b.k === "s" ? 0 : 1;
      if (aAgg !== bAgg) return aAgg - bAgg;
    }
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.n.length - b.n.length;
  });

  return results;
}
