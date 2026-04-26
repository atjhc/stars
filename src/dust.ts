import * as THREE from "three";
import { camera } from "./scene.ts";
import { SCALE, TILE_BASE_URL } from "./constants.ts";
import { magLimitUniform } from "./starfield.ts";
// Float32 precision is adequate — dust spans ~6000 scene units.
const dustCamPosUniform: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };
// Sphere occluder for the focused planet/moon body — stops dust
// accumulation along rays that pass through it. Position is passed
// camera-relative (computed in CPU Float64) because the absolute
// world coords ~1.4e-5 are too close to Float32 ULP for the GPU to
// subtract safely; small bodies (~6e-10) would vanish in the noise.
const dustOccluderFromCamUniform: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };
const dustOccluderRadiusUniform: THREE.IUniform<number> = { value: 0 };
export function setDustOccluder(pos: THREE.Vector3 | null, radius: number): void {
  if (pos && radius > 0) {
    dustOccluderFromCamUniform.value.subVectors(pos, camera.position);
    dustOccluderRadiusUniform.value = radius;
  } else {
    dustOccluderRadiusUniform.value = 0;
  }
}

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

const emissionScene = new THREE.Scene();
let emissionMesh: THREE.Mesh | null = null;
let wantVisible = true;

// Half-resolution render target for the emission pass. Volumetric glow
// is inherently smooth, so half-res + bilinear upscale is nearly
// indistinguishable from full-res at ~4× less GPU cost.
let halfResRT: THREE.WebGLRenderTarget | null = null;
let blitMaterial: THREE.ShaderMaterial | null = null;
const blitScene = new THREE.Scene();
const blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);


const SHARED_VERTEX = `
  varying vec3 vWorldPos;
  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const EMISSION_FRAGMENT = `
  uniform sampler3D uDustVolume;
  uniform vec3 uVolumeSize;
  uniform mat3 uSceneToGal;
  uniform vec3 uCamWorldPos;
  uniform float uOpacity;
  uniform float uMagLimit;
  uniform vec3 uOccluderFromCam;
  uniform float uOccluderRadius;
  varying vec3 vWorldPos;

  vec3 sceneToUV(vec3 scenePos) {
    vec3 galPos = uSceneToGal * scenePos;
    return galPos / uVolumeSize + 0.5;
  }

  void main() {
    vec3 camRel = vWorldPos - uCamWorldPos;
    vec3 rayDir = normalize(camRel);
    vec3 pos = uCamWorldPos;
    float maxDist = length(camRel);

    // Optional sphere occluder — clip the ray when it enters the
    // focused body's surface so dust doesn't leak through it.
    // uOccluderFromCam is camera-relative (Float64 on the CPU);
    // see setDustOccluder for the precision rationale.
    if (uOccluderRadius > 0.0) {
      float b = dot(rayDir, uOccluderFromCam);
      float c = dot(uOccluderFromCam, uOccluderFromCam) - uOccluderRadius * uOccluderRadius;
      float disc = b * b - c;
      if (disc > 0.0) {
        float t = b - sqrt(disc);
        if (t > 0.0) maxDist = min(maxDist, t);
      }
    }

    float accumDensity = 0.0;
    float accumHII = 0.0;
    float accumRef = 0.0;
    float stepSize = 18.0;
    float traveled = 0.0;
    float magScale = pow(2.512, uMagLimit - 7.5);

    for (int i = 0; i < 128; i++) {
      if (traveled > maxDist) break;
      if (accumDensity > 4.0) break;
      vec3 uv = sceneToUV(pos);

      if (all(greaterThanEqual(uv, vec3(0.0))) && all(lessThanEqual(uv, vec3(1.0)))) {
        vec4 texel = texture(uDustVolume, uv);
        float density = texel.r;
        float ionFlux = texel.g;
        float scatFlux = texel.b;

        float transmittance = exp(-accumDensity);
        accumDensity += density * uOpacity * 0.3;

        float sampleDist = max(traveled, 1.0);
        float distAtten = 150.0 / (150.0 + sampleDist);

        float hiiEm = ionFlux * ionFlux * density;
        float refEm = scatFlux * scatFlux * density * 0.5;
        float brightness = uOpacity * 3.5 * distAtten * magScale;
        accumHII += hiiEm * transmittance * brightness;
        accumRef += refEm * transmittance * brightness;
      }

      pos += rayDir * stepSize;
      traveled += stepSize;
    }

    vec3 hiiColor = vec3(0.9, 0.2, 0.25);
    vec3 refColor = vec3(0.3, 0.45, 0.85);
    float total = accumHII + accumRef;
    vec3 color = total > 0.001
      ? (hiiColor * accumHII + refColor * accumRef) / total * total
      : vec3(0.0);
    float alpha = min(1.0, total);
    if (alpha < 0.001) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

function createEmissionMaterial(
  texture: THREE.Data3DTexture,
  volSize: THREE.Vector3,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uDustVolume: { value: texture },
      uVolumeSize: { value: volSize },
      uSceneToGal: { value: new THREE.Matrix3().copy(GAL_TO_SCENE).invert() },
      uCamWorldPos: dustCamPosUniform,
      uOpacity: { value: 0.04 },
      uMagLimit: magLimitUniform,
      uOccluderFromCam: dustOccluderFromCamUniform,
      uOccluderRadius: dustOccluderRadiusUniform,
    },
    vertexShader: SHARED_VERTEX,
    fragmentShader: EMISSION_FRAGMENT,
    blending: THREE.NormalBlending,  // writes to offscreen RT, not directly to screen
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
  });
}

export async function initDust(): Promise<void> {
  const [metaResp, dataResp] = await Promise.all([
    fetch(`${TILE_BASE_URL}dust_meta.json`),
    fetch(`${TILE_BASE_URL}dust_volume_rgba.bin`),
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
  dustTexture.format = THREE.RGBAFormat;
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

  const geometry = new THREE.BoxGeometry(1, 1, 1);

  const emMat = createEmissionMaterial(dustTexture, volSize);
  emissionMesh = new THREE.Mesh(geometry, emMat);
  emissionMesh.position.copy(center);
  emissionMesh.scale.copy(size);
  emissionMesh.frustumCulled = false;
  emissionScene.add(emissionMesh);

  const hw = Math.round(window.innerWidth * window.devicePixelRatio / 2);
  const hh = Math.round(window.innerHeight * window.devicePixelRatio / 2);
  halfResRT = new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType });

  // Fullscreen blit quad to upscale the half-res result. The RT was
  // filled with NormalBlending, so its RGB is already premultiplied by
  // accumulated alpha — tell the blend pipeline to treat it as such so
  // AdditiveBlending maps to (ONE, ONE) and we don't re-multiply by
  // alpha. Matches what the lensing shader does when it samples tDust
  // directly, so crossing the deep-zoom boundary doesn't change dust
  // brightness.
  blitMaterial = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: halfResRT.texture } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv; void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`,
    blending: THREE.AdditiveBlending,
    premultipliedAlpha: true,
    depthWrite: false,
    depthTest: false,
  });
  const blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMaterial);
  blitScene.add(blitQuad);

  console.log(`Dust volume: ${xSize}×${ySize}×${zSize} @ ${meta.resolution_pc} pc/voxel, bbox ${size.x.toFixed(0)}×${size.y.toFixed(0)}×${size.z.toFixed(0)}`);
}

export function updateDust(): void {
  dustCamPosUniform.value.copy(camera.position);
}

// Ray march to the half-res RT. Run every frame — the target-relative
// math in the fragment shader keeps the output stable across frames
// at deep zoom without any skip heuristic.
export function renderDustToRT(renderer: THREE.WebGLRenderer): void {
  if (!emissionMesh || !wantVisible || !halfResRT) return;
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(halfResRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.render(emissionScene, camera);
  renderer.setRenderTarget(prevTarget);
}

// Additive blit of halfResRT onto the screen. Used when lensing isn't
// active — when it is, the lensing pass samples tDust itself.
export function compositeDustToScreen(renderer: THREE.WebGLRenderer): void {
  if (!emissionMesh || !wantVisible || !halfResRT || !blitMaterial) return;
  blitMaterial.uniforms.tDiffuse.value = halfResRT.texture;
  renderer.setRenderTarget(null);
  const prev = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(blitScene, blitCamera);
  renderer.autoClear = prev;
}

export function getDustTexture(): THREE.Texture | null {
  return (emissionMesh && wantVisible && halfResRT) ? halfResRT.texture : null;
}

export function handleDustResize(): void {
  if (!halfResRT) return;
  const hw = Math.round(window.innerWidth * window.devicePixelRatio / 2);
  const hh = Math.round(window.innerHeight * window.devicePixelRatio / 2);
  halfResRT.setSize(hw, hh);
}

export function setDustVisible(v: boolean): void { wantVisible = v; }
export function isDustVisible(): boolean { return wantVisible; }
export function toggleDust(): void { wantVisible = !wantVisible; }
