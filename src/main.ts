import * as THREE from "three";
import type { Star, SystemGroup } from "./types.ts";
import { CLICK_THRESHOLD, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS } from "./constants.ts";
import {
  scene, camera, renderer, labelRenderer, composer,
  gridHelper, handleResize, bloomPass,
  beginBloomRender, endBloomRender,
  updateCamera, applyOrbitDrag, onWheel, tickAnimation,
  orbitRadius, setOrbitRadius,
} from "./scene.ts";
import {
  registerLabelMap,
  highlightStar,
  hoverTarget, unhoverAll,
  selectTarget, selectSystem, selectStar,
  showSystemMembers, hideSystemMembers,
} from "./interaction.ts";
import {
  getSelectedSystem, getHoveredSystem, setHoveredSystem,
  setLabelsDirty,
} from "./systemStore.ts";
import { type SearchEntry, getSearchIndex } from "./catalog.ts";
import { updateDetailPanel } from "./detail.ts";
import { setupSearch } from "./search.ts";
import { updateLabels, checkCameraMoved } from "./labels.ts";
import { initConstellations, toggleConstellations } from "./constellations.ts";
import { initDust, updateDust, renderDustPostBloom, toggleDust, handleDustResize } from "./dust.ts";
import { initNebulaeLabels } from "./nebulaeLabels.ts";
import { setAllLabelsVisible, updateAllLabels, clearAllSelections, dispatchLabelClick, selectByType } from "./labelRegistry.ts";
import { initDebug, debugEnabled, debug, onDebugChange, tickDebug } from "./debug.ts";
import {
  initStarfield, updateStarfield,
  notableObjects, notableLabelMap, notableLabelMeshMap,
  allInteractiveStars, tier1Meshes,
  systemGroups, meshToSystem,
  setInitLabelDrag, onLabelsChanged,
  tier1LabelMeshFromDiv, tier1LabelDivFromMesh,
  streamedLabelMap,
  canonicalTarget,
  setStarMode, setPointDepthTest,
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
  if (info) makeCollapsible(info);
}

let labelsVisible = true;

// Input state
let isDragging = false;
let isZooming = false;
let prevMouse = { x: 0, y: 0 };
let dragDistance = 0;
let lastInputWasTouch = false;
let hoveredViaLabel = false;

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

function meshFromLabel(el: HTMLElement): THREE.Mesh | undefined {
  const label = el.closest("[data-star-label]") as HTMLElement | null;
  if (!label) return undefined;
  return notableLabelMeshMap.get(label) || tier1LabelMeshFromDiv(label);
}

function divFor(mesh: THREE.Mesh): HTMLElement | undefined {
  return notableLabelMap.get(mesh) || tier1LabelDivFromMesh(mesh);
}

function trySelectAt(clientX: number, clientY: number) {
  setMouseNDC(clientX, clientY);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(allInteractiveStars);
  if (hits.length > 0) {
    clearAllSelections();
    selectTarget(canonicalTarget(hits[0].object), meshToSystem, updateDetailPanel, doUpdateLabelVisibility);
  }
}

function doUpdateLabelVisibility() {
  if (!labelsVisible) {
    for (const anchor of notableObjects) anchor.visible = false;
    for (const obj of allInteractiveStars) obj.visible = false;
    for (const group of systemGroups) group.label.visible = false;
  }
  setAllLabelsVisible(labelsVisible);
  setLabelsDirty(true);
}

// Wire system label divs each time the system list is rebuilt.
const wiredSystems = new WeakSet<SystemGroup>();
function wireSystemLabels() {
  for (const group of systemGroups) {
    if (wiredSystems.has(group)) continue;
    wiredSystems.add(group);
    const labelDiv = group.label.element as HTMLElement;
    labelDiv.addEventListener("mouseenter", () => {
      if (isDragging || isZooming) return;
      if (getSelectedSystem() !== group) {
        setHoveredSystem(group);
        showSystemMembers(group);
      }
    });
    labelDiv.addEventListener("mouseleave", () => {
      if (isDragging || isZooming) return;
      if (getHoveredSystem() === group && getSelectedSystem() !== group) {
        hideSystemMembers(group);
        setHoveredSystem(null);
      }
    });
    labelDiv.addEventListener("mouseup", () => {
      if (dragDistance >= CLICK_THRESHOLD) return;
      clearAllSelections();
      selectSystem(group, updateDetailPanel);
    });
  }
}
onLabelsChanged(() => {
  wireSystemLabels();
  setLabelsDirty(true);
  if (pendingClusterSelect) {
    if (trySelectCluster(pendingClusterSelect)) pendingClusterSelect = null;
  }
});

// Mouse controls
renderer.domElement.addEventListener("mousedown", (e) => {
  if (e.altKey) { isZooming = true; } else { isDragging = true; }
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
  if (!isDragging && !isZooming) return;
  if (isDragging) {
    dragDistance += Math.abs(dx) + Math.abs(dy);
    applyOrbitDrag(dx, dy);
  } else {
    dragDistance += Math.abs(dx) + Math.abs(dy);
    setOrbitRadius(THREE.MathUtils.clamp(orbitRadius + dy * 0.1, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS));
    updateCamera();
  }
});

window.addEventListener("mouseup", (e) => {
  const wasClick = isDragging && dragDistance < CLICK_THRESHOLD;
  isDragging = false;
  isZooming = false;
  if (wasClick) trySelectAt(e.clientX, e.clientY);
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
      MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS,
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
}, { passive: false });

renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
labelRenderer.domElement.addEventListener("wheel", onWheel, { passive: false });

window.addEventListener("touchstart", () => { lastInputWasTouch = true; }, { capture: true });
window.addEventListener("mousemove", () => { lastInputWasTouch = false; }, { capture: true });

renderer.domElement.addEventListener("mousemove", (e) => {
  if (hoveredViaLabel || lastInputWasTouch || isDragging || isZooming) return;
  setMouseNDC(e.clientX, e.clientY);
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(allInteractiveStars);
  if (intersects.length > 0) {
    hoverTarget(canonicalTarget(intersects[0].object), meshToSystem);
  } else {
    unhoverAll();
  }
});

labelRenderer.domElement.addEventListener("mouseover", (e) => {
  if (lastInputWasTouch || isDragging || isZooming) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  hoveredViaLabel = true;
  hoverTarget(mesh, meshToSystem);
});

labelRenderer.domElement.addEventListener("mousemove", (e) => {
  if (!hoveredViaLabel || isDragging || isZooming) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  hoverTarget(mesh, meshToSystem);
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
    return;
  }
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (mesh) {
    clearAllSelections();
    selectTarget(mesh, meshToSystem, updateDetailPanel, doUpdateLabelVisibility);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "l") {
    labelsVisible = !labelsVisible;
    doUpdateLabelVisibility();
  } else if (e.key === "g") {
    gridHelper.visible = !gridHelper.visible;
  } else if (e.key === "c") {
    toggleConstellations();
  } else if (e.key === "d") {
    toggleDust();
    doUpdateLabelVisibility();
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
let pendingClusterSelect: string | null = null;

function trySelectCluster(name: string): boolean {
  const group = systemGroups.find((g) => g.name === name);
  if (!group) return false;
  selectSystem(group, updateDetailPanel);
  return true;
}

function handleSearchSelect(entry: SearchEntry) {
  pendingClusterSelect = null;
  animateTo(new THREE.Vector3(entry.p[0], entry.p[1], entry.p[2]));
  if (entry.k === "n") {
    selectByType("nebula", entry.n);
    updateDetailPanel();
    return;
  }
  if (entry.k === "c") {
    if (!trySelectCluster(entry.n)) {
      // Group doesn't exist yet — member tiles haven't streamed.
      // Force-load a member tile; when rebuildSystems fires, the
      // onLabelsChanged callback retries the selection.
      pendingClusterSelect = entry.n;
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
      selectTarget(mesh, meshToSystem, updateDetailPanel, doUpdateLabelVisibility);
    });
  }
}
setupSearch(handleSearchSelect);

// Boot the catalog + starfield, then select Sol once notables are loaded.
await initStarfield();
registerLabelMap(notableLabelMap);
registerLabelMap(streamedLabelMap);
wireSystemLabels();
await initConstellations();
await initDust();
await initNebulaeLabels();

const solAnchor = notableObjects.find((m) => (m.userData as Star).name === "Sol");
if (solAnchor) {
  highlightStar(solAnchor);
  selectStar(solAnchor, updateDetailPanel, doUpdateLabelVisibility);
}

// Debug mode: keyboard toggles for visual bug isolation. Gated on ?debug=1.
if (debugEnabled) {
  initDebug();
  onDebugChange((key, value) => {
    switch (key) {
      case "textureGlow":
        if (value) { debug.flatStars = false; setStarMode("texture"); }
        else { setStarMode("math"); }
        break;
      case "flatStars":
        if (value) { debug.textureGlow = false; setStarMode("flat"); }
        else { setStarMode("math"); }
        break;
      case "bloom":
        bloomPass.enabled = value;
        break;
      case "depthTest":
        setPointDepthTest(value);
        break;
    }
  });
}

// Render loop
function animate(now: number) {
  requestAnimationFrame(animate);
  tickAnimation(now);
  checkCameraMoved();
  updateStarfield();
  updateDust();
  updateAllLabels();
  updateLabels(labelsVisible, notableObjects, tier1Meshes, systemGroups, meshToSystem, divFor);
  if (debugEnabled && debug.directRender) {
    renderer.render(scene, camera);
  } else {
    beginBloomRender();
    composer.render();
    endBloomRender();
  }
  renderDustPostBloom(renderer);
  labelRenderer.render(scene, camera);
  if (debugEnabled) tickDebug();
}
animate(performance.now());
