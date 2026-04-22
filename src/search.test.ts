import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { SearchEntry } from "./catalog.ts";

// Isolate the search-matching logic from the DOM-dependent setupSearch.
// Extract the core filtering into a testable function.
import { filterSearch } from "./searchFilter.ts";

function makeEntry(overrides: Partial<SearchEntry> & { n: string }): SearchEntry {
  return {
    p: [0, 0, 0],
    mg: 0,
    M: 0,
    d: 0,
    ...overrides,
  };
}

describe("filterSearch", () => {
  const hyadesStar1 = makeEntry({ n: "97 Tau", t: "tile1", i: 1, sy: "Hyades" });
  const hyadesStar2 = makeEntry({ n: "Prima Hyadum", t: "tile1", i: 2, sy: "Hyades" });
  const hyadesStar3 = makeEntry({ n: "76 Tau", t: "tile1", i: 3, sy: "Hyades" });
  const hyadesCluster = makeEntry({ n: "Hyades", k: "c", sy: "Hyades", a: ["Melotte 25"] });
  const pleiadesCluster = makeEntry({ n: "Pleiades", k: "c", sy: "Pleiades", a: ["M45", "Seven Sisters"] });
  const alcyone = makeEntry({ n: "Alcyone", t: "tile2", i: 10, sy: "Pleiades" });
  const siriusA = makeEntry({ n: "Sirius A", t: "tile3", i: 20, sy: "Sirius", a: ["Sirius"] });
  const siriusB = makeEntry({ n: "Sirius B", t: "tile3", i: 21, sy: "Sirius" });
  const vega = makeEntry({ n: "Vega", t: "tile4", i: 30 });
  const sol = makeEntry({ n: "Sol", t: "tile5", i: 40 });
  const solitaire = makeEntry({ n: "Solitaire", t: "tile6", i: 41 });

  const index: SearchEntry[] = [
    hyadesStar1, hyadesStar2, hyadesStar3,
    alcyone, siriusA, siriusB, vega, solitaire, sol,
    hyadesCluster, pleiadesCluster,
  ];

  it("searching 'Hyades' returns the cluster entry, not individual members", () => {
    const results = filterSearch("Hyades", index);
    expect(results.length).toBe(1);
    expect(results[0]).toBe(hyadesCluster);
  });

  it("searching 'M45' matches Pleiades cluster via alias", () => {
    const results = filterSearch("M45", index);
    expect(results.length).toBe(1);
    expect(results[0]).toBe(pleiadesCluster);
  });

  it("searching 'Seven Sisters' matches Pleiades cluster via alias", () => {
    const results = filterSearch("Seven Sisters", index);
    expect(results.length).toBe(1);
    expect(results[0]).toBe(pleiadesCluster);
  });

  it("searching 'Melotte 25' matches Hyades cluster via alias", () => {
    const results = filterSearch("Melotte 25", index);
    expect(results.length).toBe(1);
    expect(results[0]).toBe(hyadesCluster);
  });

  it("searching 'Alcyone' returns Alcyone (not Pleiades cluster)", () => {
    const results = filterSearch("Alcyone", index);
    expect(results.length).toBe(1);
    expect(results[0]).toBe(alcyone);
  });

  it("searching 'Sirius' returns every member of the binary", () => {
    const results = filterSearch("Sirius", index);
    expect(results.length).toBe(2);
    const names = results.map((r) => r.n).sort();
    expect(names).toEqual(["Sirius A", "Sirius B"]);
  });

  it("searching 'Vega' returns Vega (no system dedup)", () => {
    const results = filterSearch("Vega", index);
    expect(results.length).toBe(1);
    expect(results[0]).toBe(vega);
  });

  it("searching 'Prima Hyadum' returns that star, not the Hyades cluster", () => {
    const results = filterSearch("Prima Hyadum", index);
    // Prima Hyadum matches by name, but Hyades cluster doesn't match "Prima Hyadum".
    // So Prima Hyadum should show (even though it has sy:"Hyades" — the cluster
    // entry doesn't match this query, so it doesn't block via seenSystems).
    expect(results.length).toBe(1);
    expect(results[0]).toBe(hyadesStar2);
  });

  it("searching 'cluster' matches all cluster entries", () => {
    const results = filterSearch("cluster", index);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.k === "c")).toBe(true);
  });

  it("searching 'star cluster' matches cluster entries", () => {
    const results = filterSearch("star cluster", index);
    expect(results.length).toBe(2);
    expect(results.every((r) => r.k === "c")).toBe(true);
  });

  it("exact name match ranks before prefix match", () => {
    const results = filterSearch("Sol", index);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].n).toBe("Sol");
  });

  it("prefix match ranks before substring match", () => {
    // "Vega" should rank before a hypothetical star containing "vega" mid-name
    const testIndex = [
      ...index,
      makeEntry({ n: "Novega", t: "tile9", i: 90 }),
    ];
    const results = filterSearch("vega", testIndex);
    const vegaIdx = results.findIndex((r) => r.n === "Vega");
    const novegaIdx = results.findIndex((r) => r.n === "Novega");
    expect(vegaIdx).toBeLessThan(novegaIdx);
  });

  it("shorter prefix match ranks before longer prefix match", () => {
    const testIndex = [
      makeEntry({ n: "Sol", t: "tile1", i: 1 }),
      makeEntry({ n: "Solitaire", t: "tile2", i: 2 }),
    ];
    const results = filterSearch("sol", testIndex);
    expect(results[0].n).toBe("Sol");
    expect(results[1].n).toBe("Solitaire");
  });

  it("cluster dedupe only fires when the cluster entry itself matches", () => {
    const results = filterSearch("Tau", index);
    const names = results.map((r) => r.n);
    // Cluster entry doesn't match "Tau" so it doesn't block Hyades
    // members — both 97 Tau and 76 Tau should show through.
    expect(names).toContain("97 Tau");
    expect(names).toContain("76 Tau");
    expect(names).not.toContain("Hyades");
  });

  it("cluster entry dedupes its star members when both match", () => {
    // "Hyades" matches the cluster entry (Pass 1) and all three members
    // via their sy (Pass 2). Only the cluster entry should come back.
    const results = filterSearch("Hyades", index);
    expect(results.length).toBe(1);
    expect(results[0]).toBe(hyadesCluster);
  });
});
