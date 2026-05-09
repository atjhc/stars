import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { CLICK_THRESHOLD, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS, ANIM_DURATION, SOL_NAME } from "./constants.ts";
import {
  scene, camera, renderer, composer, lensingPass,
  gridMesh, handleResize, bloomPass,
  beginBloomRender, endBloomRender,
  updateCamera, applyOrbitDrag, applyRollDelta, lookToward, onWheel, tickAnimation,
  orbitRadius, getOrbitPhi, getOrbitTheta, getOrbitRoll, target,
  setOrbitRadius, setOrbitPhi, setOrbitTheta, setOrbitRoll, getEffectiveMinOrbit,
  setTargetImmediate, updateDeepZoom, animation,
  finalizeLensingFrame, getLensingOccluder,
  toggleAutoOrbit, stopAutoOrbit, isAutoOrbit,
} from "./scene.ts";
import {
  initUrlState, enableUrlWrites, scheduleUrlWrite, parseUrlState,
} from "./urlState.ts";
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

import { type SearchEntry, getSearchIndex, whenSearchIndexReady } from "./catalog.ts";
import { updateDetailPanel, onDetailStarClick } from "./detail.ts";
import { setupSearch } from "./search.ts";
import { updateLabels, checkCameraMoved } from "./labels.ts";
import { initConstellations, toggleConstellations, setConstellationsVisible, constellationsVisible } from "./constellations.ts";
import {
  initDust, updateDust, renderDustToRT, compositeDustToScreen, getDustTexture,
  getDustExtinctionTexture,
  toggleDust, setDustVisible, isDustVisible, handleDustResize,
} from "./dust.ts";
import { initNebulaeLabels } from "./nebulaeLabels.ts";
import {
  initSkybox, setSkyboxDustExtinction,
  toggleSkybox, setSkyboxVisible, isSkyboxVisible,
} from "./skybox.ts";
import { initSkyboxDebug } from "./skyboxDebug.ts";
import { initBlackHoleLabels } from "./blackholes.ts";
import { initNeutronStarLabels, renderNeutronStars } from "./neutronstars.ts";
import { initPlanetLabels, pickPlanetAt, toggleOrbits, setOrbitsVisible, getOrbitsVisible } from "./planets.ts";
import { setupLayersControl } from "./layersControl.ts";
import {
  setAllLabelsVisible, updateAllLabels, clearAllSelections, selectByType,
  registerScreenOccluder, clearFrameOccluders, onSelectionChanged, clearHoverExcept, getHandlerSelectedName,
  getHandlerByType, handlerTypeForSearchKind,
} from "./labelRegistry.ts";
import { initDebug, debugEnabled, benchEnabled, gpuTimerEnabled, debug, onDebugChange, tickDebug, statsBegin, statsEnd, statsPhase, refreshDebugPanel } from "./debug.ts";
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
import { focusTarget } from "./systemDispatch.ts";
import { startRenderLoop, bumpInput, setAlwaysOn } from "./renderLoop.ts";
import { initGpuTimer, gpuPhase, drainGpuQueries, wrapComposerPasses } from "./gpuTimer.ts";

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
// Screen-center "trackball" angle for the most recent in-mode roll
// event. Roll mode is shift+drag (with click) or shift+option (no
// click); each mousemove computes the angle from the screen center
// to the cursor and applies the delta from the previous angle as
// roll. Reset to null whenever roll mode is not active so the next
// entry starts fresh.
let lastRollAngle: number | null = null;
function rollAngleFromCenter(e: MouseEvent): number {
  return Math.atan2(e.clientY - window.innerHeight / 2, e.clientX - window.innerWidth / 2);
}
function applyMouseRoll(e: MouseEvent): void {
  const angle = rollAngleFromCenter(e);
  if (lastRollAngle === null) {
    lastRollAngle = angle;
    return;
  }
  let delta = angle - lastRollAngle;
  // Wrap into (-π, π] so crossing the atan2 discontinuity (e.g. left
  // of center, mouse straddling -π/+π) gives a small delta, not 2π.
  if (delta > Math.PI) delta -= 2 * Math.PI;
  else if (delta < -Math.PI) delta += 2 * Math.PI;
  applyRollDelta(delta);
  lastRollAngle = angle;
}

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
  // Planet/moon disc pick. Same screen-space approach as stars; the
  // planet handler maintains a per-frame list of {x, y, hitRadius}
  // entries during update() and pickPlanetAt walks them.
  const planetName = pickPlanetAt(clientX, clientY);
  if (planetName) {
    clearAllSelections();
    selectByType("planet", planetName);
    return;
  }
  // Missed all discs — try label rects (tier-1 text clicks, systems,
  // nebulae, BHs).
  dispatchCanvasLabelClick(clientX, clientY);
}

function dispatchCanvasLabelClick(x: number, y: number): boolean {
  const id = pickLabelAt(x, y);
  if (!id || !isCanvasLabelInteractive(id)) return false;
  const label = getCanvasLabel(id);
  if (!label) return false;

  if (label.kind === "star") {
    const mesh = label.payload as THREE.Object3D | undefined;
    if (!mesh) return false;
    clearAllSelections();
    selectTarget(mesh, updateDetailPanel, doUpdateLabelVisibility);
    rebaseForStar(mesh);
    return true;
  }
  if (label.kind === "system") {
    const group = label.payload as SystemGroup | undefined;
    if (!group) return false;
    clearAllSelections();
    selectSystem(group, updateDetailPanel);
    return true;
  }
  // Registry-managed types (nebula, BH, NS, and any future type)
  const name = (label.payload as { name?: string } | undefined)?.name;
  if (name) return selectByType(label.kind, name);
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
  // Roll mode: shift held while in any active manipulation gesture
  // (drag with click, or option without click). Single source of
  // truth — clears lastRollAngle whenever roll isn't active.
  const inAltMove = e.altKey && !isDragging;
  const wantRoll = e.shiftKey && (inAltMove || isDragging);
  if (!wantRoll) lastRollAngle = null;

  if (inAltMove) {
    if (!isAltOrbit) { unhoverAll(); clearHoverExcept(null); }
    isAltOrbit = true;
    stopAutoOrbit();
    if (wantRoll) applyMouseRoll(e);
    else applyOrbitDrag(dx, dy);
    scheduleUrlWrite();
    return;
  }
  isAltOrbit = false;
  if (!isDragging) return;
  dragDistance += Math.abs(dx) + Math.abs(dy);
  if (wantRoll) applyMouseRoll(e);
  else applyOrbitDrag(dx, dy);
  scheduleUrlWrite();
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
  // Planet/moon disc hover — glow the body and label like clicking
  // the label would. Routed through the registry so cross-type hover
  // (e.g. star + planet) clears appropriately.
  const planetName = pickPlanetAt(e.clientX, e.clientY);
  if (planetName) {
    clearHoverExcept("planet");
    const handler = getHandlerByType("planet");
    handler?.setHoverByName(planetName);
    return;
  }
  // Missed all discs — canvas label hover (text rect pick, plus
  // system / nebula / BH dispatch).
  if (dispatchCanvasLabelHover(e.clientX, e.clientY)) return;
  unhoverAll();
});

function isTargetClusterLabelInteractive(cluster: SystemGroup): boolean {
  return isCanvasLabelInteractive(`system:${cluster.name}`);
}

// Canvas-only hover dispatch. Returns true when a canvas label was hit
// and hover state was updated so the caller skips the unhoverAll
// fallback. Uses the label registry to clear cross-type hover state
// automatically.
function dispatchCanvasLabelHover(x: number, y: number): boolean {
  const id = pickLabelAt(x, y);
  const label = id && isCanvasLabelInteractive(id) ? getCanvasLabel(id) : null;

  // Clear handler-managed hover for any type we're not entering.
  clearHoverExcept(label?.kind ?? null);

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
  // Registry-managed types (nebula, BH, NS, and any future type):
  // clearHoverExcept already cleared other types; now set hover on this one.
  const name = (label.payload as { name?: string } | undefined)?.name;
  if (name) {
    unhoverAll();
    const handler = getHandlerByType(label.kind);
    if (handler) handler.setHoverByName(name);
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
  } else if (e.key === "r") {
    toggleOrbits();
    scheduleUrlWrite();
  } else if (e.key === "s") {
    toggleSkybox();
    scheduleUrlWrite();
  } else if (e.key === "f") {
    const name = getSelectedSystem()?.name ?? (getSelectedMesh()?.userData as Star | undefined)?.name ?? getHandlerSelectedName();
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

function handleSearchSelect(entry: SearchEntry): Promise<void> {
  pendingSystemSelect = null;
  // Constellations span the sky — no meaningful point to fly to.
  if (entry.k !== "x") {
    animateTo(new THREE.Vector3(entry.p[0], entry.p[1], entry.p[2]));
  }
  // Registry-managed types: nebula, BH, NS, constellation (and any future kind)
  const handlerType = entry.k ? handlerTypeForSearchKind(entry.k) : undefined;
  if (handlerType) {
    selectByType(handlerType, entry.n);
    scheduleUrlWrite();
    return Promise.resolve();
  }
  if (entry.k === "c" || entry.k === "s") {
    if (trySelectSystem(entry.n)) {
      scheduleUrlWrite();
      return Promise.resolve();
    }
    // Group doesn't exist yet — member tiles haven't streamed.
    // Force-load a member tile; when rebuildSystems fires, the
    // onLabelsChanged callback retries the selection and writes the URL.
    pendingSystemSelect = { name: entry.n };
    const member = getSearchIndex().find((e) => e.sy === entry.n && e.t);
    if (member?.t && member.i !== undefined) {
      return new Promise<void>((resolve) => {
        requestTileFocus(member.t!, member.i!, () => resolve());
      });
    }
    return Promise.resolve();
  }
  if (entry.t !== undefined && entry.i !== undefined) {
    const tile = entry.t;
    const i = entry.i;
    return new Promise<void>((resolve) => {
      requestTileFocus(tile, i, (mesh) => {
        clearAllSelections();
        selectTarget(mesh, updateDetailPanel, doUpdateLabelVisibility);
        rebaseForStar(mesh);
        scheduleUrlWrite();
        resolve();
      });
    });
  }
  return Promise.resolve();
}
setupSearch(handleSearchSelect, (entry) => {
  lookToward(new THREE.Vector3(entry.p[0], entry.p[1], entry.p[2]));
});

// Canvas label layer (see docs/canvas-labels-plan.md). Sole label path.
initLabelCanvas();

// Dust is the only big asset (~22 MB gzip); stream it in alongside its
// labels so the render loop can paint stars while it loads.
await initStarfield();
await initConstellations();
await initBlackHoleLabels();
await initNeutronStarLabels();
await initPlanetLabels();
const dustInit = initDust();
const nebulaeInit = initNebulaeLabels();
const skyboxInit = initSkybox();
dustInit.catch((e) => console.error("initDust failed:", e));
nebulaeInit.catch((e) => console.error("initNebulaeLabels failed:", e));
skyboxInit.catch((e) => console.error("initSkybox failed:", e));
// Hand the dust half-res RT to the skybox once both are ready, so the
// skybox can sample integrated optical depth from its alpha channel
// for backdrop extinction. The RT is cleared each frame regardless of
// dust visibility, so this stays valid even when nebulae are toggled off.
Promise.all([dustInit, skyboxInit]).then(() => {
  setSkyboxDustExtinction(getDustExtinctionTexture());
}).catch(() => {});
initSkyboxDebug();
registerScreenOccluder(getLensingOccluder);
onSelectionChanged(updateDetailPanel);

// Clicking a star name inside the detail panel (e.g. constellation members)
// looks it up in the search index and selects it.
onDetailStarClick((name) => {
  const entry = getSearchIndex().find((e) => !e.k && e.n === name);
  if (entry) handleSearchSelect(entry);
});

// Restore toggle state from URL (defaults: labels on, grid off, constellations on, nebulae on)
{
  const parsed = parseUrlState(window.location.search);
  const urlToggles = parsed.toggles;
  if (urlToggles?.labels !== undefined) labelsVisible = urlToggles.labels;
  if (urlToggles?.grid !== undefined) gridMesh.visible = urlToggles.grid;
  if (urlToggles?.constellations !== undefined) setConstellationsVisible(urlToggles.constellations);
  if (urlToggles?.nebulae !== undefined) setDustVisible(urlToggles.nebulae);
  if (urlToggles?.orbits !== undefined) setOrbitsVisible(urlToggles.orbits);
  if (urlToggles?.skybox !== undefined) setSkyboxVisible(urlToggles.skybox);
  if (parsed.mag !== undefined) {
    setMagLimit(parsed.mag);
    debug.mag_limit = parsed.mag;
  }
}
doUpdateLabelVisibility();

setupLayersControl([
  { id: "labels", isOn: () => labelsVisible, toggle: () => { labelsVisible = !labelsVisible; doUpdateLabelVisibility(); } },
  { id: "grid", isOn: () => gridMesh.visible, toggle: () => { gridMesh.visible = !gridMesh.visible; } },
  { id: "constellations", isOn: constellationsVisible, toggle: toggleConstellations },
  { id: "nebulae", isOn: isDustVisible, toggle: () => { toggleDust(); doUpdateLabelVisibility(); } },
  { id: "orbits", isOn: getOrbitsVisible, toggle: toggleOrbits },
  { id: "skybox", isOn: isSkyboxVisible, toggle: toggleSkybox },
], scheduleUrlWrite);

// Restore focus + orbit from URL query params (?focus=, ?r=, ?phi=, ?theta=).
// Also supports legacy ?name= param.
{
  const urlState = parseUrlState(window.location.search);
  const legacyName = new URLSearchParams(window.location.search).get("name");
  const focusName = urlState.focus ?? legacyName;

  if (focusName) {
    // Names of dim tier-1 stars only resolve through the search index;
    // wait for it before attempting lookup.
    await whenSearchIndexReady();
    // Sub-group syntax: "Rigil Kentaurus,Toliman" → find the system
    // they belong to and select just those members.
    if (focusName.includes(",")) {
      const memberNames = focusName.split(",").map((s) => s.trim()).filter(Boolean);
      const firstMember = getSearchIndex().find((e) => e.n === memberNames[0]);
      const systemName = firstMember?.sy;
      if (systemName) {
        let memberTileReady: Promise<void> = Promise.resolve();
        if (!trySelectSystem(systemName, memberNames)) {
          pendingSystemSelect = { name: systemName, subsetNames: memberNames };
          if (firstMember.t && firstMember.i !== undefined) {
            // Await member tile so the system's stars are visible
            // on the very first painted frame, not after streaming.
            memberTileReady = new Promise<void>((resolve) => {
              requestTileFocus(firstMember.t!, firstMember.i!, () => resolve());
            });
          }
        }
        // setTargetImmediate cancels any animation queued by
        // trySelectSystem; wanted hard cut on URL restore.
        if (firstMember.p) setTargetImmediate(new THREE.Vector3(firstMember.p[0], firstMember.p[1], firstMember.p[2]));
        await memberTileReady;
      }
    } else if (trySelectSystem(focusName)) {
      // Exact system-name match (binary/trinary or cluster).
      // Hard-cut to the system so the first painted frame shows the
      // restored selection at rest, not mid-flyby from origin.
      const sys = getSelectedSystem();
      if (sys) setTargetImmediate(focusTarget(sys, camera.position));
      scheduleUrlWrite();
    } else {
      // Name-exact match wins over a system-membership match — otherwise
      // ?focus=Gaia%20BH1 (the black hole) resolves to "Gaia BH1 A"
      // (its companion star, whose `sy` is "Gaia BH1") whenever the
      // companion's index entry comes first in names.json.
      const entry = getSearchIndex().find((e) => e.n === focusName)
        ?? getSearchIndex().find((e) => e.sy === focusName);
      if (entry) {
        const focusReady = handleSearchSelect(entry);
        // setTargetImmediate cancels the animateTo that handleSearchSelect
        // queued; URL restore wants a hard cut, not a flyby on page load.
        setTargetImmediate(new THREE.Vector3(entry.p[0], entry.p[1], entry.p[2]));
        await focusReady;
      }
    }
  } else {
    const solAnchor = notableObjects.find((m) => (m.userData as Star).name === SOL_NAME);
    if (solAnchor) {
      selectStar(solAnchor, updateDetailPanel, doUpdateLabelVisibility);
      rebaseForStar(solAnchor);
      setTargetImmediate(solAnchor.position);
    }
  }

  if (urlState.orbit) {
    const { radius, phi, theta, roll } = urlState.orbit;
    // Set radius directly — deep zoom allows arbitrarily small values
    setOrbitRadius(radius);
    setOrbitPhi(THREE.MathUtils.clamp(phi, 0.1, Math.PI - 0.1));
    setOrbitTheta(theta);
    if (roll !== undefined) setOrbitRoll(roll);
    updateDeepZoom();
    updateCamera();
  }
  setLabelsDirty(true);
  // Ensure collision runs after any startup animation clears.
  setTimeout(() => setLabelsDirty(true), ANIM_DURATION + 100);
}

// Re-push label visibility once the nebula handler registers.
nebulaeInit.then(() => doUpdateLabelVisibility()).catch(() => {});

function currentFocusName(): string | undefined {
  // Star systems and individual stars are managed outside the handler
  // registry (through interaction.ts / systemStore.ts), so check first.
  const sys = getSelectedSystem();
  if (sys) {
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
  // Registry-managed types (nebula, BH, NS, etc.)
  return getHandlerSelectedName() ?? undefined;
}

initUrlState({
  getState: () => ({
    orbit: { radius: orbitRadius, phi: getOrbitPhi(), theta: getOrbitTheta(), roll: getOrbitRoll() },
    focus: currentFocusName(),
    toggles: {
      labels: labelsVisible,
      grid: gridMesh.visible,
      constellations: constellationsVisible(),
      nebulae: isDustVisible(),
      orbits: getOrbitsVisible(),
      skybox: isSkyboxVisible(),
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

// Gate GPU timer queries on `?bench=1` or `?gputimer=1` only. iOS 16+
// Safari exposes `EXT_disjoint_timer_query_webgl2`, but each begin/end
// query forces a pipeline flush on Apple's TBDR GPU — and we wrap 7
// phases per frame. Always-on cost the user as ~10+ ms/frame, the
// difference between 30 fps and 20 fps on iPhone 15. Off in production;
// off in plain `?debug=1` (so the FPS overlay reads true frame cost);
// on only when explicitly measuring.
if (gpuTimerEnabled) {
  initGpuTimer(renderer);
  wrapComposerPasses(composer, "gpu.composer");
}
if (benchEnabled) runBench();

// Bench + debug need continuous frames for sampling / live stats graphs.
if (benchEnabled || debugEnabled) setAlwaysOn(true);

// Diagnostic: Bun's dev server forwards `window.onerror` events as
// "Script error." when the offending script is CORS-tainted (the HMR
// client chunk hits this on some Bun versions). Catching the error
// inside our own callbacks bypasses the event boundary and lets us
// log the actual stack via console.error, which the relay forwards
// verbatim. Same for unhandledrejection — Promise reasons aren't
// subject to CORS sanitization either.
window.addEventListener("unhandledrejection", (e) => {
  console.error("unhandledrejection:", e.reason);
});

// Render loop
function animate(now: number) {
  try {
    animateInner(now);
  } catch (e) {
    console.error("animate threw:", e);
    throw e;
  }
}
function animateInner(now: number) {
  statsBegin();
  tickAnimation(now);
  updateDeepZoom();
  updateTileTargets(getHoveredWorldPos());
  checkCameraMoved();
  statsPhase("updateStarfield", updateStarfield);
  statsPhase("updateDust", updateDust);
  // Cleared once before any pusher runs; planets push during
  // updateAllLabels, stars push during updateLabels.
  clearFrameOccluders();
  statsPhase("updateAllLabels", updateAllLabels);
  finalizeLensingFrame();
  statsPhase("updateLabels", () => updateLabels(labelsVisible, notableObjects, tier1Meshes, systemGroups, meshToSystem));

  // Main scene pass (lensing pass is in the composer, auto-enabled by blackholes.ts).
  // Dust is ray-marched into its half-res RT first. When lensing is
  // active (BH selected), the lensing shader samples tDust at the bent
  // UV so the nebula warps with the scene. Otherwise it's blitted onto
  // the screen additively after the composer.
  statsPhase("sceneRender", () => {
    drainGpuQueries();
    gpuPhase("gpu.dustRT", () => renderDustToRT(renderer));
    if (lensingPass.enabled) {
      const dustTex = getDustTexture();
      lensingPass.uniforms.tDust!.value = dustTex;
      lensingPass.uniforms.uDustActive!.value = dustTex ? 1 : 0;
    }
    beginBloomRender();
    composer.render();
    endBloomRender();
    if (!lensingPass.enabled) gpuPhase("gpu.dustComposite", () => compositeDustToScreen(renderer));
    // Render NS markers after the composer so the lensing pass
    // never sees the body in tDiffuse and can't bend it into an
    // Einstein ring around itself.
    gpuPhase("gpu.neutronStars", () => renderNeutronStars(renderer));
  });

  statsPhase("labelCanvas", renderLabelCanvas);
  if (debugEnabled) tickDebug();
  statsEnd();
}
startRenderLoop(animate);
