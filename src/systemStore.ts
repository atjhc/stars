import type * as THREE from "three";
import type { SystemGroup } from "./types.ts";
import { kick, registerKeepFrame } from "./renderLoop.ts";

let _selected: SystemGroup | null = null;
let _selectedSubset: THREE.Object3D[] | null = null;
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
  if (!g) _selectedSubset = null;
  rebuildSelectedMembers();
}

// The specific sub-set of member anchors the user committed to — used
// when a binary/trinary's label collapsed only part of the system on
// screen (e.g. Alpha Cen's A+B still clustered while Proxima has
// separated). null means "the whole selected group". Drives zoom floor,
// focus target, and URL serialization so reloads land on the exact
// sub-group.
export function getSelectedSubset(): THREE.Object3D[] | null { return _selectedSubset; }
export function setSelectedSubset(members: THREE.Object3D[] | null) {
  _selectedSubset = members && members.length >= 2 ? members : null;
}

export function getHoveredSystem() { return _hovered; }
export function setHoveredSystem(g: SystemGroup | null) { _hovered = g; }

export function getSelectedMesh() { return _selectedMesh; }
export function setSelectedMesh(m: THREE.Object3D | null) { _selectedMesh = m; }

export function getLastHoveredMesh() { return _lastHoveredMesh; }
export function setLastHoveredMesh(m: THREE.Object3D | null) { _lastHoveredMesh = m; }

export function isLabelsDirty() { return _labelsDirty; }
export function setLabelsDirty(v: boolean) {
  _labelsDirty = v;
  if (v) kick();
}
registerKeepFrame(() => _labelsDirty);

export function isInSelectedGroup(target: THREE.Object3D): boolean {
  return _selectedMembers.has(target);
}

let _pinnedTile: string | null = null;
export function getPinnedTile(): string | null { return _pinnedTile; }
export function setPinnedTile(t: string | null) { _pinnedTile = t; }

// After rebuildSystems destroys and recreates all groups, re-link any
// active references by name so identity checks don't silently fail.
export function relinkAfterRebuild(
  systemGroups: SystemGroup[],
  reapplyHighlight: (g: SystemGroup) => void,
) {
  if (_selected) {
    const replacement = systemGroups.find((g) => g.name === _selected!.name);
    if (replacement) {
      // Map the subset by member name to the new mesh refs.
      if (_selectedSubset) {
        const names = new Set(_selectedSubset.map((m) => (m.userData as { name: string }).name));
        _selectedSubset = replacement.meshes.filter((m) =>
          names.has((m.userData as { name: string }).name),
        );
        if (_selectedSubset.length < 2) _selectedSubset = null;
      }
      _selected = replacement;
      rebuildSelectedMembers();
      reapplyHighlight(replacement);
    } else {
      _selected = null;
      _selectedSubset = null;
      rebuildSelectedMembers();
    }
  }
  if (_hovered) {
    const replacement = systemGroups.find((g) => g.name === _hovered!.name);
    _hovered = replacement ?? null;
  }
}
