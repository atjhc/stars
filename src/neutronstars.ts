import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import {
  scene, camera, target, animateTo, setMinOrbitOverride,
  isDeepZoom, orbitRadius, requestLensing,
  distanceFromCamera, animation, getRenderPixelRatio,
} from "./scene.ts";
import {
  SCALE, TILE_BASE_URL, KM_PER_PC, SCENE_UNIT_TO_KM,
  DEEP_ZOOM_MIN_ORBIT, formatAstroDistance, solDistanceFade,
} from "./constants.ts";
import {
  halfViewportPxUniform,
  starCameraOffsetUniform, starViewRotationUniform,
} from "./shaderUniforms.ts";
import { F_HALF_TAN_INV_GLSL, VIEW_UNIFORMS_GLSL, TARGET_VIEW_GLSL } from "./shaderLib.ts";
import { setLabelsDirty } from "./systemStore.ts";
import { registerLabelType, type LabelTypeHandler } from "./labelRegistry.ts";
import { favoriteIcon } from "./detail.ts";
import { isFavorite } from "./favorites.ts";
import {
  registerCanvasLabel, updateCanvasLabel, hideCanvasLabel,
} from "./labelCanvas.ts";
import { computeStarMinOrbit } from "./stars.ts";
import { starLabelMargin } from "./labels.ts";
import { inSolarSystemView } from "./planets.ts";

// Canvas label styling — a saturated cyan-teal that reads as cool
// thermal glow but stays clearly distinct from the pale powder-blue
// used for star clusters. Italic serif helps sell the "not an
// ordinary star" character without competing for attention.
const NS_CANVAS_FONT = `italic 12px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const NS_CANVAS_COLOR = "rgba(110,220,225,0.9)";
const NS_CANVAS_SHADOW = { color: "rgba(60,150,170,0.8)", blur: 6 };
const NS_CANVAS_GLOW = { color: "rgba(140,240,240,1.0)", blur: 12 };
const NS_SUBTITLE_FONT = `9px "Helvetica Neue", Helvetica, Arial, sans-serif`;
const NS_SUBTITLE_COLOR = "rgba(170,170,170,0.9)";

// Minimum disc radius in pixels. Far away, the NS's physical size
// is sub-pixel; we floor the disc to a tiny visible dot so the
// bloom pass downstream has something to spread into a glow. Keep
// this small — bloom inflates even a 1-px point into a recognizable
// halo, so a larger floor makes distant NSes read as nearby stars.
const DISC_FLOOR_PX = 1.2;

// Close-camera label fade, expressed as multiples of the NS surface
// radius. Same multipliers as black holes (which scale by shadow
// radius); for a typical 12 km NS the label fades from ~180,000 km
// down to ~60 km of camera distance, mirroring the visible-feature
// proximity range.
const LABEL_FADE_FAR_FEATURE_RADII = 15000;
const LABEL_FADE_NEAR_FEATURE_RADII = 5;

interface NeutronStarEntry {
  aliases?: string[];
  kind: "ins" | "pulsar";
  ra: number;
  dec: number;
  dist_pc: number;
  mass_msun: number;
  radius_km: number;
  wikipedia?: string;
  notes?: string;
  scene_pos: [number, number, number];
}

interface NeutronStarLabel {
  name: string;
  entry: NeutronStarEntry;
  anchor: THREE.Object3D;
  markerMesh: THREE.Mesh;
  sceneRadius: number;          // physical radius in scene units
}

const neutronStars: NeutronStarLabel[] = [];
let selectedNS: NeutronStarLabel | null = null;
let hoveredNS: NeutronStarLabel | null = null;
let maxSolDist = 0;

let departingNS: NeutronStarLabel | null = null;

// Scene routing for NS markers.
//
// - Non-focused NSes live in the main `scene`. They're in tDiffuse
//   when the lensing pass runs, so the focused NS's lensing bends
//   their pixels like any other background object. This is how a
//   distant pulsar visibly smears around the focus NS.
// - The focused NS is moved into `nsMarkerScene` (rendered AFTER
//   the composer) so it's never in tDiffuse. The lensing pass can't
//   bend its own body into an Einstein ring of itself, and it gets
//   the dedicated bright bloom pipeline below.
//
// `setFocusedMesh` swaps a mesh between the two at selection time.
const nsMarkerScene = new THREE.Scene();

function setFocusedMesh(ns: NeutronStarLabel | null) {
  if (selectedNS && selectedNS !== ns) {
    nsMarkerScene.remove(selectedNS.markerMesh);
    scene.add(selectedNS.markerMesh);
  }
  if (ns && ns !== selectedNS) {
    scene.remove(ns.markerMesh);
    nsMarkerScene.add(ns.markerMesh);
  }
}

// Lazy-initialized bloom pipeline for the NS markers. Markers render
// into the composer's internal RT, UnrealBloomPass adds a soft glow,
// and the composer's current readBuffer is blitted over the screen.
let nsComposer: EffectComposer | null = null;
let nsBlitScene: THREE.Scene | null = null;
let nsBlitMaterial: THREE.ShaderMaterial | null = null;
const nsBlitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function ensureBloomPipeline(renderer: THREE.WebGLRenderer): void {
  if (nsComposer) return;
  const w = Math.round(window.innerWidth * getRenderPixelRatio());
  const h = Math.round(window.innerHeight * getRenderPixelRatio());
  const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
  nsComposer = new EffectComposer(renderer, rt);
  nsComposer.setSize(window.innerWidth, window.innerHeight);
  nsComposer.renderToScreen = false;
  const renderPass = new RenderPass(nsMarkerScene, camera);
  renderPass.clearColor = new THREE.Color(0, 0, 0);
  renderPass.clearAlpha = 0;
  nsComposer.addPass(renderPass);
  // Subtle bloom: low strength, wide radius, zero threshold so even
  // the dimmest disc pixels get a soft halo.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.8, 0.6, 0.0,
  );
  for (const brt of bloom.renderTargetsHorizontal) brt.texture.type = THREE.HalfFloatType;
  for (const brt of bloom.renderTargetsVertical) brt.texture.type = THREE.HalfFloatType;
  bloom.renderTargetBright.texture.type = THREE.HalfFloatType;
  nsComposer.addPass(bloom);

  // Blit scene: full-screen quad that samples the composer's final
  // output and normal-blends it over the main composer's on-screen
  // output. The texture uniform is re-bound each frame because
  // UnrealBloomPass doesn't swap, so readBuffer can land on either
  // of the composer's two internal RTs depending on pass order.
  nsBlitMaterial = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      varying vec2 vUv;
      void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
    `,
    transparent: true,
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
  });
  const blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), nsBlitMaterial);
  nsBlitScene = new THREE.Scene();
  nsBlitScene.add(blitQuad);
}

window.addEventListener("resize", () => {
  if (!nsComposer) return;
  nsComposer.setSize(window.innerWidth, window.innerHeight);
});

function canvasIdFor(name: string): string { return `neutronstar:${name}`; }

function applyGlow(ns: NeutronStarLabel) {
  updateCanvasLabel(canvasIdFor(ns.name), {
    shadowColor: NS_CANVAS_GLOW.color,
    shadowBlur: NS_CANVAS_GLOW.blur,
  });
  setLabelsDirty(true);
}

function removeGlow(ns: NeutronStarLabel) {
  updateCanvasLabel(canvasIdFor(ns.name), {
    shadowColor: NS_CANVAS_SHADOW.color,
    shadowBlur: NS_CANVAS_SHADOW.blur,
  });
  setLabelsDirty(true);
}

function kindLabel(kind: "ins" | "pulsar"): string {
  return kind === "pulsar" ? "Pulsar" : "Isolated Neutron Star";
}

function buildDetailHtml(ns: NeutronStarLabel): string {
  const e = ns.entry;
  const dist = ns === selectedNS ? orbitRadius : distanceFromCamera(ns.anchor.position);
  const aliasLine = e.aliases && e.aliases.length > 0
    ? `<div class="star-aliases">${e.aliases.join(" · ")}</div>` : "";
  const wikiLink = e.wikipedia
    ? `<div class="star-wiki"><a href="${e.wikipedia}" target="_blank">Wikipedia</a></div>` : "";
  const notes = e.notes ? `<div class="star-notes">${e.notes}</div>` : "";

  return `
    ${favoriteIcon(ns.name)}
    <div class="star-name">${ns.name}</div>
    ${aliasLine}
    <div class="detail-body">
      <div class="star-detail">
        Distance: ${formatAstroDistance(dist)}<br>
        Mass: ${e.mass_msun} M☉<br>
        Radius: ${e.radius_km} km<br>
        Type: ${kindLabel(e.kind)}
      </div>
      ${notes}
      ${wikiLink}
    </div>`;
}

// Billboard shader: camera-facing quad with a limb-darkened blue disc.
// Uses camera-relative view math (matches stars.ts) so NSes near the
// camera get full Float32 precision automatically.
const markerVertex = `
  uniform float uSceneRadius;
  uniform float uDiscFloorPx;
  uniform vec3 uNSLocalTarget;    // nsWorldPos - target (Float64 on CPU)
  ${VIEW_UNIFORMS_GLSL}

  varying vec2 vUv;
  varying float vDiscPx;
  varying float vHalfBillPx;

  ${F_HALF_TAN_INV_GLSL}
  ${TARGET_VIEW_GLSL}

  void main() {
    vUv = uv;
    vec3 viewPos = targetToView(uNSLocalTarget);
    float camDist = max(-viewPos.z, 1e-20);

    // Physical angular radius in screen pixels, floored so far-away
    // stars still render as a couple of pixels (the bloom pass will
    // turn those into a soft dot of light).
    float physicalPx = uSceneRadius * F_HALF_TAN_INV * uHalfViewportPx / camDist;
    vDiscPx = max(physicalPx, uDiscFloorPx);
    vHalfBillPx = vDiscPx + 2.0;  // margin for the ±1.5 px disc edge smoothstep

    // Scale the unit quad so its edges project to ±vHalfBillPx px.
    float worldScale = vHalfBillPx * camDist / (F_HALF_TAN_INV * uHalfViewportPx);
    vec3 finalPos = viewPos + vec3(position.xy * worldScale * 2.0, 0.0);
    gl_Position = projectionMatrix * vec4(finalPos, 1.0);
  }
`;

const markerFragment = `
  uniform vec3 uColor;
  uniform float uIntensity;

  varying vec2 vUv;
  varying float vDiscPx;
  varying float vHalfBillPx;

  void main() {
    float rUv = length((vUv - 0.5) * 2.0);
    if (rUv > 1.0) discard;
    float rPx = rUv * vHalfBillPx;

    // Wider edge smoothstep (±1.5 px) so the disc's own border blends
    // into the bloom halo instead of reading as a hard circle. Bloom
    // alone softens intensity, not shape — the disc boundary still
    // registers as a sharp color/transparency step unless it fades
    // over more than one pixel.
    float discMask = smoothstep(vDiscPx + 1.5, vDiscPx - 1.5, rPx);
    if (discMask < 0.01) discard;

    // Cool-blue base with strong limb darkening and a modest
    // core-brighten. The stronger limb (matching stars.ts's 0.6
    // coefficient) gives a gentler white→blue gradient across the
    // disc so the edge doesn't read as a distinct blue ring.
    float rN = (vDiscPx > 0.0) ? min(rPx / vDiscPx, 1.0) : 1.0;
    float limb = 1.0 - 0.6 * rN * rN;
    float coreBrighten = smoothstep(1.0, 0.4, rN);
    vec3 color = uColor * limb * (1.0 + 0.4 * coreBrighten) * uIntensity;

    gl_FragColor = vec4(color, discMask);
  }
`;

// Saturated cool-blue base colors. Keep R and G well below 1 so the
// core-brighten multiplier in the shader doesn't drive them past
// ceiling — a blue channel that clips to 1 with R=0.5 still reads
// as blue; if R also clips to 1 the result is white.
const MARKER_COLOR_INS = new THREE.Color(0.35, 0.6, 1.0);
const MARKER_COLOR_PULSAR = new THREE.Color(0.5, 0.7, 1.0);

function createMarkerMesh(ns: NeutronStarEntry, worldPos: THREE.Vector3, sceneRadius: number): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const baseColor = ns.kind === "pulsar" ? MARKER_COLOR_PULSAR : MARKER_COLOR_INS;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uHalfViewportPx: halfViewportPxUniform,
      uSceneRadius: { value: sceneRadius },
      uDiscFloorPx: { value: DISC_FLOOR_PX },
      uNSLocalTarget: { value: new THREE.Vector3() },
      uStarCameraOffset: starCameraOffsetUniform,
      uStarViewRotation: starViewRotationUniform,
      uColor: { value: baseColor.clone() },
      uIntensity: { value: 1.4 },
    },
    vertexShader: markerVertex,
    fragmentShader: markerFragment,
    transparent: true,
    // NormalBlending (not Additive) so the opaque disc fully covers
    // whatever the lensing pass put in the body region. Additive
    // would just sum the disc on top, letting bent-background
    // streaks show through inside the body.
    blending: THREE.NormalBlending,
    depthWrite: false,
    // depthTest on so distant NSes get occluded by foreground planets
    // / stars. The marker's projected z is the NS center's true depth
    // (vertex offset is xy-only), and dynamic camera.near = orbit×0.1
    // never crowds the marker even at planet-close orbits.
    depthTest: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  // Mesh position is ignored by the shader (world position comes from
  // uNSPos); set it anyway for the rare case that some Three.js
  // internal relies on it (bounding sphere, etc.).
  mesh.position.copy(worldPos);
  mesh.frustumCulled = false;
  return mesh;
}


const nsHandler: LabelTypeHandler = {
  type: "neutronstar",
  searchKind: "ns",
  searchKeywords: ["neutron star", "pulsar"],
  searchLabel: "Neutron Star",

  setVisible(v) {
    // The marker mesh is the star's visual body — leave it on even
    // when text labels are toggled off; only the canvas label hides.
    for (const ns of neutronStars) {
      const isActive = ns === selectedNS || ns === hoveredNS;
      if (v) {
        updateCanvasLabel(canvasIdFor(ns.name), {
          hidden: false,
          opacityTarget: isActive ? 1.0 : solDistanceFade(ns.anchor.position.length(), maxSolDist),
        });
      } else {
        updateCanvasLabel(canvasIdFor(ns.name), { hidden: true });
      }
    }
  },

  update() {
    if (maxSolDist === 0 && neutronStars.length > 0) {
      for (const ns of neutronStars) {
        const d = ns.anchor.position.length();
        if (d > maxSolDist) maxSolDist = d;
      }
    }

    const halfTan = Math.tan((camera.fov * Math.PI) / 360);
    const halfHeight = window.innerHeight / 2;
    const BLOOM_SPREAD_PX = 16;

    const hideForSolarView = inSolarSystemView();
    for (const ns of neutronStars) {
      const isActive = ns === selectedNS || ns === hoveredNS;
      const camDist = ns === selectedNS ? orbitRadius : distanceFromCamera(ns.anchor.position);
      const solDist = ns.anchor.position.length();
      const camDistKm = camDist * SCENE_UNIT_TO_KM;
      // Log-space fade: zooming feels exponential, so the smoothstep
      // operates on log(camDist) for a roughly uniform dim per zoom
      // decade rather than a cliff at the lower end.
      const closeFade = THREE.MathUtils.smoothstep(
        Math.log(Math.max(camDistKm, 1)),
        Math.log(LABEL_FADE_NEAR_FEATURE_RADII * ns.entry.radius_km),
        Math.log(LABEL_FADE_FAR_FEATURE_RADII * ns.entry.radius_km),
      );
      const baseOpacity = isActive ? 1.0 : solDistanceFade(solDist, maxSolDist);
      const opacity = baseOpacity * closeFade;
      if (hideForSolarView && !isActive) {
        hideCanvasLabel(canvasIdFor(ns.name));
      } else {
        updateCanvasLabel(canvasIdFor(ns.name), {
          hidden: false,
          opacityTarget: opacity,
          pinned: isActive,
          subtitles: isActive ? [formatAstroDistance(camDist)] : [],
        });
      }

      const mat = ns.markerMesh.material as THREE.ShaderMaterial;
      const pos = ns.anchor.position;
      mat.uniforms.uNSLocalTarget!.value.set(
        pos.x - target.x, pos.y - target.y, pos.z - target.z,
      );
      const distFade = 1 - 0.4 * Math.min(1, solDist / Math.max(maxSolDist, 1));
      mat.uniforms.uIntensity!.value = isActive ? 1.0 : 0.3 * distFade;

      const discPx = (ns.sceneRadius / Math.max(camDist, 1e-30)) * halfHeight / halfTan;
      const halfBillPx = Math.max(discPx, DISC_FLOOR_PX) + BLOOM_SPREAD_PX;
      updateCanvasLabel(canvasIdFor(ns.name), {
        marginTop: starLabelMargin(discPx, halfBillPx),
      });
    }

    // Lensing: during transit, use real camera distance so the effect
    // scales naturally. At rest, gate on deep zoom + orbit radius.
    if (selectedNS) {
      const dist = animation ? distanceFromCamera(selectedNS.anchor.position) : orbitRadius;
      const LENSING_RADIUS_CUTOFF = 1e-6;
      if (animation || (isDeepZoom() && dist < LENSING_RADIUS_CUTOFF)) {
        requestLensing({
          pos: selectedNS.anchor.position,
          shadowRadiusScene: selectedNS.sceneRadius,
          massMsun: selectedNS.entry.mass_msun,
          mode: "bodyElsewhere",
          camDist: dist,
        });
      }
    }

    if (departingNS) {
      if (!animation) {
        departingNS = null;
      } else {
        const dist = distanceFromCamera(departingNS.anchor.position);
        requestLensing({
          pos: departingNS.anchor.position,
          shadowRadiusScene: departingNS.sceneRadius,
          massMsun: departingNS.entry.mass_msun,
          mode: "bodyElsewhere",
          camDist: dist,
        });
      }
    }
  },

  selectByName(name) {
    const ns = neutronStars.find((n) => n.name === name);
    if (!ns) return false;
    if (selectedNS && selectedNS !== ns) {
      departingNS = selectedNS;
      removeGlow(selectedNS);
    }
    setFocusedMesh(ns);
    selectedNS = ns;
    applyGlow(ns);
    setMinOrbitOverride(DEEP_ZOOM_MIN_ORBIT);
    // Arrive where the disc fills ~15% of the viewport — close enough
    // to see surface detail, far enough for context.
    animateTo(ns.anchor.position, computeStarMinOrbit(ns.sceneRadius, 0.15));
    setLabelsDirty(true);
    return true;
  },

  clearSelection() {
    if (selectedNS) {
      if (animation) departingNS = selectedNS;
      removeGlow(selectedNS);
      setFocusedMesh(null);
      selectedNS = null;
      setMinOrbitOverride(null);
    }
    if (hoveredNS) { removeGlow(hoveredNS); hoveredNS = null; }
  },

  getSelectedName() {
    return selectedNS?.name ?? null;
  },

  setHoverByName(name) {
    const next = name ? neutronStars.find((n) => n.name === name) ?? null : null;
    if (hoveredNS === next) return;
    if (hoveredNS && selectedNS !== hoveredNS) removeGlow(hoveredNS);
    hoveredNS = next;
    if (next && selectedNS !== next) applyGlow(next);
  },

  handleClick(div) {
    const name = div.getAttribute("data-label-name");
    return name ? this.selectByName(name) : false;
  },

  detailHtml() {
    return selectedNS ? buildDetailHtml(selectedNS) : null;
  },
};

export async function initNeutronStarLabels(): Promise<void> {
  const resp = await fetch(`${TILE_BASE_URL}neutronstars.json`);
  if (!resp.ok) return;
  const data: Record<string, NeutronStarEntry> = await resp.json();

  for (const [name, entry] of Object.entries(data)) {
    const anchor = new THREE.Object3D();
    anchor.position.set(entry.scene_pos[0], entry.scene_pos[1], entry.scene_pos[2]);
    scene.add(anchor);

    // Physical radius in scene units: km → pc → scene.
    const sceneRadius = (entry.radius_km / KM_PER_PC) * SCALE;

    const markerMesh = createMarkerMesh(entry, anchor.position, sceneRadius);
    scene.add(markerMesh);

    const ns: NeutronStarLabel = { name, entry, anchor, markerMesh, sceneRadius };
    neutronStars.push(ns);

    registerCanvasLabel({
      id: canvasIdFor(name),
      kind: "neutronstar",
      anchor: anchor.position,
      text: name,
      font: NS_CANVAS_FONT,
      color: NS_CANVAS_COLOR,
      shadowColor: NS_CANVAS_SHADOW.color,
      shadowBlur: NS_CANVAS_SHADOW.blur,
      subtitleFont: NS_SUBTITLE_FONT,
      subtitleColor: NS_SUBTITLE_COLOR,
      rank: 1700 + (isFavorite(name) ? 5000 : 0),
      marginTop: 10,
      opacityTarget: 0,
      payload: { name },
    });
  }

  registerLabelType(nsHandler);
}

// Run from main.ts's animate loop AFTER composer.render() so the
// lensing pass never sees the focused NS body in tDiffuse.
export function renderNeutronStars(renderer: THREE.WebGLRenderer): void {
  // nsMarkerScene only ever contains the focused NS. If nothing is
  // focused, skip the full bloom pipeline + blit — otherwise we'd
  // run UnrealBloomPass (5-level mip chain) on a cleared RT every
  // frame for nothing.
  if (!selectedNS) return;
  ensureBloomPipeline(renderer);
  if (!nsComposer || !nsBlitScene || !nsBlitMaterial) return;
  nsComposer.render();
  // UnrealBloomPass has needsSwap=false, so final content lands in
  // composer.readBuffer — NOT the RT passed to the constructor.
  nsBlitMaterial.uniforms.tDiffuse!.value = nsComposer.readBuffer.texture;
  renderer.setRenderTarget(null);
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.render(nsBlitScene, nsBlitCamera);
  renderer.autoClear = prevAutoClear;
}
