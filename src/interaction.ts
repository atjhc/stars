import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { HIGHLIGHT_BOOST } from "./constants.ts";
import { camera, animateTo } from "./scene.ts";
import { addRecent } from "./recents.ts";
import { refreshSearch } from "./search.ts";
import { starGlowShadow } from "./color.ts";
import {
  getSelectedSystem, setSelectedSystem,
  getHoveredSystem, setHoveredSystem,
  getSelectedMesh, setSelectedMesh,
  getLastHoveredMesh, setLastHoveredMesh,
  setLabelsDirty, isInSelectedGroup, setPinnedTile,
} from "./systemStore.ts";
import {
  focusTarget,
  applySystemLabelGlow, removeSystemLabelGlow,
  labelContent,
} from "./systemDispatch.ts";

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
  const isActive = getHoveredSystem() === group || getSelectedSystem() === group;
  const html = labelContent(group, isActive);
  if (lastSystemLabelState.get(group) === html) return;
  lastSystemLabelState.set(group, html);
  const el = group.label.element as HTMLElement;
  el.innerHTML = html.includes("<div") ? html : `<div>${html}</div>`;
}

export function showSystemMembers(group: SystemGroup) {
  if (group.kind !== "cluster") highlightSystem(group);
  applySystemLabelGlow(group);
  updateSystemLabelText(group);
  setLabelsDirty(true);
}

export function hideSystemMembers(group: SystemGroup) {
  if (group.kind !== "cluster") unhighlightSystem(group);
  removeSystemLabelGlow(group);
  updateSystemLabelText(group);
  setLabelsDirty(true);
}

// Hover
export function showHover(target: THREE.Object3D) {
  const lastHovered = getLastHoveredMesh();
  if (lastHovered === target) return;
  if (lastHovered && lastHovered !== getSelectedMesh() && !isInSelectedGroup(lastHovered)) {
    unhighlightStar(lastHovered);
    const prevLabel = getLabelDiv(lastHovered);
    if (prevLabel) removeLabelGlow(prevLabel);
  }
  setLastHoveredMesh(target);
  if (target !== getSelectedMesh()) highlightStar(target);
  const label = getLabelDiv(target);
  if (label) applyLabelGlow(label, target);
  setLabelsDirty(true);
}

export function hideHover() {
  const lastHovered = getLastHoveredMesh();
  if (lastHovered && lastHovered !== getSelectedMesh() && !isInSelectedGroup(lastHovered)) {
    unhighlightStar(lastHovered);
    const label = getLabelDiv(lastHovered);
    if (label) removeLabelGlow(label);
  }
  setLastHoveredMesh(null);
  setLabelsDirty(true);
}

export function hoverTarget(target: THREE.Object3D, meshToSystem: Map<THREE.Object3D, SystemGroup>, clusterOf?: Map<THREE.Object3D, SystemGroup>) {
  const sys = meshToSystem.get(target);
  const cluster = clusterOf?.get(target);
  const group = sys ?? cluster;
  if (group) {
    if (cluster) {
      showHover(target);
    } else {
      hideHover();
    }
    if (getHoveredSystem() !== group && getSelectedSystem() !== group) {
      const hovered = getHoveredSystem();
      if (hovered && hovered !== getSelectedSystem()) hideSystemMembers(hovered);
      setHoveredSystem(group);
      showSystemMembers(group);
    }
  } else {
    const hovered = getHoveredSystem();
    if (hovered && hovered !== getSelectedSystem()) {
      hideSystemMembers(hovered);
      setHoveredSystem(null);
    }
    showHover(target);
  }
}

export function unhoverAll() {
  hideHover();
  const hovered = getHoveredSystem();
  if (hovered && hovered !== getSelectedSystem()) {
    hideSystemMembers(hovered);
    setHoveredSystem(null);
  }
}

// Selection
export function selectSystem(group: SystemGroup, updateDetailPanel: () => void) {
  const prevMesh = getSelectedMesh();
  if (prevMesh) unhighlightStar(prevMesh);
  setSelectedMesh(null);
  setPinnedTile(null);
  const prevSys = getSelectedSystem();
  if (prevSys && prevSys !== group) hideSystemMembers(prevSys);
  setSelectedSystem(group);
  showSystemMembers(group);
  setLabelsDirty(true);
  animateTo(focusTarget(group, camera.position));
  setLastHoveredMesh(null);
  addRecent(group.name);
  refreshSearch();
  updateDetailPanel();
}

export function selectStar(target: THREE.Object3D, updateDetailPanel: () => void, updateLabelVisibility: () => void) {
  const prevMesh = getSelectedMesh();
  if (prevMesh) {
    unhighlightStar(prevMesh);
    const prevLabel = getLabelDiv(prevMesh);
    if (prevLabel) removeLabelGlow(prevLabel);
  }
  const prevSys = getSelectedSystem();
  if (prevSys) { hideSystemMembers(prevSys); setSelectedSystem(null); }
  setSelectedMesh(target);
  const star = target.userData as Star;
  setPinnedTile(star.tile ?? null);
  addRecent(star.name);
  refreshSearch();
  highlightStar(target);
  const label = getLabelDiv(target);
  if (label) applyLabelGlow(label, target);
  setLabelsDirty(true);
  animateTo(target.position);
  updateLabelVisibility();
  setLastHoveredMesh(null);
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
