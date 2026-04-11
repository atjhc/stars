import type { SearchEntry } from "./catalog.ts";
import { MAX_SEARCH_RESULTS } from "./constants.ts";

export function filterSearch(query: string, index: SearchEntry[], excludeKinds?: Set<string>): SearchEntry[] {
  const q = query.toLowerCase().trim();
  if (q.length === 0) return [];

  const results: SearchEntry[] = [];
  const seen = new Set<SearchEntry>();
  const seenSystems = new Set<string>();

  function add(entry: SearchEntry): boolean {
    if (seen.has(entry)) return false;
    if (entry.sy && seenSystems.has(entry.sy)) return false;
    if (entry.sy) seenSystems.add(entry.sy);
    seen.add(entry);
    results.push(entry);
    return results.length >= MAX_SEARCH_RESULTS;
  }

  const nameOrSysMatch = (e: SearchEntry) =>
    e.n.toLowerCase().includes(q) || e.sy?.toLowerCase().includes(q);

  const aliasMatch = (e: SearchEntry) =>
    e.a?.some((a) => a.toLowerCase().includes(q)) ?? false;

  const clusterMatch = (e: SearchEntry) =>
    "star cluster".startsWith(q) || "cluster".startsWith(q) || nameOrSysMatch(e) || aliasMatch(e);

  // Rank: 0 = exact name, 1 = name prefix, 2 = name/sys substring, 3 = alias
  function rank(e: SearchEntry): number {
    const nl = e.n.toLowerCase();
    if (nl === q) return 0;
    if (nl.startsWith(q)) return 1;
    if (nl.includes(q) || e.sy?.toLowerCase().includes(q)) return 2;
    return 3;
  }

  const nebulaMatch = (e: SearchEntry) =>
    "nebula".startsWith(q) || "molecular cloud".startsWith(q) ||
    "dark nebula".startsWith(q) || nameOrSysMatch(e) || aliasMatch(e);

  // Pass 1: cluster and nebula entries.
  for (const entry of index) {
    if (excludeKinds?.has(entry.k ?? "")) continue;
    if (entry.k === "c") {
      if (!clusterMatch(entry)) continue;
    } else if (entry.k === "n") {
      if (!nebulaMatch(entry)) continue;
    } else {
      continue;
    }
    if (add(entry)) break;
  }

  // Pass 2: star primary name / system match.
  for (const entry of index) {
    if (entry.k === "c" || entry.k === "n") continue;
    if (!nameOrSysMatch(entry)) continue;
    if (add(entry)) break;
  }

  // Pass 3: star alias match.
  for (const entry of index) {
    if (entry.k === "c" || entry.k === "n") continue;
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
