import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { LABEL_FADE_NEAR, LABEL_FADE_FAR, LABEL_HIDE_DIST, COLLAPSE_PX_SQ } from "./constants.ts";
import { camera } from "./scene.ts";
import {
  selectedMesh, selectedSystem, hoveredSystem, lastHoveredMesh, labelsDirty, setLabelsDirty,
  updateSystemLabelText,
} from "./interaction.ts";
import { bvToColor } from "./color.ts";

const projVec = new THREE.Vector3();
const screenBuf = { x: 0, y: 0 };
function projectToScreen(pos: THREE.Vector3): typeof screenBuf {
  projVec.copy(pos).project(camera);
  screenBuf.x = (projVec.x * 0.5 + 0.5) * window.innerWidth;
  screenBuf.y = (-projVec.y * 0.5 + 0.5) * window.innerHeight;
  return screenBuf;
}

function setLabelStyle(div: HTMLElement, opacity: string, zIndex: string, visible: boolean) {
  div.style.visibility = visible ? "visible" : "hidden";
  div.style.opacity = opacity;
  div.style.zIndex = zIndex;
}

const prevCamPos = new THREE.Vector3();

export function updateLabels(
  labelsVisible: boolean,
  starObjects: THREE.Mesh[],
  systemGroups: SystemGroup[],
  meshLabelMap: WeakMap<THREE.Mesh, HTMLElement>,
  meshToSystem: Map<THREE.Mesh, SystemGroup>,
) {
  if (!labelsVisible) return;
  if (!labelsDirty) return;

  const collapsed = new Set<THREE.Mesh>();

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
      group.label.visible = (group.notable && dist <= LABEL_HIDE_DIST) || isSystemHighlighted;
      if (!group.label.visible) continue;

      const opacity = isSystemHighlighted ? 1.0 : 1.0 - THREE.MathUtils.smoothstep(dist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
      const zIndex = Math.round(10000 - dist * 100);
      const el = group.label.element as HTMLElement;
      setLabelStyle(el, String(Math.max(0.2, opacity)), String(zIndex), true);
      updateSystemLabelText(group);
    } else {
      group.collapsedMembers = [];
      group.label.visible = false;
      if (hoveredSystem === group) {
        // Cleared by the interaction module
      }
    }
  }

  for (const mesh of starObjects) {
    const div = meshLabelMap.get(mesh);
    if (!div) continue;

    const camDist = mesh.position.distanceTo(camera.position);
    const sys = meshToSystem.get(mesh);

    if (collapsed.has(mesh)) {
      setLabelStyle(div, "0", "0", false);
      continue;
    }

    const isHighlighted = mesh === lastHoveredMesh || mesh === selectedMesh
      || (sys !== undefined && (sys === hoveredSystem || sys === selectedSystem));
    const star = mesh.userData as Star;
    const isNotable = !!star.wikipedia;

    if (!isNotable && !isHighlighted) {
      setLabelStyle(div, "0", "0", false);
      continue;
    }

    if (camDist > LABEL_HIDE_DIST && !isHighlighted) {
      setLabelStyle(div, "0", "0", false);
      continue;
    }

    const zIndex = String(Math.round(10000 - camDist * 100));
    const isSystemMemberHighlighted = sys !== undefined && (sys === hoveredSystem || sys === selectedSystem);
    if (isHighlighted) {
      setLabelStyle(div, "1", zIndex, true);
      // Apply glow to uncollapsed system member labels
      if (isSystemMemberHighlighted && !div.style.textShadow.includes("rgba")) {
        const color = bvToColor(star.ci);
        const r = Math.round(Math.min(255, color.r * 255 * 1.3));
        const g = Math.round(Math.min(255, color.g * 255 * 1.3));
        const b = Math.round(Math.min(255, color.b * 255 * 1.3));
        div.style.textShadow = `0 0 8px rgba(${r},${g},${b},0.9), 0 0 20px rgba(${r},${g},${b},0.4), 0 0 4px #000`;
      }
    } else {
      if (div.style.textShadow.includes("rgba")) div.style.textShadow = "";
      const opacity = 1.0 - THREE.MathUtils.smoothstep(camDist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
      setLabelStyle(div, String(Math.max(0.2, opacity)), zIndex, true);
    }
  }

  setLabelsDirty(false);
  prevCamPos.copy(camera.position);
}

export function checkCameraMoved() {
  if (!prevCamPos.equals(camera.position)) setLabelsDirty(true);
}
