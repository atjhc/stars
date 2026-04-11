import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { HIGHLIGHT_BOOST } from "./constants.ts";
import { camera, animateTo } from "./scene.ts";
import { starGlowShadow } from "./color.ts";

// Label maps — registered by main.ts after starfield init
const labelMaps: WeakMap<THREE.Object3D, HTMLElement>[] = [];
export function registerLabelMap(map: WeakMap<THREE.Object3D, HTMLElement>) {
  labelMaps.push(map);
}

function getLabelDiv(target: THREE.Object3D): HTMLElement | undefined {
  for (const map of labelMaps) {
    const div = map.get(target);
    if (div) return div;
  }
  return undefined;
}

// Companion lookup: when a target without a shader (e.g. a notable anchor)
// is highlighted, also ripple the highlight to its associated billboard if
// one is currently spawned. Registered by starfield.ts.
let companionResolver: ((target: THREE.Object3D) => THREE.Object3D | undefined) | null = null;
export function setCompanionResolver(fn: (target: THREE.Object3D) => THREE.Object3D | undefined) {
  companionResolver = fn;
}

// Shared interaction state
export let selectedMesh: THREE.Object3D | null = null;
export let selectedSystem: SystemGroup | null = null;
export let hoveredSystem: SystemGroup | null = null;
export let lastHoveredMesh: THREE.Object3D | null = null;
export let labelsDirty = true;

export function setLabelsDirty(v: boolean) { labelsDirty = v; }
export function setHoveredSystem(g: SystemGroup | null) { hoveredSystem = g; }
export function setSelectedSystem(g: SystemGroup | null) {
  selectedSystem = g;
  rebuildSelectedGroupMembers();
}

function applyLabelGlow(div: HTMLElement, target: THREE.Object3D) {
  const star = target.userData as Star;
  div.classList.add("highlight");
  div.style.textShadow = starGlowShadow(star.ci);
}

function removeLabelGlow(div: HTMLElement) {
  div.classList.remove("highlight");
  div.style.textShadow = "";
}

// Star highlight: sets uHighlight uniform on the target's shader if any,
// then ripples to a companion target (anchor → billboard or billboard → anchor).
function setShaderHighlight(target: THREE.Object3D, value: number) {
  const mesh = target as THREE.Mesh;
  const mat = mesh.material as THREE.ShaderMaterial | undefined;
  if (mat?.uniforms?.uHighlight) {
    mat.uniforms.uHighlight.value = value;
    mat.uniformsNeedUpdate = true;
  }
}

function setStarHighlight(target: THREE.Object3D, value: number) {
  setShaderHighlight(target, value);
  const companion = companionResolver?.(target);
  if (companion) setShaderHighlight(companion, value);
}

export function highlightStar(target: THREE.Object3D) { setStarHighlight(target, HIGHLIGHT_BOOST); }
export function unhighlightStar(target: THREE.Object3D) { setStarHighlight(target, 1.0); }
function highlightSystem(group: SystemGroup) { group.meshes.forEach((m) => setStarHighlight(m, HIGHLIGHT_BOOST)); }
function unhighlightSystem(group: SystemGroup) { group.meshes.forEach((m) => setStarHighlight(m, 1.0)); }

// System label text
const lastSystemLabelState = new WeakMap<SystemGroup, string>();

export function updateSystemLabelText(group: SystemGroup) {
  const isActive = hoveredSystem === group || selectedSystem === group;
  // Clusters never show member names in their label — there are too
  // many and the names are independently visible.
  const showMembers = isActive && group.kind !== "cluster";
  const members = showMembers
    ? (group.collapsedMembers.length > 0 ? group.collapsedMembers : group.meshes)
    : [];
  const key = showMembers ? members.map((m) => (m.userData as Star).name).join(",") : "";
  if (lastSystemLabelState.get(group) === key) return;
  lastSystemLabelState.set(group, key);
  const el = group.label.element as HTMLElement;
  if (showMembers) {
    const names = members.map((m) => (m.userData as Star).name);
    el.innerHTML = `<div>${group.name}</div><div class="system-members">${names.join(" · ")}</div>`;
  } else {
    el.innerHTML = `<div>${group.name}</div>`;
  }
}

const DEFAULT_CLUSTER_GLOW = "0 0 12px rgba(130,170,255,0.7), 0 0 4px rgba(100,150,220,0.5)";

function applySystemLabelGlow(group: SystemGroup) {
  const el = group.label.element as HTMLElement;
  if (group.meshes.length > 0) {
    let brightestStar = group.meshes[0].userData as Star;
    for (const m of group.meshes) {
      const s = m.userData as Star;
      if (s.lum > brightestStar.lum) brightestStar = s;
    }
    el.style.textShadow = starGlowShadow(brightestStar.ci);
  } else {
    el.style.textShadow = DEFAULT_CLUSTER_GLOW;
  }
}

// Default text-shadow from CLUSTER_LABEL_CSS — must match constants.ts.
const DEFAULT_CLUSTER_SHADOW = "0 0 8px rgba(100,150,220,0.6), 0 0 3px #000";

function removeSystemLabelGlow(group: SystemGroup) {
  const el = group.label.element as HTMLElement;
  // Clusters: restore the default glow (the original was inline via cssText,
  // so setting "" would destroy it permanently).
  el.style.textShadow = group.kind === "cluster" ? DEFAULT_CLUSTER_SHADOW : "";
}

export function showSystemMembers(group: SystemGroup) {
  highlightSystem(group);
  applySystemLabelGlow(group);
  updateSystemLabelText(group);
  labelsDirty = true;
}

export function hideSystemMembers(group: SystemGroup) {
  unhighlightSystem(group);
  removeSystemLabelGlow(group);
  updateSystemLabelText(group);
  labelsDirty = true;
}

// Set of meshes in the currently selected system, rebuilt on selection
// change. O(1) lookup in hover handlers instead of linear .includes().
let selectedGroupMembers = new Set<THREE.Object3D>();

function rebuildSelectedGroupMembers() {
  selectedGroupMembers = selectedSystem
    ? new Set(selectedSystem.meshes)
    : new Set();
}

function isInSelectedGroup(target: THREE.Object3D): boolean {
  return selectedGroupMembers.has(target);
}

export function showHover(target: THREE.Object3D) {
  if (lastHoveredMesh === target) return;
  if (lastHoveredMesh && lastHoveredMesh !== selectedMesh && !isInSelectedGroup(lastHoveredMesh)) {
    unhighlightStar(lastHoveredMesh);
    const prevLabel = getLabelDiv(lastHoveredMesh);
    if (prevLabel) removeLabelGlow(prevLabel);
  }
  lastHoveredMesh = target;
  if (target !== selectedMesh) highlightStar(target);
  const label = getLabelDiv(target);
  if (label) applyLabelGlow(label, target);
  labelsDirty = true;
}

export function hideHover() {
  if (lastHoveredMesh && lastHoveredMesh !== selectedMesh && !isInSelectedGroup(lastHoveredMesh)) {
    unhighlightStar(lastHoveredMesh);
    const label = getLabelDiv(lastHoveredMesh);
    if (label) removeLabelGlow(label);
  }
  lastHoveredMesh = null;
  labelsDirty = true;
}

export function hoverTarget(target: THREE.Object3D, meshToSystem: Map<THREE.Object3D, SystemGroup>) {
  const sys = meshToSystem.get(target);
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
    showHover(target);
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
  rebuildSelectedGroupMembers();
  showSystemMembers(group);
  labelsDirty = true;

  if (group.kind === "cluster") {
    animateTo(group.centroid);
  } else {
    let nearest = group.meshes[0];
    let nearestDist = Infinity;
    for (const m of group.meshes) {
      const d = m.position.distanceTo(camera.position);
      if (d < nearestDist) { nearest = m; nearestDist = d; }
    }
    const focusTarget = nearest.position.distanceTo(group.centroid) < 0.5
      ? group.centroid : nearest.position;
    animateTo(focusTarget);
  }
  lastHoveredMesh = null;
  updateDetailPanel();
}

export function selectStar(target: THREE.Object3D, updateDetailPanel: () => void, updateLabelVisibility: () => void) {
  if (selectedMesh) {
    unhighlightStar(selectedMesh);
    const prevLabel = getLabelDiv(selectedMesh);
    if (prevLabel) removeLabelGlow(prevLabel);
  }
  if (selectedSystem) { hideSystemMembers(selectedSystem); selectedSystem = null; rebuildSelectedGroupMembers(); }
  selectedMesh = target;
  highlightStar(target);
  const label = getLabelDiv(target);
  if (label) applyLabelGlow(label, target);
  labelsDirty = true;
  animateTo(target.position);
  updateLabelVisibility();
  lastHoveredMesh = null;
  updateDetailPanel();
}

export function selectTarget(
  target: THREE.Object3D,
  meshToSystem: Map<THREE.Object3D, SystemGroup>,
  updateDetailPanel: () => void,
  updateLabelVisibility: () => void,
) {
  const sys = meshToSystem.get(target);
  if (sys) {
    selectSystem(sys, updateDetailPanel);
  } else {
    selectStar(target, updateDetailPanel, updateLabelVisibility);
  }
}
