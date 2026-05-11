import * as THREE from "three";
import { scene, BLOOM_OVERSCAN, GAL_TO_SCENE } from "./scene.ts";
import { TILE_BASE_URL } from "./constants.ts";
import { magLimitUniform } from "./starfield.ts";
import { composerNdcToHalfResUvGlsl } from "./shaderLib.ts";

// Panorama is in galactic equirect, so we rotate scene-space view
// directions into the galactic frame before sampling.
const SCENE_TO_GAL = new THREE.Matrix3().copy(GAL_TO_SCENE).transpose();

// Strip translation so the sphere always surrounds the camera; .xyww
// forces NDC z=1 so scene geometry passes the depth test in front.
// vClipPos lets the fragment shader derive screen UV for the dust
// optical-depth lookup.
const VERTEX = `
varying vec3 vDir;
varying vec4 vClipPos;
void main() {
  vDir = position;
  mat4 viewRot = mat4(mat3(viewMatrix));
  vec4 p = projectionMatrix * viewRot * vec4(position, 1.0);
  vClipPos = p.xyww;
  gl_Position = vClipPos;
}
`;

const FRAGMENT = `
uniform sampler2D uTexture;
uniform sampler2D uDustTex;
uniform float uHasDust;
uniform mat3 uSceneToGal;
uniform float uIntensity;
uniform float uMagLimit;
varying vec3 vDir;
varying vec4 vClipPos;

${composerNdcToHalfResUvGlsl(BLOOM_OVERSCAN)}

const float PI = 3.14159265359;

void main() {
  vec3 g = uSceneToGal * normalize(vDir);
  float lon = atan(g.y, g.x);
  float lat = asin(clamp(g.z, -1.0, 1.0));
  // ESO Brunier panorama: galactic east on the LEFT (standard
  // astronomical sky-map convention, mirror of Earth maps), so
  // increasing longitude moves u towards 0.
  float u = 0.5 - lon / (2.0 * PI);
  float v = 0.5 - lat / PI;
  // Pogson scale at HALF rate (×0.5 in the exponent) so the panorama
  // dims faster than resolved stars when mag_limit drops, and grows
  // more conservatively when it rises — at high mag_limit the panorama
  // would otherwise overwhelm the foreground and amplify pole and
  // seam artifacts in the source texture.
  float magScale = pow(2.512, (uMagLimit - 7.5) * 0.5);
  // Polar attenuation: equirect projection collapses each polar
  // circle to a single texture row, so |lat|→90° has no real signal,
  // just a smeared average that brightness scaling makes ugly.
  // sqrt(cos(lat)) fades smoothly to 0 at the poles.
  float polarFade = sqrt(max(cos(lat), 0.0));
  vec3 col = texture2D(uTexture, vec2(u, v)).rgb * uIntensity * magScale * polarFade;

  // Foreground dust extinction. The dust ray-march writes integrated
  // optical depth into halfResRT's alpha channel; multiply through by
  // exp(-tau) so dense local clouds silhouette against the panorama.
  if (uHasDust > 0.5) {
    vec2 ndc = vClipPos.xy / vClipPos.w;
    vec2 dustUv = composerNdcToHalfResUv(ndc);
    if (all(greaterThanEqual(dustUv, vec2(0.0))) && all(lessThanEqual(dustUv, vec2(1.0)))) {
      float tau = texture2D(uDustTex, dustUv).a;
      col *= exp(-tau);
    }
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

let mesh: THREE.Mesh | null = null;
// Tracked separately from `mesh.visible` so toggles dispatched before
// the (async) initSkybox resolves are honoured when the mesh appears.
let wantVisible = false;

export async function initSkybox(): Promise<void> {
  const loader = new THREE.TextureLoader();
  const texture = await loader.loadAsync(`${TILE_BASE_URL}skybox.jpg`);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  // Longitude wraps at u=0/u=1 — without RepeatWrapping the bilinear
  // filter clamps to edge and produces a visible seam at the meridian
  // opposite the panorama centre.
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: texture },
      uDustTex: { value: null },
      uHasDust: { value: 0 },
      uSceneToGal: { value: SCENE_TO_GAL },
      uIntensity: { value: 0.09 },
      uMagLimit: magLimitUniform,
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
  });
  mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.visible = wantVisible;
  scene.add(mesh);
}

export function setSkyboxDustExtinction(tex: THREE.Texture | null): void {
  if (!mesh) return;
  const u = (mesh.material as THREE.ShaderMaterial).uniforms;
  u.uDustTex.value = tex;
  u.uHasDust.value = tex ? 1 : 0;
}

export function setSkyboxVisible(v: boolean): void {
  wantVisible = v;
  if (mesh) mesh.visible = v;
}

export function isSkyboxVisible(): boolean {
  return wantVisible;
}

export function toggleSkybox(): void {
  setSkyboxVisible(!wantVisible);
}
