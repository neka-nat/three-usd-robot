/**
 * M31 demo: the RTX-style viewer. `WebGPURenderer` with a TSL post stack for
 * interaction — GTAO / SSGI, screen-space reflections, temporal AA, bloom,
 * depth of field — and a progressive path tracer (three-gpu-pathtracer) for
 * stills. The two modes mirror Isaac Sim's "RTX – Real-Time" and "RTX –
 * Interactive (Path Tracing)". Everything USD-side (materials, UsdLux lights,
 * dome HDRI, calibration) comes from the library exactly as in the inspector.
 *
 * Without WebGPU the renderer falls back to WebGL 2: the post stack still
 * runs, path tracing needs the real thing.
 */

import GUI from "lil-gui";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RectAreaLightTexturesLib } from "three/addons/lights/RectAreaLightTexturesLib.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { ssgi } from "three/addons/tsl/display/SSGINode.js";
import { ssr } from "three/addons/tsl/display/SSRNode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import {
  convertToTexture,
  metalness,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  roughness,
  uniform,
  vec4,
  velocity,
} from "three/tsl";
import * as THREE from "three/webgpu";
import { WebGPUPathTracer } from "three-gpu-pathtracer/webgpu";
import { type ThreeUsdRobot, ThreeUsdRobotLoader } from "three-usd-robot";
import { createJointSliderPanel } from "three-usd-robot/extras";
import {
  applyRenderDefaults,
  applyUsdEnvironment,
  type ToneMappingPreset,
} from "three-usd-robot/rendering";

/** NVIDIA's public Isaac Sim asset CDN — no login, and CORS is open. */
const ISAAC = "https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1";

const PRESETS: Record<string, string> = {
  "Franka Panda (Isaac Sim)": `${ISAAC}/Isaac/Robots/FrankaRobotics/FrankaPanda/franka.usd`,
  "Kawasaki RS007N + gripper": `${ISAAC}/Isaac/Robots/Kawasaki/RS007N/rs007n_onrobot_rg2.usd`,
  "Fanuc CRX-10iA/L": `${ISAAC}/Isaac/Robots/Fanuc/CRX10IAL/crx10ial.usd`,
  "Shadow Hand (25 joints)": `${ISAAC}/Isaac/Robots/ShadowRobot/ShadowHand/shadow_hand.usd`,
  "Simple Room (UsdLux lights)": `${ISAAC}/Isaac/Environments/Simple_Room/simple_room.usd`,
  "Factory cell (authored here)": "/factory.usda",
  "Sample arm": "/robot.usda",
};

const params = new URLSearchParams(location.search);
const isaacPath = params.get("isaac");
const initialUrl =
  params.get("asset") ?? (isaacPath ? `${ISAAC}/${isaacPath}` : Object.values(PRESETS)[0]!);

const status = document.getElementById("status") as HTMLDivElement;
const setStatus = (text: string, warn = false) => {
  status.textContent = text;
  status.classList.toggle("warn", warn);
};

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
// TRAA replaces MSAA (the two must not be combined).
const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL: !hasWebGPU });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
await renderer.init();
// ACES tone mapping + soft shadow maps (PCFShadowMap on r182+).
applyRenderDefaults(renderer);
document.body.appendChild(renderer.domElement);
// RectAreaLight (USD RectLight/DiskLight) needs its LTC lookup tables on WebGPU too.
THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
const backend =
  hasWebGPU && !(renderer.backend as { isWebGLBackend?: boolean }).isWebGLBackend
    ? "WebGPU"
    : "WebGL 2 fallback";

const scene = new THREE.Scene();
// The post stack tone-maps the clear color too (ACES crushes near-black),
// so the background is a lighter gray than the inspector's.
const DEFAULT_BACKGROUND = new THREE.Color(0x4a4a52);
scene.background = DEFAULT_BACKGROUND;

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.001, 1000);
camera.position.set(2, 2, 2);
const controls = new OrbitControls(camera, renderer.domElement);

const grid = new THREE.GridHelper(4, 8, 0x555555, 0x3a3a40);
scene.add(grid);

// Fallback rig for stages that author no UsdLux lights (most robot assets).
const fallbackLights = new THREE.Group();
fallbackLights.name = "fallbackLights";
const hemisphere = new THREE.HemisphereLight(0xffffff, 0x404040, 0.3);
fallbackLights.add(hemisphere);
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(3, 5, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.normalBias = 0.02;
fallbackLights.add(sun);
fallbackLights.add(sun.target);
scene.add(fallbackLights);

// Invisible ground that only renders received shadows, sized per asset.
const shadowCatcher = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.ShadowMaterial({ opacity: 0.35 }),
);
shadowCatcher.receiveShadow = true;
scene.add(shadowCatcher);

/**
 * A soft gradient sky as an equirect half-float texture — the stand-in
 * environment for dome-less stages. Unlike a PMREM'd RoomEnvironment it is a
 * plain image, so the path tracer can importance-sample it too.
 */
function createGradientSky(): THREE.DataTexture {
  const width = 128;
  const height = 64;
  const data = new Uint16Array(width * height * 4);
  const zenith = [0.45, 0.6, 0.9];
  const horizon = [1.0, 0.98, 0.95];
  const ground = [0.28, 0.28, 0.3];
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + ((b[i] ?? 0) - v) * t);
  for (let y = 0; y < height; y++) {
    // Row 0 is the bottom of the texture (v = 0) for an un-flipped DataTexture.
    const t = y / (height - 1); // 0 = nadir, 1 = zenith
    const rgb = t < 0.5 ? mix(ground, horizon, t * 2) : mix(horizon, zenith, (t - 0.5) * 2);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = THREE.DataUtils.toHalfFloat(rgb[0]!);
      data[i + 1] = THREE.DataUtils.toHalfFloat(rgb[1]!);
      data[i + 2] = THREE.DataUtils.toHalfFloat(rgb[2]!);
      data[i + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
const gradientSky = createGradientSky();

/** Drop any DomeLight environment from a previously loaded asset. */
function resetEnvironment() {
  scene.environment = null;
  scene.background = DEFAULT_BACKGROUND;
  scene.environmentIntensity = 1;
  scene.backgroundIntensity = 1;
  scene.environmentRotation.set(0, 0, 0);
  scene.backgroundRotation.set(0, 0, 0);
  lighting.environment = 1;
}

/** Move the camera so the whole robot is in frame; refit the fallback sun + ground. */
function frame(object: THREE.Object3D) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.7, 1).setLength(radius * 3));
  camera.near = radius / 100;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  controls.update();

  sun.position.copy(center).add(new THREE.Vector3(1, 1.6, 0.7).setLength(radius * 3));
  sun.target.position.copy(center);
  sun.shadow.normalBias = 0.02 * Math.max(radius, 1);
  const extent = radius * 1.5;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = radius;
  sun.shadow.camera.far = radius * 6;
  sun.shadow.camera.updateProjectionMatrix();

  shadowCatcher.scale.setScalar(radius * 8);
  shadowCatcher.position.set(center.x, box.min.y - radius * 0.001, center.z);

  // Screen-space effects work in world units: scale them with the scene.
  sceneRadius = radius;
  postUniforms.aoRadius.value = THREE.MathUtils.clamp(radius * 0.1, 0.05, 0.6);
  postUniforms.ssrDistance.value = THREE.MathUtils.clamp(radius * 2, 1, 50);
  post.dofFocus = camera.position.distanceTo(center);
  postUniforms.dofFocus.value = post.dofFocus;
  dofFocusCtrl?.updateDisplay();
}

/** Free the GPU resources of a robot before dropping it. */
function dispose(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material.dispose();
    }
  });
}

// ---------------------------------------------------------------------------
// Post-processing (real-time mode)
// ---------------------------------------------------------------------------

const post = {
  ao: true,
  ssgi: false,
  ssr: true,
  traa: true,
  bloom: true,
  dof: false,
  dofFocus: 2,
  dofFocal: 0.6,
  dofBokeh: 2,
};
const postUniforms = {
  aoRadius: uniform(0.25),
  ssrDistance: uniform(5),
  dofFocus: uniform(2),
  dofFocal: uniform(0.6),
  dofBokeh: uniform(2),
};
let sceneRadius = 1;
let dofFocusCtrl: ReturnType<GUI["add"]> | undefined;

const renderPipeline = new THREE.RenderPipeline(renderer);

/**
 * Compose the frame: scene pass with MRT (color, packed normals, velocity,
 * metalness, roughness) → ambient occlusion or SSGI → additive SSR →
 * TRAA → bloom → depth of field. The pipeline applies tone mapping and the
 * output color space at the end.
 */
function buildPipeline() {
  const scenePass = pass(scene, camera);
  scenePass.setMRT(
    mrt({
      output,
      normal: packNormalToRGB(normalView),
      velocity,
      metalness,
      roughness,
    }),
  );
  const color = scenePass.getTextureNode("output");
  const depth = scenePass.getTextureNode("depth");
  const normal = scenePass.getTextureNode("normal");

  // biome-ignore lint/suspicious/noExplicitAny: TSL node graphs are built dynamically here
  let node: any = color;
  if (post.ssgi) {
    // Screen-space GI: visibility-bitmask AO plus one bounce of indirect diffuse.
    // The typings want a vec3 node; the runtime samples the packed-normal texture.
    const gi = ssgi(color, depth, normal as unknown as Parameters<typeof ssgi>[2], camera);
    gi.sliceCount.value = post.traa ? 2 : 3;
    gi.stepCount.value = 8;
    gi.useTemporalFiltering = post.traa;
    node = vec4(color.rgb.mul(gi.r).add(gi.getGINode().rgb), color.a);
  } else if (post.ao) {
    const aoPass = ao(depth, normal, camera);
    aoPass.radius = postUniforms.aoRadius;
    aoPass.resolutionScale = 0.75;
    node = vec4(color.rgb.mul(aoPass.getTextureNode().r), color.a);
  }
  if (post.ssr) {
    // Glossy floors and metal links reflect the scene, not only the sky.
    // SSR samples its inputs as textures (the typings say vec3 / float nodes).
    const reflections = ssr(
      convertToTexture(node),
      depth,
      normal as unknown as Parameters<typeof ssr>[2],
      {
        metalnessNode: scenePass.getTextureNode("metalness").r,
        roughnessNode: scenePass.getTextureNode("roughness").r,
        reflectNonMetals: true,
        camera,
      },
    );
    reflections.resolutionScale = 0.5;
    reflections.maxDistance = postUniforms.ssrDistance;
    node = node.add(reflections);
  }
  if (post.traa) {
    node = traa(node, depth, scenePass.getTextureNode("velocity"), camera);
  }
  if (post.bloom) {
    // Only the brightest parts (emissive LED rings, light panels) bloom — the
    // threshold sits above a sunlit white plastic.
    node = node.add(bloom(node, 0.2, 0.2, 2.0));
  }
  if (post.dof) {
    node = dof(
      node,
      scenePass.getViewZNode(),
      postUniforms.dofFocus,
      postUniforms.dofFocal,
      postUniforms.dofBokeh,
    );
  }
  renderPipeline.outputNode = node;
  renderPipeline.needsUpdate = true;
}
buildPipeline();

// ---------------------------------------------------------------------------
// Path tracing (stills)
// ---------------------------------------------------------------------------

const pt = { enabled: false, bounces: 4, renderScale: 1, samples: "–" };
let pathTracer: WebGPUPathTracer | null = null;
let jointSnapshot = "";

/**
 * The path tracer sees the scene as it is, so helpers and raster-only
 * stand-ins step aside, and the area-light shadow proxies (M30) fold their
 * share back into the panels — a ray tracer shadows area lights natively.
 */
function prepareSceneForPathTracing(on: boolean) {
  grid.visible = !on;
  shadowCatcher.visible = !on;
  hemisphere.visible = !on; // the gradient sky / dome supplies the ambient
  robot?.traverse((object) => {
    const proxy = object.userData.shadowProxy as THREE.SpotLight | undefined;
    if (!proxy?.isSpotLight) return;
    const area = object as THREE.RectAreaLight;
    const share = proxy.intensity / (area.width * area.height); // candela → nits
    if (on && !proxy.userData.folded) {
      area.intensity += share;
      proxy.visible = false;
      proxy.userData.folded = true;
    } else if (!on && proxy.userData.folded) {
      area.intensity -= share;
      proxy.visible = true;
      proxy.userData.folded = false;
    }
  });
}

function setPathTracing(on: boolean) {
  if (on && !hasWebGPU) {
    pt.enabled = false;
    ptCtrl.updateDisplay();
    setStatus("path tracing needs WebGPU (this browser fell back to WebGL 2)", true);
    return;
  }
  pt.enabled = on;
  prepareSceneForPathTracing(on);
  if (on) {
    pathTracer ??= new WebGPUPathTracer(renderer);
    pathTracer.maxBounces = pt.bounces;
    pathTracer.renderScale = pt.renderScale;
    pathTracer.dynamicLowRes = true;
    pathTracer.setScene(scene, camera);
    jointSnapshot = snapshotJoints();
  }
}

function snapshotJoints(): string {
  if (!robot) return "";
  return robot
    .getJointNames()
    .map((name) => robot!.getJointValue(name)?.toFixed(4))
    .join(",");
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const gui = new GUI({ title: `three-usd-robot · ${backend}` });
const state = { asset: initialUrl };
gui
  .add(state, "asset", PRESETS)
  .name("robot")
  .onChange((url: string) => {
    void load(url);
  });

const lighting = {
  fallback: true,
  toneMapping: "ACES" as ToneMappingPreset,
  exposure: 1,
  environment: 1,
};
const PHOTOMETRIC_EXPOSURE = 0.8;
const INTERIOR_DOME_FRACTION = 0.3;
const lightingFolder = gui.addFolder("Lighting");
const fallbackCtrl = lightingFolder
  .add(lighting, "fallback")
  .name("fallback rig")
  .onChange((on: boolean) => {
    fallbackLights.visible = on;
    pathTracer?.updateLights();
  });
lightingFolder
  .add(lighting, "toneMapping", ["ACES", "AgX", "neutral", "none"])
  .name("tone mapping")
  .onChange((preset: ToneMappingPreset) => {
    applyRenderDefaults(renderer, { toneMapping: preset });
    renderPipeline.needsUpdate = true;
  });
const exposureCtrl = lightingFolder
  .add(lighting, "exposure", 0.05, 4, 0.05)
  .onChange((value: number) => {
    renderer.toneMappingExposure = value;
  });
const environmentCtrl = lightingFolder
  .add(lighting, "environment", 0, 3, 0.05)
  .onChange((value: number) => {
    scene.environmentIntensity = value;
    if (scene.background && !(scene.background as THREE.Color).isColor) {
      scene.backgroundIntensity = value;
    }
    pathTracer?.updateEnvironment();
  });
lightingFolder.close();

const postFolder = gui.addFolder("Post (real-time)");
for (const key of ["ao", "ssgi", "ssr", "traa", "bloom", "dof"] as const) {
  postFolder
    .add(post, key)
    .name(
      { ao: "GTAO", ssgi: "SSGI (replaces GTAO)", ssr: "SSR", traa: "TRAA", bloom: "bloom", dof: "DoF" }[key],
    )
    .onChange(() => buildPipeline());
}
dofFocusCtrl = postFolder
  .add(post, "dofFocus", 0.05, 20, 0.05)
  .name("DoF focus (m)")
  .onChange((v: number) => {
    postUniforms.dofFocus.value = v;
  });
postFolder
  .add(post, "dofFocal", 0.05, 5, 0.05)
  .name("DoF focal range (m)")
  .onChange((v: number) => {
    postUniforms.dofFocal.value = v;
  });
postFolder
  .add(post, "dofBokeh", 0, 6, 0.1)
  .name("DoF bokeh")
  .onChange((v: number) => {
    postUniforms.dofBokeh.value = v;
  });
postFolder.close();

const ptFolder = gui.addFolder("Path tracing (stills)");
const ptCtrl = ptFolder
  .add(pt, "enabled")
  .name(hasWebGPU ? "enabled" : "enabled (needs WebGPU)")
  .onChange((on: boolean) => setPathTracing(on));
ptFolder
  .add(pt, "bounces", 1, 12, 1)
  .onChange((v: number) => {
    if (pathTracer) {
      pathTracer.maxBounces = v;
      pathTracer.reset();
    }
  });
ptFolder
  .add(pt, "renderScale", 0.25, 1, 0.05)
  .name("render scale")
  .onChange((v: number) => {
    if (pathTracer) {
      pathTracer.renderScale = v;
      pathTracer.reset();
    }
  });
const samplesCtrl = ptFolder.add(pt, "samples").name("samples").disable();
ptFolder.close();

// ---------------------------------------------------------------------------
// Load / reload
// ---------------------------------------------------------------------------

const clock = new THREE.Timer();
let robot: ThreeUsdRobot | null = null;
let tick: (() => void) | undefined;
let jointFolder: GUI | undefined;
let playbackFolder: GUI | undefined;

async function load(url: string) {
  setStatus("loading…");
  tick = undefined;
  jointFolder?.destroy();
  playbackFolder?.destroy();
  jointFolder = undefined;
  playbackFolder = undefined;

  try {
    const next = await new ThreeUsdRobotLoader({ loadSceneGeometry: true }).loadAsync(url);
    if (robot) {
      prepareSceneForPathTracing(false);
      scene.remove(robot);
      dispose(robot);
    }
    robot = next;
    scene.add(next);
    frame(next);

    lighting.fallback = next.domeLights.length === 0 && next.lights.length < 2;
    fallbackLights.visible = lighting.fallback;
    fallbackCtrl.updateDisplay();
    lighting.exposure =
      !lighting.fallback && (next.lightIntensityScale ?? 1) < 1 ? PHOTOMETRIC_EXPOSURE : 1;
    renderer.toneMappingExposure = lighting.exposure;
    exposureCtrl.updateDisplay();

    jointFolder = gui.addFolder("Joints");
    const panel = createJointSliderPanel(next, jointFolder);

    const lightNote =
      next.lights.length + next.domeLights.length > 0
        ? `, ${next.lights.length} lights${next.domeLights.length > 0 ? " + dome" : ""}`
        : "";
    const statusText = `${next.robot.name} — ${next.getLinkNames().length} links, ${next.getJointNames().length} joints${lightNote} · ${backend}`;
    setStatus(statusText);

    // DomeLight → IBL, or the gradient sky for dome-less stages. Interiors
    // (fixtures, no sun) get the dome at a fraction: IBL is never occluded by
    // walls, a path tracer does that properly.
    resetEnvironment();
    if (next.domeLights.length > 0) setStatus(`${statusText} — fetching dome environment…`);
    const interior =
      next.lights.some((l) => !(l as THREE.DirectionalLight).isDirectionalLight) &&
      !next.lights.some((l) => (l as THREE.DirectionalLight).isDirectionalLight);
    const env = await applyUsdEnvironment(next, scene, {
      background: true,
      fallback: gradientSky,
      fallbackIntensity: 0.8,
      ...(interior ? { intensityScale: (next.lightIntensityScale ?? 1) * INTERIOR_DOME_FRACTION } : {}),
      onWarn: (m) => console.warn(`[three-usd-robot] ${m}`),
    });
    if (robot !== next) {
      resetEnvironment();
      return;
    }
    lighting.environment = env?.intensity ?? 1;
    environmentCtrl.updateDisplay();
    setStatus(statusText);

    const range = next.getTimeRange();
    if (range) {
      const fps = next.getTimeCodesPerSecond();
      const pb = { playing: true, time: range.start };
      playbackFolder = gui.addFolder("Playback");
      playbackFolder.add(pb, "playing").name("play");
      const timeCtrl = playbackFolder.add(pb, "time", range.start, range.end, 0.01).onChange(() => {
        pb.playing = false;
        next.setTime(pb.time);
        panel.update();
      });
      tick = () => {
        if (!pb.playing) return;
        pb.time += clock.getDelta() * fps;
        if (pb.time > range.end) pb.time = range.start;
        next.setTime(pb.time);
        timeCtrl.updateDisplay();
        panel.update();
      };
    }

    if (pt.enabled) setPathTracing(true);
  } catch (err) {
    console.error(err);
    setStatus(`failed to load ${url}: ${(err as Error).message}`, true);
  }
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  pathTracer?.updateCamera();
});
controls.addEventListener("change", () => {
  if (pt.enabled) pathTracer?.updateCamera();
});

let sampleTimer = 0;
function renderFrame() {
  clock.update();
  tick?.();
  controls.update();
  if (pt.enabled && pathTracer) {
    // Joint sliders / playback move links: re-read the transforms (no rebuild).
    const joints = snapshotJoints();
    if (joints !== jointSnapshot) {
      jointSnapshot = joints;
      pathTracer.updateTransforms();
    }
    pathTracer.renderSample();
    if (performance.now() - sampleTimer > 500) {
      sampleTimer = performance.now();
      void pathTracer.getSampleCountsAsync().then((counts) => {
        pt.samples = `${counts.avg.toFixed(0)} spp · ${counts.samplesPerSecond.toFixed(1)}/s`;
        samplesCtrl.updateDisplay();
      });
    }
  } else {
    renderPipeline.render();
  }
}

// Viewer internals for automated tooling (screenshot scripts, e2e checks).
Object.assign(window as unknown as Record<string, unknown>, {
  __usdViewer: {
    scene,
    camera,
    controls,
    renderer,
    lighting,
    post,
    pt,
    backend,
    get robot() {
      return robot;
    },
    rebuild: buildPipeline,
    renderOnce() {
      renderer.setAnimationLoop(null);
      renderFrame();
    },
    resume() {
      renderer.setAnimationLoop(renderFrame);
    },
  },
});

renderer.setAnimationLoop(renderFrame);

void load(initialUrl);
