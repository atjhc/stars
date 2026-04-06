import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Star, SystemGroup } from "./types.ts";
import {
  SCALE, CLICK_THRESHOLD, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS,
  LABEL_CSS,
} from "./constants.ts";
import { createBillboardMesh, createStarLabel } from "./billboard.ts";
import {
  scene, camera, renderer, labelRenderer, composer,
  gridHelper, target, handleResize,
  updateCamera, animateTo, tickAnimation, applyOrbitDrag, onWheel,
  orbitRadius, setOrbitRadius,
} from "./scene.ts";
import {
  selectedMesh, selectedSystem, hoveredSystem, lastHoveredMesh,
  labelsDirty, setLabelsDirty,
  registerLabelMap,
  highlightStar, unhighlightStar,
  showHover, hideHover, hoverTarget, unhoverAll,
  selectTarget, selectSystem, selectStar,
  showSystemMembers, hideSystemMembers,
} from "./interaction.ts";
import { updateDetailPanel } from "./detail.ts";
import { setupSearch } from "./search.ts";
import { updateLabels, checkCameraMoved } from "./labels.ts";
import { initStarfield, updateStarfield } from "./starfield.ts";
import { createNotableStars, notableObjects, notableLabelMap, notableLabelMeshMap } from "./notable.ts";
import starsData from "../data/stars.json";

// Wait for DOM
await new Promise<void>((resolve) => {
  if (document.readyState !== "loading") resolve();
  else document.addEventListener("DOMContentLoaded", () => resolve());
});

// Prevent iOS Safari from scrolling the document
document.addEventListener("touchmove", (e) => {
  if (!(e.target as HTMLElement).closest("#search-results, #detail")) {
    e.preventDefault();
  }
}, { passive: false });

// Star creation
const starObjects: THREE.Mesh[] = [];
const starLabels: CSS2DObject[] = [];
const labelMeshMap = new WeakMap<HTMLElement, THREE.Mesh>();
const meshLabelMap = new WeakMap<THREE.Mesh, HTMLElement>();
const systemGroups: SystemGroup[] = [];
const meshToSystem = new Map<THREE.Mesh, SystemGroup>();
let labelsVisible = true;

function initLabelDrag(div: HTMLElement) {
  div.setAttribute("data-star-label", "");
  div.addEventListener("mousedown", (e) => {
    e.preventDefault();
    isDragging = true;
    prevMouse.x = e.clientX;
    prevMouse.y = e.clientY;
    dragDistance = 0;
  });
}


const starGroup = new THREE.Group();
scene.add(starGroup);

(starsData as Star[]).forEach((star) => {
  const mesh = createBillboardMesh(star);
  starGroup.add(mesh);
  starObjects.push(mesh);

  const { div, label } = createStarLabel(star, mesh, initLabelDrag);
  labelMeshMap.set(div, mesh);
  meshLabelMap.set(mesh, div);
  starLabels.push(label);
});

// Create systems
{
  const systemMap = new Map<string, THREE.Mesh[]>();
  for (const mesh of starObjects) {
    const star = mesh.userData as Star;
    if (star.system) {
      if (!systemMap.has(star.system)) systemMap.set(star.system, []);
      systemMap.get(star.system)!.push(mesh);
    }
  }

  for (const [name, meshes] of systemMap) {
    if (meshes.length < 2) continue;
    const labelDiv = document.createElement("div");
    labelDiv.style.cssText = LABEL_CSS;
    labelDiv.innerHTML = `<div>${name}</div>`;
    labelDiv.setAttribute("data-system-label", "");
    initLabelDrag(labelDiv);

    const anchor = new THREE.Object3D();
    scene.add(anchor);
    const label = new CSS2DObject(labelDiv);
    label.center.set(0.5, 0);
    label.visible = false;
    anchor.add(label);

    const centroid = new THREE.Vector3();
    for (const m of meshes) centroid.add(m.position);
    centroid.divideScalar(meshes.length);

    const avgDist = meshes.reduce((s, m) => s + (m.userData as Star).dist, 0) / meshes.length;
    const screens = meshes.map(() => ({ x: 0, y: 0 }));
    const parents = new Array(meshes.length);
    const notable = meshes.some((m) => !!(m.userData as Star).wikipedia);
    const group: SystemGroup = { name, meshes, label, anchor, centroid, avgDist, collapsedMembers: [], screens, parents, notable };
    systemGroups.push(group);
    for (const m of meshes) meshToSystem.set(m, group);

    labelDiv.addEventListener("mouseenter", () => {
      if (selectedSystem !== group) {
        showSystemMembers(group);
      }
    });
    labelDiv.addEventListener("mouseleave", () => {
      if (hoveredSystem === group && selectedSystem !== group) {
        hideSystemMembers(group);
      }
    });
    labelDiv.addEventListener("mouseup", () => {
      if (dragDistance >= CLICK_THRESHOLD) return;
      selectSystem(group, updateDetailPanel);
    });
  }
}

// Notable distant stars (beyond 50 ly, with proper names)
createNotableStars(initLabelDrag);

// Register label maps for hover/select label visibility
registerLabelMap(meshLabelMap);
registerLabelMap(notableLabelMap);

// Input state
let isDragging = false;
let isZooming = false;
let prevMouse = { x: 0, y: 0 };
let dragDistance = 0;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function setMouseNDC(clientX: number, clientY: number) {
  mouse.x = (clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(clientY / window.innerHeight) * 2 + 1;
}

function meshFromLabel(el: HTMLElement): THREE.Mesh | undefined {
  const label = el.closest("[data-star-label]") as HTMLElement | null;
  if (!label) return undefined;
  return labelMeshMap.get(label) || notableLabelMeshMap.get(label);
}

const allInteractiveStars: THREE.Mesh[] = [...starObjects, ...notableObjects];

function trySelectAt(clientX: number, clientY: number) {
  setMouseNDC(clientX, clientY);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(allInteractiveStars);
  if (hits.length > 0) selectTarget(hits[0].object as THREE.Mesh, meshToSystem, updateDetailPanel, doUpdateLabelVisibility);
}

function doUpdateLabelVisibility() {
  for (const label of starLabels) {
    label.visible = labelsVisible;
  }
  for (const group of systemGroups) {
    if (!labelsVisible) group.label.visible = false;
  }
  if (!labelsVisible) {
    for (const mesh of starObjects) {
      const div = meshLabelMap.get(mesh);
      if (div) div.style.visibility = "hidden";
    }
    for (const mesh of notableObjects) {
      const div = notableLabelMap.get(mesh);
      if (div) div.style.visibility = "hidden";
    }
    for (const group of systemGroups) {
      (group.label.element as HTMLElement).style.visibility = "hidden";
    }
  }
  setLabelsDirty(true);
}

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

// Wheel zoom
renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
labelRenderer.domElement.addEventListener("wheel", onWheel, { passive: false });

// Hover (mouse only)
let lastInputWasTouch = false;
let hoveredViaLabel = false;

window.addEventListener("touchstart", () => { lastInputWasTouch = true; }, { capture: true });
window.addEventListener("mousemove", () => { lastInputWasTouch = false; }, { capture: true });

renderer.domElement.addEventListener("mousemove", (e) => {
  if (hoveredViaLabel || lastInputWasTouch || isDragging || isZooming) return;
  setMouseNDC(e.clientX, e.clientY);
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(allInteractiveStars);
  if (intersects.length > 0) {
    hoverTarget(intersects[0].object as THREE.Mesh, meshToSystem);
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
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (mesh) selectTarget(mesh, meshToSystem, updateDetailPanel, doUpdateLabelVisibility);
});

// Keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "l") {
    labelsVisible = !labelsVisible;
    doUpdateLabelVisibility();
  } else if (e.key === "g") {
    gridHelper.visible = !gridHelper.visible;
  }
});

// Resize
window.addEventListener("resize", () => {
  handleResize();
  setLabelsDirty(true);
});

// Search
const search = setupSearch(allInteractiveStars, meshToSystem, (mesh) => {
  selectTarget(mesh, meshToSystem, updateDetailPanel, doUpdateLabelVisibility);
});

// Select Sol on load
{
  const solMesh = starObjects[0];
  highlightStar(solMesh);
  // Set selectedMesh via selectStar to properly initialize
  selectStar(solMesh, updateDetailPanel, doUpdateLabelVisibility);
}

// Initialize starfield tiles
initStarfield();

// Render loop
function animate(now: number) {
  requestAnimationFrame(animate);
  tickAnimation(now);
  checkCameraMoved();
  updateStarfield();
  updateLabels(labelsVisible, starObjects, systemGroups, meshLabelMap, meshToSystem, notableObjects, notableLabelMap);
  composer.render();
  labelRenderer.render(scene, camera);
}
animate(performance.now());
