import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { camera, animateTo, setMinOrbitOverride, effectiveCamDist } from "./scene.ts";
import { addRecent } from "./recents.ts";
import { refreshSearch } from "./search.ts";
import { starGlowShadow, starRadiusScene } from "./color.ts";
import { computeStarMinOrbit, setHoveredStar } from "./stars.ts";
import {
  getSelectedSystem, setSelectedSystem,
  getHoveredSystem, setHoveredSystem,
  getSelectedMesh, setSelectedMesh,
  getLastHoveredMesh, setLastHoveredMesh,
  setSelectedSubset,
  setLabelsDirty, isInSelectedGroup, setPinnedTile,
} from "./systemStore.ts";
import {
  focusTarget, effectiveSystemSubset,
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

function applyLabelGlow(div: HTMLElement, target: THREE.Object3D) {
  const star = target.userData as Star;
  div.classList.add("highlight");
  div.style.textShadow = starGlowShadow(star.ci);
}

function removeLabelGlow(div: HTMLElement) {
  div.classList.remove("highlight");
  div.style.textShadow = "";
}

// Fade out the ".system-members" subtitle (distance / member names) on a
// label whose selection is about to end. Setting opacity:0 triggers the
// CSS transition; labels.ts will later swap the innerHTML to remove the
// subtitle entirely when the animation completes and the label pass
// reclassifies this target as unhighlighted.
function fadeOutSubtitle(div: HTMLElement) {
  const sub = div.querySelector(".system-members") as HTMLElement | null;
  if (sub) sub.style.opacity = "0";
}

// System label text
const lastSystemLabelState = new WeakMap<SystemGroup, string>();

export function updateSystemLabelText(group: SystemGroup, isActive: boolean) {
  // effectiveCamDist returns the unclamped orbit radius when the system
  // is the orbit target — correct even past the deep-zoom camera clamp.
  // For just-hovered systems fall back to raw world-space distance.
  const camDist = getSelectedSystem() === group
    ? effectiveCamDist(group.centroid)
    : camera.position.distanceTo(group.centroid);
  const html = labelContent(group, isActive, camDist);
  if (lastSystemLabelState.get(group) === html) return;
  lastSystemLabelState.set(group, html);
  const el = group.label.element as HTMLElement;
  el.innerHTML = html.includes("<div") ? html : `<div>${html}</div>`;
}

export function showSystemMembers(group: SystemGroup) {
  applySystemLabelGlow(group);
  updateSystemLabelText(group, true);
  setLabelsDirty(true);
}

export function hideSystemMembers(group: SystemGroup) {
  removeSystemLabelGlow(group);
  updateSystemLabelText(group, false);
  setLabelsDirty(true);
}

// Hover
export function showHover(target: THREE.Object3D) {
  const lastHovered = getLastHoveredMesh();
  if (lastHovered === target) return;
  if (lastHovered && lastHovered !== getSelectedMesh() && !isInSelectedGroup(lastHovered)) {
    const prevLabel = getLabelDiv(lastHovered);
    if (prevLabel) removeLabelGlow(prevLabel);
  }
  setLastHoveredMesh(target);
  const label = getLabelDiv(target);
  if (label) applyLabelGlow(label, target);
  setHoveredStar(target.position);
  setLabelsDirty(true);
}

export function hideHover() {
  const lastHovered = getLastHoveredMesh();
  if (lastHovered && lastHovered !== getSelectedMesh() && !isInSelectedGroup(lastHovered)) {
    const label = getLabelDiv(lastHovered);
    if (label) removeLabelGlow(label);
  }
  setLastHoveredMesh(null);
  setHoveredStar(null);
  setLabelsDirty(true);
}

export function hoverTarget(target: THREE.Object3D, meshToSystem: Map<THREE.Object3D, SystemGroup>, clusterOf?: Map<THREE.Object3D, SystemGroup>) {
  const cluster = clusterOf?.get(target);

  // Clusters keep their aggregate hover — hovering any Pleiades member
  // lights up the cluster label. That's the "cluster label" half of what
  // the system designation drives.
  if (cluster) {
    showHover(target);
    if (getHoveredSystem() !== cluster && getSelectedSystem() !== cluster) {
      const hovered = getHoveredSystem();
      if (hovered && hovered !== getSelectedSystem()) hideSystemMembers(hovered);
      setHoveredSystem(cluster);
      showSystemMembers(cluster);
    }
    return;
  }

  // Binary/trinary members and solo stars: individual hover only. The
  // system grouping isn't a hover target — it's metadata for search and
  // on-screen collapse — so hovering Toliman must not drag Proxima into
  // a highlighted state.
  const hovered = getHoveredSystem();
  if (hovered && hovered !== getSelectedSystem()) {
    hideSystemMembers(hovered);
    setHoveredSystem(null);
  }
  showHover(target);
}

export function unhoverAll() {
  hideHover();
  const hovered = getHoveredSystem();
  if (hovered && hovered !== getSelectedSystem()) {
    hideSystemMembers(hovered);
    setHoveredSystem(null);
  }
}

// Minimum orbit radius for a system — keeps the effective members
// framed when zoomed in. For a binary/trinary whose label is partially
// collapsed on screen, "effective members" is just the collapsed
// subset so the user can zoom in further to that sub-group (e.g. the
// A+B pair within Alpha Centauri after Proxima breaks out).
function systemMinOrbit(group: SystemGroup): number {
  const { members, centroid } = effectiveSystemSubset(group);
  if (members.length === 0) return 3;
  let maxR = 0;
  let maxMemberFloor = 0;
  for (const m of members) {
    const d = m.position.distanceTo(centroid);
    if (d > maxR) maxR = d;
    const star = m.userData as Star;
    const mf = computeStarMinOrbit(starRadiusScene(star.lum, star.ci));
    if (mf > maxMemberFloor) maxMemberFloor = mf;
  }
  // 1.5× gives the members room to breathe on screen. The member floor
  // handles the coincident-binary edge case — you can't zoom closer
  // than you could if you selected the largest member by itself.
  return Math.max(maxR * 1.5, maxMemberFloor);
}

// Selection. `subset` lets a caller (URL restore, future features) pin
// the effective-subset explicitly; without it, the current screen-space
// collapsed members are snapshotted — so clicking a partially-collapsed
// label like "Rigil Kentaurus · Toliman" refines the selection to just
// those two.
export function selectSystem(
  group: SystemGroup,
  updateDetailPanel: () => void,
  subset?: THREE.Object3D[],
) {
  setSelectedMesh(null);
  setPinnedTile(null);
  const prevSys = getSelectedSystem();
  if (prevSys && prevSys !== group) hideSystemMembers(prevSys);
  setSelectedSystem(group);
  const snap = subset
    ?? (group.kind !== "cluster"
        && group.collapsedMembers.length >= 2
        && group.collapsedMembers.length < group.meshes.length
      ? [...group.collapsedMembers]
      : null);
  setSelectedSubset(snap);
  // Must set the override BEFORE animateTo so its default toRadius picks
  // up the new floor via getEffectiveMinOrbit.
  setMinOrbitOverride(systemMinOrbit(group));
  showSystemMembers(group);
  setLabelsDirty(true);
  animateTo(focusTarget(group, camera.position));
  setLastHoveredMesh(null);
  addRecent(group.name);
  refreshSearch();
  updateDetailPanel();
}

export function clearStarSystemSelection() {
  const prevMesh = getSelectedMesh();
  if (prevMesh) {
    const prevLabel = getLabelDiv(prevMesh);
    if (prevLabel) { removeLabelGlow(prevLabel); fadeOutSubtitle(prevLabel); }
  }
  setSelectedMesh(null);
  setPinnedTile(null);
  setMinOrbitOverride(null);
  const prevSys = getSelectedSystem();
  if (prevSys) { hideSystemMembers(prevSys); setSelectedSystem(null); }
  setLabelsDirty(true);
}

export function selectStar(target: THREE.Object3D, updateDetailPanel: () => void, updateLabelVisibility: () => void) {
  const prevMesh = getSelectedMesh();
  if (prevMesh) {
    const prevLabel = getLabelDiv(prevMesh);
    if (prevLabel) { removeLabelGlow(prevLabel); fadeOutSubtitle(prevLabel); }
  }
  const prevSys = getSelectedSystem();
  if (prevSys) { hideSystemMembers(prevSys); setSelectedSystem(null); }
  setSelectedMesh(target);
  const star = target.userData as Star;
  setPinnedTile(star.tile ?? null);
  // Per-star zoom floor: a giant like Betelgeuse gets a larger floor
  // than a red dwarf because its physical radius is much greater. Set
  // BEFORE animateTo so its default toRadius picks up the new floor via
  // getEffectiveMinOrbit.
  const radius = starRadiusScene(star.lum, star.ci);
  setMinOrbitOverride(computeStarMinOrbit(radius));
  addRecent(star.name);
  refreshSearch();
  const label = getLabelDiv(target);
  if (label) applyLabelGlow(label, target);
  setLabelsDirty(true);
  animateTo(target.position);
  updateLabelVisibility();
  setLastHoveredMesh(null);
  updateDetailPanel();
}

// Clicking a member always selects the individual star so the user can
// zoom close to a binary's components. System-level selection is still
// reachable via the system label's click handler.
export function selectTarget(
  target: THREE.Object3D,
  updateDetailPanel: () => void,
  updateLabelVisibility: () => void,
) {
  selectStar(target, updateDetailPanel, updateLabelVisibility);
}
