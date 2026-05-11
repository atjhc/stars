import * as THREE from "three";
import { camera, getRenderPixelRatio, qualityProfile, GAL_TO_SCENE, scene, BLOOM_OVERSCAN } from "./scene.ts";
import { SCALE, TILE_BASE_URL } from "./constants.ts";
import { magLimitUniform } from "./starfield.ts";
import { registerKeepFrame } from "./renderLoop.ts";
import { isSkyboxVisible } from "./skybox.ts";
// Float32 precision is adequate — dust spans ~6000 scene units.
const dustCamPosUniform: THREE.IUniform<THREE.Vector3> = { value: new THREE.Vector3() };

interface DustMeta {
  shape: [number, number, number];
  resolution_pc: number;
  extent_pc: [number, number, number];
}

const emissionScene = new THREE.Scene();
let emissionMesh: THREE.Mesh | null = null;
let wantVisible = true;

const TARGET_OPACITY = 0.025;
const FADE_DURATION_MS = 1200;
let fadeStartMs = -1;
registerKeepFrame(() => fadeStartMs >= 0);

// Half-resolution render target for the emission pass. Volumetric glow
// is inherently smooth, so half-res + bilinear upscale is nearly
// indistinguishable from full-res at ~4× less GPU cost.
let halfResRT: THREE.WebGLRenderTarget | null = null;
let inSceneDustMesh: THREE.Mesh | null = null;


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
  uniform float uExtinctionStrength;
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

    float accumDensity = 0.0;
    float accumExt = 0.0;
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
        // Raw integrated density for backdrop extinction. Decoupled
        // from uOpacity (which controls emission brightness) so we
        // can dial extinction independently of dust glow.
        accumExt += density;

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
    float emAlpha = min(1.0, total);
    float opticalDepth = accumExt * uExtinctionStrength;
    if (emAlpha < 0.001 && opticalDepth < 0.001) discard;
    // RGB premultiplied for AdditiveBlending into the zero-cleared RT;
    // alpha carries optical depth for the skybox extinction lookup.
    gl_FragColor = vec4(color * emAlpha, opticalDepth);
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
      uOpacity: { value: 0 },
      uMagLimit: magLimitUniform,
      uExtinctionStrength: { value: 0.025 },
    },
    vertexShader: SHARED_VERTEX,
    fragmentShader: EMISSION_FRAGMENT,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
  });
}

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
  // 3-channel: alpha was always 255 (the shader only reads .rgb), so
  // baking and uploading without it cuts GPU memory by 25%. WebGL2 3D
  // textures need a SIZED internalFormat — `RGB8` — since the unsized
  // `RGB` is invalid for texImage3D.
  dustTexture.format = THREE.RGBFormat;
  dustTexture.internalFormat = "RGB8";
  dustTexture.type = THREE.UnsignedByteType;
  dustTexture.minFilter = THREE.LinearFilter;
  dustTexture.magFilter = THREE.LinearFilter;
  dustTexture.wrapS = THREE.ClampToEdgeWrapping;
  dustTexture.wrapT = THREE.ClampToEdgeWrapping;
  dustTexture.wrapR = THREE.ClampToEdgeWrapping;
  // 333 voxels × 3 bytes = 999 bytes/row, not a multiple of 4. Default
  // UNPACK_ALIGNMENT (4) would mis-align rows; Three.js sets this on
  // upload from `texture.unpackAlignment`, but defaults to 4 — so we
  // override to 1.
  dustTexture.unpackAlignment = 1;
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

  const [hw, hh] = computeDustRTSize();
  halfResRT = new THREE.WebGLRenderTarget(hw, hh, { type: THREE.HalfFloatType });

  // In-scene depth-tested upscale mesh. Rendered as part of the main
  // RenderPass so the GPU's hardware depth test occludes dust behind
  // planet meshes. The quad is positioned at NDC z = far plane so the
  // depth test passes wherever no opaque geometry wrote a closer Z;
  // planets (which write depth) hide dust on their pixels, while stars
  // (depthWrite:false) don't.
  // The mesh samples halfResRT — already raymarched at half-res before
  // composer.render() — so this is just an upscale, not a re-march.
  // The composer renders with a BLOOM_OVERSCAN-widened FOV; the visible
  // viewport's NDC range is [-1/BLOOM_OVERSCAN, +1/BLOOM_OVERSCAN], so
  // we scale clip-space xy by BLOOM_OVERSCAN to map composer NDC to
  // halfResRT UV. Pixels in the overscan band sample outside [0,1] and
  // get clamped to halfResRT's edge — negligible, since the dust there
  // would also be cropped out.
  const inSceneDustMaterial = new THREE.ShaderMaterial({
    uniforms: { tDust: { value: halfResRT.texture } },
    vertexShader: `
      varying vec2 vDustUv;
      void main() {
        vDustUv = position.xy * float(${(0.5 * BLOOM_OVERSCAN).toFixed(6)}) + 0.5;
        gl_Position = vec4(position.xy, 1.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDust;
      varying vec2 vDustUv;
      void main() {
        if (any(lessThan(vDustUv, vec2(0.0))) || any(greaterThan(vDustUv, vec2(1.0)))) discard;
        gl_FragColor = texture2D(tDust, vDustUv);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    transparent: true,
  });
  inSceneDustMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), inSceneDustMaterial);
  inSceneDustMesh.frustumCulled = false;
  // High render order so it draws after all opaque geometry; planets
  // have already written depth by then.
  inSceneDustMesh.renderOrder = 1000;
  scene.add(inSceneDustMesh);

  syncInSceneDustVisibility();
  console.log(`Dust volume: ${xSize}×${ySize}×${zSize} @ ${meta.resolution_pc} pc/voxel, bbox ${size.x.toFixed(0)}×${size.y.toFixed(0)}×${size.z.toFixed(0)}`);
  fadeStartMs = performance.now();
}

export function updateDust(): void {
  dustCamPosUniform.value.copy(camera.position);
  if (fadeStartMs >= 0 && emissionMesh) {
    const elapsed = performance.now() - fadeStartMs;
    const t = Math.min(1, elapsed / FADE_DURATION_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    (emissionMesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value = TARGET_OPACITY * eased;
    if (t >= 1) fadeStartMs = -1;
  }
}

// Ray march to the half-res RT. Run every frame — the target-relative
// math in the fragment shader keeps the output stable across frames
// at deep zoom without any skip heuristic.
export function renderDustToRT(renderer: THREE.WebGLRenderer): void {
  if (!halfResRT) return;
  // Skip the bind+clear entirely when nothing consumes the RT. The
  // skybox needs a zero-cleared buffer for its extinction lookup
  // (so toggling dust off doesn't leave stale optical depth), and
  // the emission pass needs to render into it. If neither is on,
  // there's no consumer.
  const dustVisible = emissionMesh != null && wantVisible;
  if (!dustVisible && !isSkyboxVisible()) return;

  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.setRenderTarget(halfResRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, false);
  renderer.autoClear = false;

  if (dustVisible) renderer.render(emissionScene, camera);

  renderer.autoClear = prevAutoClear;
  renderer.setRenderTarget(prevTarget);
}

function syncInSceneDustVisibility(): void {
  if (inSceneDustMesh) inSceneDustMesh.visible = wantVisible && emissionMesh != null;
}

// Always-on accessor for the dust RT, used by the skybox shader to
// read integrated optical depth from the alpha channel for backdrop
// extinction. Stays valid when dust is toggled off (the RT is cleared
// each frame regardless), so the skybox can sample unconditionally
// and get zero extinction when there's no dust pass running.
export function getDustExtinctionTexture(): THREE.Texture | null {
  return halfResRT?.texture ?? null;
}

// Quarter-res on mobile (divisor 4), half-res on desktop. The dust
// volume is baked at 6 pc/voxel — low enough frequency that bilinear
// upsample doesn't alias at typical viewing distance. On mobile this
// is one of the largest single bandwidth savings, since dust ray-
// marching is texture-fetch heavy.
function computeDustRTSize(): [number, number] {
  const dustDiv = qualityProfile.dustDiv;
  const hw = Math.round(window.innerWidth * getRenderPixelRatio() / dustDiv);
  const hh = Math.round(window.innerHeight * getRenderPixelRatio() / dustDiv);
  return [hw, hh];
}

export function handleDustResize(): void {
  if (!halfResRT) return;
  const [hw, hh] = computeDustRTSize();
  halfResRT.setSize(hw, hh);
}

export function setDustVisible(v: boolean): void {
  wantVisible = v;
  syncInSceneDustVisibility();
}
export function isDustVisible(): boolean {
  return wantVisible;
}
export function toggleDust(): void {
  wantVisible = !wantVisible;
  syncInSceneDustVisibility();
}
