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
document.body.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(window.innerWidth, window.innerHeight);
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.top = "0";
labelRenderer.domElement.style.pointerEvents = "none";
labelRenderer.domElement.style.zIndex = "10";
labelRenderer.domElement.style.userSelect = "none";
labelRenderer.domElement.style.webkitUserSelect = "none";
document.body.appendChild(labelRenderer.domElement);

// Star shader material — procedural multi-layer glow
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

    // Billboard: always face camera
    vec4 mvCenter = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    // Logarithmic scaling: grows slowly when close, preserves presence when far
    float dist = -mvCenter.z;
    float scale = clamp(log(1.0 + dist * 0.5) * 0.2, 0.05, 0.3);
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

// Shared quad geometry for all star billboards
const starQuadGeo = new THREE.PlaneGeometry(1, 1);

(starsData as Star[]).forEach((star) => {
  const color = bvToColor(star.ci);

  // Billboard size based on luminosity (log scale)
  const quadSize = 0.4;
  // Brightness multiplier for the shader
  const brightness = Math.max(0.6, Math.min(2.0, 0.7 + 0.3 * Math.log10(Math.max(star.lum, 0.001))));

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
  labelDiv.style.cssText = `
    color: rgba(255,255,255,0.7); font-size: 10px;
    pointer-events: auto; white-space: nowrap; text-shadow: 0 0 4px #000;
    margin-top: 16px; user-select: none; text-align: center;
    cursor: pointer;
  `;
  labelDiv.textContent = star.name;
  labelMeshMap.set(labelDiv, mesh);
  meshLabelMap.set(mesh, labelDiv);
  labelDiv.setAttribute("data-star-label", "");
  labelDiv.addEventListener("mousedown", (e) => {
    e.preventDefault();
    // Forward to drag system so camera rotation works from labels
    isDragging = true;
    prevMouse.x = e.clientX;
    prevMouse.y = e.clientY;
    dragDistance = 0;
  });
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
  collapsedMembers: THREE.Mesh[];
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
    labelDiv.style.cssText = `
      color: rgba(255,255,255,0.7); font-size: 10px;
      pointer-events: auto; white-space: nowrap; text-shadow: 0 0 4px #000;
      margin-top: 16px; user-select: none; cursor: pointer; text-align: center;
    `;
    const memberNames = meshes.map((m) => (m.userData as Star).name);
    const membersHtml = `<div class="system-members">${memberNames.join(" · ")}</div>`;
    labelDiv.innerHTML = `<div>${name}</div>`;
    labelDiv.setAttribute("data-star-label", "");
    labelDiv.setAttribute("data-system-label", "");
    labelDiv.addEventListener("mousedown", (e) => {
      e.preventDefault();
      isDragging = true;
      prevMouse.x = e.clientX;
      prevMouse.y = e.clientY;
      dragDistance = 0;
    });

    const anchor = new THREE.Object3D();
    scene.add(anchor);
    const label = new CSS2DObject(labelDiv);
    label.center.set(0.5, 0);
    label.visible = false;
    anchor.add(label);

    const centroid = new THREE.Vector3();
    for (const m of meshes) centroid.add(m.position);
    centroid.divideScalar(meshes.length);

    const group: SystemGroup = { name, meshes, label, anchor, centroid, collapsedMembers: [] };
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

const HIGHLIGHT_BOOST = 1.25;

function highlightStar(mesh: THREE.Mesh) {
  (mesh.material as THREE.ShaderMaterial).uniforms.uHighlight.value = HIGHLIGHT_BOOST;
  meshLabelMap.get(mesh)?.classList.add("highlight");
}

function unhighlightStar(mesh: THREE.Mesh) {
  (mesh.material as THREE.ShaderMaterial).uniforms.uHighlight.value = 1.0;
  meshLabelMap.get(mesh)?.classList.remove("highlight");
}

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
  if (hits.length > 0) {
    const mesh = hits[0].object as THREE.Mesh;
    const sys = meshToSystem.get(mesh);
    if (sys) {
      selectSystem(sys);
    } else {
      selectStar(mesh);
    }
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

function formatDist(pc: number): string {
  return `${(pc * 3.262).toFixed(1)} ly (${pc.toFixed(2)} pc)`;
}

function renderWikiLink(url: string | undefined): string {
  return url ? `<div class="star-wiki"><a href="${url}" target="_blank">Wikipedia \u2197</a></div>` : "";
}

function renderNotes(text: string | undefined): string {
  return text ? `<div class="star-notes">${text}</div>` : "";
}

function showSystemMembers(group: SystemGroup) {
  const el = group.label.element as HTMLElement;
  const members = group.collapsedMembers.length > 0 ? group.collapsedMembers : group.meshes;
  const names = members.map((m) => (m.userData as Star).name);
  el.innerHTML = `<div>${group.name}</div><div class="system-members">${names.join(" · ")}</div>`;
  el.classList.add("highlight");
}

function hideSystemMembers(group: SystemGroup) {
  const el = group.label.element as HTMLElement;
  el.innerHTML = `<div>${group.name}</div>`;
  el.classList.remove("highlight");
}

function showHover(mesh: THREE.Mesh) {
  if (lastHoveredMesh === mesh) return;
  if (lastHoveredMesh && lastHoveredMesh !== selectedMesh) unhighlightStar(lastHoveredMesh);
  lastHoveredMesh = mesh;
  if (mesh !== selectedMesh) highlightStar(mesh);
}

function hideHover() {
  if (lastHoveredMesh && lastHoveredMesh !== selectedMesh) unhighlightStar(lastHoveredMesh);
  lastHoveredMesh = null;
}

function selectSystem(group: SystemGroup) {
  if (selectedMesh) unhighlightStar(selectedMesh);
  selectedMesh = null;
  if (selectedSystem && selectedSystem !== group) hideSystemMembers(selectedSystem);
  selectedSystem = group;
  showSystemMembers(group);

  animation = {
    from: target.clone(),
    to: group.centroid.clone(),
    start: performance.now(),
  };
  lastHoveredMesh = null;
  updateDetailPanel();
}

function updateSystemDetailPanel(group: SystemGroup) {
  const allMembers = group.meshes;
  const avgDist = allMembers.reduce((s, m) => s + (m.userData as Star).dist, 0) / allMembers.length;

  const wikiUrls = new Set<string>();
  const notes: string[] = [];
  const rows: string[] = [];
  for (const m of allMembers) {
    const s = m.userData as Star;
    const spect = s.spect ? `<span class="member-spect">${s.spect}</span>` : "";
    rows.push(`<div class="system-member-row">${s.name} — ${formatDist(s.dist)} ${spect}</div>`);
    if (s.wikipedia) wikiUrls.add(s.wikipedia);
    if (s.notes) notes.push(`<strong>${s.name}:</strong> ${s.notes}`);
  }

  detail.innerHTML = `
    <div class="star-name">${group.name}</div>
    <div class="star-detail">
      Distance: ${formatDist(avgDist)}
    </div>
    <div class="system-member-list">${rows.join("")}</div>
    ${notes.length > 0 ? `<div class="star-notes">${notes.join("<br>")}</div>` : ""}
    ${renderWikiLink([...wikiUrls][0])}
  `;
  detail.classList.add("active");
}

function selectStar(mesh: THREE.Mesh) {
  if (selectedMesh) unhighlightStar(selectedMesh);
  if (selectedSystem) { hideSystemMembers(selectedSystem); selectedSystem = null; }
  selectedMesh = mesh;
  highlightStar(mesh);
  animation = {
    from: target.clone(),
    to: mesh.position.clone(),
    start: performance.now(),
  };
  updateLabelVisibility();
  lastHoveredMesh = null;
  updateDetailPanel();
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
    ${aliasLine}
    <div class="star-detail">
      From Sol: ${formatDist(star.dist)}<br>
      Magnitude: ${star.mag.toFixed(1)} (abs: ${star.absmag.toFixed(1)})<br>
      Spectral: ${star.spect || "\u2014"}<br>
      Luminosity: ${star.lum.toFixed(3)} L\u2609
    </div>
    ${renderNotes(star.notes)}
    ${renderWikiLink(star.wikipedia)}
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
    const mesh = intersects[0].object as THREE.Mesh;
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
  } else {
    hideHover();
    if (hoveredSystem && hoveredSystem !== selectedSystem) {
      hideSystemMembers(hoveredSystem);
      hoveredSystem = null;
    }
  }
});

labelRenderer.domElement.addEventListener("mouseover", (e) => {
  if (lastInputWasTouch) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  hoveredViaLabel = true;
  const sys = meshToSystem.get(mesh);
  if (sys) {
    if (hoveredSystem !== sys && selectedSystem !== sys) {
      if (hoveredSystem && hoveredSystem !== selectedSystem) hideSystemMembers(hoveredSystem);
      hoveredSystem = sys;
      showSystemMembers(sys);
    }
  } else {
    showHover(mesh);
  }
});

labelRenderer.domElement.addEventListener("mousemove", (e) => {
  if (!hoveredViaLabel) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  const sys = meshToSystem.get(mesh);
  if (sys) {
    if (hoveredSystem !== sys && selectedSystem !== sys) {
      if (hoveredSystem && hoveredSystem !== selectedSystem) hideSystemMembers(hoveredSystem);
      hoveredSystem = sys;
      showSystemMembers(sys);
    }
  } else {
    showHover(mesh);
  }
});

labelRenderer.domElement.addEventListener("mouseout", (e) => {
  const label = (e.target as HTMLElement).closest("[data-star-label]") as HTMLElement | null;
  if (!label) return;
  const related = (e as MouseEvent).relatedTarget as HTMLElement | null;
  if (related && label.contains(related)) return;
  hoveredViaLabel = false;
  hideHover();
  if (hoveredSystem && hoveredSystem !== selectedSystem) {
    hideSystemMembers(hoveredSystem);
    hoveredSystem = null;
  }
});

labelRenderer.domElement.addEventListener("mouseup", (e) => {
  if (dragDistance >= CLICK_THRESHOLD) return;
  const mesh = meshFromLabel(e.target as HTMLElement);
  if (!mesh) return;
  const sys = meshToSystem.get(mesh);
  if (sys) {
    selectSystem(sys);
  } else {
    selectStar(mesh);
  }
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
    const seenSystems = new Set<string>();
    for (const mesh of starObjects) {
      const star = mesh.userData as Star;
      if (!starMatchesQuery(star, q)) continue;
      // Deduplicate system members — show system once
      if (star.system) {
        if (seenSystems.has(star.system)) continue;
        seenSystems.add(star.system);
      }
      filteredStars.push({ star, mesh });
      if (filteredStars.length >= MAX_SEARCH_RESULTS) break;
    }
  }
  selectedIndex = 0;
  renderSearchResults();
}

function renderSearchResults() {
  searchResults.innerHTML = "";
  filteredStars.forEach((entry, i) => {
    const li = document.createElement("li");
    const displayName = entry.star.system || entry.star.name;
    const sys = meshToSystem.get(entry.mesh);
    const dist = sys
      ? sys.meshes.reduce((s, m) => s + (m.userData as Star).dist, 0) / sys.meshes.length
      : entry.star.dist;
    li.textContent = `${displayName}  (${formatDist(dist)})`;
    if (i === selectedIndex) li.classList.add("selected");
    li.addEventListener("click", () => selectSearchResult(i));
    searchResults.appendChild(li);
  });
}

function selectSearchResult(index: number) {
  if (index < 0 || index >= filteredStars.length) return;
  const mesh = filteredStars[index].mesh;
  const sys = meshToSystem.get(mesh);
  if (sys) {
    selectSystem(sys);
  } else {
    selectStar(mesh);
  }
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
  0.8,  // strength
  0.3,  // radius
  0.2,  // threshold
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const LABEL_FADE_NEAR = 5;
const LABEL_FADE_FAR = 40;
const COLLAPSE_PX = 45;

const projVec = new THREE.Vector3();
function projectToScreen(pos: THREE.Vector3): { x: number; y: number } {
  projVec.copy(pos).project(camera);
  return {
    x: (projVec.x * 0.5 + 0.5) * window.innerWidth,
    y: (-projVec.y * 0.5 + 0.5) * window.innerHeight,
  };
}

// Per-frame: which meshes are currently collapsed into a system label
const currentCollapsed = new Set<THREE.Mesh>();

function updateLabels() {
  if (!labelsVisible) return;

  currentCollapsed.clear();

  // Dynamic screen-space clustering within each system
  for (const group of systemGroups) {
    const n = group.meshes.length;
    const screens = group.meshes.map((m) => projectToScreen(m.position));

    // Single-linkage clustering by screen distance
    const parent = group.meshes.map((_, i) => i);
    function find(i: number): number { return parent[i] === i ? i : (parent[i] = find(parent[i])); }
    function union(a: number, b: number) { parent[find(a)] = find(b); }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = screens[i].x - screens[j].x;
        const dy = screens[i].y - screens[j].y;
        if (Math.sqrt(dx * dx + dy * dy) < COLLAPSE_PX) {
          union(i, j);
        }
      }
    }

    // Find the largest cluster with 2+ members
    const clusters = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      if (!clusters.has(root)) clusters.set(root, []);
      clusters.get(root)!.push(i);
    }

    let bestCluster: number[] | null = null;
    for (const indices of clusters.values()) {
      if (indices.length >= 2 && (!bestCluster || indices.length > bestCluster.length)) {
        bestCluster = indices;
      }
    }

    if (bestCluster) {
      const collapsed = bestCluster.map((i) => group.meshes[i]);
      group.collapsedMembers = collapsed;

      // Position anchor at centroid of collapsed members
      group.anchor.position.set(0, 0, 0);
      for (const m of collapsed) group.anchor.position.add(m.position);
      group.anchor.position.divideScalar(collapsed.length);

      group.label.visible = true;
      const dist = group.anchor.position.distanceTo(camera.position);
      const opacity = 1.0 - THREE.MathUtils.smoothstep(dist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
      const zIndex = Math.round(10000 - dist * 100);
      const el = group.label.element as HTMLElement;
      el.style.opacity = String(Math.max(0.1, opacity));
      el.style.zIndex = String(zIndex);

      for (const m of collapsed) currentCollapsed.add(m);

      // Update hover text if this system is being hovered or selected
      if (hoveredSystem === group || selectedSystem === group) {
        showSystemMembers(group);
      }
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

    const isHighlighted = mesh === lastHoveredMesh || mesh === selectedMesh;
    const collapsed = currentCollapsed.has(mesh) && !isHighlighted;
    div.style.visibility = collapsed ? "hidden" : "visible";
    if (collapsed) continue;

    const camDist = mesh.position.distanceTo(camera.position);
    const zIndex = Math.round(10000 - camDist * 100);
    div.style.zIndex = String(zIndex);

    if (isHighlighted) {
      div.style.opacity = "1";
    } else {
      const opacity = 1.0 - THREE.MathUtils.smoothstep(camDist, LABEL_FADE_NEAR, LABEL_FADE_FAR);
      div.style.opacity = String(Math.max(0.1, opacity));
    }
  }
}

function animate(now: number) {
  requestAnimationFrame(animate);
  tickAnimation(now);
  updateLabels();
  composer.render();
  labelRenderer.render(scene, camera);
}
animate(performance.now());
