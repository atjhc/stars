import type * as THREE from "three";
import type { SystemGroup } from "./types.ts";

let _selected: SystemGroup | null = null;
let _hovered: SystemGroup | null = null;
let _selectedMesh: THREE.Object3D | null = null;
let _lastHoveredMesh: THREE.Object3D | null = null;
let _labelsDirty = true;
let _selectedMembers = new Set<THREE.Object3D>();

function rebuildSelectedMembers() {
  _selectedMembers = _selected ? new Set(_selected.meshes) : new Set();
}

export function getSelectedSystem() { return _selected; }
export function setSelectedSystem(g: SystemGroup | null) {
  _selected = g;
  rebuildSelectedMembers();
}

export function getHoveredSystem() { return _hovered; }
export function setHoveredSystem(g: SystemGroup | null) { _hovered = g; }

export function getSelectedMesh() { return _selectedMesh; }
export function setSelectedMesh(m: THREE.Object3D | null) { _selectedMesh = m; }

export function getLastHoveredMesh() { return _lastHoveredMesh; }
export function setLastHoveredMesh(m: THREE.Object3D | null) { _lastHoveredMesh = m; }

export function isLabelsDirty() { return _labelsDirty; }
export function setLabelsDirty(v: boolean) { _labelsDirty = v; }

export function isInSelectedGroup(target: THREE.Object3D): boolean {
  return _selectedMembers.has(target);
}

// After rebuildSystems destroys and recreates all groups, re-link any
// active references by name so identity checks don't silently fail.
export function relinkAfterRebuild(
  systemGroups: SystemGroup[],
  reapplyHighlight: (g: SystemGroup) => void,
) {
  if (_selected) {
    const replacement = systemGroups.find((g) => g.name === _selected!.name);
    if (replacement) {
      _selected = replacement;
      rebuildSelectedMembers();
      reapplyHighlight(replacement);
    } else {
      _selected = null;
      rebuildSelectedMembers();
    }
  }
  if (_hovered) {
    const replacement = systemGroups.find((g) => g.name === _hovered!.name);
    _hovered = replacement ?? null;
  }
}
