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

// Prevent iOS Safari from scrolling the document (CSS2D labels expand beyond viewport)
document.addEventListener("touchmove", (e) => {
  if (!(e.target as HTMLElement).closest("#search-results, #detail")) {
    e.preventDefault();
  }
}, { passive: false });

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
  system?: string;
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
document.getElementById("viewport")!.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.top = "0";
labelRenderer.domElement.style.left = "0";
labelRenderer.domElement.style.overflow = "hidden";
labelRenderer.domElement.style.pointerEvents = "none";
labelRenderer.domElement.style.zIndex = "10";
labelRenderer.domElement.style.userSelect = "none";
labelRenderer.domElement.style.webkitUserSelect = "none";
document.getElementById("viewport")!.appendChild(labelRenderer.domElement);

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
    vBrightness = starBrightness * uHighlight;

    vec4 mvCenter = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float camDist = -mvCenter.z;
    float logScale = clamp(log(1.0 + camDist * 0.5) * 0.12, 0.02, 0.15);
    // Minimum scale proportional to distance — ensures enough pixels
    // for bloom downsample to capture the bright core consistently
    float minScale = camDist * 0.006;
    float scale = max(logScale, minScale);

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


const BLOOM_LAYER = 1;

const starGroup = new THREE.Group();
scene.add(starGroup);

const starObjects: THREE.Mesh[] = [];
const starLabels: CSS2DObject[] = [];
const labelMeshMap = new WeakMap<HTMLElement, THREE.Mesh>();
const meshLabelMap = new WeakMap<THREE.Mesh, HTMLElement>();
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

  // Exaggerate saturation so color differences are visible
  const avg = (r + g + b) / 3;
  const sat = 1.8;
  r = Math.min(1, Math.max(0, avg + (r - avg) * sat));
  g = Math.min(1, Math.max(0, avg + (g - avg) * sat));
  b = Math.min(1, Math.max(0, avg + (b - avg) * sat));

  return new THREE.Color(r, g, b);
}

const LABEL_CSS = `
  color: rgba(255,255,255,0.7); font-size: 10px;
  pointer-events: auto; white-space: nowrap; text-shadow: 0 0 4px #000;
  margin-top: 16px; user-select: none; text-align: center; cursor: pointer;
`;

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

// Shared quad geometry for all star billboards
const starQuadGeo = new THREE.PlaneGeometry(1, 1);

(starsData as Star[]).forEach((star) => {
  const color = bvToColor(star.ci);

  // Billboard size based on luminosity (log scale)
  const quadSize = 0.4;
  // Brightness multiplier for the shader
  const brightness = Math.max(0.8, Math.min(2.5, 0.9 + 0.35 * Math.log10(Math.max(star.lum, 0.001))));

  // Per-star shader material with attributes baked as uniforms
  const mat = new THREE.ShaderMaterial({
    uniforms: { uHighlight: { value: 1.0 } },
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

  const HIT_SCREEN_FRACTION = 0.02;
  const hitSphere = new THREE.Sphere();
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

// System labels: shown when members are close on screen, replacing individual labels
interface SystemGroup {
  name: string;
  meshes: THREE.Mesh[];
  label: CSS2DObject;
  anchor: THREE.Object3D;
  centroid: THREE.Vector3;
  avgDist: number;
  collapsedMembers: THREE.Mesh[];
  screens: { x: number; y: number }[];
  parents: number[];
  notable: boolean;
}

const systemGroups: SystemGroup[] = [];
const meshToSystem = new Map<THREE.Mesh, SystemGroup>();

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

    // Hover/click events for system label
    labelDiv.addEventListener("mouseenter", () => {
      if (selectedSystem !== group) {
        hoveredSystem = group;
        showSystemMembers(group);
      }
    });
    labelDiv.addEventListener("mouseleave", () => {
      if (hoveredSystem === group && selectedSystem !== group) {
        hoveredSystem = null;
        hideSystemMembers(group);
      }
    });
    labelDiv.addEventListener("mouseup", () => {
      if (dragDistance >= CLICK_THRESHOLD) return;
      selectSystem(group);
    });
  }
}

// Galactic north pole in equatorial coords: RA=192.8595deg, Dec=27.1284deg
// HYG uses equatorial coordinates; scene maps: x=eq_x, y=eq_z, z=-eq_y
const raGNP = (192.8595 * Math.PI) / 180;
const decGNP = (27.1284 * Math.PI) / 180;
const galNorthEq = new THREE.Vector3(
  Math.cos(decGNP) * Math.cos(raGNP),
  Math.sin(decGNP),
  -Math.cos(decGNP) * Math.sin(raGNP),
).normalize();

const GRID_SIZE = 300;
const GRID_DIVISIONS = 65;
const GRID_FADE_RADIUS = 30.0;

const gridShaderMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uCenter: { value: new THREE.Vector3(0, 0, 0) },
    uFadeRadius: { value: GRID_FADE_RADIUS },
    uColor: { value: new THREE.Color(0x4d7fc4) },
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

const HIGHLIGHT_BOOST = 1.5;

function setStarHighlight(mesh: THREE.Mesh, value: number) {
  const mat = mesh.material as THREE.ShaderMaterial;
  mat.uniforms.uHighlight.value = value;
  mat.uniformsNeedUpdate = true;
}

function highlightStar(mesh: THREE.Mesh) { setStarHighlight(mesh, HIGHLIGHT_BOOST); }
function unhighlightStar(mesh: THREE.Mesh) { setStarHighlight(mesh, 1.0); }

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
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
  if (hits.length > 0) selectTarget(hits[0].object as THREE.Mesh);
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
      touchStartRadius * Math.pow(touchStartDist / dist, 2.0),
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

function updateLabelVisibility() {
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
  labelsDirty = true;
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

function onWheel(e: WheelEvent) {
  e.preventDefault();
  orbitRadius = THREE.MathUtils.clamp(
    orbitRadius + e.deltaY * 0.02,
    MIN_ORBIT_RADIUS,
    MAX_ORBIT_RADIUS,
  );
  updateCamera();
}
renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
labelRenderer.domElement.addEventListener("wheel", onWheel, { passive: false });

let lastHoveredMesh: THREE.Mesh | null = null;
let selectedSystem: SystemGroup | null = null;
let hoveredSystem: SystemGroup | null = null;
const detail = document.getElementById("detail")!;
detail.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("a")) return;
  if (window.getSelection()?.toString()) return;
  detail.classList.toggle("collapsed");
});

function formatDist(pc: number): string {
  return `${(pc * 3.262).toFixed(1)} ly (${pc.toFixed(2)} pc)`;
}

function renderWikiLink(url: string | undefined): string {
  return url ? `<div class="star-wiki"><a href="${url}" target="_blank">Wikipedia</a></div>` : "";
}

function renderNotes(text: string | undefined): string {
  return text ? `<div class="star-notes">${text}</div>` : "";
}

const lastSystemLabelState = new WeakMap<SystemGroup, string>();

function updateSystemLabelText(group: SystemGroup) {
  const isActive = hoveredSystem === group || selectedSystem === group;
  const members = isActive
    ? (group.collapsedMembers.length > 0 ? group.collapsedMembers : group.meshes)
    : [];
  const key = isActive ? members.map((m) => (m.userData as Star).name).join(",") : "";

  if (lastSystemLabelState.get(group) === key) return;
  lastSystemLabelState.set(group, key);

  const el = group.label.element as HTMLElement;
  if (isActive) {
    const names = members.map((m) => (m.userData as Star).name);
    el.innerHTML = `<div>${group.name}</div><div class="system-members">${names.join(" · ")}</div>`;
  } else {
    el.innerHTML = `<div>${group.name}</div>`;
  }
}

function highlightSystem(group: SystemGroup) { group.meshes.forEach((m) => setStarHighlight(m, HIGHLIGHT_BOOST)); }
function unhighlightSystem(group: SystemGroup) { group.meshes.forEach((m) => setStarHighlight(m, 1.0)); }

function showSystemMembers(group: SystemGroup) {
  highlightSystem(group);
  updateSystemLabelText(group);
  labelsDirty = true;
}

function hideSystemMembers(group: SystemGroup) {
  unhighlightSystem(group);
  updateSystemLabelText(group);
  labelsDirty = true;
}

function animateTo(pos: THREE.Vector3) {
  animation = { from: target.clone(), to: pos.clone(), start: performance.now() };
}

function showHover(mesh: THREE.Mesh) {
  if (lastHoveredMesh === mesh) return;
  if (lastHoveredMesh && lastHoveredMesh !== selectedMesh) unhighlightStar(lastHoveredMesh);
  lastHoveredMesh = mesh;
  if (mesh !== selectedMesh) highlightStar(mesh);
  labelsDirty = true;
}

function hideHover() {
  if (lastHoveredMesh && lastHoveredMesh !== selectedMesh) unhighlightStar(lastHoveredMesh);
  lastHoveredMesh = null;
  labelsDirty = true;
}

function hoverTarget(mesh: THREE.Mesh) {
  const sys = meshToSystem.get(mesh);
  if (sys) {
    hideHover();
    if (hoveredSystem !== sys && selectedSystem !== sys) {
      if (hoveredSystem && hoveredSystem !== selectedSystem) hideSystemMembers(hoveredSystem);
      hoveredSystem = sys;
      showSystemMembers(sys);
    }
  } else {
    if (hoveredSystem && hoveredSystem !== selectedSystem) {
      hideSystemMembers(hoveredSystem);
      hoveredSystem = null;
    }
    showHover(mesh);
  }
}

function unhoverAll() {
  hideHover();
  if (hoveredSystem && hoveredSystem !== selectedSystem) {
    hideSystemMembers(hoveredSystem);
    hoveredSystem = null;
  }
}

function selectTarget(mesh: THREE.Mesh) {
  const sys = meshToSystem.get(mesh);
  if (sys) {
    selectSystem(sys);
  } else {
    selectStar(mesh);
  }
}

function selectSystem(group: SystemGroup) {
  if (selectedMesh) unhighlightStar(selectedMesh);
  selectedMesh = null;
  if (selectedSystem && selectedSystem !== group) hideSystemMembers(selectedSystem);
  selectedSystem = group;
  showSystemMembers(group);
  labelsDirty = true;

  // For tight systems, focus on centroid; for wide systems, focus on nearest member
  let nearest = group.meshes[0];
  let nearestDist = Infinity;
  for (const m of group.meshes) {
    const d = m.position.distanceTo(camera.position);
    if (d < nearestDist) { nearest = m; nearestDist = d; }
  }
  const focusTarget = nearest.position.distanceTo(group.centroid) < 0.5
    ? group.centroid : nearest.position;
  animateTo(focusTarget);
  lastHoveredMesh = null;
  updateDetailPanel();
}

function selectStar(mesh: THREE.Mesh) {
  if (selectedMesh) unhighlightStar(selectedMesh);
  if (selectedSystem) { hideSystemMembers(selectedSystem); selectedSystem = null; }
  selectedMesh = mesh;
  highlightStar(mesh);
  labelsDirty = true;
  animateTo(mesh.position);
  updateLabelVisibility();
  lastHoveredMesh = null;
  updateDetailPanel();
}

function updateSystemDetailPanel(group: SystemGroup) {
  const wikiUrls = new Set<string>();
  const notes: string[] = [];
  const rows: string[] = [];
  for (const m of group.meshes) {
    const s = m.userData as Star;
    const spect = s.spect ? `<span class="member-spect">${s.spect}</span>` : "";
    rows.push(`<div class="system-member-row">${s.name} — ${formatDist(s.dist)} ${spect}</div>`);
    if (s.wikipedia) wikiUrls.add(s.wikipedia);
    if (s.notes) notes.push(`<strong>${s.name}:</strong> ${s.notes}`);
  }

  detail.innerHTML = `
    <div class="star-name">${group.name}</div>
    <div class="detail-body">
      <div class="star-detail">
        Distance: ${formatDist(group.avgDist)}
      </div>
      <div class="system-member-list">${rows.join("")}</div>
      ${notes.length > 0 ? `<div class="star-notes">${notes.join("<br>")}</div>` : ""}
      ${renderWikiLink([...wikiUrls][0])}
    </div>
  `;
  detail.classList.add("active");
}

function updateDetailPanel() {
  if (selectedSystem) {
    updateSystemDetailPanel(selectedSystem);
    return;
  }

  if (!selectedMesh) {
    detail.classList.remove("active");
    return;
  }
  const star = selectedMesh.userData as Star;

  const aliasLine = star.aliases?.length
    ? `<div class="star-aliases">${star.aliases.join(" · ")}</div>`
    : "";

  detail.innerHTML = `
    <div class="star-name">${star.name}</div>
    <div class="detail-body">
      ${aliasLine}
      <div class="star-detail">
        From Sol: ${formatDist(star.dist)}<br>
        Magnitude: ${star.mag.toFixed(1)} (abs: ${star.absmag.toFixed(1)})<br>
        Spectral: ${star.spect || "\u2014"}<br>
        Luminosity: ${star.lum.toFixed(3)} L\u2609
      </div>
      ${renderNotes(star.notes)}
      ${renderWikiLink(star.wikipedia)}
    </div>
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
    hoverTarget(intersects[0].object as THREE.Mesh);
  } else {
    unhoverAll();
  }
});

labelRenderer.domElement.addEventListener("mouseover", (e) => {
  if (lastInputWasTouch) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  hoveredViaLabel = true;
  hoverTarget(mesh);
});

labelRenderer.domElement.addEventListener("mousemove", (e) => {
  if (!hoveredViaLabel) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  hoverTarget(mesh);
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
  if (mesh) selectTarget(mesh);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  labelRenderer.setSize(window.innerWidth, window.innerHeight);
  labelsDirty = true;
});

const searchEl = document.getElementById("search")!;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchResults = document.getElementById("search-results")!;
const searchBtn = document.getElementById("search-btn")!;
let searchOpen = false;
let selectedIndex = 0;
let filteredStars: { star: Star; mesh: THREE.Mesh }[] = [];

function openSearch() {
  searchOpen = true;
  searchEl.classList.add("active");
  searchBtn.classList.add("hidden");
  searchInput.value = "";
  updateSearchResults("");
  searchInput.focus();
}

function closeSearch() {
  searchOpen = false;
  searchEl.classList.remove("active");
  searchBtn.classList.remove("hidden");
  searchInput.blur();
}

searchBtn.addEventListener("pointerup", (e) => {
  e.preventDefault();
  e.stopPropagation();
  openSearch();
});

function starMatchesQuery(star: Star, q: string): boolean {
  if (star.name.toLowerCase().includes(q)) return true;
  if (star.system?.toLowerCase().includes(q)) return true;
  if (star.aliases?.some((a) => a.toLowerCase().includes(q))) return true;
  return false;
}

function updateSearchResults(query: string) {
  const q = query.toLowerCase().trim();
  filteredStars = [];
  if (q.length > 0) {
    // Two passes: primary name/system matches first, then alias matches
    const seen = new Set<THREE.Mesh>();

    for (const mesh of starObjects) {
      const star = mesh.userData as Star;
      const nameMatch = star.name.toLowerCase().includes(q);
      const sysMatch = star.system?.toLowerCase().includes(q) ?? false;
      if (!nameMatch && !sysMatch) continue;
      seen.add(mesh);
      filteredStars.push({ star, mesh });
      if (filteredStars.length >= MAX_SEARCH_RESULTS) break;
    }

    if (filteredStars.length < MAX_SEARCH_RESULTS) {
      const seenSystems = new Set<string>();
      for (const mesh of starObjects) {
        if (seen.has(mesh)) continue;
        const star = mesh.userData as Star;
        if (!star.aliases?.some((a) => a.toLowerCase().includes(q))) continue;
        if (star.system) {
          if (seenSystems.has(star.system)) continue;
          seenSystems.add(star.system);
        }
        filteredStars.push({ star, mesh });
        if (filteredStars.length >= MAX_SEARCH_RESULTS) break;
      }
    }
  }
  selectedIndex = 0;
  renderSearchResults();
}

function findMatchSource(star: Star, q: string): string | null {
  if (star.name.toLowerCase().includes(q)) return null;
  if (star.system?.toLowerCase().includes(q)) return star.system;
  const alias = star.aliases?.find((a) => a.toLowerCase().includes(q));
  if (alias) return alias;
  return null;
}

function renderSearchResults() {
  searchResults.innerHTML = "";
  const q = searchInput.value.toLowerCase().trim();
  filteredStars.forEach((entry, i) => {
    const li = document.createElement("li");
    const sys = meshToSystem.get(entry.mesh);
    const primaryName = sys ? sys.name : entry.star.name;
    const matchSource = findMatchSource(entry.star, q);
    // Show the star's own name if it differs from the system name
    const secondary = matchSource && matchSource !== primaryName
      ? matchSource
      : (sys && entry.star.name !== sys.name ? entry.star.name : null);

    if (secondary) {
      li.innerHTML = `${primaryName} <span class="search-secondary">${secondary}</span>`;
    } else {
      li.textContent = primaryName;
    }
    if (i === selectedIndex) li.classList.add("selected");
    li.addEventListener("click", () => selectSearchResult(i));
    searchResults.appendChild(li);
  });
}

function selectSearchResult(index: number) {
  if (index < 0 || index >= filteredStars.length) return;
  selectTarget(filteredStars[index].mesh);
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

searchInput.addEventListener("blur", () => {
  setTimeout(() => { if (searchOpen) closeSearch(); }, 150);
});

searchInput.addEventListener("input", () => {
  updateSearchResults(searchInput.value);
});

// Select Sol on load
selectedMesh = starObjects[0];
highlightStar(selectedMesh);
updateDetailPanel();

// Bloom post-processing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  1.2,  // strength
  0.5,  // radius
  0.15, // threshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const LABEL_FADE_NEAR = 8;
const LABEL_FADE_FAR = 50;
const LABEL_HIDE_DIST = 55;
const COLLAPSE_PX = 45;
const COLLAPSE_PX_SQ = COLLAPSE_PX * COLLAPSE_PX;

const projVec = new THREE.Vector3();
const screenBuf = { x: 0, y: 0 };
function projectToScreen(pos: THREE.Vector3): typeof screenBuf {
  projVec.copy(pos).project(camera);
  screenBuf.x = (projVec.x * 0.5 + 0.5) * window.innerWidth;
  screenBuf.y = (-projVec.y * 0.5 + 0.5) * window.innerHeight;
  return screenBuf;
}

let labelsDirty = true;
const prevCamPos = new THREE.Vector3();

function setLabelStyle(div: HTMLElement, opacity: string, zIndex: string, visible: boolean) {
  div.style.visibility = visible ? "visible" : "hidden";
  div.style.opacity = opacity;
  div.style.zIndex = zIndex;
}

function updateLabels() {
  if (!labelsVisible) return;

  if (!labelsDirty) return;

  const collapsed = new Set<THREE.Mesh>();

  // Dynamic screen-space clustering within each system
  for (const group of systemGroups) {
    const n = group.meshes.length;
    const screens = group.screens;
    const parent = group.parents;

    for (let i = 0; i < n; i++) {
      const s = projectToScreen(group.meshes[i].position);
      screens[i].x = s.x;
      screens[i].y = s.y;
      parent[i] = i;
    }

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

    // Find the largest cluster with 2+ members
    const clusterCounts = new Map<number, number>();
    let bestRoot = -1, bestCount = 0;
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const count = (clusterCounts.get(root) || 0) + 1;
      clusterCounts.set(root, count);
      if (count > bestCount && count >= 2) { bestRoot = root; bestCount = count; }
    }

    if (bestRoot >= 0) {
      const members: THREE.Mesh[] = [];
      for (let i = 0; i < n; i++) {
        if (find(i) === bestRoot) members.push(group.meshes[i]);
      }
      group.collapsedMembers = members;

      group.anchor.position.set(0, 0, 0);
      for (const m of members) group.anchor.position.add(m.position);
      group.anchor.position.divideScalar(members.length);

      for (const m of members) collapsed.add(m);

      const dist = group.anchor.position.distanceTo(camera.position);
      const isSystemHighlighted = hoveredSystem === group || selectedSystem === group;
      group.label.visible = (group.notable && dist <= LABEL_HIDE_DIST) || isSystemHighlighted;
      if (!group.label.visible) continue;
      const opacity = isSystemHighlighted ? 1.0 : 1.0 - THREE.MathUtils.smoothstep(dist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
      const zIndex = Math.round(10000 - dist * 100);
      const el = group.label.element as HTMLElement;
      setLabelStyle(el, String(Math.max(0.2, opacity)), String(zIndex), true);
      updateSystemLabelText(group);
    } else {
      group.collapsedMembers = [];
      group.label.visible = false;

      if (hoveredSystem === group) {
        hoveredSystem = null;
      }
    }
  }

  // Update individual star labels
  for (const mesh of starObjects) {
    const div = meshLabelMap.get(mesh);
    if (!div) continue;

    const camDist = mesh.position.distanceTo(camera.position);
    const sys = meshToSystem.get(mesh);

    // Collapsed system members always hidden — the system label handles display
    if (collapsed.has(mesh)) {
      setLabelStyle(div, "0", "0", false);
      continue;
    }

    const isHighlighted = mesh === lastHoveredMesh || mesh === selectedMesh
      || (sys !== undefined && (sys === hoveredSystem || sys === selectedSystem));
    const star = mesh.userData as Star;
    const isNotable = !!star.wikipedia;

    // Non-notable stars only show label when highlighted
    if (!isNotable && !isHighlighted) {
      setLabelStyle(div, "0", "0", false);
      continue;
    }

    // Hide labels beyond visible range
    if (camDist > LABEL_HIDE_DIST && !isHighlighted) {
      setLabelStyle(div, "0", "0", false);
      continue;
    }

    const zIndex = String(Math.round(10000 - camDist * 100));
    if (isHighlighted) {
      setLabelStyle(div, "1", zIndex, true);
    } else {
      const opacity = 1.0 - THREE.MathUtils.smoothstep(camDist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
      setLabelStyle(div, String(Math.max(0.2, opacity)), zIndex, true);
    }
  }

  labelsDirty = false;
  prevCamPos.copy(camera.position);
}

function animate(now: number) {
  requestAnimationFrame(animate);
  tickAnimation(now);
  // Check if camera moved since last frame
  if (!prevCamPos.equals(camera.position)) labelsDirty = true;
  updateLabels();
  composer.render();
  labelRenderer.render(scene, camera);
}
animate(performance.now());
