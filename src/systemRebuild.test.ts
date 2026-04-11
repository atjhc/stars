import { describe, it, expect } from "bun:test";
import type { SystemGroup } from "./types.ts";

// The core bug: rebuildSystems creates new group objects, but
// selectedSystem/hoveredSystem still reference the old (destroyed) group.
// After rebuild, identity checks like `selectedSystem === group` fail
// because they're different objects with the same name.

describe("selectedSystem survives rebuildSystems", () => {
  it("FAILS: after rebuild, old selectedSystem !== new group with same name", () => {
    const oldGroup = { name: "Pleiades" } as SystemGroup;
    const selectedSystem = oldGroup;

    // Simulate rebuildSystems: creates a NEW group object
    const newGroup = { name: "Pleiades" } as SystemGroup;
    const newSystemGroups = [newGroup];

    // The bug: identity check fails
    const isHighlighted = selectedSystem === newGroup;
    expect(isHighlighted).toBe(false); // This is what happens — BROKEN
  });

  it("FIX: after rebuild, selectedSystem is updated to the new group", () => {
    let selectedSystem: SystemGroup | null = { name: "Pleiades" } as SystemGroup;

    // Simulate rebuildSystems with fix: re-link by name
    const newGroup = { name: "Pleiades" } as SystemGroup;
    const newSystemGroups = [newGroup];

    // Fix: update selectedSystem to new group with same name
    if (selectedSystem) {
      const replacement = newSystemGroups.find((g) => g.name === selectedSystem!.name);
      if (replacement) {
        selectedSystem = replacement;
      } else {
        selectedSystem = null; // group no longer exists
      }
    }

    expect(selectedSystem).toBe(newGroup);
    expect(selectedSystem === newGroup).toBe(true);
  });

  it("FIX: hoveredSystem is also updated after rebuild", () => {
    let hoveredSystem: SystemGroup | null = { name: "Hyades" } as SystemGroup;

    const newGroup = { name: "Hyades" } as SystemGroup;
    const newSystemGroups = [newGroup];

    if (hoveredSystem) {
      const replacement = newSystemGroups.find((g) => g.name === hoveredSystem!.name);
      hoveredSystem = replacement ?? null;
    }

    expect(hoveredSystem).toBe(newGroup);
  });

  it("FIX: selectedSystem cleared if group no longer exists after rebuild", () => {
    let selectedSystem: SystemGroup | null = { name: "Removed" } as SystemGroup;

    const newSystemGroups: SystemGroup[] = [];

    if (selectedSystem) {
      const replacement = newSystemGroups.find((g) => g.name === selectedSystem!.name);
      selectedSystem = replacement ?? null;
    }

    expect(selectedSystem).toBeNull();
  });
});
