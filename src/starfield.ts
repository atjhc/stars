import * as THREE from "three";
import { scene, camera } from "./scene.ts";

interface TileMeta {
  file: string;
  stars: number;
  min: [number, number, number];
  max: [number, number, number];
  depth: number;
}

interface CatalogMeta {
  tileCount: number;
  totalStars: number;
  bytesPerStar: number;
  format: string;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  tiles: Record<string, TileMeta>;
}

const BYTES_PER_STAR = 16;
const MAX_LOADED_TILES = 80;
const TILE_BASE_URL = "/tiles/";

// Point cloud shader — simpler than billboard stars, optimized for millions
const pointVertexShader = `
  attribute float brightness;
  attribute vec3 starColor;
  varying vec3 vColor;
  varying float vBrightness;

  void main() {
    vColor = starColor;
    vBrightness = brightness / 255.0;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float dist = -mvPosition.z;
    float baseSize = max(2.0, vBrightness * 4.0);
    float rawSize = baseSize * (500.0 / dist);
    // Fade brightness smoothly as point size shrinks to avoid popping
    float fadeFactor = smoothstep(4.0, 8.0, rawSize);
    vBrightness *= fadeFactor;
    // Discard fully faded stars
    if (fadeFactor < 0.01) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    gl_PointSize = clamp(rawSize, 4.0, 16.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const pointFragmentShader = `
  varying vec3 vColor;
  varying float vBrightness;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    // Same glow model as billboard stars for visual consistency
    float core = exp(-d * d * 30.0);
    float halo = 1.0 / (1.0 + pow(d * 6.0, 2.0));
    float outerGlow = exp(-d * 4.0) * 0.3;
    float intensity = (core + halo * 0.4 + outerGlow) * vBrightness * 2.5;
    vec3 color = mix(vColor, vec3(1.0), smoothstep(0.3, 1.0, core * vBrightness));
    gl_FragColor = vec4(color * intensity, intensity);
  }
`;

const pointMaterial = new THREE.ShaderMaterial({
  vertexShader: pointVertexShader,
  fragmentShader: pointFragmentShader,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: true,
});

// State
let catalogMeta: CatalogMeta | null = null;
const loadedTiles = new Map<string, { geometry: THREE.BufferGeometry; points: THREE.Points; lastUsed: number }>();
let pointsGroup: THREE.Group;

function tileBoundingSphere(tile: TileMeta): THREE.Sphere {
  const center = new THREE.Vector3(
    (tile.min[0] + tile.max[0]) / 2,
    (tile.min[1] + tile.max[1]) / 2,
    (tile.min[2] + tile.max[2]) / 2,
  );
  const halfSize = new THREE.Vector3(
    (tile.max[0] - tile.min[0]) / 2,
    (tile.max[1] - tile.min[1]) / 2,
    (tile.max[2] - tile.min[2]) / 2,
  );
  return new THREE.Sphere(center, halfSize.length());
}

function shouldLoadTile(tile: TileMeta, frustum: THREE.Frustum, camPos: THREE.Vector3): boolean {
  const sphere = tileBoundingSphere(tile);
  if (!frustum.intersectsSphere(sphere)) return false;

  // Distance-based priority: don't load very distant tiles
  const dist = sphere.center.distanceTo(camPos);
  const maxDist = 800; // scene units
  return dist < maxDist;
}

async function loadTile(path: string, tile: TileMeta) {
  if (loadedTiles.has(path)) {
    loadedTiles.get(path)!.lastUsed = performance.now();
    return;
  }

  try {
    const response = await fetch(`${TILE_BASE_URL}${tile.file}`);
    if (!response.ok) return;
    const buffer = await response.arrayBuffer();
    const starCount = buffer.byteLength / BYTES_PER_STAR;

    const positions = new Float32Array(starCount * 3);
    const brightnesses = new Float32Array(starCount);
    const colors = new Float32Array(starCount * 3);

    const view = new DataView(buffer);
    for (let i = 0; i < starCount; i++) {
      const offset = i * BYTES_PER_STAR;
      positions[i * 3] = view.getFloat32(offset, true);
      positions[i * 3 + 1] = view.getFloat32(offset + 4, true);
      positions[i * 3 + 2] = view.getFloat32(offset + 8, true);
      brightnesses[i] = view.getUint8(offset + 12);
      colors[i * 3] = view.getUint8(offset + 13) / 255;
      colors[i * 3 + 1] = view.getUint8(offset + 14) / 255;
      colors[i * 3 + 2] = view.getUint8(offset + 15) / 255;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("brightness", new THREE.BufferAttribute(brightnesses, 1));
    geometry.setAttribute("starColor", new THREE.BufferAttribute(colors, 3));

    const points = new THREE.Points(geometry, pointMaterial);
    points.frustumCulled = false;
    pointsGroup.add(points);

    loadedTiles.set(path, { geometry, points, lastUsed: performance.now() });
  } catch (e) {
    // Silently skip failed tiles
  }
}

function evictOldTiles() {
  if (loadedTiles.size <= MAX_LOADED_TILES) return;

  const entries = [...loadedTiles.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  const toEvict = entries.slice(0, loadedTiles.size - MAX_LOADED_TILES);
  for (const [path, tile] of toEvict) {
    pointsGroup.remove(tile.points);
    tile.geometry.dispose();
    loadedTiles.delete(path);
  }
}

const frustum = new THREE.Frustum();
const projScreenMatrix = new THREE.Matrix4();
let lastUpdateTime = 0;
const UPDATE_INTERVAL = 500; // ms between tile checks

export async function initStarfield() {
  pointsGroup = new THREE.Group();
  scene.add(pointsGroup);

  try {
    const response = await fetch(`${TILE_BASE_URL}meta.json`);
    if (!response.ok) {
      console.warn("Star tiles not found — run scripts/build-tiles.py to generate");
      return;
    }
    catalogMeta = await response.json();
    console.log(`Star catalog: ${catalogMeta!.totalStars} stars in ${catalogMeta!.tileCount} tiles`);
  } catch {
    console.warn("Could not load star tile metadata");
  }
}

export function updateStarfield() {
  if (!catalogMeta) return;

  const now = performance.now();
  if (now - lastUpdateTime < UPDATE_INTERVAL) return;
  lastUpdateTime = now;

  // Build frustum from camera
  projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreenMatrix);

  const camPos = camera.position;

  // Check which tiles should be loaded
  for (const [path, tile] of Object.entries(catalogMeta.tiles)) {
    if (shouldLoadTile(tile, frustum, camPos)) {
      loadTile(path, tile);
    } else {
      // Hide tiles that are out of view
      const loaded = loadedTiles.get(path);
      if (loaded) loaded.points.visible = false;
    }
  }

  // Show visible loaded tiles
  for (const [path, loaded] of loadedTiles) {
    const tile = catalogMeta.tiles[path];
    if (tile && shouldLoadTile(tile, frustum, camPos)) {
      loaded.points.visible = true;
      loaded.lastUsed = now;
    }
  }

  evictOldTiles();
}
