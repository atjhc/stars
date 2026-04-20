import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import {
  LABEL_FADE_NEAR, LABEL_FADE_FAR, LABEL_HIDE_DIST, COLLAPSE_PX_SQ,
  solDistanceFade, formatAstroDistance,
} from "./constants.ts";
import {
  camera, animation, isDeepZoom, orbitRadius, labelCamera, labelCamOffset,
} from "./scene.ts";
import { apparentMag, magLimitUniform, clusterOf } from "./starfield.ts";
import { computeStarScreenMetrics } from "./stars.ts";
import { starRadiusScene } from "./color.ts";
import { LABEL_DISC_BUFFER_PX } from "./constants.ts";
import { shouldHighlightLabel, type HighlightContext } from "./labelVisibility.ts";
import { type RankedLabel, resolveCollisions, isLabelInteractive, isCollisionHidden, visibleLabels } from "./labelCollision.ts";
import { collectAllRegisteredLabels, clearFrameOccluders, pushFrameOccluder } from "./labelRegistry.ts";
import {
  getSelectedMesh, getSelectedSystem, getSelectedSubset, getHoveredSystem,
  getLastHoveredMesh, isLabelsDirty, setLabelsDirty,
} from "./systemStore.ts";
import { updateSystemLabelText, unhoverAll } from "./interaction.ts";
import { starGlowShadow } from "./color.ts";
import { isFavorite } from "./favorites.ts";

const collapsed = new Set<THREE.Object3D>();
const labelsWithSubtitle = new WeakSet<HTMLElement>();
let cachedMaxNotableSolDist = 0;
let cachedMaxClusterSolDist = 0;


const projVec = new THREE.Vector3();
const screenBuf = { x: 0, y: 0, behind: false };
// Use labelCamera (unclamped world position) so screen positions match
// where CSS2DRenderer actually places the <div>s and where the shader
// draws the disc (target-relative render, also unclamped). The main
// `camera` is Float32-clamped at deep zoom and would mis-project.
function projectToScreen(pos: THREE.Vector3): typeof screenBuf {
  projVec.copy(pos).project(labelCamera);
  screenBuf.x = (projVec.x * 0.5 + 0.5) * window.innerWidth;
  screenBuf.y = (-projVec.y * 0.5 + 0.5) * window.innerHeight;
  screenBuf.behind = projVec.z > 1;
  return screenBuf;
}

function setLabelStyle(div: HTMLElement, opacity: string, zIndex: string) {
  // Skip opacity writes for labels hidden by collision — resolveCollisions
  // is the sole authority on their opacity. Writing here would flash them
  // visible for the remainder of the synchronous frame (before collision
  // re-hides them) and confuse the lastOpacity tracking.
  if (!isCollisionHidden(div)) div.style.opacity = opacity;
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
  if (animation) return;
  if (!isLabelsDirty()) return;

  const frameLabels: RankedLabel[] = [];
  visibleLabels.clear();
  clearFrameOccluders();

  const magLimit = magLimitUniform.value;
  // Narrow fade band: tier-0 labels stay at full opacity until the star
  // is nearly at the render cutoff, then ease out over 0.5 mag. A wider
  // band muted nearby-but-intrinsically-dim notables (e.g. Proxima
  // viewed from Alpha Centauri A+B), which the user expects to see
  // clearly whenever they'd be rendered at all.
  const tier0FadeStart = magLimit - 0.5;

  // Cache max Sol distance for notables (positions are static after init).
  if (cachedMaxNotableSolDist === 0 && notableAnchors.length > 0) {
    for (const anchor of notableAnchors) {
      const d = anchor.position.length();
      if (d > cachedMaxNotableSolDist) cachedMaxNotableSolDist = d;
    }
  }

  const selectedSystem = getSelectedSystem();
  const selectedSubset = getSelectedSubset();
  const hoveredSystem = getHoveredSystem();
  const selectedMesh = getSelectedMesh();
  const lastHoveredMesh = getLastHoveredMesh();

  const hlCtx: import("./labelVisibility.ts").HighlightContext = {
    meshToSystem,
    hoveredSystem, selectedSystem, selectedSubset,
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
      const clampedOpacity = Math.max(0.2, opacity);
      setLabelStyle(group.label.element as HTMLElement, String(clampedOpacity), String(zIndex));
      if (isHighlighted) updateSystemLabelText(group, true);
      const favBonus = isFavorite(group.name) ? 5000 : 0;
      const clusterDiv = group.label.element as HTMLElement;
      visibleLabels.add(clusterDiv);
      frameLabels.push({
        div: clusterDiv,
        rank: 1500 + favBonus,
        opacity: clampedOpacity,
        pinned: isHighlighted,
      });

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

    // Any focus on a member of this group disables the on-screen
    // collapse — the user explicitly asked for the other members to
    // render as normal stars, so Proxima's label shouldn't disappear
    // into an "Alpha Centauri · A · B" aggregate when the user is
    // zoomed in on the pair. Collisions between individual labels
    // are then handled naturally by resolveCollisions.
    const memberInFocus = (m: THREE.Object3D | null) =>
      m !== null && meshToSystem.get(m) === group;
    const skipCollapse =
      (selectedSystem === group && selectedSubset !== null)
      || memberInFocus(selectedMesh)
      || memberInFocus(lastHoveredMesh);

    if (skipCollapse) {
      group.collapsedMembers = [];
      group.label.visible = false;
      continue;
    }

    const n = group.meshes.length;
    const screens = group.screens;
    const parent = group.parents;

    for (let i = 0; i < n; i++) {
      const s = projectToScreen(group.meshes[i].position);
      screens[i].x = s.x;
      screens[i].y = s.y;
    }
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
      const members: THREE.Object3D[] = [];
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
      const clampedOpacity = Math.max(0.2, opacity);
      const zIndex = Math.round(10000 - dist * 100);
      const el = group.label.element as HTMLElement;
      setLabelStyle(el, String(clampedOpacity), String(zIndex));
      updateSystemLabelText(group, isSystemHighlighted);
      const favBonus = isFavorite(group.name) ? 5000 : 0;
      visibleLabels.add(el);
      frameLabels.push({
        div: el,
        rank: 1000 + favBonus,
        opacity: clampedOpacity,
        pinned: isSystemHighlighted,
      });
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

    // Unclamped camera position: camera.position is clamped to 0.001
    // during deep zoom (Float32 safety), which would vastly over-estimate
    // camDist for stars near the target and shrink their disc-size math.
    const camDist = target.position.distanceTo(labelCamOffset);
    const star = target.userData as Star;
    const radius = starRadiusScene(star.lum, star.ci);
    const discPx = computeStarScreenMetrics(radius, star.absmag ?? 10, Math.max(camDist, 1e-20)).discPx;

    // Every rendered star's disc occludes labels behind it. Register
    // the occluder before any early-return so a collapsed-system
    // member (whose individual label is hidden) still hides labels
    // that project inside its visible disc.
    if (discPx > 2) {
      const s = projectToScreen(target.position);
      if (!s.behind) {
        pushFrameOccluder({ cx: s.x, cy: s.y, radius: discPx });
      }
    }

    const sys = meshToSystem.get(target);
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

    // Label margin clears the star's disc (which can grow past the
    // default 16px when the camera is close).
    const margin = Math.min(discPx, window.innerHeight) + LABEL_DISC_BUFFER_PX;
    div.style.marginTop = `${margin}px`;

    const zIndex = String(Math.round(10000 - camDist * 100));
    const isTier0 = star.tier === 0;
    const owningGroup = sys ?? clusterOf.get(target);
    const isSystemMemberHighlighted = owningGroup !== undefined && (owningGroup === hoveredSystem || owningGroup === selectedSystem);

    if (isHighlighted) {
      target.visible = true;
      setLabelStyle(div, "1", zIndex);

      // Selected target(s) show distance from camera. Hovered others
      // show distance from the current selection (so the user sees how
      // far the hovered star is from what they're orbiting).
      const isSelectedTarget = target === selectedMesh
        || (sys !== undefined && sys === selectedSystem);
      let subtitleDist = camDist;
      if (!isSelectedTarget) {
        if (selectedMesh) subtitleDist = target.position.distanceTo(selectedMesh.position);
        else if (selectedSystem) subtitleDist = target.position.distanceTo(selectedSystem.centroid);
      }
      div.innerHTML = `<div>${star.name}</div><div class="system-members">${formatAstroDistance(subtitleDist)}</div>`;
      labelsWithSubtitle.add(div);
      if (isSystemMemberHighlighted) {
        div.style.textShadow = starGlowShadow(star.ci);
      }
      visibleLabels.add(div);
      frameLabels.push({ div, rank: 500, opacity: 1, pinned: true });
      return;
    }

    if (labelsWithSubtitle.has(div)) {
      div.textContent = star.name;
      labelsWithSubtitle.delete(div);
    }
    if (div.style.textShadow.includes("rgba")) div.style.textShadow = "";

    const favBonus = isFavorite(star.name) ? 5000 : 0;

    if (isTier0) {
      const appMag = apparentMag(star.absmag ?? 10, Math.max(camDist, 1e-20));
      const t = THREE.MathUtils.clamp((appMag - tier0FadeStart) / 0.5, 0, 1);
      if (t >= 1) {
        target.visible = false;
        return;
      }
      target.visible = true;
      const solDist = target.position.length();
      const solFade = solDistanceFade(solDist, cachedMaxNotableSolDist);
      const finalOpacity = Math.max(0.15, (1 - t) * solFade);
      setLabelStyle(div, String(finalOpacity), zIndex);
      const magRank = Math.max(0, (10 - appMag) * 10);
      const solBonus = star.name === "Sol" ? 3000 : 0;
      visibleLabels.add(div);
      frameLabels.push({ div, rank: 500 + magRank + favBonus + solBonus, opacity: finalOpacity });
    } else {
      if (camDist > LABEL_HIDE_DIST) {
        target.visible = false;
        return;
      }
      target.visible = true;
      const opacity = 1.0 - THREE.MathUtils.smoothstep(camDist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
      const finalOpacity = Math.max(0.2, opacity);
      setLabelStyle(div, String(finalOpacity), zIndex);
      visibleLabels.add(div);
      frameLabels.push({ div, rank: favBonus, opacity: finalOpacity });
    }
  }

  for (const anchor of notableAnchors) processLabel(anchor);
  for (const mesh of interactiveStars) processLabel(mesh);

  const registeredLabels = collectAllRegisteredLabels();
  for (const rl of registeredLabels) visibleLabels.add(rl.div);
  frameLabels.push(...registeredLabels);
  resolveCollisions(frameLabels);

  const lastHovered = getLastHoveredMesh();
  const hoverDiv = lastHovered ? divFor(lastHovered) : null;
  const hovSys = getHoveredSystem();
  const sysDiv = hovSys ? hovSys.label.element as HTMLElement : null;
  if ((hoverDiv && !isLabelInteractive(hoverDiv))
    || (sysDiv && hovSys !== getSelectedSystem() && !isLabelInteractive(sysDiv))) {
    unhoverAll();
  }

  setLabelsDirty(false);
  prevCamPos.copy(camera.position);
}

const CAMERA_CHECK_INTERVAL = 300;
let lastCameraCheckTime = 0;

let prevOrbitRadius = 0;

export function checkCameraMoved() {
  const radiusChanged = isDeepZoom() && orbitRadius !== prevOrbitRadius;
  prevOrbitRadius = orbitRadius;
  if (!radiusChanged && prevCamPos.equals(camera.position)) return;
  const now = performance.now();
  if (!isDeepZoom() && now - lastCameraCheckTime < CAMERA_CHECK_INTERVAL) return;
  lastCameraCheckTime = now;
  setLabelsDirty(true);
}
