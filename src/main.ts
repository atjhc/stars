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

const MIN_ORBIT_RADIUS = 0.5;
const MAX_ORBIT_RADIUS = 100;
const CLICK_THRESHOLD = 5;
const ANIM_DURATION = 600;
const SCALE = 3;
const MAX_SEARCH_RESULTS = 20;

function starDisplayName(star: Star): string {
  return star.name === "ID 0" ? "Sol" : star.name;
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
  if (ci < -0.4) ci = -0.4;
  if (ci > 2.0) ci = 2.0;

  let t: number, r: number, g: number, b: number;
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

const glowTextureCache = new Map<string, THREE.CanvasTexture>();

function getGlowTexture(color: THREE.Color, ci: number): THREE.CanvasTexture {
  const key = (Math.round(ci * 20) / 20).toFixed(2);
  const cached = glowTextureCache.get(key);
  if (cached) return cached;

  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const cx = size / 2;
  const r = (color.r * 255) | 0;
  const g = (color.g * 255) | 0;
  const b = (color.b * 255) | 0;

  const core = ctx.createRadialGradient(cx, cx, 0, cx, cx, size * 0.08);
  core.addColorStop(0, `rgba(255,255,255,1)`);
  core.addColorStop(1, `rgba(255,255,255,0)`);
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);

  const inner = ctx.createRadialGradient(cx, cx, 0, cx, cx, size * 0.25);
  inner.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
  inner.addColorStop(0.3, `rgba(${r},${g},${b},0.4)`);
  inner.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = inner;
  ctx.fillRect(0, 0, size, size);

  const outer = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
  outer.addColorStop(0, `rgba(${r},${g},${b},0.3)`);
  outer.addColorStop(0.15, `rgba(${r},${g},${b},0.12)`);
  outer.addColorStop(0.4, `rgba(${r},${g},${b},0.03)`);
  outer.addColorStop(1, `rgba(0,0,0,0)`);
  ctx.fillStyle = outer;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  glowTextureCache.set(key, tex);
  return tex;
}

const starGroup = new THREE.Group();
scene.add(starGroup);

const starObjects: THREE.Mesh[] = [];
const starLabels: CSS2DObject[] = [];
const labelMeshMap = new WeakMap<HTMLElement, THREE.Mesh>();
let labelsVisible = true;
let selectedMesh: THREE.Mesh | null = null;

(starsData as Star[]).forEach((star) => {
  const color = bvToColor(star.ci);

  const lumSize = Math.max(
    0.03,
    Math.min(0.3, 0.04 + 0.06 * Math.log10(Math.max(star.lum, 0.001))),
  );

  const geo = new THREE.SphereGeometry(lumSize, 12, 8);
  geo.computeBoundingSphere();
  geo.boundingSphere!.radius = Math.max(0.3, lumSize * 3);
  const mat = new THREE.MeshBasicMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(star.x * SCALE, star.z * SCALE, -star.y * SCALE);
  mesh.userData = star;
  starGroup.add(mesh);
  starObjects.push(mesh);

  const spriteMat = new THREE.SpriteMaterial({
    map: getGlowTexture(color, star.ci),
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
    color: rgba(255,255,255,0.7); font-size: 10px;
    pointer-events: auto; white-space: nowrap; text-shadow: 0 0 4px #000;
    cursor: pointer;
  `;
  labelDiv.textContent = starDisplayName(star);
  labelMeshMap.set(labelDiv, mesh);
  labelDiv.setAttribute("data-star-label", "");
  const label = new CSS2DObject(labelDiv);
  label.position.set(0, -(lumSize + 0.06), 0);
  label.center.set(0.5, 0);
  label.userData.mesh = mesh;
  mesh.add(label);
  starLabels.push(label);
});

// Galactic north pole in equatorial coords: RA=192.8595deg, Dec=27.1284deg
// HYG uses equatorial coordinates; scene maps: x=eq_x, y=eq_z, z=-eq_y
const raGNP = (192.8595 * Math.PI) / 180;
const decGNP = (27.1284 * Math.PI) / 180;
const galNorthEq = new THREE.Vector3(
  Math.cos(decGNP) * Math.cos(raGNP),
  Math.sin(decGNP),
  -Math.cos(decGNP) * Math.sin(raGNP),
).normalize();

const GRID_SIZE = 60;
const GRID_DIVISIONS = 30;
const GRID_FADE_RADIUS = 30.0;

const gridShaderMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uCenter: { value: new THREE.Vector3(0, 0, 0) },
    uFadeRadius: { value: GRID_FADE_RADIUS },
    uColor: { value: new THREE.Color(0x6699dd) },
  },
  vertexShader: `
    varying vec3 vWorldPos;
    void main() {
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorldPos = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: `
    uniform vec3 uCenter;
    uniform float uFadeRadius;
    uniform vec3 uColor;
    varying vec3 vWorldPos;
    void main() {
      float d = distance(vWorldPos, uCenter);
      float alpha = 1.0 * smoothstep(uFadeRadius, 0.0, d);
      if (alpha < 0.005) discard;
      gl_FragColor = vec4(uColor, alpha);
    }
  `,
});

const gridHelper = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS);
gridHelper.material = gridShaderMat;
gridHelper.quaternion.setFromUnitVectors(
  new THREE.Vector3(0, 1, 0),
  galNorthEq,
);
scene.add(gridHelper);

const target = new THREE.Vector3(0, 0, 0);
let orbitRadius = 18;
let orbitPhi = 0.4;
let orbitTheta = 0;
let isDragging = false;
let isZooming = false;
let prevMouse = { x: 0, y: 0 };

const galUp = galNorthEq;
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

const dropLineMat = new THREE.LineBasicMaterial({
  color: 0x4466aa,
  transparent: true,
  opacity: 0.6,
  depthTest: false,
});

function createDropLine(): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(),
    new THREE.Vector3(),
  ]);
  const line = new THREE.Line(geo, dropLineMat);
  line.visible = false;
  scene.add(line);
  return line;
}

const selectDropLine = createDropLine();
const hoverDropLine = createDropLine();

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const tooltip = document.getElementById("tooltip")!;
const scratchVec3 = new THREE.Vector3();

let dragDistance = 0;

function meshFromLabel(el: HTMLElement): THREE.Mesh | undefined {
  const label = el.closest("[data-star-label]") as HTMLElement | null;
  return label ? labelMeshMap.get(label) : undefined;
}

function setMouseNDC(vec: THREE.Vector2, clientX: number, clientY: number) {
  vec.x = (clientX / window.innerWidth) * 2 - 1;
  vec.y = -(clientY / window.innerHeight) * 2 + 1;
}

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
  prevMouse.x = e.clientX;
  prevMouse.y = e.clientY;

  if (!isDragging && !isZooming) return;
  dragDistance += Math.abs(dx) + Math.abs(dy);

  if (isDragging) {
    orbitTheta -= dx * 0.005;
    orbitPhi = THREE.MathUtils.clamp(orbitPhi + dy * 0.005, 0.1, Math.PI - 0.1);
    updateCamera();
  } else {
    orbitRadius = THREE.MathUtils.clamp(orbitRadius + dy * 0.1, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS);
    updateCamera();
  }
});

window.addEventListener("mouseup", (e) => {
  const wasClick = dragDistance < CLICK_THRESHOLD;
  isDragging = false;
  isZooming = false;

  if (wasClick) {
    setMouseNDC(mouse, e.clientX, e.clientY);
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(starObjects);
    if (hits.length > 0) {
      selectStar(hits[0].object as THREE.Mesh);
    }
  }
});

let animation: { from: THREE.Vector3; to: THREE.Vector3; start: number } | null = null;

function updateGridCenter() {
  scratchVec3.copy(target).addScaledVector(galUp, -target.dot(galUp));
  gridShaderMat.uniforms.uCenter.value.copy(scratchVec3);
}

function selectStar(mesh: THREE.Mesh) {
  selectedMesh = mesh;
  animation = {
    from: target.clone(),
    to: mesh.position.clone(),
    start: performance.now(),
  };
  updateLabelVisibility();
  setDropLine(selectDropLine, mesh);
}

function updateLabelVisibility() {
  for (const label of starLabels) {
    label.visible = labelsVisible;
  }
}

function tickAnimation(now: number) {
  if (!animation) return;
  const t = Math.min(1, (now - animation.start) / ANIM_DURATION);
  const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  target.lerpVectors(animation.from, animation.to, ease);
  updateGridCenter();
  updateCamera();
  if (t >= 1) animation = null;
}

renderer.domElement.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    orbitRadius = THREE.MathUtils.clamp(
      orbitRadius + e.deltaY * 0.02,
      MIN_ORBIT_RADIUS,
      MAX_ORBIT_RADIUS,
    );
    updateCamera();
  },
  { passive: false },
);

function setDropLine(line: THREE.Line, mesh: THREE.Mesh) {
  const starPos = mesh.position;
  scratchVec3.copy(starPos).addScaledVector(galUp, -starPos.dot(galUp));
  const positions = line.geometry.attributes.position as THREE.BufferAttribute;
  positions.setXYZ(0, starPos.x, starPos.y, starPos.z);
  positions.setXYZ(1, scratchVec3.x, scratchVec3.y, scratchVec3.z);
  positions.needsUpdate = true;
  line.visible = gridHelper.visible;
}

let lastHoveredMesh: THREE.Mesh | null = null;
let lastTooltipSelection: THREE.Mesh | null = null;

function showHover(mesh: THREE.Mesh, clientX: number, clientY: number) {
  setDropLine(hoverDropLine, mesh);

  if (lastHoveredMesh !== mesh || lastTooltipSelection !== selectedMesh) {
    lastHoveredMesh = mesh;
    lastTooltipSelection = selectedMesh;
    const star = mesh.userData as Star;

    let distLine = `From Sol: ${star.dist.toFixed(2)} pc (${(star.dist * 3.262).toFixed(1)} ly)`;
    if (selectedMesh && selectedMesh !== mesh) {
      const sel = selectedMesh.userData as Star;
      const dx = star.x - sel.x;
      const dy = star.y - sel.y;
      const dz = star.z - sel.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      distLine += `<br>From ${starDisplayName(sel)}: ${d.toFixed(2)} pc (${(d * 3.262).toFixed(1)} ly)`;
    }

    tooltip.innerHTML = `
      <div class="star-name">${starDisplayName(star)}</div>
      <div class="star-detail">
        ${distLine}<br>
        Magnitude: ${star.mag.toFixed(1)} (abs: ${star.absmag.toFixed(1)})<br>
        Spectral: ${star.spect || "\u2014"}<br>
        Luminosity: ${star.lum.toFixed(3)} L\u2609
      </div>
    `;
  }
  tooltip.style.display = "block";
  tooltip.style.left = clientX + 16 + "px";
  tooltip.style.top = clientY - 10 + "px";
}

function hideHover() {
  tooltip.style.display = "none";
  hoverDropLine.visible = false;
  lastHoveredMesh = null;
}

let hoveredViaLabel = false;

renderer.domElement.addEventListener("mousemove", (e) => {
  if (hoveredViaLabel) return;
  setMouseNDC(mouse, e.clientX, e.clientY);

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(starObjects);

  if (intersects.length > 0) {
    showHover(intersects[0].object as THREE.Mesh, e.clientX, e.clientY);
  } else {
    hideHover();
  }
});

labelRenderer.domElement.addEventListener("mouseover", (e) => {
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  hoveredViaLabel = true;
  showHover(mesh, e.clientX, e.clientY);
});

labelRenderer.domElement.addEventListener("mousemove", (e) => {
  if (!hoveredViaLabel) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  showHover(mesh, e.clientX, e.clientY);
});

labelRenderer.domElement.addEventListener("mouseout", (e) => {
  const label = (e.target as HTMLElement).closest("[data-star-label]") as HTMLElement | null;
  if (!label) return;
  const related = (e as MouseEvent).relatedTarget as HTMLElement | null;
  if (related && label.contains(related)) return;
  hoveredViaLabel = false;
  hideHover();
});

labelRenderer.domElement.addEventListener("click", (e) => {
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (mesh) selectStar(mesh);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
});

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
      if (starDisplayName(star).toLowerCase().includes(q)) {
        filteredStars.push({ star, mesh });
        if (filteredStars.length >= MAX_SEARCH_RESULTS) break;
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
    li.textContent = `${starDisplayName(entry.star)}  (${entry.star.dist.toFixed(1)} pc)`;
    if (i === selectedIndex) li.classList.add("selected");
    li.addEventListener("click", () => selectSearchResult(i));
    searchResults.appendChild(li);
  });
}

function selectSearchResult(index: number) {
  if (index < 0 || index >= filteredStars.length) return;
  selectStar(filteredStars[index].mesh);
  closeSearch();
}

window.addEventListener("keydown", (e) => {
  if (searchOpen) {
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
  } else if (e.key === "g") {
    gridHelper.visible = !gridHelper.visible;
    selectDropLine.visible = gridHelper.visible && selectDropLine.visible;
    hoverDropLine.visible = gridHelper.visible && hoverDropLine.visible;
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
