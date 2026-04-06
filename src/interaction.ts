import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { HIGHLIGHT_BOOST } from "./constants.ts";
import { camera, animateTo } from "./scene.ts";

// Label maps — registered by main.ts and notable.ts
const labelMaps: WeakMap<THREE.Mesh, HTMLElement>[] = [];
export function registerLabelMap(map: WeakMap<THREE.Mesh, HTMLElement>) {
  labelMaps.push(map);
}

function getLabelDiv(mesh: THREE.Mesh): HTMLElement | undefined {
  for (const map of labelMaps) {
    const div = map.get(mesh);
    if (div) return div;
  }
  return undefined;
}

// Shared interaction state
export let selectedMesh: THREE.Mesh | null = null;
export let selectedSystem: SystemGroup | null = null;
export let hoveredSystem: SystemGroup | null = null;
export let lastHoveredMesh: THREE.Mesh | null = null;
export let labelsDirty = true;

export function setLabelsDirty(v: boolean) { labelsDirty = v; }

// Star highlight
function setStarHighlight(mesh: THREE.Mesh, value: number) {
  const mat = mesh.material as THREE.ShaderMaterial;
  mat.uniforms.uHighlight.value = value;
  mat.uniformsNeedUpdate = true;
}

export function highlightStar(mesh: THREE.Mesh) { setStarHighlight(mesh, HIGHLIGHT_BOOST); }
export function unhighlightStar(mesh: THREE.Mesh) { setStarHighlight(mesh, 1.0); }
function highlightSystem(group: SystemGroup) { group.meshes.forEach((m) => setStarHighlight(m, HIGHLIGHT_BOOST)); }
function unhighlightSystem(group: SystemGroup) { group.meshes.forEach((m) => setStarHighlight(m, 1.0)); }

// System label text
const lastSystemLabelState = new WeakMap<SystemGroup, string>();

export function updateSystemLabelText(group: SystemGroup) {
  const isActive = hoveredSystem === group || selectedSystem === group;
  const members = isActive
    ? (group.collapsedMembers.length > 0 ? group.collapsedMembers : group.meshes)
    : [];
  const key = isActive ? members.map((m) => (m.userData as Star).name).join(",") : "";
  if (lastSystemLabelState.get(group) === key) return;
  lastSystemLabelState.set(group, key);
  const el = group.label.element as HTMLElement;
  if (isActive) {
    const names = members.map((m) => (m.userData as Star).name);
    el.innerHTML = `<div>${group.name}</div><div class="system-members">${names.join(" · ")}</div>`;
  } else {
    el.innerHTML = `<div>${group.name}</div>`;
  }
}

export function showSystemMembers(group: SystemGroup) {
  highlightSystem(group);
  updateSystemLabelText(group);
  labelsDirty = true;
}

export function hideSystemMembers(group: SystemGroup) {
  unhighlightSystem(group);
  updateSystemLabelText(group);
  labelsDirty = true;
}

// Hover
export function showHover(mesh: THREE.Mesh) {
  if (lastHoveredMesh === mesh) return;
  if (lastHoveredMesh && lastHoveredMesh !== selectedMesh) {
    unhighlightStar(lastHoveredMesh);
    const prevLabel = getLabelDiv(lastHoveredMesh);
    if (prevLabel) prevLabel.style.visibility = "hidden";
  }
  lastHoveredMesh = mesh;
  if (mesh !== selectedMesh) highlightStar(mesh);
  const label = getLabelDiv(mesh);
  if (label) label.style.visibility = "visible";
  labelsDirty = true;
}

export function hideHover() {
  if (lastHoveredMesh && lastHoveredMesh !== selectedMesh) {
    unhighlightStar(lastHoveredMesh);
    const label = getLabelDiv(lastHoveredMesh);
    if (label) label.style.visibility = "hidden";
  }
  lastHoveredMesh = null;
  labelsDirty = true;
}

export function hoverTarget(mesh: THREE.Mesh, meshToSystem: Map<THREE.Mesh, SystemGroup>) {
  const sys = meshToSystem.get(mesh);
  if (sys) {
    hideHover();
    if (hoveredSystem !== sys && selectedSystem !== sys) {
      if (hoveredSystem && hoveredSystem !== selectedSystem) hideSystemMembers(hoveredSystem);
      hoveredSystem = sys;
      showSystemMembers(sys);
    }
  } else {
    if (hoveredSystem && hoveredSystem !== selectedSystem) {
      hideSystemMembers(hoveredSystem);
      hoveredSystem = null;
    }
    showHover(mesh);
  }
}

export function unhoverAll() {
  hideHover();
  if (hoveredSystem && hoveredSystem !== selectedSystem) {
    hideSystemMembers(hoveredSystem);
    hoveredSystem = null;
  }
}

// Selection
export function selectSystem(group: SystemGroup, updateDetailPanel: () => void) {
  if (selectedMesh) unhighlightStar(selectedMesh);
  selectedMesh = null;
  if (selectedSystem && selectedSystem !== group) hideSystemMembers(selectedSystem);
  selectedSystem = group;
  showSystemMembers(group);
  labelsDirty = true;

  let nearest = group.meshes[0];
  let nearestDist = Infinity;
  for (const m of group.meshes) {
    const d = m.position.distanceTo(camera.position);
    if (d < nearestDist) { nearest = m; nearestDist = d; }
  }
  const focusTarget = nearest.position.distanceTo(group.centroid) < 0.5
    ? group.centroid : nearest.position;
  animateTo(focusTarget);
  lastHoveredMesh = null;
  updateDetailPanel();
}

export function selectStar(mesh: THREE.Mesh, updateDetailPanel: () => void, updateLabelVisibility: () => void) {
  if (selectedMesh) {
    unhighlightStar(selectedMesh);
    const prevLabel = getLabelDiv(selectedMesh);
    if (prevLabel) prevLabel.style.visibility = "hidden";
  }
  if (selectedSystem) { hideSystemMembers(selectedSystem); selectedSystem = null; }
  selectedMesh = mesh;
  highlightStar(mesh);
  const label = getLabelDiv(mesh);
  if (label) label.style.visibility = "visible";
  labelsDirty = true;
  animateTo(mesh.position);
  updateLabelVisibility();
  lastHoveredMesh = null;
  updateDetailPanel();
}

export function selectTarget(
  mesh: THREE.Mesh,
  meshToSystem: Map<THREE.Mesh, SystemGroup>,
  updateDetailPanel: () => void,
  updateLabelVisibility: () => void,
) {
  const sys = meshToSystem.get(mesh);
  if (sys) {
    selectSystem(sys, updateDetailPanel);
  } else {
    selectStar(mesh, updateDetailPanel, updateLabelVisibility);
  }
}
