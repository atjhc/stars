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

  const meshToSystem = new Map<any, SystemGroup>();
  meshToSystem.set(siriusA, sirius);
  meshToSystem.set(siriusB, sirius);

  it("cluster member is NOT label-highlighted when only its cluster is hovered", () => {
    expect(shouldHighlightLabel(alcyone, {
      meshToSystem,
      hoveredSystem: pleiades, selectedSystem: null,
      selectedSubset: null, lastHoveredMesh: null, selectedMesh: null,
    })).toBe(false);
  });

  it("cluster member is NOT label-highlighted when only its cluster is selected", () => {
    expect(shouldHighlightLabel(maia, {
      meshToSystem,
      hoveredSystem: null, selectedSystem: pleiades,
      selectedSubset: null, lastHoveredMesh: null, selectedMesh: null,
    })).toBe(false);
  });

  it("cluster member IS label-highlighted when individually hovered", () => {
    expect(shouldHighlightLabel(alcyone, {
      meshToSystem,
      hoveredSystem: pleiades, selectedSystem: null,
      selectedSubset: null, lastHoveredMesh: alcyone, selectedMesh: null,
    })).toBe(true);
  });

  it("cluster member is NOT highlighted when no cluster is active", () => {
    expect(shouldHighlightLabel(alcyone, {
      meshToSystem,
      hoveredSystem: null, selectedSystem: null,
      selectedSubset: null, lastHoveredMesh: null, selectedMesh: null,
    })).toBe(false);
  });

  it("binary system member is highlighted when its system is hovered", () => {
    expect(shouldHighlightLabel(siriusA, {
      meshToSystem,
      hoveredSystem: sirius, selectedSystem: null,
      selectedSubset: null, lastHoveredMesh: null, selectedMesh: null,
    })).toBe(true);
  });

  it("directly hovered star is highlighted regardless of system", () => {
    expect(shouldHighlightLabel(alcyone, {
      meshToSystem,
      hoveredSystem: null, selectedSystem: null,
      selectedSubset: null, lastHoveredMesh: alcyone, selectedMesh: null,
    })).toBe(true);
  });

  it("selected star is highlighted", () => {
    expect(shouldHighlightLabel(maia, {
      meshToSystem,
      hoveredSystem: null, selectedSystem: null,
      selectedSubset: null, lastHoveredMesh: null, selectedMesh: maia,
    })).toBe(true);
  });

  it("unrelated star is NOT highlighted when a different cluster is active", () => {
    expect(shouldHighlightLabel(siriusA, {
      meshToSystem,
      hoveredSystem: pleiades, selectedSystem: null,
      selectedSubset: null, lastHoveredMesh: null, selectedMesh: null,
    })).toBe(false);
  });

  it("non-subset member is NOT highlighted when system is selected with subset", () => {
    const proxima = makeMesh("Proxima Centauri");
    const alphaCen = makeGroup("Alpha Centauri");
    alphaCen.meshes = [siriusA, siriusB, proxima]; // reusing siriusA/B as A+B stand-ins
    const m2s = new Map<any, SystemGroup>();
    m2s.set(siriusA, alphaCen);
    m2s.set(siriusB, alphaCen);
    m2s.set(proxima, alphaCen);
    expect(shouldHighlightLabel(proxima, {
      meshToSystem: m2s,
      hoveredSystem: null, selectedSystem: alphaCen,
      selectedSubset: [siriusA, siriusB],
      lastHoveredMesh: null, selectedMesh: null,
    })).toBe(false);
  });

  it("subset member IS highlighted when system is selected with subset", () => {
    const proxima = makeMesh("Proxima Centauri");
    const alphaCen = makeGroup("Alpha Centauri");
    alphaCen.meshes = [siriusA, siriusB, proxima];
    const m2s = new Map<any, SystemGroup>();
    m2s.set(siriusA, alphaCen);
    m2s.set(siriusB, alphaCen);
    m2s.set(proxima, alphaCen);
    expect(shouldHighlightLabel(siriusA, {
      meshToSystem: m2s,
      hoveredSystem: null, selectedSystem: alphaCen,
      selectedSubset: [siriusA, siriusB],
      lastHoveredMesh: null, selectedMesh: null,
    })).toBe(true);
  });

  it("hover still spans whole system even when a subset is selected", () => {
    const proxima = makeMesh("Proxima Centauri");
    const alphaCen = makeGroup("Alpha Centauri");
    alphaCen.meshes = [siriusA, siriusB, proxima];
    const m2s = new Map<any, SystemGroup>();
    m2s.set(siriusA, alphaCen);
    m2s.set(siriusB, alphaCen);
    m2s.set(proxima, alphaCen);
    expect(shouldHighlightLabel(proxima, {
      meshToSystem: m2s,
      hoveredSystem: alphaCen, selectedSystem: null,
      selectedSubset: null,
      lastHoveredMesh: null, selectedMesh: null,
    })).toBe(true);
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
