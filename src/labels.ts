import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import {
  LABEL_FADE_NEAR, LABEL_FADE_FAR, LABEL_HIDE_DIST, COLLAPSE_PX_SQ,
  NOTABLE_FADE_NEAR, NOTABLE_FADE_FAR,
} from "./constants.ts";
import { camera } from "./scene.ts";
import {
  selectedMesh, selectedSystem, hoveredSystem, lastHoveredMesh,
  labelsDirty, setLabelsDirty,
  updateSystemLabelText,
} from "./interaction.ts";
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
  if (!labelsDirty) return;

  const collapsed = new Set<THREE.Object3D>();

  for (const group of systemGroups) {
    const n = group.meshes.length;
    const screens = group.screens;
    const parent = group.parents;

    for (let i = 0; i < n; i++) {
      const s = projectToScreen(group.meshes[i].position);
      screens[i].x = s.x;
      screens[i].y = s.y;
      parent[i] = i;
    }

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
    const isHighlighted = target === lastHoveredMesh || target === selectedMesh
      || (sys !== undefined && (sys === hoveredSystem || sys === selectedSystem));

    // CSS2DObject child; toggled separately from target.visible so a
    // collapsed system member can hide its individual label while its
    // billboard hit sphere stays active for canvas selection.
    const css = cssLabelChild(target);

    if (collapsed.has(target)) {
      if (css) css.visible = false;
      return;
    }
    if (css) css.visible = true;

    const zIndex = String(Math.round(10000 - camDist * 100));
    const isTier0 = star.tier === 0;
    const isSystemMemberHighlighted = sys !== undefined && (sys === hoveredSystem || sys === selectedSystem);

    if (isHighlighted) {
      target.visible = true;
      setLabelStyle(div, "1", zIndex);
      if (isSystemMemberHighlighted) {
        div.style.textShadow = starGlowShadow(star.ci);
      }
      return;
    }

    if (div.style.textShadow.includes("rgba")) div.style.textShadow = "";

    if (isTier0) {
      const t = THREE.MathUtils.clamp(
        (camDist - NOTABLE_FADE_NEAR) / (NOTABLE_FADE_FAR - NOTABLE_FADE_NEAR), 0, 1);
      if (t >= 1) {
        target.visible = false;
        return;
      }
      target.visible = true;
      setLabelStyle(div, String(1 - t), zIndex);
    } else {
      if (camDist > LABEL_HIDE_DIST) {
        target.visible = false;
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
