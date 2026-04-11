import { describe, it, expect } from "bun:test";
import type { SystemGroup } from "./types.ts";
import { shouldHighlightLabel } from "./labelVisibility.ts";

function makeMesh(name: string) {
  return { userData: { name } } as any;
}

function makeGroup(name: string, kind?: "cluster"): SystemGroup {
  return {
    name, kind, meshes: [], label: {} as any, anchor: {} as any,
    centroid: {} as any, avgDist: 0, collapsedMembers: [],
    screens: [], parents: [],
  } as any;
}

describe("shouldHighlightLabel", () => {
  const alcyone = makeMesh("Alcyone");
  const maia = makeMesh("Maia");
  const siriusA = makeMesh("Sirius A");
  const siriusB = makeMesh("Sirius B");

  const pleiades = makeGroup("Pleiades", "cluster");
  pleiades.meshes = [alcyone, maia];

  const sirius = makeGroup("Sirius");
  sirius.meshes = [siriusA, siriusB];

  const clusterOf = new Map<any, SystemGroup>();
  clusterOf.set(alcyone, pleiades);
  clusterOf.set(maia, pleiades);

  const meshToSystem = new Map<any, SystemGroup>();
  meshToSystem.set(siriusA, sirius);
  meshToSystem.set(siriusB, sirius);

  it("cluster member is NOT label-highlighted when only its cluster is hovered", () => {
    expect(shouldHighlightLabel(alcyone, {
      meshToSystem, clusterOf,
      hoveredSystem: pleiades, selectedSystem: null,
      lastHoveredMesh: null, selectedMesh: null,
    })).toBe(false);
  });

  it("cluster member is NOT label-highlighted when only its cluster is selected", () => {
    expect(shouldHighlightLabel(maia, {
      meshToSystem, clusterOf,
      hoveredSystem: null, selectedSystem: pleiades,
      lastHoveredMesh: null, selectedMesh: null,
    })).toBe(false);
  });

  it("cluster member IS label-highlighted when individually hovered", () => {
    expect(shouldHighlightLabel(alcyone, {
      meshToSystem, clusterOf,
      hoveredSystem: pleiades, selectedSystem: null,
      lastHoveredMesh: alcyone, selectedMesh: null,
    })).toBe(true);
  });

  it("cluster member is NOT highlighted when no cluster is active", () => {
    expect(shouldHighlightLabel(alcyone, {
      meshToSystem, clusterOf,
      hoveredSystem: null, selectedSystem: null,
      lastHoveredMesh: null, selectedMesh: null,
    })).toBe(false);
  });

  it("binary system member is highlighted when its system is hovered", () => {
    expect(shouldHighlightLabel(siriusA, {
      meshToSystem, clusterOf,
      hoveredSystem: sirius, selectedSystem: null,
      lastHoveredMesh: null, selectedMesh: null,
    })).toBe(true);
  });

  it("directly hovered star is highlighted regardless of system", () => {
    expect(shouldHighlightLabel(alcyone, {
      meshToSystem, clusterOf,
      hoveredSystem: null, selectedSystem: null,
      lastHoveredMesh: alcyone, selectedMesh: null,
    })).toBe(true);
  });

  it("selected star is highlighted", () => {
    expect(shouldHighlightLabel(maia, {
      meshToSystem, clusterOf,
      hoveredSystem: null, selectedSystem: null,
      lastHoveredMesh: null, selectedMesh: maia,
    })).toBe(true);
  });

  it("unrelated star is NOT highlighted when a different cluster is active", () => {
    expect(shouldHighlightLabel(siriusA, {
      meshToSystem, clusterOf,
      hoveredSystem: pleiades, selectedSystem: null,
      lastHoveredMesh: null, selectedMesh: null,
    })).toBe(false);
  });
});

// The isInSelectedGroup check lives in interaction.ts as a simple
// `selectedSystem.meshes.includes(target)` — test it via that contract.
describe("isInSelectedGroup logic (selectedSystem.meshes.includes)", () => {
  const alcyone = makeMesh("Alcyone");
  const maia = makeMesh("Maia");
  const siriusA = makeMesh("Sirius A");
  const vega = makeMesh("Vega");

  const pleiades = makeGroup("Pleiades", "cluster");
  pleiades.meshes = [alcyone, maia];

  const sirius = makeGroup("Sirius");
  sirius.meshes = [siriusA];

  function isInSelectedGroup(target: any, selectedSystem: SystemGroup | null) {
    return selectedSystem !== null && selectedSystem.meshes.includes(target);
  }

  it("cluster member is in selected group when cluster is selected", () => {
    expect(isInSelectedGroup(alcyone, pleiades)).toBe(true);
  });

  it("cluster member is NOT in selected group when cluster is not selected", () => {
    expect(isInSelectedGroup(alcyone, null)).toBe(false);
  });

  it("binary member is in selected group when system is selected", () => {
    expect(isInSelectedGroup(siriusA, sirius)).toBe(true);
  });

  it("unrelated star is NOT in selected group", () => {
    expect(isInSelectedGroup(vega, pleiades)).toBe(false);
  });
});
