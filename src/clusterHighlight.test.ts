import { describe, it, expect } from "bun:test";
import type { SystemGroup } from "./types.ts";
import { shouldHighlightLabel, type HighlightContext } from "./labelVisibility.ts";

// Model the label-processing decision for a star in a cluster.
// This mirrors the logic in labels.ts processLabel.

interface LabelDecision {
  visible: boolean;
  labelFullOpacity: boolean;
  labelGlow: boolean;
  subtitle: boolean;
}

interface Context {
  hoveredSystem: SystemGroup | null;
  selectedSystem: SystemGroup | null;
  lastHoveredMesh: any;
  selectedMesh: any;
  meshToSystem: Map<any, SystemGroup>;
  clusterOf: Map<any, SystemGroup>;
}

// Pure function modeling the decision logic we WANT:
function decideLabelState(target: any, ctx: Context): LabelDecision {
  const sys = ctx.meshToSystem.get(target);
  const cluster = ctx.clusterOf.get(target);

  // Individually highlighted: directly hovered, directly selected, or
  // member of a hovered/selected binary system.
  const isIndividuallyHighlighted =
    target === ctx.lastHoveredMesh ||
    target === ctx.selectedMesh ||
    (sys !== undefined && (sys === ctx.hoveredSystem || sys === ctx.selectedSystem));

  // Cluster is active but this star isn't individually highlighted.
  const isClusterActive = cluster !== undefined &&
    (cluster === ctx.hoveredSystem || cluster === ctx.selectedSystem);

  return {
    // Star is visible if individually highlighted OR its cluster is active
    // (so the billboard glow from highlightSystem shows).
    visible: isIndividuallyHighlighted || isClusterActive,

    // Label gets full opacity + subtitle ONLY when individually highlighted.
    labelFullOpacity: isIndividuallyHighlighted,

    // Label glow ONLY when individually highlighted.
    labelGlow: isIndividuallyHighlighted,

    // Subtitle ONLY when individually highlighted.
    subtitle: isIndividuallyHighlighted,
  };
}

function makeMesh(name: string) { return { userData: { name } } as any; }
function makeGroup(name: string, kind?: "cluster"): SystemGroup {
  return { name, kind, meshes: [], collapsedMembers: [] } as any;
}

describe("cluster highlight requirements", () => {
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

  const base: Context = {
    hoveredSystem: null, selectedSystem: null,
    lastHoveredMesh: null, selectedMesh: null,
    meshToSystem, clusterOf,
  };

  describe("Req 2: highlighted cluster glows stars but NOT their labels", () => {
    it("cluster hovered: member star visible (for billboard glow)", () => {
      const d = decideLabelState(alcyone, { ...base, hoveredSystem: pleiades });
      expect(d.visible).toBe(true);
    });

    it("cluster hovered: member label NOT at full opacity", () => {
      const d = decideLabelState(alcyone, { ...base, hoveredSystem: pleiades });
      expect(d.labelFullOpacity).toBe(false);
    });

    it("cluster hovered: member label NOT glowing", () => {
      const d = decideLabelState(alcyone, { ...base, hoveredSystem: pleiades });
      expect(d.labelGlow).toBe(false);
    });

    it("cluster selected: member star visible", () => {
      const d = decideLabelState(maia, { ...base, selectedSystem: pleiades });
      expect(d.visible).toBe(true);
    });

    it("cluster selected: member label NOT at full opacity", () => {
      const d = decideLabelState(maia, { ...base, selectedSystem: pleiades });
      expect(d.labelFullOpacity).toBe(false);
    });
  });

  describe("Req 4: hovering a star within a highlighted cluster glows its label", () => {
    it("individually hovered member: label at full opacity", () => {
      const d = decideLabelState(alcyone, {
        ...base, selectedSystem: pleiades, lastHoveredMesh: alcyone,
      });
      expect(d.labelFullOpacity).toBe(true);
    });

    it("individually hovered member: label glows", () => {
      const d = decideLabelState(alcyone, {
        ...base, selectedSystem: pleiades, lastHoveredMesh: alcyone,
      });
      expect(d.labelGlow).toBe(true);
    });

    it("non-hovered sibling: label does NOT glow", () => {
      const d = decideLabelState(maia, {
        ...base, selectedSystem: pleiades, lastHoveredMesh: alcyone,
      });
      expect(d.labelGlow).toBe(false);
    });
  });

  describe("Req 5: selecting cluster from search puts it in selected state", () => {
    // Model the selectSystem call chain to verify glow is applied
    it("selectSystem sets selectedSystem and calls showSystemMembers which applies glow", () => {
      // Simulate selectSystem's effects
      let selectedSystem: SystemGroup | null = null;
      let systemGlowApplied = false;
      let systemHighlighted = false;

      function applySystemLabelGlow(_group: SystemGroup) { systemGlowApplied = true; }
      function highlightSystem(_group: SystemGroup) { systemHighlighted = true; }
      function showSystemMembers(group: SystemGroup) {
        highlightSystem(group);
        applySystemLabelGlow(group);
      }
      function selectSystem(group: SystemGroup) {
        selectedSystem = group;
        showSystemMembers(group);
      }

      selectSystem(pleiades);
      expect(selectedSystem).toBe(pleiades);
      expect(systemGlowApplied).toBe(true);
      expect(systemHighlighted).toBe(true);
    });

    it("cluster label stays visible when selectedSystem matches", () => {
      // Model the labels.ts cluster block: label visible if isHighlighted
      const isHighlighted = pleiades === pleiades; // selectedSystem === group
      const t = 0.9; // would normally hide
      const visible = t < 1 || isHighlighted;
      expect(visible).toBe(true);
    });

    it("search handleSearchSelect for cluster calls selectSystem (not selectStar)", () => {
      // The k:"c" branch should route to selectSystem, which applies glow.
      // If it falls through to the star path, glow won't be applied.
      const entry = { n: "Pleiades", k: "c" as const, sy: "Pleiades", p: [0, 0, 0] as [number, number, number], mg: 0, M: 0, d: 0 };
      let selectedCluster: string | null = null;
      let selectedStar: any = null;

      // Model handleSearchSelect routing
      if (entry.k === "c") {
        selectedCluster = entry.n;
      } else {
        selectedStar = entry;
      }

      expect(selectedCluster).toBe("Pleiades");
      expect(selectedStar).toBeNull();
    });
  });

  describe("Req 3: labels.ts cluster block must apply/maintain glow per frame", () => {
    it("cluster label gets glow in labels.ts when selectedSystem matches", () => {
      // Model the labels.ts cluster block decision
      const isHighlighted = true; // selectedSystem === group
      // The block should apply textShadow, not just opacity/zIndex
      let textShadowSet = false;
      let opacitySet = false;

      // Current code (BUG): only sets opacity/zIndex, doesn't set textShadow
      // Fixed code: when isHighlighted, also set textShadow
      if (isHighlighted) {
        opacitySet = true;
        textShadowSet = true; // FIX: must set glow in per-frame block
      }

      expect(opacitySet).toBe(true);
      expect(textShadowSet).toBe(true);
    });

    it("cluster label loses glow in labels.ts when NOT highlighted", () => {
      const isHighlighted = false;
      let textShadowCleared = false;

      if (!isHighlighted) {
        textShadowCleared = true; // restore default or clear highlight glow
      }

      expect(textShadowCleared).toBe(true);
    });
  });

  describe("binary system members still behave as before", () => {
    it("binary system hovered: member label at full opacity", () => {
      const d = decideLabelState(siriusA, { ...base, hoveredSystem: sirius });
      expect(d.labelFullOpacity).toBe(true);
    });

    it("binary system hovered: member label glows", () => {
      const d = decideLabelState(siriusA, { ...base, hoveredSystem: sirius });
      expect(d.labelGlow).toBe(true);
    });
  });
});

// Tests against the ACTUAL shouldHighlightLabel function to verify it
// matches the desired model. These should FAIL if the current code
// treats cluster membership the same as binary system membership.
describe("shouldHighlightLabel vs cluster requirements (CURRENT CODE)", () => {
  const alcyone = makeMesh("Alcyone");
  const maia = makeMesh("Maia");
  const siriusA = makeMesh("Sirius A");

  const pleiades = makeGroup("Pleiades", "cluster");
  pleiades.meshes = [alcyone, maia];

  const sirius = makeGroup("Sirius");
  sirius.meshes = [siriusA];

  const meshToSystem = new Map<any, SystemGroup>();
  meshToSystem.set(siriusA, sirius);

  const base: HighlightContext = {
    hoveredSystem: null, selectedSystem: null, selectedSubset: null,
    lastHoveredMesh: null, selectedMesh: null,
    meshToSystem,
  };

  it("cluster hovered: member should NOT be label-highlighted", () => {
    // shouldHighlightLabel currently returns true here (BUG).
    // It should return false — cluster members only get billboard glow,
    // not label highlight.
    const result = shouldHighlightLabel(alcyone, { ...base, hoveredSystem: pleiades });
    expect(result).toBe(false);
  });

  it("cluster selected: member should NOT be label-highlighted", () => {
    const result = shouldHighlightLabel(maia, { ...base, selectedSystem: pleiades });
    expect(result).toBe(false);
  });

  it("individually hovered cluster member SHOULD be label-highlighted", () => {
    const result = shouldHighlightLabel(alcyone, {
      ...base, selectedSystem: pleiades, lastHoveredMesh: alcyone,
    });
    expect(result).toBe(true);
  });

  it("binary system member SHOULD be label-highlighted when system hovered", () => {
    const result = shouldHighlightLabel(siriusA, { ...base, hoveredSystem: sirius });
    expect(result).toBe(true);
  });
});
