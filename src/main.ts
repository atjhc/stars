import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { CLICK_THRESHOLD, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS, ANIM_DURATION } from "./constants.ts";
import {
  scene, camera, renderer, composer, lensingPass,
  gridMesh, handleResize, bloomPass,
  beginBloomRender, endBloomRender,
  updateCamera, applyOrbitDrag, lookToward, onWheel, tickAnimation,
  orbitRadius, orbitPhi, orbitTheta, target,
  setOrbitRadius, setOrbitPhi, setOrbitTheta, getEffectiveMinOrbit,
  setTargetImmediate, updateDeepZoom, animation,
  finalizeLensingFrame, getLensingOccluder,
  toggleAutoOrbit, stopAutoOrbit, isAutoOrbit,
} from "./scene.ts";
import {
  initUrlState, enableUrlWrites, scheduleUrlWrite, parseUrlState,
} from "./urlState.ts";
import { getSelectedNebulaName, setNebulaHoverByName } from "./nebulaeLabels.ts";
import { starRadiusScene } from "./color.ts";
import {
  hoverTarget, unhoverAll,
  selectTarget, selectSystem, selectStar,
  showSystemMembers, hideSystemMembers,
} from "./interaction.ts";
import {
  getSelectedSystem, getHoveredSystem, setHoveredSystem,
  getSelectedMesh, getSelectedSubset, setLabelsDirty,
} from "./systemStore.ts";
import { toggleFavorite } from "./favorites.ts";

import { type SearchEntry, getSearchIndex } from "./catalog.ts";
import { updateDetailPanel } from "./detail.ts";
import { setupSearch } from "./search.ts";
import { updateLabels, checkCameraMoved } from "./labels.ts";
import { initConstellations, toggleConstellations, setConstellationsVisible, constellationsVisible } from "./constellations.ts";
import {
  initDust, updateDust, renderDustToRT, compositeDustToScreen, getDustTexture,
  toggleDust, setDustVisible, isDustVisible, handleDustResize,
} from "./dust.ts";
import { initNebulaeLabels } from "./nebulaeLabels.ts";
import { initBlackHoleLabels, getSelectedBlackHoleName, setBlackHoleHoverByName } from "./blackholes.ts";
import { initNeutronStarLabels, getSelectedNeutronStarName, setNeutronStarHoverByName, renderNeutronStars } from "./neutronstars.ts";
import { setAllLabelsVisible, updateAllLabels, clearAllSelections, selectByType, registerScreenOccluder, onSelectionChanged } from "./labelRegistry.ts";
import { initDebug, debugEnabled, benchEnabled, debug, onDebugChange, tickDebug, statsBegin, statsEnd, statsPhase, refreshDebugPanel } from "./debug.ts";
import { runBench } from "./bench.ts";
import {
  initLabelCanvas, renderLabelCanvas, setHitTargetsOverlay, setCanvasLabelsVisible,
  pickLabelAt, pickStarAt, getCanvasLabel, isCanvasLabelInteractive,
} from "./labelCanvas.ts";
import {
  initStarfield, updateStarfield, updateTileTargets,
  notableObjects, tier1Meshes,
  systemGroups, meshToSystem, clusterOf,
  onLabelsChanged,
  requestTileFocus, rebaseForTarget,
  magLimitUniform, setMagLimit,
  getHoveredWorldPos,
} from "./starfield.ts";
import { animateTo } from "./scene.ts";
import { startRenderLoop, bumpInput, setAlwaysOn } from "./renderLoop.ts";

// Wait for DOM
await new Promise<void>((resolve) => {
  if (document.readyState !== "loading") resolve();
  else document.addEventListener("DOMContentLoaded", () => resolve());
});

document.addEventListener("touchmove", (e) => {
  if (!(e.target as HTMLElement).closest("#search-results, #detail")) {
    e.preventDefault();
  }
}, { passive: false });

import { makeCollapsible } from "./collapse.ts";
{
  const info = document.getElementById("info");
  if (info) makeCollapsible(info, "info");
}

let labelsVisible = true;

// Rebase the tile containing a selected star for floating-origin precision.
function rebaseForStar(mesh: THREE.Object3D) {
  const star = mesh.userData as Star;
  if (star.tile) rebaseForTarget(star.tile, mesh.position);
}

// Input state
let isDragging = false;
let prevMouse = { x: 0, y: 0 };
let dragDistance = 0;
let lastInputWasTouch = false;
let isAltOrbit = false;

function trySelectAt(clientX: number, clientY: number) {
  // Screen-space star disc pick. Replaces the old 3D raycast against
  // hit spheres — immune to deep-zoom camera clamping and to binary
  // members whose hit spheres overlap in 3D but not on screen.
  const starMesh = pickStarAt(clientX, clientY) as THREE.Object3D | null;
  if (starMesh) {
    clearAllSelections();
    selectTarget(starMesh, updateDetailPanel, doUpdateLabelVisibility);
    rebaseForStar(starMesh);
    return;
  }
  // Missed the disc — try label rects (tier-1 text clicks, systems,
  // nebulae, BHs).
  dispatchCanvasLabelClick(clientX, clientY);
}

function dispatchCanvasLabelClick(x: number, y: number): boolean {
  const id = pickLabelAt(x, y);
  if (!id || !isCanvasLabelInteractive(id)) return false;
  const label = getCanvasLabel(id);
  if (!label) return false;
  switch (label.kind) {
    case "star": {
      const mesh = label.payload as THREE.Object3D | undefined;
      if (!mesh) return false;
      clearAllSelections();
      selectTarget(mesh, updateDetailPanel, doUpdateLabelVisibility);
      rebaseForStar(mesh);
      return true;
    }
    case "system": {
      const group = label.payload as SystemGroup | undefined;
      if (!group) return false;
      clearAllSelections();
      selectSystem(group, updateDetailPanel);
      return true;
    }
    case "nebula":
    case "blackhole":
    case "neutronstar": {
      const name = (label.payload as { name?: string } | undefined)?.name;
      if (name) return selectByType(label.kind, name);
      return false;
    }
  }
  return false;
}

function doUpdateLabelVisibility() {
  setCanvasLabelsVisible(labelsVisible);
  setAllLabelsVisible(labelsVisible);
  setLabelsDirty(true);
}

onLabelsChanged(() => {
  setLabelsDirty(true);
  if (pendingSystemSelect && trySelectSystem(pendingSystemSelect.name, pendingSystemSelect.subsetNames)) {
    pendingSystemSelect = null;
    scheduleUrlWrite();
  }
});

// Mouse controls
renderer.domElement.addEventListener("mousedown", (e) => {
  isDragging = true;
  prevMouse.x = e.clientX;
  prevMouse.y = e.clientY;
  dragDistance = 0;
  unhoverAll();
  stopAutoOrbit();
  bumpInput();
});

window.addEventListener("mousemove", (e) => {
  const dx = e.clientX - prevMouse.x;
  const dy = e.clientY - prevMouse.y;
  prevMouse.x = e.clientX;
  prevMouse.y = e.clientY;
  bumpInput();
  if (e.altKey && !isDragging) {
    isAltOrbit = true;
    stopAutoOrbit();
    applyOrbitDrag(dx, dy);
    return;
  }
  isAltOrbit = false;
  if (!isDragging) return;
  dragDistance += Math.abs(dx) + Math.abs(dy);
  applyOrbitDrag(dx, dy);
});

window.addEventListener("mouseup", (e) => {
  const wasClick = isDragging && dragDistance < CLICK_THRESHOLD;
  const wasDrag = isDragging && !wasClick;
  isDragging = false;
  if (wasClick) trySelectAt(e.clientX, e.clientY);
  if (wasDrag || wasClick) scheduleUrlWrite();
  bumpInput();
});

// Touch controls
let touchStartDist = 0;
let touchStartRadius = 0;

renderer.domElement.addEventListener("touchstart", (e) => {
  e.preventDefault();
  bumpInput();
  if (e.touches.length === 1) {
    isDragging = true;
    prevMouse.x = e.touches[0].clientX;
    prevMouse.y = e.touches[0].clientY;
    dragDistance = 0;
    stopAutoOrbit();
  } else if (e.touches.length === 2) {
    isDragging = false;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    touchStartDist = Math.sqrt(dx * dx + dy * dy);
    touchStartRadius = orbitRadius;
  }
}, { passive: false });

renderer.domElement.addEventListener("touchmove", (e) => {
  e.preventDefault();
  bumpInput();
  if (e.touches.length === 1 && isDragging) {
    const dx = e.touches[0].clientX - prevMouse.x;
    const dy = e.touches[0].clientY - prevMouse.y;
    prevMouse.x = e.touches[0].clientX;
    prevMouse.y = e.touches[0].clientY;
    dragDistance += Math.abs(dx) + Math.abs(dy);
    applyOrbitDrag(dx, dy);
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    setOrbitRadius(THREE.MathUtils.clamp(
      touchStartRadius * Math.pow(touchStartDist / dist, 2.0),
      getEffectiveMinOrbit(), MAX_ORBIT_RADIUS,
    ));
    updateCamera();
  }
}, { passive: false });

renderer.domElement.addEventListener("touchend", (e) => {
  e.preventDefault();
  const wasClick = isDragging && dragDistance < CLICK_THRESHOLD;
  isDragging = false;
  if (wasClick && e.changedTouches.length > 0) {
    const touch = e.changedTouches[0];
    trySelectAt(touch.clientX, touch.clientY);
  }
  scheduleUrlWrite();
  bumpInput();
}, { passive: false });

function onWheelWithUrl(e: WheelEvent) {
  onWheel(e);
  scheduleUrlWrite();
  bumpInput();
}
renderer.domElement.addEventListener("wheel", onWheelWithUrl, { passive: false });

window.addEventListener("touchstart", () => { lastInputWasTouch = true; }, { capture: true });
window.addEventListener("mousemove", () => { lastInputWasTouch = false; }, { capture: true });

renderer.domElement.addEventListener("mousemove", (e) => {
  if (lastInputWasTouch || isDragging || e.altKey) return;
  // Screen-space star disc pick first (matches the magenta overlay).
  const starMesh = pickStarAt(e.clientX, e.clientY) as THREE.Object3D | null;
  if (starMesh) {
    const cluster = clusterOf.get(starMesh);
    if (!cluster || isTargetClusterLabelInteractive(cluster)) {
      hoverTarget(starMesh, meshToSystem, clusterOf);
      return;
    }
  }
  // Missed disc — canvas label hover (text rect pick, plus system /
  // nebula / BH dispatch).
  if (dispatchCanvasLabelHover(e.clientX, e.clientY)) return;
  unhoverAll();
});

function isTargetClusterLabelInteractive(cluster: SystemGroup): boolean {
  return isCanvasLabelInteractive(`system:${cluster.name}`);
}

// Canvas-only hover dispatch — star, system, nebula, BH. Returns true
// when a canvas label was hit and hover state was updated so the
// caller skips the unhoverAll fallback. Also ensures that leaving one
// label type and entering another clears the first type's hover glow,
// since each type owns its own hover state (stars through
// interaction.ts, nebula/BH through their own modules).
function dispatchCanvasLabelHover(x: number, y: number): boolean {
  const id = pickLabelAt(x, y);
  const label = id && isCanvasLabelInteractive(id) ? getCanvasLabel(id) : null;

  // Clear cross-type hover first — keeps only the matching type active.
  if (label?.kind !== "nebula") setNebulaHoverByName(null);
  if (label?.kind !== "blackhole") setBlackHoleHoverByName(null);
  if (label?.kind !== "neutronstar") setNeutronStarHoverByName(null);

  if (!label) {
    unhoverAll();
    return false;
  }

  if (label.kind === "star") {
    const mesh = label.payload as THREE.Object3D | undefined;
    if (!mesh) return false;
    hoverTarget(mesh, meshToSystem, clusterOf);
    return true;
  }
  if (label.kind === "system") {
    const group = label.payload as SystemGroup | undefined;
    if (!group) return false;
    unhoverAll();
    if (getSelectedSystem() !== group && getHoveredSystem() !== group) {
      const prevHovered = getHoveredSystem();
      if (prevHovered && prevHovered !== group && prevHovered !== getSelectedSystem()) {
        hideSystemMembers(prevHovered);
      }
      setHoveredSystem(group);
      showSystemMembers(group);
    }
    return true;
  }
  if (label.kind === "nebula") {
    unhoverAll();
    setNebulaHoverByName((label.payload as { name: string }).name);
    return true;
  }
  if (label.kind === "blackhole") {
    unhoverAll();
    setBlackHoleHoverByName((label.payload as { name: string }).name);
    return true;
  }
  if (label.kind === "neutronstar") {
    unhoverAll();
    setNeutronStarHoverByName((label.payload as { name: string }).name);
    return true;
  }
  return false;
}


const MAG_STEP = 0.25;
const MAG_MIN = 2;
const MAG_MAX = 10;
function adjustMagLimit(dir: 1 | -1) {
  const next = Math.min(MAG_MAX, Math.max(MAG_MIN, magLimitUniform.value + dir * MAG_STEP));
  setMagLimit(next);
  debug.mag_limit = next;
  refreshDebugPanel();
  scheduleUrlWrite();
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  bumpInput();
  if (e.key === "l") {
    labelsVisible = !labelsVisible;
    doUpdateLabelVisibility();
    scheduleUrlWrite();
  } else if (e.key === "g") {
    gridMesh.visible = !gridMesh.visible;
    scheduleUrlWrite();
  } else if (e.key === "c") {
    toggleConstellations();
    scheduleUrlWrite();
  } else if (e.key === "n") {
    toggleDust();
    doUpdateLabelVisibility();
    scheduleUrlWrite();
  } else if (e.key === "f") {
    const name = getSelectedSystem()?.name ?? (getSelectedMesh()?.userData as Star | undefined)?.name;
    if (name) {
      toggleFavorite(name);
      setLabelsDirty(true);
      updateDetailPanel();
    }
  } else if (e.key === "o") {
    toggleAutoOrbit();
  } else if ((e.key === "-" || e.key === "=") && !e.metaKey && !e.ctrlKey && !e.altKey) {
    // Cmd/Ctrl +/- are reserved for browser zoom — leave those alone.
    adjustMagLimit(e.key === "=" ? 1 : -1);
    e.preventDefault();
  }
});

window.addEventListener("resize", () => {
  handleResize();
  handleDustResize();
  setLabelsDirty(true);
  bumpInput();
});

// Search is driven by the global names.json index (every tier-0/tier-1
// star plus one synthetic entry per cluster). When the user picks an
// entry whose tile isn't loaded, we force-load the tile and upgrade the
// selection to a real mesh once it spawns. Cluster entries resolve to
// the live SystemGroup by name.
// A system (binary/cluster) selected by name — possibly with a member-
// name sub-selection — before its SystemGroup has been rebuilt. Retried
// from onLabelsChanged when the group finally appears.
let pendingSystemSelect: { name: string; subsetNames?: string[] } | null = null;

function trySelectSystem(name: string, subsetNames?: string[]): boolean {
  const group = systemGroups.find((g) => g.name === name);
  if (!group) return false;
  let subset: THREE.Object3D[] | undefined;
  if (subsetNames && subsetNames.length >= 2) {
    const byName = new Map<string, THREE.Object3D>();
    for (const m of group.meshes) byName.set((m.userData as Star).name, m);
    subset = subsetNames
      .map((n) => byName.get(n))
      .filter((m): m is THREE.Object3D => m !== undefined);
    if (subset.length < 2) subset = undefined;
  }
  selectSystem(group, updateDetailPanel, subset);
  return true;
}

function handleSearchSelect(entry: SearchEntry) {
  pendingSystemSelect = null;
  animateTo(new THREE.Vector3(entry.p[0], entry.p[1], entry.p[2]));
  if (entry.k === "n") {
    selectByType("nebula", entry.n);
    scheduleUrlWrite();
    return;
  }
  if (entry.k === "b") {
    selectByType("blackhole", entry.n);
    scheduleUrlWrite();
    return;
  }
  if (entry.k === "ns") {
    selectByType("neutronstar", entry.n);
    scheduleUrlWrite();
    return;
  }
  if (entry.k === "c") {
    if (trySelectSystem(entry.n)) {
      scheduleUrlWrite();
    } else {
      // Group doesn't exist yet — member tiles haven't streamed.
      // Force-load a member tile; when rebuildSystems fires, the
      // onLabelsChanged callback retries the selection and writes the URL.
      pendingSystemSelect = { name: entry.n };
      const member = getSearchIndex().find((e) => e.sy === entry.n && e.t);
      if (member?.t && member.i !== undefined) {
        requestTileFocus(member.t, member.i, () => {});
      }
    }
    return;
  }
  if (entry.t !== undefined && entry.i !== undefined) {
    requestTileFocus(entry.t, entry.i, (mesh) => {
      clearAllSelections();
      selectTarget(mesh, updateDetailPanel, doUpdateLabelVisibility);
      rebaseForStar(mesh);
      scheduleUrlWrite();
    });
  }
}
setupSearch(handleSearchSelect, (entry) => {
  lookToward(new THREE.Vector3(entry.p[0], entry.p[1], entry.p[2]));
});

// Canvas label layer (see docs/canvas-labels-plan.md). Sole label path.
initLabelCanvas();

// Boot the catalog + starfield, then select Sol once notables are loaded.
await initStarfield();
await initConstellations();
await initDust();
await initNebulaeLabels();
await initBlackHoleLabels();
await initNeutronStarLabels();
registerScreenOccluder(getLensingOccluder);
onSelectionChanged(updateDetailPanel);

// Restore toggle state from URL (defaults: labels on, grid off, constellations on, nebulae on)
{
  const parsed = parseUrlState(window.location.search);
  const urlToggles = parsed.toggles;
  if (urlToggles?.labels !== undefined) labelsVisible = urlToggles.labels;
  if (urlToggles?.grid !== undefined) gridMesh.visible = urlToggles.grid;
  if (urlToggles?.constellations !== undefined) setConstellationsVisible(urlToggles.constellations);
  if (urlToggles?.nebulae !== undefined) setDustVisible(urlToggles.nebulae);
  if (parsed.mag !== undefined) {
    setMagLimit(parsed.mag);
    debug.mag_limit = parsed.mag;
  }
}
doUpdateLabelVisibility();

// Restore focus + orbit from URL query params (?focus=, ?r=, ?phi=, ?theta=).
// Also supports legacy ?name= param.
{
  const urlState = parseUrlState(window.location.search);
  const legacyName = new URLSearchParams(window.location.search).get("name");
  const focusName = urlState.focus ?? legacyName;

  if (focusName) {
    // Sub-group syntax: "Rigil Kentaurus,Toliman" → find the system
    // they belong to and select just those members.
    if (focusName.includes(",")) {
      const memberNames = focusName.split(",").map((s) => s.trim()).filter(Boolean);
      const firstMember = getSearchIndex().find((e) => e.n === memberNames[0]);
      const systemName = firstMember?.sy;
      if (systemName) {
        if (!trySelectSystem(systemName, memberNames)) {
          pendingSystemSelect = { name: systemName, subsetNames: memberNames };
          if (firstMember.t && firstMember.i !== undefined) {
            requestTileFocus(firstMember.t, firstMember.i, () => {});
          }
        }
        if (firstMember.p) setTargetImmediate(new THREE.Vector3(firstMember.p[0], firstMember.p[1], firstMember.p[2]));
      }
    } else if (trySelectSystem(focusName)) {
      // Exact system-name match (binary/trinary or cluster).
      scheduleUrlWrite();
    } else {
      const entry = getSearchIndex().find((e) => e.n === focusName || e.sy === focusName);
      if (entry) {
        handleSearchSelect(entry);
        setTargetImmediate(new THREE.Vector3(entry.p[0], entry.p[1], entry.p[2]));
      }
    }
  } else {
    const solAnchor = notableObjects.find((m) => (m.userData as Star).name === "Sol");
    if (solAnchor) {
      selectStar(solAnchor, updateDetailPanel, doUpdateLabelVisibility);
      rebaseForStar(solAnchor);
      setTargetImmediate(solAnchor.position);
    }
  }

  if (urlState.orbit) {
    const { radius, phi, theta } = urlState.orbit;
    // Set radius directly — deep zoom allows arbitrarily small values
    setOrbitRadius(radius);
    setOrbitPhi(THREE.MathUtils.clamp(phi, 0.1, Math.PI - 0.1));
    setOrbitTheta(theta);
    updateDeepZoom();
    updateCamera();
  }
  setLabelsDirty(true);
  // Ensure collision runs after any startup animation clears.
  setTimeout(() => setLabelsDirty(true), ANIM_DURATION + 100);
}

function currentFocusName(): string | undefined {
  const sys = getSelectedSystem();
  if (sys) {
    // When the user has refined down to a sub-group (e.g. Rigil+Toliman
    // within Alpha Centauri), serialize the member names comma-joined
    // so reload lands back on that specific subset instead of a
    // single lookup-winner member.
    const subset = getSelectedSubset();
    if (subset && subset.length < sys.meshes.length) {
      return subset.map((m) => (m.userData as Star).name).join(",");
    }
    return sys.name;
  }
  const mesh = getSelectedMesh();
  if (mesh) {
    const name = (mesh.userData as Star).name;
    if (name) return name;
  }
  const nebula = getSelectedNebulaName();
  if (nebula) return nebula;
  const bh = getSelectedBlackHoleName();
  if (bh) return bh;
  const ns = getSelectedNeutronStarName();
  return ns ?? undefined;
}

initUrlState({
  getState: () => ({
    orbit: { radius: orbitRadius, phi: orbitPhi, theta: orbitTheta },
    focus: currentFocusName(),
    toggles: {
      labels: labelsVisible,
      grid: gridMesh.visible,
      constellations: constellationsVisible(),
      nebulae: isDustVisible(),
    },
    mag: magLimitUniform.value,
  }),
});
enableUrlWrites();

// Debug mode: keyboard toggles for visual bug isolation. Gated on ?debug=1
// or ?bench=1 (bench piggy-backs on the stats panel).
if (debugEnabled) {
  initDebug();
  onDebugChange((key, value) => {
    switch (key) {
      case "bloom":
        bloomPass.enabled = value;
        break;
      case "hitTargets":
        setHitTargetsOverlay(value);
        break;
    }
  });
}

if (benchEnabled) runBench();

// Bench + debug need continuous frames for sampling / live stats graphs.
if (benchEnabled || debugEnabled) setAlwaysOn(true);

// Render loop
function animate(now: number) {
  statsBegin();
  tickAnimation(now);
  updateDeepZoom();
  updateTileTargets(getHoveredWorldPos());
  checkCameraMoved();
  statsPhase("updateStarfield", updateStarfield);
  statsPhase("updateDust", updateDust);
  statsPhase("updateAllLabels", updateAllLabels);
  finalizeLensingFrame();
  statsPhase("updateLabels", () => updateLabels(labelsVisible, notableObjects, tier1Meshes, systemGroups, meshToSystem));

  // Main scene pass (lensing pass is in the composer, auto-enabled by blackholes.ts).
  // Dust is ray-marched into its half-res RT first. When lensing is
  // active (BH selected), the lensing shader samples tDust at the bent
  // UV so the nebula warps with the scene. Otherwise it's blitted onto
  // the screen additively after the composer.
  statsPhase("sceneRender", () => {
    renderDustToRT(renderer);
    if (lensingPass.enabled) {
      const dustTex = getDustTexture();
      lensingPass.uniforms.tDust!.value = dustTex;
      lensingPass.uniforms.uDustActive!.value = dustTex ? 1 : 0;
    }
    beginBloomRender();
    composer.render();
    endBloomRender();
    if (!lensingPass.enabled) compositeDustToScreen(renderer);
    // Render NS markers after the composer so the lensing pass
    // never sees the body in tDiffuse and can't bend it into an
    // Einstein ring around itself.
    renderNeutronStars(renderer);
  });

  statsPhase("labelCanvas", renderLabelCanvas);
  if (debugEnabled) tickDebug();
  statsEnd();
}
startRenderLoop(animate);
