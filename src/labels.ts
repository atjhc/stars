import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import {
  LABEL_FADE_NEAR, LABEL_FADE_FAR, LABEL_HIDE_DIST, COLLAPSE_PX_SQ, SCALE,
  solDistanceFade,
} from "./constants.ts";
import { apparentMag, magLimitUniform, clusterOf } from "./starfield.ts";
import { shouldHighlightLabel, shouldForceVisible, type HighlightContext } from "./labelVisibility.ts";

const collapsed = new Set<THREE.Object3D>();

import { LY_PER_PARSEC } from "./constants.ts";
const labelsWithSubtitle = new WeakSet<HTMLElement>();
let cachedMaxNotableSolDist = 0;
let cachedMaxClusterSolDist = 0;

function formatSceneDistance(sceneUnits: number): string {
  const ly = (sceneUnits / SCALE) * LY_PER_PARSEC;
  if (ly < 1) return `${ly.toFixed(3)} ly`;
  if (ly < 10) return `${ly.toFixed(2)} ly`;
  return `${ly.toFixed(1)} ly`;
}
import { camera } from "./scene.ts";
import {
  getSelectedMesh, getSelectedSystem, getHoveredSystem, getLastHoveredMesh,
  isLabelsDirty, setLabelsDirty,
} from "./systemStore.ts";
import { updateSystemLabelText } from "./interaction.ts";
import { starGlowShadow } from "./color.ts";

const projVec = new THREE.Vector3();
const screenBuf = { x: 0, y: 0 };
function projectToScreen(pos: THREE.Vector3): typeof screenBuf {
  projVec.copy(pos).project(camera);
  screenBuf.x = (projVec.x * 0.5 + 0.5) * window.innerWidth;
  screenBuf.y = (-projVec.y * 0.5 + 0.5) * window.innerHeight;
  return screenBuf;
}

function setLabelStyle(div: HTMLElement, opacity: string, zIndex: string) {
  div.style.opacity = opacity;
  div.style.zIndex = zIndex;
}

function cssLabelChild(target: THREE.Object3D): THREE.Object3D | undefined {
  for (const c of target.children) if ((c as THREE.Object3D & { isCSS2DObject?: boolean }).isCSS2DObject) return c;
  return undefined;
}

function projectGroupToScreen(group: import("./types.ts").BinarySystem) {
  for (let i = 0; i < group.meshes.length; i++) {
    const s = projectToScreen(group.meshes[i].position);
    group.screens[i].x = s.x;
    group.screens[i].y = s.y;
  }
}

const prevCamPos = new THREE.Vector3();

export type DivResolver = (target: THREE.Object3D) => HTMLElement | undefined;

export function updateLabels(
  labelsVisible: boolean,
  notableAnchors: THREE.Object3D[],
  interactiveStars: THREE.Object3D[],
  systemGroups: SystemGroup[],
  meshToSystem: Map<THREE.Object3D, SystemGroup>,
  divFor: DivResolver,
) {
  if (!labelsVisible) return;
  if (!isLabelsDirty()) return;

  const magLimit = magLimitUniform.value;
  const tier0FadeStart = magLimit - 1.5;

  // Cache max Sol distance for notables (positions are static after init).
  if (cachedMaxNotableSolDist === 0 && notableAnchors.length > 0) {
    for (const anchor of notableAnchors) {
      const d = anchor.position.length();
      if (d > cachedMaxNotableSolDist) cachedMaxNotableSolDist = d;
    }
  }

  const selectedSystem = getSelectedSystem();
  const hoveredSystem = getHoveredSystem();
  const selectedMesh = getSelectedMesh();
  const lastHoveredMesh = getLastHoveredMesh();

  const hlCtx: import("./labelVisibility.ts").HighlightContext = {
    meshToSystem, clusterOf,
    hoveredSystem, selectedSystem,
    lastHoveredMesh, selectedMesh,
  };

  collapsed.clear();

  if (cachedMaxClusterSolDist === 0) {
    for (const group of systemGroups) {
      if (group.kind === "cluster") {
        const d = group.anchor.position.length();
        if (d > cachedMaxClusterSolDist) cachedMaxClusterSolDist = d;
      }
    }
  }
  const maxClusterSolDist = cachedMaxClusterSolDist;

  for (const group of systemGroups) {
    if (group.kind === "cluster") {
      const isHighlighted = hoveredSystem === group || selectedSystem === group;
      const solDist = group.anchor.position.length();
      const baseOpacity = solDistanceFade(solDist, maxClusterSolDist);
      const opacity = isHighlighted ? 1.0 : baseOpacity;
      group.label.visible = true;
      const dist = group.anchor.position.distanceTo(camera.position);
      const zIndex = Math.round(20000 - dist * 100);
      setLabelStyle(group.label.element as HTMLElement, String(Math.max(0.2, opacity)), String(zIndex));

      // Check each member against the cluster label position.
      const anchorScreen = projectToScreen(group.anchor.position);
      const ax = anchorScreen.x, ay = anchorScreen.y;
      for (const m of group.meshes) {
        const ms = projectToScreen(m.position);
        const dx = ms.x - ax, dy = ms.y - ay;
        if (dx * dx + dy * dy < COLLAPSE_PX_SQ) collapsed.add(m);
      }
      continue;
    }

    const n = group.meshes.length;
    const screens = group.screens;
    const parent = group.parents;

    projectGroupToScreen(group);
    for (let i = 0; i < n; i++) parent[i] = i;

    function find(i: number): number { return parent[i] === i ? i : (parent[i] = find(parent[i])); }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = screens[i].x - screens[j].x;
        const dy = screens[i].y - screens[j].y;
        if (dx * dx + dy * dy < COLLAPSE_PX_SQ) {
          parent[find(i)] = find(j);
        }
      }
    }

    const clusterCounts = new Map<number, number>();
    let bestRoot = -1, bestCount = 0;
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const count = (clusterCounts.get(root) || 0) + 1;
      clusterCounts.set(root, count);
      if (count > bestCount && count >= 2) { bestRoot = root; bestCount = count; }
    }

    if (bestRoot >= 0) {
      const members: THREE.Mesh[] = [];
      for (let i = 0; i < n; i++) {
        if (find(i) === bestRoot) members.push(group.meshes[i]);
      }
      group.collapsedMembers = members;

      group.anchor.position.set(0, 0, 0);
      for (const m of members) group.anchor.position.add(m.position);
      group.anchor.position.divideScalar(members.length);

      for (const m of members) collapsed.add(m);

      const dist = group.anchor.position.distanceTo(camera.position);
      const isSystemHighlighted = hoveredSystem === group || selectedSystem === group;
      group.label.visible = dist <= LABEL_HIDE_DIST || isSystemHighlighted;
      if (!group.label.visible) continue;

      const opacity = isSystemHighlighted ? 1.0 : 1.0 - THREE.MathUtils.smoothstep(dist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
      const zIndex = Math.round(10000 - dist * 100);
      const el = group.label.element as HTMLElement;
      setLabelStyle(el, String(Math.max(0.2, opacity)), String(zIndex));
      updateSystemLabelText(group);
    } else {
      group.collapsedMembers = [];
      group.label.visible = false;
    }
  }

  // Single pass over all label-bearing objects: notable anchors (tier 0,
  // always-on fade) + interactive billboards (tier 1, close-only fade).
  // Tier-0 billboards have no label child, so divFor() returns undefined for
  // them and they're skipped automatically.
  //
  // Toggling target.visible short-circuits the CSS2DRenderer's per-frame
  // matrix/projection work for out-of-range labels — the main perf lever.
  function processLabel(target: THREE.Object3D) {
    const div = divFor(target);
    if (!div) return;

    const camDist = target.position.distanceTo(camera.position);
    const sys = meshToSystem.get(target);
    const star = target.userData as Star;
    const isHighlighted = shouldHighlightLabel(target, hlCtx);

    // CSS2DObject child; toggled separately from target.visible so a
    // collapsed system member can hide its individual label while its
    // billboard hit sphere stays active for canvas selection.
    const css = cssLabelChild(target);

    if (collapsed.has(target)) {
      // Keep the anchor visible so the tier-0 billboard's hit sphere stays
      // active — clicking a collapsed member's orb routes to selectSystem
      // via meshToSystem. Only the individual label child is hidden.
      target.visible = true;
      if (css) css.visible = false;
      return;
    }
    if (css) css.visible = true;

    const zIndex = String(Math.round(10000 - camDist * 100));
    const isTier0 = star.tier === 0;
    const owningGroup = sys ?? clusterOf.get(target);
    const isSystemMemberHighlighted = owningGroup !== undefined && (owningGroup === hoveredSystem || owningGroup === selectedSystem);

    if (isHighlighted) {
      target.visible = true;
      setLabelStyle(div, "1", zIndex);

      // Selected target(s) show distance from camera. Hovered others show
      // distance from the current selection (star position or system centroid).
      const isSelectedTarget = target === selectedMesh
        || (sys !== undefined && sys === selectedSystem);
      let subtitleDist = camDist;
      if (!isSelectedTarget) {
        if (selectedMesh) subtitleDist = target.position.distanceTo(selectedMesh.position);
        else if (selectedSystem) subtitleDist = target.position.distanceTo(selectedSystem.centroid);
      }
      div.innerHTML = `<div>${star.name}</div><div class="system-members">${formatSceneDistance(subtitleDist)}</div>`;
      labelsWithSubtitle.add(div);
      if (isSystemMemberHighlighted) {
        div.style.textShadow = starGlowShadow(star.ci);
      }
      return;
    }

    if (labelsWithSubtitle.has(div)) {
      div.textContent = star.name;
      labelsWithSubtitle.delete(div);
    }
    if (div.style.textShadow.includes("rgba")) div.style.textShadow = "";

    // Cluster members whose cluster is active: keep the Object3D visible
    // (so the billboard glow from highlightSystem renders) but don't
    // override the label's normal fade styling.
    const forceVis = shouldForceVisible(target, hlCtx);

    if (isTier0) {
      const appMag = apparentMag(star.absmag ?? 10, camDist);
      const t = THREE.MathUtils.clamp((appMag - tier0FadeStart) / 1.5, 0, 1);
      if (t >= 1) {
        target.visible = forceVis;
        return;
      }
      target.visible = true;
      const solDist = target.position.length();
      const solFade = solDistanceFade(solDist, cachedMaxNotableSolDist);
      setLabelStyle(div, String(Math.max(0.15, (1 - t) * solFade)), zIndex);
    } else {
      if (camDist > LABEL_HIDE_DIST) {
        target.visible = forceVis;
        return;
      }
      target.visible = true;
      const opacity = 1.0 - THREE.MathUtils.smoothstep(camDist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
      setLabelStyle(div, String(Math.max(0.2, opacity)), zIndex);
    }
  }

  for (const anchor of notableAnchors) processLabel(anchor);
  for (const mesh of interactiveStars) processLabel(mesh);

  setLabelsDirty(false);
  prevCamPos.copy(camera.position);
}

export function checkCameraMoved() {
  if (!prevCamPos.equals(camera.position)) setLabelsDirty(true);
}
