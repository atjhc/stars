import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Star, SystemGroup } from "./types.ts";
import {
  SCALE, HIGHLIGHT_BOOST, CLICK_THRESHOLD, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS,
  LABEL_CSS, HIT_SCREEN_FRACTION,
} from "./constants.ts";
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
import starsData from "./stars.json";

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


// Billboard meshes add detailed glow when close to camera.
// At distance they fade to zero, letting the point cloud take over.
const starVertexShader = `
  attribute vec3 starColor;
  attribute float starBrightness;
  uniform float uHighlight;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vBrightness;
  void main() {
    vUv = uv;
    vColor = starColor;
    vec4 mvCenter = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float camDist = -mvCenter.z;
    float scale = clamp(log(1.0 + camDist * 0.5) * 0.12, 0.02, 0.15);
    // Fade out as camera moves away — point cloud takes over
    float proximityFade = smoothstep(40.0, 10.0, camDist);
    vBrightness = starBrightness * uHighlight * proximityFade;
    // Discard when fully faded
    if (proximityFade < 0.01) {
      gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
      return;
    }
    mvCenter.xy += position.xy * scale;
    gl_Position = projectionMatrix * mvCenter;
  }
`;

const starFragmentShader = `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vBrightness;
  void main() {
    vec2 uv = (vUv - 0.5) * 2.0;
    float d = length(uv);
    float core = exp(-d * d * 30.0);
    float halo = 1.0 / (1.0 + pow(d * 6.0, 2.0));
    float outerGlow = exp(-d * 4.0) * 0.3;
    float intensity = (core + halo * 0.4 + outerGlow) * vBrightness;
    vec3 color = mix(vColor, vec3(1.0), smoothstep(0.3, 1.0, core * vBrightness));
    gl_FragColor = vec4(color * intensity, intensity);
  }
`;

function bvToColor(ci: number): THREE.Color {
  if (ci < -0.4) ci = -0.4;
  if (ci > 2.0) ci = 2.0;
  const temp = 4600.0 * (1.0 / (0.92 * ci + 1.7) + 1.0 / (0.92 * ci + 0.62));
  const t = temp / 100.0;
  let r: number, g: number, b: number;
  if (t <= 66) { r = 1.0; } else { r = Math.min(1, 329.698727446 * Math.pow(t - 60, -0.1332047592) / 255); }
  if (t <= 66) { g = Math.min(1, Math.max(0, (99.4708025861 * Math.log(t) - 161.1195681661) / 255)); }
  else { g = Math.min(1, 288.1221695283 * Math.pow(t - 60, -0.0755148492) / 255); }
  if (t >= 66) { b = 1.0; } else if (t <= 19) { b = 0.0; }
  else { b = Math.min(1, Math.max(0, (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255)); }
  const avg = (r + g + b) / 3;
  const sat = 1.8;
  r = Math.min(1, Math.max(0, avg + (r - avg) * sat));
  g = Math.min(1, Math.max(0, avg + (g - avg) * sat));
  b = Math.min(1, Math.max(0, avg + (b - avg) * sat));
  return new THREE.Color(r, g, b);
}

const starQuadGeo = new THREE.PlaneGeometry(1, 1);
const scratchVec3 = new THREE.Vector3();

// Create all stars
const starGroup = new THREE.Group();
scene.add(starGroup);

(starsData as Star[]).forEach((star) => {
  const color = bvToColor(star.ci);
  const quadSize = 0.4;
  const brightness = Math.max(0.8, Math.min(2.5, 0.9 + 0.35 * Math.log10(Math.max(star.lum, 0.001))));

  const mat = new THREE.ShaderMaterial({
    uniforms: { uHighlight: { value: 1.0 } },
    vertexShader: starVertexShader,
    fragmentShader: starFragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });

  const geo = starQuadGeo.clone();
  geo.setAttribute("starColor", new THREE.Float32BufferAttribute(
    [color.r, color.g, color.b, color.r, color.g, color.b,
     color.r, color.g, color.b, color.r, color.g, color.b], 3));
  geo.setAttribute("starBrightness", new THREE.Float32BufferAttribute(
    [brightness, brightness, brightness, brightness], 1));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(quadSize, quadSize, 1);

  const hitSphere = new THREE.Sphere(new THREE.Vector3(), 0);
  mesh.raycast = (raycaster, intersects) => {
    hitSphere.center.copy(mesh.getWorldPosition(scratchVec3));
    const camDist = hitSphere.center.distanceTo(raycaster.ray.origin);
    hitSphere.radius = camDist * HIT_SCREEN_FRACTION;
    const intersection = raycaster.ray.intersectSphere(hitSphere, scratchVec3);
    if (intersection) {
      const distance = raycaster.ray.origin.distanceTo(intersection);
      if (distance >= raycaster.near && distance <= raycaster.far) {
        intersects.push({ distance, point: intersection.clone(), object: mesh });
      }
    }
  };
  mesh.position.set(star.x * SCALE, star.z * SCALE, -star.y * SCALE);
  mesh.userData = star;
  starGroup.add(mesh);
  starObjects.push(mesh);

  const labelDiv = document.createElement("div");
  labelDiv.style.cssText = LABEL_CSS;
  labelDiv.textContent = star.name;
  labelMeshMap.set(labelDiv, mesh);
  meshLabelMap.set(mesh, labelDiv);
  initLabelDrag(labelDiv);
  const label = new CSS2DObject(labelDiv);
  label.center.set(0.5, 0);
  label.userData.mesh = mesh;
  mesh.add(label);
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

const allInteractiveStars = () => [...starObjects, ...notableObjects];

function trySelectAt(clientX: number, clientY: number) {
  setMouseNDC(clientX, clientY);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(allInteractiveStars());
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
  if (hoveredViaLabel || lastInputWasTouch) return;
  setMouseNDC(e.clientX, e.clientY);
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(allInteractiveStars());
  if (intersects.length > 0) {
    hoverTarget(intersects[0].object as THREE.Mesh, meshToSystem);
  } else {
    unhoverAll();
  }
});

labelRenderer.domElement.addEventListener("mouseover", (e) => {
  if (lastInputWasTouch) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  hoveredViaLabel = true;
  hoverTarget(mesh, meshToSystem);
});

labelRenderer.domElement.addEventListener("mousemove", (e) => {
  if (!hoveredViaLabel) return;
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
const search = setupSearch([...starObjects, ...notableObjects], meshToSystem, (mesh) => {
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
  updateLabels(labelsVisible, starObjects, systemGroups, meshLabelMap, meshToSystem);
  composer.render();
  labelRenderer.render(scene, camera);
}
animate(performance.now());
