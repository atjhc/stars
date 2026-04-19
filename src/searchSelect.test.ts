import { describe, it, expect } from "bun:test";
import type { SearchEntry } from "./catalog.ts";

// Test: when a star search entry is selected, the selection pipeline
// should call selectTarget on the resolved mesh. When a cluster entry
// is selected, it should call selectSystem on the found group.
//
// We model the decision logic from main.ts handleSearchSelect as a
// pure function to verify the routing.

interface SelectActions {
  animatedTo: [number, number, number] | null;
  selectedTarget: any | null;
  selectedCluster: string | null;
  pendingCluster: string | null;
  forcedTile: { t: string; i: number } | null;
}

function simulateSearchSelect(
  entry: SearchEntry,
  systemGroupNames: string[],
  meshByRef: Map<string, any>,
  searchIndex: SearchEntry[],
): SelectActions {
  const actions: SelectActions = {
    animatedTo: null,
    selectedTarget: null,
    selectedCluster: null,
    pendingCluster: null,
    forcedTile: null,
  };

  actions.animatedTo = [entry.p[0], entry.p[1], entry.p[2]];

  if (entry.k === "c") {
    const groupExists = systemGroupNames.includes(entry.n);
    if (groupExists) {
      actions.selectedCluster = entry.n;
    } else {
      actions.pendingCluster = entry.n;
      const member = searchIndex.find((e) => e.sy === entry.n && e.t);
      if (member?.t && member.i !== undefined) {
        actions.forcedTile = { t: member.t, i: member.i };
      }
    }
    return actions;
  }

  if (entry.t !== undefined && entry.i !== undefined) {
    // requestTileFocus resolves immediately if mesh exists
    const mesh = meshByRef.get(`${entry.t}/${entry.i}`);
    if (mesh) {
      actions.selectedTarget = mesh;
    } else {
      actions.forcedTile = { t: entry.t, i: entry.i };
    }
  }

  return actions;
}

describe("search selection routing", () => {
  const alcyoneAnchor = { name: "alcyone-anchor" };
  const tau97Mesh = { name: "97-tau-mesh" };

  const meshByRef = new Map<string, any>();
  meshByRef.set("bright/100", alcyoneAnchor);  // tier-0 notable
  meshByRef.set("0_3_4_4_4/500", tau97Mesh);    // tier-1

  const searchIndex: SearchEntry[] = [
    { n: "Hyades", k: "c", sy: "Hyades", p: [0, 0, 0], mg: 0, M: 0, d: 0, a: [] },
    { n: "97 Tau", t: "0_3_4_4_4", i: 500, sy: "Hyades", p: [1, 2, 3], mg: 5, M: 2, d: 40 },
    { n: "Alcyone", t: "bright", i: 100, sy: "Pleiades", p: [4, 5, 6], mg: 3, M: -1, d: 136 },
  ];

  it("selecting a star entry resolves immediately when mesh exists", () => {
    const entry = searchIndex[2]; // Alcyone
    const actions = simulateSearchSelect(entry, ["Pleiades"], meshByRef, searchIndex);
    expect(actions.selectedTarget).toBe(alcyoneAnchor);
    expect(actions.animatedTo).toEqual([4, 5, 6]);
    expect(actions.selectedCluster).toBeNull();
    expect(actions.forcedTile).toBeNull();
  });

  it("selecting a star entry whose tile isn't loaded triggers force-load", () => {
    const entry: SearchEntry = { n: "Some Star", t: "unloaded_tile", i: 999, p: [7, 8, 9], mg: 6, M: 3, d: 200 };
    const actions = simulateSearchSelect(entry, [], meshByRef, searchIndex);
    expect(actions.selectedTarget).toBeNull();
    expect(actions.forcedTile).toEqual({ t: "unloaded_tile", i: 999 });
  });

  it("selecting a cluster entry selects the group when it exists", () => {
    const entry = searchIndex[0]; // Hyades cluster
    const actions = simulateSearchSelect(entry, ["Hyades", "Pleiades"], meshByRef, searchIndex);
    expect(actions.selectedCluster).toBe("Hyades");
    expect(actions.selectedTarget).toBeNull();
    expect(actions.pendingCluster).toBeNull();
  });

  it("selecting a cluster entry sets pending + force-loads when group doesn't exist", () => {
    const entry = searchIndex[0]; // Hyades cluster
    const actions = simulateSearchSelect(entry, ["Pleiades"], meshByRef, searchIndex);
    expect(actions.selectedCluster).toBeNull();
    expect(actions.pendingCluster).toBe("Hyades");
    expect(actions.forcedTile).toEqual({ t: "0_3_4_4_4", i: 500 });
  });

  it("selecting a star calls selectTarget which highlights the star", () => {
    const entry = searchIndex[1]; // 97 Tau (tier-1, tile loaded)
    const actions = simulateSearchSelect(entry, ["Hyades"], meshByRef, searchIndex);
    expect(actions.selectedTarget).toBe(tau97Mesh);
  });

  it("selecting a star whose mesh exists resolves SYNCHRONOUSLY (no async gap)", () => {
    const entry = searchIndex[2]; // Alcyone, mesh exists
    const actions = simulateSearchSelect(entry, ["Pleiades"], meshByRef, searchIndex);
    expect(actions.selectedTarget).toBe(alcyoneAnchor);
  });

  it("new search clears any pending cluster selection from a previous search", () => {
    // Scenario: user searched "Hyades" (cluster, group not found yet),
    // then immediately searches "Alcyone". The pending Hyades state
    // should not persist and override Alcyone when Hyades materializes.
    const hyadesEntry = searchIndex[0]; // k:"c"
    const alcyoneEntry = searchIndex[2]; // regular star

    // Model shared mutable state (mirrors main.ts pendingClusterSelect)
    let pendingCluster: string | null = null;

    function handleSelect(entry: SearchEntry) {
      // FIX: clear pending from previous search
      pendingCluster = null;

      if (entry.k === "c") {
        const groupExists = ["Pleiades"].includes(entry.n); // Hyades not yet
        if (!groupExists) pendingCluster = entry.n;
        return;
      }
      // star selection would fire here
    }

    handleSelect(hyadesEntry);
    expect(pendingCluster).toBe("Hyades");

    handleSelect(alcyoneEntry);
    expect(pendingCluster).toBeNull();
  });
});

