import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { CLICK_THRESHOLD, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS } from "./constants.ts";
import {
  scene, camera, labelCamera, renderer, labelRenderer, composer,
  gridHelper, handleResize, bloomPass,
  beginBloomRender, endBloomRender,
  updateCamera, applyOrbitDrag, lookToward, onWheel, tickAnimation,
  orbitRadius, orbitPhi, orbitTheta, target,
  setOrbitRadius, setOrbitPhi, setOrbitTheta, getEffectiveMinOrbit,
  setTargetImmediate, updateDeepZoom, effectiveCamDist, animation,
} from "./scene.ts";
import {
  initUrlState, enableUrlWrites, scheduleUrlWrite, parseUrlState,
} from "./urlState.ts";
import { getSelectedNebulaName } from "./nebulaeLabels.ts";
import { computeStarScreenMetrics, setOverlayActive, setOverlayUniforms } from "./stars.ts";
import { starRadiusScene, bvToColor } from "./color.ts";
import {
  registerLabelMap,
  hoverTarget, unhoverAll,
  selectTarget, selectSystem, selectStar,
  showSystemMembers, hideSystemMembers,
} from "./interaction.ts";
import {
  getSelectedSystem, getHoveredSystem, setHoveredSystem,
  getSelectedMesh, getSelectedSubset, setLabelsDirty,
} from "./systemStore.ts";
import { toggleFavorite } from "./favorites.ts";
import { isLabelInteractive, resetCollisionFadeState } from "./labelCollision.ts";

import { type SearchEntry, getSearchIndex } from "./catalog.ts";
import { updateDetailPanel } from "./detail.ts";
import { setupSearch } from "./search.ts";
import { updateLabels, flushLabelCollisions, checkCameraMoved } from "./labels.ts";
import { initConstellations, toggleConstellations, setConstellationsVisible, constellationsVisible } from "./constellations.ts";
import { initDust, updateDust, renderDustPostBloom, toggleDust, setDustVisible, isDustVisible, handleDustResize } from "./dust.ts";
import { initNebulaeLabels } from "./nebulaeLabels.ts";
import { initBlackHoleLabels, getSelectedBlackHoleName } from "./blackholes.ts";
import { setAllLabelsVisible, updateAllLabels, clearAllSelections, dispatchLabelClick, selectByType } from "./labelRegistry.ts";
import { initDebug, debugEnabled, benchEnabled, debug, onDebugChange, tickDebug, statsBegin, statsEnd } from "./debug.ts";
import { runBench } from "./bench.ts";
import {
  initStarfield, updateStarfield,
  notableObjects, notableLabelMap, notableLabelMeshMap,
  allInteractiveStars, tier1Meshes,
  systemGroups, meshToSystem, clusterOf,
  setInitLabelDrag, onLabelsChanged,
  tier1LabelMeshFromDiv, tier1LabelDivFromMesh,
  streamedLabelMap,
  requestTileFocus,
} from "./starfield.ts";
import { animateTo } from "./scene.ts";

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

// Input state
let isDragging = false;
let prevMouse = { x: 0, y: 0 };
let dragDistance = 0;
let lastInputWasTouch = false;
let hoveredViaLabel = false;
let isAltOrbit = false;

function initLabelDrag(div: HTMLElement) {
  div.setAttribute("data-star-label", "");
  div.addEventListener("mousedown", (e) => {
    e.preventDefault();
    isDragging = true;
    prevMouse.x = e.clientX;
    prevMouse.y = e.clientY;
    dragDistance = 0;
    hoveredViaLabel = false;
  });
}
setInitLabelDrag(initLabelDrag);

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function setMouseNDC(clientX: number, clientY: number) {
  mouse.x = (clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(clientY / window.innerHeight) * 2 + 1;
}

function meshFromLabel(el: HTMLElement): THREE.Object3D | undefined {
  const label = el.closest("[data-star-label]") as HTMLElement | null;
  if (!label) return undefined;
  return notableLabelMeshMap.get(label) || tier1LabelMeshFromDiv(label);
}

function divFor(mesh: THREE.Object3D): HTMLElement | undefined {
  return notableLabelMap.get(mesh) || tier1LabelDivFromMesh(mesh);
}

function trySelectAt(clientX: number, clientY: number) {
  setMouseNDC(clientX, clientY);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(allInteractiveStars);
  for (const h of hits) {
    const t = h.object;
    const d = divFor(t);
    if (!d || !isLabelInteractive(d)) continue;
    clearAllSelections();
    selectTarget(t, updateDetailPanel, doUpdateLabelVisibility);
    return;
  }
}

function doUpdateLabelVisibility() {
  if (!labelsVisible) {
    // Hide only the CSS2DObject children — the billboard meshes stay
    // rendered so the star's disc/glow remains visible. Toggling
    // anchor.visible or mesh.visible would also hide the billboard's
    // raycast and its rendering, which isn't what "hide labels" means.
    for (const anchor of notableObjects) hideCss2dChild(anchor);
    for (const obj of allInteractiveStars) hideCss2dChild(obj);
    for (const group of systemGroups) {
      group.label.visible = false;
      (group.label.element as HTMLElement).style.opacity = "0";
    }
    // Clear collision fade state so labels coming back don't replay a
    // stale fade-out animation from their pre-hide opacity.
    resetCollisionFadeState();
  }
  setAllLabelsVisible(labelsVisible);
  setLabelsDirty(true);
}

function hideCss2dChild(parent: THREE.Object3D) {
  for (const c of parent.children) {
    if ((c as THREE.Object3D & { isCSS2DObject?: boolean }).isCSS2DObject) {
      c.visible = false;
      const el = (c as unknown as { element?: HTMLElement }).element;
      if (el) el.style.opacity = "0";
    }
  }
}

// Wire system label divs each time the system list is rebuilt.
const wiredSystems = new WeakSet<SystemGroup>();
function wireSystemLabels() {
  for (const group of systemGroups) {
    if (wiredSystems.has(group)) continue;
    wiredSystems.add(group);
    const labelDiv = group.label.element as HTMLElement;
    labelDiv.addEventListener("mouseenter", () => {
      if (isDragging || isAltOrbit) return;
      if (!isLabelInteractive(labelDiv)) return;
      if (getSelectedSystem() !== group) {
        setHoveredSystem(group);
        showSystemMembers(group);
      }
    });
    labelDiv.addEventListener("mouseleave", () => {
      if (isDragging || isAltOrbit) return;
      if (getHoveredSystem() === group && getSelectedSystem() !== group) {
        hideSystemMembers(group);
        setHoveredSystem(null);
      }
    });
    labelDiv.addEventListener("mouseup", () => {
      if (dragDistance >= CLICK_THRESHOLD) return;
      if (!isLabelInteractive(labelDiv)) return;
      clearAllSelections();
      selectSystem(group, updateDetailPanel);
      scheduleUrlWrite();
    });
  }
}
onLabelsChanged(() => {
  wireSystemLabels();
  setLabelsDirty(true);
  // New labels need one CSS2DRenderer pass before collision rects are valid.
  // Schedule a second dirty so they get re-evaluated after positioning.
  requestAnimationFrame(() => setLabelsDirty(true));
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
  hoveredViaLabel = false;
  unhoverAll();
});

window.addEventListener("mousemove", (e) => {
  const dx = e.clientX - prevMouse.x;
  const dy = e.clientY - prevMouse.y;
  prevMouse.x = e.clientX;
  prevMouse.y = e.clientY;
  if (e.altKey && !isDragging) {
    isAltOrbit = true;
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
});

// Touch controls
let touchStartDist = 0;
let touchStartRadius = 0;

renderer.domElement.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    isDragging = true;
    prevMouse.x = e.touches[0].clientX;
    prevMouse.y = e.touches[0].clientY;
    dragDistance = 0;
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
}, { passive: false });

function onWheelWithUrl(e: WheelEvent) {
  onWheel(e);
  scheduleUrlWrite();
}
renderer.domElement.addEventListener("wheel", onWheelWithUrl, { passive: false });
labelRenderer.domElement.addEventListener("wheel", onWheelWithUrl, { passive: false });

window.addEventListener("touchstart", () => { lastInputWasTouch = true; }, { capture: true });
window.addEventListener("mousemove", () => { lastInputWasTouch = false; }, { capture: true });

renderer.domElement.addEventListener("mousemove", (e) => {
  if (hoveredViaLabel || lastInputWasTouch || isDragging || e.altKey) return;
  setMouseNDC(e.clientX, e.clientY);
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(allInteractiveStars);
  let hoverMesh: THREE.Object3D | undefined;
  for (const h of intersects) {
    const t = h.object;
    // Check the star's own label
    const d = divFor(t);
    if (!d || !isLabelInteractive(d)) continue;
    // If the star belongs to a cluster, check the cluster label too
    const cluster = clusterOf.get(t);
    if (cluster && !isLabelInteractive(cluster.label.element as HTMLElement)) continue;
    hoverMesh = t;
    break;
  }
  if (hoverMesh) {
    hoverTarget(hoverMesh, meshToSystem, clusterOf);
  } else {
    unhoverAll();
  }
});

labelRenderer.domElement.addEventListener("mouseover", (e) => {
  if (lastInputWasTouch || isDragging || isAltOrbit) return;
  const label = (e.target as HTMLElement).closest("[data-star-label], [data-system-label], [data-label-type]") as HTMLElement | null;
  if (label && !isLabelInteractive(label)) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  hoveredViaLabel = true;
  hoverTarget(mesh, meshToSystem, clusterOf);
});

labelRenderer.domElement.addEventListener("mousemove", (e) => {
  if (!hoveredViaLabel || isDragging || isAltOrbit) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  hoverTarget(mesh, meshToSystem, clusterOf);
});

labelRenderer.domElement.addEventListener("mouseout", (e) => {
  const label = (e.target as HTMLElement).closest("[data-star-label]") as HTMLElement | null;
  if (!label) return;
  const related = (e as MouseEvent).relatedTarget as HTMLElement | null;
  if (related && label.contains(related)) return;
  hoveredViaLabel = false;
  unhoverAll();
});

labelRenderer.domElement.addEventListener("mouseup", (e) => {
  if (dragDistance >= CLICK_THRESHOLD) return;
  // Registry handles nebulae (and any future label types)
  if (dispatchLabelClick(e.target as HTMLElement)) {
    updateDetailPanel();
    scheduleUrlWrite();
    return;
  }
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (mesh) {
    clearAllSelections();
    selectTarget(mesh, updateDetailPanel, doUpdateLabelVisibility);
    scheduleUrlWrite();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "l") {
    labelsVisible = !labelsVisible;
    doUpdateLabelVisibility();
    scheduleUrlWrite();
  } else if (e.key === "g") {
    gridHelper.visible = !gridHelper.visible;
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
  }
});

window.addEventListener("resize", () => {
  handleResize();
  handleDustResize();
  setLabelsDirty(true);
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
    updateDetailPanel();
    scheduleUrlWrite();
    return;
  }
  if (entry.k === "b") {
    clearAllSelections();
    selectByType("blackhole", entry.n);
    updateDetailPanel();
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
      scheduleUrlWrite();
    });
  }
}
setupSearch(handleSearchSelect, (entry) => {
  lookToward(new THREE.Vector3(entry.p[0], entry.p[1], entry.p[2]));
});

// Boot the catalog + starfield, then select Sol once notables are loaded.
await initStarfield();
registerLabelMap(notableLabelMap);
registerLabelMap(streamedLabelMap);
wireSystemLabels();
await initConstellations();
await initDust();
await initNebulaeLabels();
await initBlackHoleLabels();

// Restore toggle state from URL (defaults: labels on, grid off, constellations on, nebulae on)
{
  const urlToggles = parseUrlState(window.location.search).toggles;
  if (urlToggles?.labels !== undefined) labelsVisible = urlToggles.labels;
  if (urlToggles?.grid !== undefined) gridHelper.visible = urlToggles.grid;
  if (urlToggles?.constellations !== undefined) setConstellationsVisible(urlToggles.constellations);
  if (urlToggles?.nebulae !== undefined) setDustVisible(urlToggles.nebulae);
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
  // Ensure collision runs after any startup animation clears (ANIM_DURATION = 600ms)
  setTimeout(() => setLabelsDirty(true), 700);
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
  return bh ?? undefined;
}

initUrlState({
  getState: () => ({
    orbit: { radius: orbitRadius, phi: orbitPhi, theta: orbitTheta },
    focus: currentFocusName(),
    toggles: {
      labels: labelsVisible,
      grid: gridHelper.visible,
      constellations: constellationsVisible(),
      nebulae: isDustVisible(),
    },
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
    }
  });
}

if (benchEnabled) runBench();

// Per-selection cache: radius and color are constant per star, so only
// recompute them when the selection changes — not every frame.
let lastSelected: THREE.Object3D | null = null;
let cachedRadius = 0;
const cachedColor = new THREE.Color();

function updateStarDeepZoom() {
  const selected = getSelectedMesh();
  if (lastSelected !== selected) {
    lastSelected = selected;
    const selStar = selected?.userData as Star | undefined;
    if (selStar) {
      cachedRadius = starRadiusScene(selStar.lum, selStar.ci);
      cachedColor.copy(bvToColor(selStar.ci));
    }
  }

  const star = selected?.userData as Star | undefined;
  // The overlay always renders at screen center (view-space origin),
  // which only matches the selected star's on-screen position when
  // `target` equals the star's world position. Mid-animation, target is
  // lerping — the overlay would draw a ghost disc at the moving
  // midpoint. Disable it during transit and let the instanced shader
  // render the destination star at its real angular position, growing
  // smoothly as the camera closes in. When the animation ends (target
  // snaps to star.position), the overlay takes over for the crisp
  // close-up render and uSkipSelected hides the instanced duplicate.
  if (!selected || !star || animation) {
    setOverlayActive(false);
    return;
  }
  const { discPx, halfBillPx, intensity } = computeStarScreenMetrics(
    cachedRadius,
    star.absmag ?? 10,
    effectiveCamDist(selected.position),
  );
  setOverlayUniforms(discPx, halfBillPx, cachedColor, intensity);
  setOverlayActive(true);
}

// Render loop
function animate(now: number) {
  requestAnimationFrame(animate);
  statsBegin();
  tickAnimation(now);
  updateDeepZoom();
  updateStarDeepZoom();
  checkCameraMoved();
  updateStarfield();
  updateDust();
  updateAllLabels();
  updateLabels(labelsVisible, notableObjects, tier1Meshes, systemGroups, meshToSystem, divFor);

  // Main scene pass (lensing pass is in the composer, auto-enabled by blackholes.ts)
  if (debugEnabled && debug.directRender) {
    renderer.render(scene, camera);
  } else {
    beginBloomRender();
    composer.render();
    endBloomRender();
  }
  renderDustPostBloom(renderer);

  labelRenderer.render(scene, labelCamera);
  // Collision resolution reads DOM rects — must run AFTER
  // labelRenderer positions the divs for this frame.
  flushLabelCollisions();
  if (debugEnabled) tickDebug();
  statsEnd();
}
// Position labels in the DOM before the first frame so collision rects are valid
labelRenderer.render(scene, labelCamera);
animate(performance.now());
