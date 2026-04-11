import * as THREE from "three";
import { camera } from "./scene.ts";
import { SCALE, TILE_BASE_URL } from "./constants.ts";

// Galactic Cartesian → Drake scene. Derived in build-catalog.py from
// IAU galactic pole (RA=192.86°, Dec=27.13°) + equatorial→scene swap.
const GAL_TO_SCENE = new THREE.Matrix3().set(
  -0.054876, 0.494111, -0.867665,
  -0.483835, 0.746982,  0.455985,
   0.873437, 0.444829,  0.198076,
);

interface DustMeta {
  shape: [number, number, number];
  resolution_pc: number;
  extent_pc: [number, number, number];
}

const dustScene = new THREE.Scene();
let dustMesh: THREE.Mesh | null = null;
let wantVisible = false;

export async function initDust(): Promise<void> {
  const [metaResp, dataResp] = await Promise.all([
    fetch(`${TILE_BASE_URL}dust_meta.json`),
    fetch(`${TILE_BASE_URL}dust_volume.bin`),
  ]);
  if (!metaResp.ok || !dataResp.ok) {
    console.warn("Dust volume not available");
    return;
  }

  const meta: DustMeta = await metaResp.json();
  const buffer = await dataResp.arrayBuffer();
  const data = new Uint8Array(buffer);
  const [zSize, ySize, xSize] = meta.shape;

  const dustTexture = new THREE.Data3DTexture(data, xSize, ySize, zSize);
  dustTexture.format = THREE.RedFormat;
  dustTexture.type = THREE.UnsignedByteType;
  dustTexture.minFilter = THREE.LinearFilter;
  dustTexture.magFilter = THREE.LinearFilter;
  dustTexture.wrapS = THREE.ClampToEdgeWrapping;
  dustTexture.wrapT = THREE.ClampToEdgeWrapping;
  dustTexture.wrapR = THREE.ClampToEdgeWrapping;
  dustTexture.needsUpdate = true;

  const galHalf = new THREE.Vector3(
    meta.extent_pc[0] / 2, meta.extent_pc[1] / 2, meta.extent_pc[2] / 2,
  );
  const corners: THREE.Vector3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1])
        corners.push(new THREE.Vector3(sx * galHalf.x, sy * galHalf.y, sz * galHalf.z)
          .applyMatrix3(GAL_TO_SCENE).multiplyScalar(SCALE));

  const box = new THREE.Box3().setFromPoints(corners);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const volSize = new THREE.Vector3(
    meta.extent_pc[0] * SCALE, meta.extent_pc[1] * SCALE, meta.extent_pc[2] * SCALE,
  );

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uDustVolume: { value: dustTexture },
      uVolumeSize: { value: volSize },
      uSceneToGal: { value: new THREE.Matrix3().copy(GAL_TO_SCENE).invert() },
      uCameraPos: { value: new THREE.Vector3() },
      uOpacity: { value: 0.12 },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform sampler3D uDustVolume;
      uniform vec3 uVolumeSize;
      uniform mat3 uSceneToGal;
      uniform vec3 uCameraPos;
      uniform float uOpacity;
      varying vec3 vWorldPos;

      vec3 sceneToUV(vec3 scenePos) {
        vec3 galPos = uSceneToGal * scenePos;
        return galPos / uVolumeSize + 0.5;
      }

      void main() {
        vec3 rayDir = normalize(vWorldPos - uCameraPos);
        vec3 pos = uCameraPos;
        float maxDist = length(vWorldPos - uCameraPos);

        float accumLight = 0.0;
        float accumDensity = 0.0;
        float stepSize = 9.0;
        float traveled = 0.0;

        for (int i = 0; i < 256; i++) {
          if (traveled > maxDist) break;
          vec3 uv = sceneToUV(pos);

          if (all(greaterThanEqual(uv, vec3(0.0))) && all(lessThanEqual(uv, vec3(1.0)))) {
            float density = texture(uDustVolume, uv).r;
            // Square density for contrast: dense cores glow much
            // brighter than diffuse edges. This makes thin nearby
            // clouds visible without over-saturating long sightlines.
            float emission = density * density;
            float transmittance = exp(-accumDensity);
            accumLight += emission * transmittance * uOpacity;
            accumDensity += density * uOpacity * 0.3;
          }

          pos += rayDir * stepSize;
          traveled += stepSize;
        }

        // Color varies with density and depth:
        // - Diffuse outer regions: blue-purple (starlight scattered by dust)
        // - Moderate density: warm amber (heated dust thermal emission)
        // - Dense cores: reddish-pink (Hα emission from ionized hydrogen)
        vec3 scatterColor = vec3(0.25, 0.35, 0.75);  // blue reflection
        vec3 warmColor = vec3(0.85, 0.45, 0.2);       // amber dust glow
        vec3 emissionColor = vec3(0.9, 0.25, 0.3);    // Hα red-pink

        float t = smoothstep(0.0, 0.3, accumLight);
        float t2 = smoothstep(0.3, 0.8, accumLight);
        vec3 nebulaColor = mix(scatterColor, warmColor, t);
        nebulaColor = mix(nebulaColor, emissionColor, t2);

        vec3 color = nebulaColor * accumLight;
        float alpha = min(1.0, accumLight);
        if (alpha < 0.001) discard;

        gl_FragColor = vec4(color, alpha);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
  });

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  dustMesh = new THREE.Mesh(geometry, material);
  dustMesh.position.copy(center);
  dustMesh.scale.copy(size);
  dustMesh.frustumCulled = false;
  dustScene.add(dustMesh);

  console.log(`Dust volume: ${xSize}×${ySize}×${zSize}, bbox ${size.x.toFixed(0)}×${size.y.toFixed(0)}×${size.z.toFixed(0)}`);
}

export function updateDust(): void {
  if (!dustMesh || !wantVisible) return;
  (dustMesh.material as THREE.ShaderMaterial).uniforms.uCameraPos.value.copy(camera.position);
}

export function renderDustPostBloom(renderer: THREE.WebGLRenderer): void {
  if (!dustMesh || !wantVisible) return;
  // Render the dust volume AFTER the bloom compositor has written to
  // the screen. Multiply blending darkens the bloomed starfield.
  renderer.setRenderTarget(null);
  const prev = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(dustScene, camera);
  renderer.autoClear = prev;
}

export function setDustVisible(v: boolean): void { wantVisible = v; }
export function isDustVisible(): boolean { return wantVisible; }
export function toggleDust(): void { wantVisible = !wantVisible; }
