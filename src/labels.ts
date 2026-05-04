import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import {
  LABEL_FADE_NEAR, LABEL_FADE_FAR, LABEL_HIDE_DIST, COLLAPSE_PX_SQ,
  ARRIVAL_COLLISION_DIST,
  solDistanceFade, formatAstroDistance,
} from "./constants.ts";
import {
  camera, animation, isDeepZoom, orbitRadius, projectToLabelScreen,
  distanceFromCamera,
} from "./scene.ts";
import { apparentMag, magLimitUniform, clusterOf, systemCanvasLabelId } from "./starfield.ts";
import { computeStarScreenMetrics } from "./stars.ts";
import { starRadiusScene, starGlowCanvas } from "./color.ts";
import { LABEL_DISC_BUFFER_PX } from "./constants.ts";
import { shouldHighlightLabel, type HighlightContext } from "./labelVisibility.ts";
import { pushFrameOccluder } from "./labelRegistry.ts";
import { updateCanvasLabel, getCanvasLabelIdForMesh, markCanvasCollisionDirty, setCanvasLabelsVisible } from "./labelCanvas.ts";
import {
  getSelectedMesh, getSelectedSystem, getSelectedSubset, getHoveredSystem,
  getLastHoveredMesh, isLabelsDirty, setLabelsDirty,
} from "./systemStore.ts";
import { isFavorite } from "./favorites.ts";
import { isConstellationStar, constellationsVisible } from "./constellations.ts";
import { inSolarSystemView } from "./planets.ts";
import { statsPhase } from "./statsPhase.ts";

// When far away the star is just a corona glow, so the label sits
// close. As the disc grows the gap widens to the full buffer.
const LABEL_GAP_NEAR_PX = 4;
const LABEL_GAP_FULL_DISC_PX = 20;
export function starLabelMargin(discPx: number, halfBillPx: number): number {
  const t = Math.min(discPx / LABEL_GAP_FULL_DISC_PX, 1);
  const gap = THREE.MathUtils.lerp(LABEL_GAP_NEAR_PX, LABEL_DISC_BUFFER_PX, t);
  return Math.min(halfBillPx + gap, window.innerHeight);
}

const collapsed = new Set<THREE.Object3D>();
let cachedMaxNotableSolDist = 0;
let cachedMaxClusterSolDist = 0;

// Tier-1 anchors whose last slow-path processing ended in the
// "far away — hide" branch. Used by processLabel's fast-path: if the
// anchor is in this set and the cheap selection / system / distance
// / collapse checks still pass, this frame's full processing would
// just rewrite the same {hidden:true,pinned:false} state. Maintained
// via add in the far-branch and delete at the top of every other
// updateCanvasStarLabel call. WeakSet so a tile-unload doesn't pin
// anchors past their natural GC.
const idleHiddenTier1 = new WeakSet<THREE.Object3D>();

const screenBuf = { x: 0, y: 0, behind: false };
function projectToScreen(pos: THREE.Vector3): typeof screenBuf {
  projectToLabelScreen(pos, screenBuf);
  return screenBuf;
}

const prevCamPos = new THREE.Vector3();

export function updateLabels(
  labelsVisible: boolean,
  notableAnchors: THREE.Object3D[],
  interactiveStars: THREE.Object3D[],
  systemGroups: SystemGroup[],
  meshToSystem: Map<THREE.Object3D, SystemGroup>,
) {
  if (!labelsVisible) return;

  // Hide every label during transit and let them fade back in once
  // the camera enters the arrival window (~1 ly from destination).
  // setCanvasLabelsVisible is idempotent and forces the collision
  // pass to flip in lockstep, so all labels fade out together.
  const inTransit = animation !== null && distanceFromCamera(animation.to) > ARRIVAL_COLLISION_DIST;
  setCanvasLabelsVisible(!inTransit);
  if (inTransit) return;

  if (!isLabelsDirty()) return;

  // This is the canonical "labels changed enough that we should
  // re-evaluate who collides with whom" signal — checkCameraMoved
  // throttles it to ~300 ms during orbit, which is exactly the cadence
  // we want for batched collision decisions.
  markCanvasCollisionDirty();
  // Frame occluders are cleared in main.ts before updateAllLabels;
  // star occluders pushed below stack on top of planet ones.

  const magLimit = magLimitUniform.value;
  // Inside Sol's planetary system: hide wider-galaxy labels so the
  // view stays focused locally. Constellation members remain a
  // navigation aid when constellations are on.
  const inSolarSystem = inSolarSystemView();
  const showConstellationStars = inSolarSystem && constellationsVisible();
  // Narrow fade band: tier-0 labels stay at full opacity until the star
  // is nearly at the render cutoff, then ease out over 0.5 mag. A wider
  // band muted nearby-but-intrinsically-dim notables (e.g. Proxima
  // viewed from Alpha Centauri A+B), which the user expects to see
  // clearly whenever they'd be rendered at all.
  const tier0FadeStart = magLimit - 0.5;

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

  const hlCtx: HighlightContext = {
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

  statsPhase("ul.systems", () => {
  for (const group of systemGroups) {
    if (group.kind === "cluster") {
      const isHighlighted = hoveredSystem === group || selectedSystem === group;
      const solDist = group.anchor.position.length();
      const baseOpacity = solDistanceFade(solDist, maxClusterSolDist);
      const opacity = isHighlighted ? 1.0 : baseOpacity;
      const dist = distanceFromCamera(group.anchor.position);
      const clampedOpacity = Math.max(0.2, opacity);
      const favBonus = isFavorite(group.name) ? 5000 : 0;
      const canvasId = systemCanvasLabelId(group);
      if (inSolarSystem && !isHighlighted) {
        if (canvasId) updateCanvasLabel(canvasId, { hidden: true, pinned: false, subtitles: [] });
        continue;
      }
      if (canvasId) {
        updateCanvasLabel(canvasId, {
          opacityTarget: clampedOpacity,
          pinned: isHighlighted,
          hidden: false,
          rank: 1500 + favBonus,
          subtitles: isHighlighted ? [formatAstroDistance(dist)] : [],
          shadowColor: isHighlighted ? "rgba(160,200,255,0.9)" : "#000",
          shadowBlur: isHighlighted ? 10 : 4,
        });
      }

      // Cluster-member collapse: members within COLLAPSE_PX of the
      // cluster centroid hide their individual labels behind the
      // cluster label (collapsed set consulted in processLabel).
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
    // are then handled naturally by the canvas collision pass.
    const memberInFocus = (m: THREE.Object3D | null) =>
      m !== null && meshToSystem.get(m) === group;
    const skipCollapse =
      (selectedSystem === group && selectedSubset !== null)
      || memberInFocus(selectedMesh)
      || memberInFocus(lastHoveredMesh);

    if (skipCollapse) {
      group.collapsedMembers = [];
      const skipId = systemCanvasLabelId(group);
      if (skipId) updateCanvasLabel(skipId, { hidden: true, pinned: false, subtitles: [] });
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

    const canvasId = systemCanvasLabelId(group);

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

      const dist = distanceFromCamera(group.anchor.position);
      const isSystemHighlighted = hoveredSystem === group || selectedSystem === group;
      const visible = dist <= LABEL_HIDE_DIST || isSystemHighlighted;
      const favBonus = isFavorite(group.name) ? 5000 : 0;

      if (canvasId) {
        if (!visible || (inSolarSystem && !isSystemHighlighted)) {
          updateCanvasLabel(canvasId, { hidden: true, pinned: false, subtitles: [] });
        } else {
          const opacity = isSystemHighlighted ? 1.0 : 1.0 - THREE.MathUtils.smoothstep(dist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
          const clampedOpacity = Math.max(0.2, opacity);
          // Active binary label layout: main line = name, sub-lines =
          // member names joined with " · ", then distance.
          let subtitles: string[] = [];
          if (isSystemHighlighted) {
            const memberNames = members.map((m) => (m.userData as Star).name).join(" · ");
            subtitles = [memberNames, formatAstroDistance(dist)];
          }
          // System glow uses brightest member's color.
          let glowColor = "rgba(255,255,255,0.9)";
          if (isSystemHighlighted && members.length > 0) {
            let brightest = members[0]!.userData as Star;
            for (const m of members) {
              const s = m.userData as Star;
              if (s.lum > brightest.lum) brightest = s;
            }
            glowColor = starGlowCanvas(brightest.ci).color;
          }
          updateCanvasLabel(canvasId, {
            opacityTarget: clampedOpacity,
            pinned: isSystemHighlighted,
            hidden: false,
            rank: 1000 + favBonus,
            subtitles,
            shadowColor: isSystemHighlighted ? glowColor : "#000",
            shadowBlur: isSystemHighlighted ? 10 : 4,
          });
        }
      }
    } else {
      group.collapsedMembers = [];
      if (canvasId) updateCanvasLabel(canvasId, { hidden: true, pinned: false, subtitles: [] });
    }
  }
  });

  // Per-anchor star label pass. Pushes a screen-space occluder for
  // every rendered disc so labels behind bright stars hide; routes
  // opacity / subtitle / highlight through the canvas updater.
  function processLabel(target: THREE.Object3D) {
    const camDist = distanceFromCamera(target.position);
    const star = target.userData as Star;

    // Fast-path: tier-1 anchor whose last slow-path call ended in the
    // far-hide branch (membership in idleHiddenTier1) AND none of the
    // cheap conditions that could flip it back to visible have changed.
    // Skips ~240 ns of metrics + Map lookups + Object.assign per call —
    // most of the 4k+ tier-1 anchors during a typical view. The disc
    // occluder push is also skipped, which is safe because at
    // camDist > LABEL_HIDE_DIST (~180 ly) no catalogued star has a
    // disc that would reach the 2 px occluder threshold.
    if (idleHiddenTier1.has(target)
      && star.tier !== 0
      && camDist > LABEL_HIDE_DIST
      && target !== selectedMesh
      && target !== lastHoveredMesh
      && !collapsed.has(target)) {
      const owning = meshToSystem.get(target) ?? clusterOf.get(target);
      if (owning !== hoveredSystem && owning !== selectedSystem) return;
    }

    // Solar-system view: hoisted above the metrics/occluder pass so
    // we don't pay screen projection for thousands of stars that the
    // gate inside updateCanvasStarLabel would just hide anyway.
    if (inSolarSystem && star.name !== "Sol") {
      const sys = meshToSystem.get(target);
      const sysHighlighted = sys !== undefined
        && (sys === selectedSystem || sys === hoveredSystem);
      if (target !== selectedMesh && target !== lastHoveredMesh && !sysHighlighted
          && (!showConstellationStars || !isConstellationStar(star.name))) {
        target.visible = false;
        const canvasId = getCanvasLabelIdForMesh(target);
        if (canvasId) updateCanvasLabel(canvasId, { hidden: true, pinned: false });
        return;
      }
    }

    const radius = starRadiusScene(star.lum, star.ci);
    const metrics = computeStarScreenMetrics(radius, star.absmag ?? 10, Math.max(camDist, 1e-20));

    if (metrics.discPx > 2) {
      const s = projectToScreen(target.position);
      if (!s.behind) {
        pushFrameOccluder({ cx: s.x, cy: s.y, radius: metrics.discPx });
      }
    }

    const canvasId = getCanvasLabelIdForMesh(target);
    if (!canvasId) return;

    const sys = meshToSystem.get(target);
    const isHighlighted = shouldHighlightLabel(target, hlCtx);
    const owningGroup = sys ?? clusterOf.get(target);
    const isSystemMemberHighlighted = owningGroup !== undefined
      && (owningGroup === hoveredSystem || owningGroup === selectedSystem);
    const margin = starLabelMargin(metrics.discPx, metrics.halfBillPx);
    updateCanvasStarLabel(
      target, canvasId, camDist, margin,
      isHighlighted, isSystemMemberHighlighted, sys, star.tier === 0,
    );
  }

  function updateCanvasStarLabel(
    target: THREE.Object3D,
    canvasId: string,
    camDist: number,
    margin: number,
    isHighlighted: boolean,
    isSystemMemberHighlighted: boolean,
    sys: SystemGroup | undefined,
    isTier0: boolean,
  ) {
    // Optimistic clear; the tier-1 far-hide branch re-adds. Keeping
    // every non-far branch out of the set ensures the fast-path's
    // membership check actually means "last full processing ended in
    // the far-hide branch", so its skip is safe.
    idleHiddenTier1.delete(target);

    const star = target.userData as Star;

    if (collapsed.has(target)) {
      target.visible = true;
      // Collapsed members want to fade out (the cluster label claims
      // the visual space). Flag hidden; leave opacityTarget intact so
      // the visibleFactor animation has something to fade from.
      updateCanvasLabel(canvasId, { hidden: true, pinned: false });
      return;
    }

    if (isHighlighted) {
      const isSelectedTarget = target === selectedMesh
        || (sys !== undefined && sys === selectedSystem);
      let subtitleDist = camDist;
      if (!isSelectedTarget) {
        if (selectedMesh) subtitleDist = target.position.distanceTo(selectedMesh.position);
        else if (selectedSystem) subtitleDist = target.position.distanceTo(selectedSystem.centroid);
      }
      target.visible = true;
      const glow = starGlowCanvas(star.ci);
      updateCanvasLabel(canvasId, {
        opacityTarget: 1,
        pinned: true,
        hidden: false,
        rank: 500,
        marginTop: margin,
        subtitles: [formatAstroDistance(subtitleDist)],
        shadowColor: glow.color,
        shadowBlur: isSystemMemberHighlighted ? glow.blur + 4 : glow.blur,
      });
      return;
    }

    const favBonus = isFavorite(star.name) ? 5000 : 0;
    const constBonus = isConstellationStar(star.name) ? 2500 : 0;

    if (isTier0) {
      const appMag = apparentMag(star.absmag ?? 10, Math.max(camDist, 1e-20));
      const t = THREE.MathUtils.clamp((appMag - tier0FadeStart) / 0.5, 0, 1);
      if (t >= 1) {
        target.visible = false;
        updateCanvasLabel(canvasId, { hidden: true, pinned: false });
        return;
      }
      target.visible = true;
      const solDist = target.position.length();
      const solFade = solDistanceFade(solDist, cachedMaxNotableSolDist);
      const finalOpacity = Math.max(0.15, (1 - t) * solFade);
      const magRank = Math.max(0, (10 - appMag) * 10);
      const solBonus = star.name === "Sol" ? 3000 : 0;
      updateCanvasLabel(canvasId, {
        opacityTarget: finalOpacity,
        pinned: false,
        hidden: false,
        rank: 500 + magRank + favBonus + solBonus + constBonus,
        marginTop: margin,
        subtitles: [],
        shadowColor: "#000",
        shadowBlur: 4,
      });
      return;
    }

    if (camDist > LABEL_HIDE_DIST) {
      target.visible = false;
      updateCanvasLabel(canvasId, { hidden: true, pinned: false });
      idleHiddenTier1.add(target);
      return;
    }
    target.visible = true;
    const opacity = 1.0 - THREE.MathUtils.smoothstep(camDist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
    const finalOpacity = Math.max(0.2, opacity);
    updateCanvasLabel(canvasId, {
      opacityTarget: finalOpacity,
      pinned: false,
      hidden: false,
      rank: favBonus + constBonus,
      marginTop: margin,
      subtitles: [],
      shadowColor: "#000",
      shadowBlur: 4,
    });
  }

  statsPhase("ul.notables", () => {
    for (const anchor of notableAnchors) processLabel(anchor);
  });
  statsPhase("ul.interactive", () => {
    for (const mesh of interactiveStars) processLabel(mesh);
  });

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
