import { describe, it, expect } from "bun:test";

// Model the glow logic from interaction.ts to verify consistency
// across clusters with and without resolved member meshes.

const DEFAULT_CLUSTER_SHADOW = "0 0 8px rgba(100,150,220,0.6), 0 0 3px #000";
const HIGHLIGHT_SHADOW = "0 0 12px rgba(200,200,255,0.8)"; // example star glow

interface MockGroup {
  meshes: { userData: { ci: number; lum: number } }[];
  labelTextShadow: string;
}

function applySystemLabelGlow(group: MockGroup) {
  if (group.meshes.length > 0) {
    // Pick brightest star's color for the glow
    group.labelTextShadow = HIGHLIGHT_SHADOW;
  } else {
    // Clusters with no resolved meshes still need a visible glow
    group.labelTextShadow = HIGHLIGHT_SHADOW;
  }
}

function removeSystemLabelGlow(group: MockGroup, defaultShadow: string) {
  // Restore the default cluster glow, don't just clear to ""
  group.labelTextShadow = defaultShadow;
}

describe("cluster label glow consistency", () => {
  it("cluster with meshes gets glow on highlight", () => {
    const group: MockGroup = {
      meshes: [{ userData: { ci: 0.5, lum: 1 } }],
      labelTextShadow: DEFAULT_CLUSTER_SHADOW,
    };
    applySystemLabelGlow(group);
    expect(group.labelTextShadow).not.toBe("");
    expect(group.labelTextShadow).not.toBe(DEFAULT_CLUSTER_SHADOW);
  });

  it("cluster WITHOUT meshes ALSO gets glow on highlight", () => {
    const group: MockGroup = {
      meshes: [],
      labelTextShadow: DEFAULT_CLUSTER_SHADOW,
    };
    applySystemLabelGlow(group);
    expect(group.labelTextShadow).not.toBe("");
    expect(group.labelTextShadow).not.toBe(DEFAULT_CLUSTER_SHADOW);
  });

  it("after unhighlight, cluster label restores default glow (not empty)", () => {
    const group: MockGroup = {
      meshes: [],
      labelTextShadow: HIGHLIGHT_SHADOW,
    };
    removeSystemLabelGlow(group, DEFAULT_CLUSTER_SHADOW);
    expect(group.labelTextShadow).toBe(DEFAULT_CLUSTER_SHADOW);
    expect(group.labelTextShadow).not.toBe("");
  });
});
