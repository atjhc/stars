import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import starsData from "./stars.json";

await new Promise<void>((resolve) => {
  if (document.readyState !== "loading") resolve();
  else document.addEventListener("DOMContentLoaded", () => resolve());
});

interface Star {
  name: string;
  x: number;
  y: number;
  z: number;
  dist: number;
  mag: number;
  absmag: number;
  ci: number;
  spect: string;
  lum: number;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.01,
  500,
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.top = "0";
labelRenderer.domElement.style.pointerEvents = "none";
labelRenderer.domElement.style.zIndex = "10";
document.body.appendChild(labelRenderer.domElement);

function bvToColor(ci: number): THREE.Color {
  let t: number;
  let r: number, g: number, b: number;
  if (ci < -0.4) ci = -0.4;
  if (ci > 2.0) ci = 2.0;

  if (ci < 0.0) {
    t = (ci + 0.4) / 0.4;
    r = 0.6 + 0.4 * t;
    g = 0.7 + 0.3 * t;
    b = 1.0;
  } else if (ci < 0.4) {
    t = ci / 0.4;
    r = 1.0;
    g = 1.0 - 0.1 * t;
    b = 1.0 - 0.2 * t;
  } else if (ci < 0.8) {
    t = (ci - 0.4) / 0.4;
    r = 1.0;
    g = 0.9 - 0.2 * t;
    b = 0.8 - 0.4 * t;
  } else if (ci < 1.4) {
    t = (ci - 0.8) / 0.6;
    r = 1.0;
    g = 0.7 - 0.3 * t;
    b = 0.4 - 0.2 * t;
  } else {
    t = (ci - 1.4) / 0.6;
    r = 1.0 - 0.2 * t;
    g = 0.4 - 0.2 * t;
    b = 0.2 - 0.1 * t;
  }
  return new THREE.Color(r, g, b);
}

function makeGlowTexture(color: THREE.Color): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;

  // Bright core
  const core = ctx.createRadialGradient(cx, cx, 0, cx, cx, size * 0.08);
  core.addColorStop(0, `rgba(255,255,255,1)`);
  core.addColorStop(1, `rgba(255,255,255,0)`);
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);

  // Inner bloom
  const inner = ctx.createRadialGradient(cx, cx, 0, cx, cx, size * 0.25);
  const r = (color.r * 255) | 0;
  const g = (color.g * 255) | 0;
  const b = (color.b * 255) | 0;
  inner.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
  inner.addColorStop(0.3, `rgba(${r},${g},${b},0.4)`);
  inner.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = inner;
  ctx.fillRect(0, 0, size, size);

  // Outer halo
  const outer = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  outer.addColorStop(0, `rgba(${r},${g},${b},0.3)`);
  outer.addColorStop(0.15, `rgba(${r},${g},${b},0.12)`);
  outer.addColorStop(0.4, `rgba(${r},${g},${b},0.03)`);
  outer.addColorStop(1, `rgba(0,0,0,0)`);
  ctx.fillStyle = outer;
  ctx.fillRect(0, 0, size, size);

  return new THREE.CanvasTexture(canvas);
}

const SCALE = 3;
const starGroup = new THREE.Group();
scene.add(starGroup);

const starObjects: THREE.Mesh[] = [];
const starLabels: CSS2DObject[] = [];
let labelsVisible = true;
let selectedMesh: THREE.Mesh | null = null;

(starsData as Star[]).forEach((star) => {
  const color = bvToColor(star.ci);

  const lumSize = Math.max(
    0.03,
    Math.min(0.3, 0.04 + 0.06 * Math.log10(Math.max(star.lum, 0.001))),
  );

  const geo = new THREE.SphereGeometry(lumSize, 12, 8);
  const mat = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(star.x * SCALE, star.z * SCALE, -star.y * SCALE);
  mesh.userData = star;
  starGroup.add(mesh);
  starObjects.push(mesh);

  const spriteMat = new THREE.SpriteMaterial({
    map: makeGlowTexture(color),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: Math.min(1, 0.5 + star.lum * 0.15),
  });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.raycast = () => {};
  const glowSize = Math.max(0.4, lumSize * 10);
  sprite.scale.set(glowSize, glowSize, 1);
  mesh.add(sprite);

  const labelDiv = document.createElement("div");
  labelDiv.style.cssText = `
    color: rgba(255,255,255,0.7); font-size: 10px; font-family: 'Helvetica Neue', sans-serif;
    pointer-events: auto; white-space: nowrap; text-shadow: 0 0 4px #000;
    cursor: pointer;
  `;
  const displayName = star.name === "ID 0" ? "Sol" : star.name;
  labelDiv.textContent = displayName;
  (labelDiv as any)._mesh = mesh;
  labelDiv.setAttribute("data-star-label", "");
  const label = new CSS2DObject(labelDiv);
  label.position.set(0, -(lumSize + 0.06), 0);
  label.center.set(0.5, 0);
  label.userData.star = star;
  label.userData.mesh = mesh;
  mesh.add(label);
  starLabels.push(label);
});

// Grid aligned to the galactic plane, fixed at Sol.
// HYG data uses equatorial coordinates (x=vernal equinox, z=north celestial pole).
// In our scene: scene_x = eq_x, scene_y = eq_z, scene_z = -eq_y.
// Galactic north pole in equatorial coords: RA=192.8595deg, Dec=27.1284deg
const raGNP = (192.8595 * Math.PI) / 180;
const decGNP = (27.1284 * Math.PI) / 180;
const galNorthEq = new THREE.Vector3(
  Math.cos(decGNP) * Math.cos(raGNP),
  Math.sin(decGNP),
  -Math.cos(decGNP) * Math.sin(raGNP),
);

const gridHelper = new THREE.GridHelper(60, 30, 0x4466aa, 0x334477);
gridHelper.material.transparent = true;
(gridHelper.material as THREE.Material).opacity = 0.5;
const defaultUp = new THREE.Vector3(0, 1, 0);
const quat = new THREE.Quaternion().setFromUnitVectors(
  defaultUp,
  galNorthEq.normalize(),
);
gridHelper.quaternion.copy(quat);
scene.add(gridHelper);

// Camera orbit controls
const target = new THREE.Vector3(0, 0, 0);
let orbitRadius = 18;
let orbitPhi = 0.4;
let orbitTheta = 0;
let isDragging = false;
let isZooming = false;
let prevMouse = { x: 0, y: 0 };

const galUp = galNorthEq.clone().normalize();
const ref =
  Math.abs(galUp.dot(new THREE.Vector3(1, 0, 0))) < 0.9
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3(0, 0, 1);
const galX = new THREE.Vector3().crossVectors(galUp, ref).normalize();
const galZ = new THREE.Vector3().crossVectors(galX, galUp).normalize();

camera.up.copy(galUp);

function updateCamera() {
  const sinPhi = Math.sin(orbitPhi);
  const cosPhi = Math.cos(orbitPhi);
  const sinTheta = Math.sin(orbitTheta);
  const cosTheta = Math.cos(orbitTheta);
  camera.position
    .copy(target)
    .addScaledVector(galX, orbitRadius * sinPhi * cosTheta)
    .addScaledVector(galZ, orbitRadius * sinPhi * sinTheta)
    .addScaledVector(galUp, orbitRadius * cosPhi);
  camera.lookAt(target);
}
updateCamera();

// Perpendicular drop line from hovered star to galactic plane
const dropLineGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(),
  new THREE.Vector3(),
]);
const dropLine = new THREE.Line(
  dropLineGeo,
  new THREE.LineBasicMaterial({
    color: 0x4466aa,
    transparent: true,
    opacity: 0.6,
  }),
);
dropLine.visible = false;
scene.add(dropLine);

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tooltip = document.getElementById("tooltip")!;

let dragDistance = 0;

renderer.domElement.addEventListener("mousedown", (e) => {
  if (e.altKey) {
    isZooming = true;
  } else {
    isDragging = true;
  }
  prevMouse.x = e.clientX;
  prevMouse.y = e.clientY;
  dragDistance = 0;
});

window.addEventListener("mousemove", (e) => {
  const dx = e.clientX - prevMouse.x;
  const dy = e.clientY - prevMouse.y;
  if (isDragging) {
    dragDistance += Math.abs(dx) + Math.abs(dy);
    orbitTheta -= dx * 0.005;
    orbitPhi = Math.max(0.1, Math.min(Math.PI - 0.1, orbitPhi + dy * 0.005));
    updateCamera();
  } else if (isZooming) {
    dragDistance += Math.abs(dx) + Math.abs(dy);
    orbitRadius = Math.max(2, Math.min(100, orbitRadius + dy * 0.1));
    updateCamera();
  }
  prevMouse.x = e.clientX;
  prevMouse.y = e.clientY;
});

window.addEventListener("mouseup", (e) => {
  const wasClick = dragDistance < 5;
  isDragging = false;
  isZooming = false;

  if (wasClick) {
    const clickMouse = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(clickMouse, camera);
    const hits = raycaster.intersectObjects(starObjects);
    if (hits.length > 0) {
      selectStar(hits[0].object as THREE.Mesh);
    }
  }
});

let animStart: number | null = null;
let animFrom: THREE.Vector3 | null = null;
let animTo: THREE.Vector3 | null = null;
const ANIM_DURATION = 600;

function selectStar(mesh: THREE.Mesh) {
  selectedMesh = mesh;
  animFrom = target.clone();
  animTo = mesh.position.clone();
  animStart = performance.now();
  updateLabelVisibility();
}

function updateLabelVisibility() {
  for (const label of starLabels) {
    label.visible = labelsVisible || label.userData.mesh === selectedMesh;
  }
}

function tickAnimation(now: number) {
  if (!animStart || !animFrom || !animTo) return;
  const t = Math.min(1, (now - animStart) / ANIM_DURATION);
  const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  target.lerpVectors(animFrom, animTo, ease);
  updateCamera();
  if (t >= 1) animStart = null;
}

renderer.domElement.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    orbitRadius = Math.max(2, Math.min(100, orbitRadius + e.deltaY * 0.02));
    updateCamera();
  },
  { passive: false },
);

function showHover(mesh: THREE.Mesh, clientX: number, clientY: number) {
  const star = mesh.userData as Star;
  const starPos = mesh.position;
  const planePos = starPos.clone().addScaledVector(galUp, -starPos.dot(galUp));
  const positions = dropLineGeo.attributes.position as THREE.BufferAttribute;
  positions.setXYZ(0, starPos.x, starPos.y, starPos.z);
  positions.setXYZ(1, planePos.x, planePos.y, planePos.z);
  positions.needsUpdate = true;
  dropLine.visible = true;

  const displayName = star.name === "ID 0" ? "Sol" : star.name;
  tooltip.innerHTML = `
    <div class="star-name">${displayName}</div>
    <div class="star-detail">
      Distance: ${star.dist.toFixed(2)} pc (${(star.dist * 3.262).toFixed(1)} ly)<br>
      Magnitude: ${star.mag.toFixed(1)} (abs: ${star.absmag.toFixed(1)})<br>
      Spectral: ${star.spect || "\u2014"}<br>
      Luminosity: ${star.lum.toFixed(3)} L\u2609
    </div>
  `;
  tooltip.style.display = "block";
  tooltip.style.left = clientX + 16 + "px";
  tooltip.style.top = clientY - 10 + "px";
}

function hideHover() {
  tooltip.style.display = "none";
  dropLine.visible = false;
}

let hoveredViaLabel = false;

// Hover via raycast on the 3D canvas
renderer.domElement.addEventListener("mousemove", (e) => {
  if (hoveredViaLabel) return;
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(starObjects);

  if (intersects.length > 0) {
    showHover(intersects[0].object as THREE.Mesh, e.clientX, e.clientY);
  } else {
    hideHover();
  }
});

// Hover via label DOM elements
labelRenderer.domElement.addEventListener("mouseover", (e) => {
  const target = (e.target as HTMLElement).closest("[data-star-label]") as HTMLElement | null;
  if (!target) return;
  hoveredViaLabel = true;
  const mesh = (target as any)._mesh as THREE.Mesh;
  showHover(mesh, e.clientX, e.clientY);
});

labelRenderer.domElement.addEventListener("mousemove", (e) => {
  if (!hoveredViaLabel) return;
  const target = (e.target as HTMLElement).closest("[data-star-label]") as HTMLElement | null;
  if (!target) return;
  const mesh = (target as any)._mesh as THREE.Mesh;
  showHover(mesh, e.clientX, e.clientY);
});

labelRenderer.domElement.addEventListener("mouseout", (e) => {
  const target = (e.target as HTMLElement).closest("[data-star-label]") as HTMLElement | null;
  if (!target) return;
  const related = (e as MouseEvent).relatedTarget as HTMLElement | null;
  if (related && target.contains(related)) return;
  hoveredViaLabel = false;
  hideHover();
});

labelRenderer.domElement.addEventListener("click", (e) => {
  const label = (e.target as HTMLElement).closest("[data-star-label]") as HTMLElement | null;
  if (!label) return;
  const mesh = (label as any)._mesh as THREE.Mesh;
  selectStar(mesh);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

// Search
const searchEl = document.getElementById("search")!;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchResults = document.getElementById("search-results")!;
let searchOpen = false;
let selectedIndex = 0;
let filteredStars: { star: Star; mesh: THREE.Mesh }[] = [];

function openSearch() {
  searchOpen = true;
  searchEl.classList.add("active");
  searchInput.value = "";
  updateSearchResults("");
  searchInput.focus();
}

function closeSearch() {
  searchOpen = false;
  searchEl.classList.remove("active");
  searchInput.blur();
}

function updateSearchResults(query: string) {
  const q = query.toLowerCase().trim();
  filteredStars = [];
  if (q.length > 0) {
    for (const mesh of starObjects) {
      const star = mesh.userData as Star;
      const name = star.name === "ID 0" ? "Sol" : star.name;
      if (name.toLowerCase().includes(q)) {
        filteredStars.push({ star, mesh });
        if (filteredStars.length >= 20) break;
      }
    }
  }
  selectedIndex = 0;
  renderSearchResults();
}

function renderSearchResults() {
  searchResults.innerHTML = "";
  filteredStars.forEach((entry, i) => {
    const li = document.createElement("li");
    const name = entry.star.name === "ID 0" ? "Sol" : entry.star.name;
    li.textContent = `${name}  (${entry.star.dist.toFixed(1)} pc)`;
    if (i === selectedIndex) li.classList.add("selected");
    li.addEventListener("click", () => selectSearchResult(i));
    searchResults.appendChild(li);
  });
}

function selectSearchResult(index: number) {
  if (index < 0 || index >= filteredStars.length) return;
  const { mesh } = filteredStars[index];
  selectStar(mesh);
  closeSearch();
}

window.addEventListener("keydown", (e) => {
  if (searchOpen) {
    // handled below
  } else if (e.target instanceof HTMLInputElement) {
    return;
  } else if (e.key === "/") {
    e.preventDefault();
    openSearch();
    return;
  } else if (e.key === "l") {
    labelsVisible = !labelsVisible;
    updateLabelVisibility();
    return;
  } else {
    return;
  }

  if (e.key === "Escape") {
    closeSearch();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex = Math.min(selectedIndex + 1, filteredStars.length - 1);
    renderSearchResults();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex = Math.max(selectedIndex - 1, 0);
    renderSearchResults();
  } else if (e.key === "Enter") {
    e.preventDefault();
    selectSearchResult(selectedIndex);
  }
});

searchInput.addEventListener("input", () => {
  updateSearchResults(searchInput.value);
});

function animate(now: number) {
  requestAnimationFrame(animate);
  tickAnimation(now);
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
animate(performance.now());
