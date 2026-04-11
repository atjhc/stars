import type { SearchEntry } from "./catalog.ts";
import { MAX_SEARCH_RESULTS } from "./constants.ts";

export function filterSearch(query: string, index: SearchEntry[]): SearchEntry[] {
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

  // Pass 1: cluster entries by name, system, alias, or the term "cluster".
  for (const entry of index) {
    if (entry.k !== "c") continue;
    if (!clusterMatch(entry)) continue;
    if (add(entry)) return results;
  }

  // Pass 2: non-cluster primary name / system match.
  for (const entry of index) {
    if (entry.k === "c") continue;
    if (!nameOrSysMatch(entry)) continue;
    if (add(entry)) return results;
  }

  // Pass 3: non-cluster alias match.
  for (const entry of index) {
    if (entry.k === "c") continue;
    if (seen.has(entry)) continue;
    if (!aliasMatch(entry)) continue;
    if (add(entry)) return results;
  }

  return results;
}
