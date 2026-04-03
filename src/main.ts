import * as THREE from "three";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
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
  aliases?: string[];
  wikipedia?: string;
  notes?: string;
}

const MIN_ORBIT_RADIUS = 0.5;
const MAX_ORBIT_RADIUS = 100;
const CLICK_THRESHOLD = 5;
const ANIM_DURATION = 600;
const SCALE = 3;
const MAX_SEARCH_RESULTS = 20;

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

// Star shader material — procedural multi-layer glow
const starVertexShader = `
  attribute vec3 starColor;
  attribute float starBrightness;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vBrightness;

  void main() {
    vUv = uv;
    vColor = starColor;
    vBrightness = starBrightness;

    // Billboard: always face camera
    vec4 mvCenter = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mvCenter.xy += position.xy;
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
    if (d > 1.0) discard;

    // Multi-layer glow
    float core = exp(-d * d * 30.0);
    float halo = 1.0 / (1.0 + pow(d * 6.0, 2.0));
    float outerGlow = exp(-d * 4.0) * 0.3;

    float intensity = (core + halo * 0.4 + outerGlow) * vBrightness;

    // Core desaturates toward white; color shows in the halo
    vec3 color = mix(vColor, vec3(1.0), smoothstep(0.3, 1.0, core * vBrightness));

    gl_FragColor = vec4(color * intensity, intensity);
  }
`;

const BLOOM_LAYER = 1;
const bloomLayer = new THREE.Layers();
bloomLayer.set(BLOOM_LAYER);

const starGroup = new THREE.Group();
scene.add(starGroup);

const starObjects: THREE.Mesh[] = [];
const starLabels: CSS2DObject[] = [];
const labelMeshMap = new WeakMap<HTMLElement, THREE.Mesh>();
let labelsVisible = true;
let selectedMesh: THREE.Mesh | null = null;

// B-V color index to RGB (Ballesteros temperature + Helland RGB)
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

  return new THREE.Color(r, g, b);
}

// Shared quad geometry for all star billboards
const starQuadGeo = new THREE.PlaneGeometry(1, 1);

(starsData as Star[]).forEach((star) => {
  const color = bvToColor(star.ci);

  // Billboard size based on luminosity (log scale)
  const quadSize = Math.max(0.4, 0.3 + 0.2 * Math.log10(Math.max(star.lum, 0.001)));
  // Brightness multiplier for the shader
  const brightness = Math.min(2.0, 0.5 + 0.3 * Math.log10(Math.max(star.lum, 0.001)));

  // Per-star shader material with attributes baked as uniforms
  const mat = new THREE.ShaderMaterial({
    vertexShader: starVertexShader,
    fragmentShader: starFragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });

  // Set per-instance attributes via geometry attributes
  const geo = starQuadGeo.clone();
  geo.setAttribute("starColor", new THREE.Float32BufferAttribute(
    [color.r, color.g, color.b, color.r, color.g, color.b,
     color.r, color.g, color.b, color.r, color.g, color.b], 3));
  geo.setAttribute("starBrightness", new THREE.Float32BufferAttribute(
    [brightness, brightness, brightness, brightness], 1));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(quadSize, quadSize, 1);
  mesh.layers.enable(BLOOM_LAYER);

  // Hitbox for raycasting — covers the visible glow area
  const hitRadius = quadSize * 0.4;
  const hitSphere = new THREE.Sphere(new THREE.Vector3(), hitRadius);
  mesh.raycast = (raycaster, intersects) => {
    hitSphere.center.copy(mesh.getWorldPosition(scratchVec3));
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
  labelDiv.style.cssText = `
    color: rgba(255,255,255,0.7); font-size: 10px;
    pointer-events: auto; white-space: nowrap; text-shadow: 0 0 4px #000;
    margin-top: 10px;
    cursor: pointer;
  `;
  labelDiv.textContent = star.name;
  labelMeshMap.set(labelDiv, mesh);
  labelDiv.setAttribute("data-star-label", "");
  const label = new CSS2DObject(labelDiv);
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

const ORBIT_SENSITIVITY = 0.005;

function applyOrbitDrag(dx: number, dy: number) {
  dragDistance += Math.abs(dx) + Math.abs(dy);
  orbitTheta += dx * ORBIT_SENSITIVITY;
  orbitPhi = THREE.MathUtils.clamp(
    orbitPhi - dy * ORBIT_SENSITIVITY,
    0.1,
    Math.PI - 0.1,
  );
  updateCamera();
}

function trySelectAt(clientX: number, clientY: number) {
  setMouseNDC(mouse, clientX, clientY);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(starObjects);
  if (hits.length > 0) {
    selectStar(hits[0].object as THREE.Mesh);
  }
}

// Mouse controls
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

  if (isDragging) {
    applyOrbitDrag(dx, dy);
  } else {
    dragDistance += Math.abs(dx) + Math.abs(dy);
    orbitRadius = THREE.MathUtils.clamp(orbitRadius + dy * 0.1, MIN_ORBIT_RADIUS, MAX_ORBIT_RADIUS);
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
    applyOrbitDrag(dx, dy);
  } else if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    orbitRadius = THREE.MathUtils.clamp(
      touchStartRadius * (touchStartDist / dist),
      MIN_ORBIT_RADIUS,
      MAX_ORBIT_RADIUS,
    );
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
  lastHoveredMesh = null;
  updateDetailPanel();
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
const detail = document.getElementById("detail")!;

function showHover(mesh: THREE.Mesh, clientX: number, clientY: number) {
  setDropLine(hoverDropLine, mesh);

  if (lastHoveredMesh !== mesh) {
    lastHoveredMesh = mesh;
    const star = mesh.userData as Star;
    tooltip.innerHTML = `
      <div class="star-name">${star.name}</div>
      <div class="star-dist">${(star.dist * 3.262).toFixed(1)} ly (${star.dist.toFixed(2)} pc)</div>
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

function updateDetailPanel() {
  if (!selectedMesh) {
    detail.classList.remove("active");
    return;
  }
  const star = selectedMesh.userData as Star;

  let distLine = `From Sol: ${(star.dist * 3.262).toFixed(1)} ly (${star.dist.toFixed(2)} pc)`;

  const aliasLine = star.aliases?.length
    ? `<div class="star-aliases">${star.aliases.join(" · ")}</div>`
    : "";
  const notesLine = star.notes
    ? `<div class="star-notes">${star.notes}</div>`
    : "";
  const wikiLink = star.wikipedia
    ? `<div class="star-wiki"><a href="${star.wikipedia}" target="_blank">Wikipedia \u2197</a></div>`
    : "";

  detail.innerHTML = `
    <div class="star-name">${star.name}</div>
    ${aliasLine}
    <div class="star-detail">
      ${distLine}<br>
      Magnitude: ${star.mag.toFixed(1)} (abs: ${star.absmag.toFixed(1)})<br>
      Spectral: ${star.spect || "\u2014"}<br>
      Luminosity: ${star.lum.toFixed(3)} L\u2609
    </div>
    ${notesLine}
    ${wikiLink}
  `;
  detail.classList.add("active");
}

// Track last input type so hover works on hybrid devices but not after touch
let lastInputWasTouch = false;
let hoveredViaLabel = false;

window.addEventListener("touchstart", () => { lastInputWasTouch = true; }, { capture: true });
window.addEventListener("mousemove", () => { lastInputWasTouch = false; }, { capture: true });

renderer.domElement.addEventListener("mousemove", (e) => {
  if (hoveredViaLabel || lastInputWasTouch) return;
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
  if (lastInputWasTouch) return;
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
  composer.setSize(window.innerWidth, window.innerHeight);
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
      if (star.name.toLowerCase().includes(q)) {
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
    li.textContent = `${entry.star.name}  (${(entry.star.dist * 3.262).toFixed(1)} ly)`;
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

// Select Sol on load
selectedMesh = starObjects[0];
updateDetailPanel();

// Bloom post-processing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.8,  // strength
  0.3,  // radius
  0.2,  // threshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

function animate(now: number) {
  requestAnimationFrame(animate);
  tickAnimation(now);
  composer.render();
  labelRenderer.render(scene, camera);
}
animate(performance.now());
