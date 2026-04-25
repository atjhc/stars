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

export function filterSearch(query: string, index: SearchEntry[], excludeKinds?: Set<string>): SearchEntry[] {
  const q = query.toLowerCase().trim();
  if (q.length === 0) return [];

  const results: SearchEntry[] = [];
  const seen = new Set<SearchEntry>();
  const seenSystems = new Set<string>();

  function add(entry: SearchEntry): boolean {
    if (seen.has(entry)) return false;
    if (entry.sy && seenSystems.has(entry.sy)) return false;
    // Only cluster / nebula / black-hole entries aggregate their
    // members into one search row — so only they dedupe later star
    // members sharing their sy. Multi-star systems (binary/trinary)
    // have no such aggregate entry, so every member stays visible and
    // renders as "System · Member" in the result list.
    if (entry.sy && entry.k) seenSystems.add(entry.sy);
    seen.add(entry);
    results.push(entry);
    return results.length >= MAX_SEARCH_RESULTS;
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

  function kindMatch(e: SearchEntry): boolean {
    if (kindKeywordHit.has(e.k!)) return true;
    return nameOrSysMatch(e) || aliasMatch(e);
  }

  // Rank: 0 = exact name, 1 = name prefix, 2 = name/sys substring, 3 = alias
  function rank(e: SearchEntry): number {
    const nl = e.n.toLowerCase();
    if (nl === q) return 0;
    if (nl.startsWith(q)) return 1;
    if (nl.includes(q) || e.sy?.toLowerCase().includes(q)) return 2;
    return 3;
  }

  // Pass 1: cluster, nebula, black hole, and neutron-star entries.
  for (const entry of index) {
    if (!entry.k) continue;
    if (excludeKinds?.has(entry.k)) continue;
    if (!kindMatch(entry)) continue;
    if (add(entry)) break;
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

  // Sort by: exact match > prefix > substring > alias, then by name length.
  results.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.n.length - b.n.length;
  });

  return results;
}
