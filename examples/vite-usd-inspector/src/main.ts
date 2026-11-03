import GUI from "lil-gui";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import {
  exportThreeUsdRobot,
  serializeUsda,
  type ThreeUsdRobot,
  ThreeUsdRobotLoader,
  type UsdBoundCamera,
  writeUsdz,
} from "three-usd-robot";
import { createJointSliderPanel } from "three-usd-robot/extras";
import { type TcpTargetEvent, TcpTargetHandle } from "three-usd-robot/helpers";
import {
  applyRenderDefaults,
  applyUsdEnvironment,
  type ToneMappingPreset,
} from "three-usd-robot/rendering";
import { type GizmoMode, createSelectionGizmo } from "./selectionGizmo.js";
import { type UsdTreePanel, createUsdTreePanel } from "./usdTreePanel.js";

/** NVIDIA's public Isaac Sim asset CDN — no login, and CORS is open. */
const ISAAC = "https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1";

/** Stock Isaac Sim robots plus the samples shipped with this example. */
const PRESETS: Record<string, string> = {
  "Franka Panda (Isaac Sim)": `${ISAAC}/Isaac/Robots/FrankaRobotics/FrankaPanda/franka.usd`,
  "Kawasaki RS007N + gripper": `${ISAAC}/Isaac/Robots/Kawasaki/RS007N/rs007n_onrobot_rg2.usd`,
  "Fanuc CRX-10iA/L": `${ISAAC}/Isaac/Robots/Fanuc/CRX10IAL/crx10ial.usd`,
  "Flexiv Rizon 4": `${ISAAC}/Isaac/Robots/Flexiv/Rizon4/flexiv_rizon4.usd`,
  "Shadow Hand (25 joints)": `${ISAAC}/Isaac/Robots/ShadowRobot/ShadowHand/shadow_hand.usd`,
  "Simple Room (UsdLux lights)": `${ISAAC}/Isaac/Environments/Simple_Room/simple_room.usd`,
  "Factory cell (authored here)": "/factory.usda",
  "Sample arm": "/robot.usda",
  "Animated arm": "/arm_anim.usda",
};

// `?asset=<url>` loads any URL; `?isaac=<path under Isaac/>` uses the CDN above.
const params = new URLSearchParams(location.search);
const isaacPath = params.get("isaac");
const initialUrl =
  params.get("asset") ?? (isaacPath ? `${ISAAC}/${isaacPath}` : Object.values(PRESETS)[0]!);

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
// ACES tone mapping + soft shadow maps — the library's viewer defaults.
applyRenderDefaults(renderer);
document.body.appendChild(renderer.domElement);

// RectAreaLight (USD RectLight/DiskLight) needs its LTC lookup tables in WebGL.
RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
// The composer tone-maps the clear color too (ACES crushes near-black), so
// the post-processed path needs a lighter gray to land on the same look.
const DEFAULT_BACKGROUND = new THREE.Color(0x202024);
const COMPOSER_BACKGROUND = new THREE.Color(0x4a4a52);
const defaultBackground = () =>
  lighting.ambientOcclusion ? COMPOSER_BACKGROUND : DEFAULT_BACKGROUND;
scene.background = DEFAULT_BACKGROUND;

/** Drop any DomeLight environment from a previously loaded asset. */
function resetEnvironment() {
  scene.environment = null;
  scene.background = defaultBackground();
  lighting.environment = 1;
  scene.environmentIntensity = 1;
  scene.backgroundIntensity = 1;
  scene.environmentRotation.set(0, 0, 0);
  scene.backgroundRotation.set(0, 0, 0);
}

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.001, 1000);
camera.position.set(2, 2, 2);

const controls = new OrbitControls(camera, renderer.domElement);

scene.add(new THREE.GridHelper(4, 8, 0x444444, 0x303030));

// Fallback rig for stages that author no UsdLux lights (most robot assets);
// stages with their own lights switch it off after load (re-enable in the GUI).
const fallbackLights = new THREE.Group();
fallbackLights.name = "fallbackLights";
fallbackLights.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.3)); // IBL (M30) carries the ambient
const sun = new THREE.DirectionalLight(0xffffff, 1.0); // key light over the RoomEnvironment (M30)
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
  sun.shadow.normalBias = 0.02 * Math.max(radius, 1); // scale acne bias with the scene
  const extent = radius * 1.5;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = radius;
  sun.shadow.camera.far = radius * 6;
  sun.shadow.camera.updateProjectionMatrix();

  // Just under the asset's lowest point, so an authored floor still wins.
  shadowCatcher.scale.setScalar(radius * 8);
  shadowCatcher.position.set(center.x, box.min.y - radius * 0.001, center.z);

  // GTAO works in world units: a tenth of the scene radius (5 cm – 60 cm)
  // reads as contact occlusion on a desk robot and on a room alike.
  gtaoPass?.updateGtaoMaterial({
    radius: THREE.MathUtils.clamp(radius * 0.1, 0.05, 0.6),
    distanceExponent: 1,
    thickness: 1,
    scale: 1,
    samples: 16,
    distanceFallOff: 1,
    screenSpaceRadius: false,
  });
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
// UI
// ---------------------------------------------------------------------------

const status = document.getElementById("status") as HTMLDivElement | null;
const setStatus = (text: string) => {
  if (status) status.textContent = text;
};

function download(filename: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const gui = new GUI({ title: "three-usd-robot" });
const state = { asset: initialUrl };

gui
  .add(state, "asset", PRESETS)
  .name("robot")
  .onChange((url: string) => {
    void load(url);
  });

const clock = new THREE.Clock();
let robot: ThreeUsdRobot | null = null;
let tick: (() => void) | undefined;
let jointFolder: GUI | undefined;
let playbackFolder: GUI | undefined;
let cameraFolder: GUI | undefined;

/** Snap the orbit camera to a USD camera's pose and lens (fov/near/far). */
function viewFromUsdCamera(usdCam: UsdBoundCamera) {
  robot?.updateMatrixWorld(true);
  const position = usdCam.getWorldPosition(new THREE.Vector3());
  const direction = usdCam.getWorldDirection(new THREE.Vector3());
  camera.position.copy(position);
  if ((usdCam as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const persp = usdCam as THREE.PerspectiveCamera;
    camera.fov = persp.fov;
    camera.near = persp.near;
    camera.far = persp.far;
  }
  camera.updateProjectionMatrix();
  // Orbit about the focus distance when authored, else a point 1 m ahead.
  const focus = (usdCam as THREE.PerspectiveCamera).focus;
  controls.target.copy(position).addScaledVector(direction, focus > 0 ? focus : 1);
  controls.update();
}
let treePanel: UsdTreePanel | undefined;

// ---------------------------------------------------------------------------
// USD structure sidebar + selection gizmo
// ---------------------------------------------------------------------------

const treeEl = document.getElementById("tree") as HTMLElement;
const inspectorEl = document.getElementById("inspector") as HTMLElement;

// ---------------------------------------------------------------------------
// TCP target handle — the mouse path of the XR interaction design (M34): a
// TransformControls drives a `TcpTargetHandle`, whose `change` events carry
// the target pose an application would hand to its IK. There is no IK here,
// so the handle follows the live link while idle and snaps back on release.
// ---------------------------------------------------------------------------

const tcpControls = new TransformControls(camera, renderer.domElement);
tcpControls.size = 0.6;
scene.add(tcpControls.getHelper());
let tcpHandle: TcpTargetHandle | null = null;
let tcpFolder: GUI | undefined;
const tcpState = {
  link: "",
  mode: "translate" as "translate" | "rotate",
  lockRotation: false,
  snap: false,
  status: "ok" as "ok" | "unreachable" | "colliding",
  phase: "-",
  x: 0,
  y: 0,
  z: 0,
};
tcpControls.addEventListener("dragging-changed", (event) => {
  controls.enabled = !event.value;
  if (!tcpHandle) return;
  if (event.value) tcpHandle.grab();
  else tcpHandle.release();
});

function detachTcp() {
  tcpControls.detach();
  tcpHandle?.dispose();
  tcpHandle = null;
  tcpFolder?.destroy();
  tcpFolder = undefined;
}

function applyTcpOptions(handle: TcpTargetHandle) {
  handle.constraints = {
    lockRotation: tcpState.lockRotation,
    ...(tcpState.snap ? { positionSnap: 0.01, angleSnap: Math.PI / 12 } : {}),
  };
  handle.setStatus({
    reachable: tcpState.status !== "unreachable",
    colliding: tcpState.status === "colliding",
  });
}

function buildTcpHandle(next: ThreeUsdRobot, link: string, size: number) {
  tcpControls.detach();
  tcpHandle?.dispose();
  const handle = new TcpTargetHandle(next, link, { size });
  applyTcpOptions(handle);
  scene.add(handle);
  tcpControls.attach(handle);
  const onEvent = (event: TcpTargetEvent) => {
    tcpState.phase = event.phase;
    [tcpState.x, tcpState.y, tcpState.z] = event.pose.position;
  };
  handle.addEventListener("grabstart", onEvent);
  handle.addEventListener("change", onEvent);
  handle.addEventListener("grabend", onEvent);
  tcpHandle = handle;
}

/** Default tool link: the deepest leaf of the kinematic tree. */
function guessToolLink(next: ThreeUsdRobot): string | null {
  const leaves = Object.values(next.tree.nodes).filter((n) => n.children.length === 0);
  leaves.sort((a, b) => b.depth - a.depth);
  return leaves[0]?.link ?? null;
}

function setupTcp(next: ThreeUsdRobot) {
  const links = next.getLinkNames();
  const tool = guessToolLink(next);
  if (!tool || links.length === 0) return;
  const radius = new THREE.Box3().setFromObject(next).getBoundingSphere(new THREE.Sphere()).radius;
  const size = THREE.MathUtils.clamp(radius * 0.12, 0.03, 0.3);
  tcpState.link = tool;
  tcpFolder = gui.addFolder("TCP target");
  tcpFolder.add(tcpState, "link", links).onChange((link: string) => buildTcpHandle(next, link, size));
  tcpFolder
    .add(tcpState, "mode", ["translate", "rotate"])
    .onChange((mode: "translate" | "rotate") => tcpControls.setMode(mode));
  const refresh = () => tcpHandle && applyTcpOptions(tcpHandle);
  tcpFolder.add(tcpState, "lockRotation").onChange(refresh);
  tcpFolder.add(tcpState, "snap").name("snap 1 cm / 15°").onChange(refresh);
  tcpFolder.add(tcpState, "status", ["ok", "unreachable", "colliding"]).onChange(refresh);
  tcpFolder.add(tcpState, "phase").listen().disable();
  for (const axis of ["x", "y", "z"] as const) {
    tcpFolder.add(tcpState, axis).decimals(3).listen().disable();
  }
  tcpFolder.close();
  buildTcpHandle(next, tool, size);
}

const selection = createSelectionGizmo({
  scene,
  camera,
  domElement: renderer.domElement,
  orbit: controls,
  getRoot: () => robot,
  resolveUnit: unitForHit,
  ignoreWhen: () => tcpControls.dragging || tcpControls.axis !== null,
  onPick: (unit, hit) => {
    // Reveal the exact mesh prim when one was hit, else the unit's link prim.
    const path =
      (hit?.userData.primPath as string | undefined) ??
      (unit as { primPath?: string } | null)?.primPath ??
      null;
    treePanel?.select(path);
  },
});

/** The direct child of the robot root containing `obj` — the movable unit. */
function unitOf(obj: THREE.Object3D): THREE.Object3D | null {
  let cur = obj;
  while (cur.parent && cur.parent !== robot) cur = cur.parent;
  return cur.parent === robot ? cur : null;
}

/**
 * Viewport pick → movable unit. Robot geometry always resolves to the whole
 * articulation (one rigid unit, no FK). Scenery resolves to its enclosing
 * `kind = "component"` group — the USD model hierarchy, so a pallet moves with
 * its cartons — or to the exact mesh in "mesh" pick mode / unkinded stages.
 */
function unitForHit(hit: THREE.Object3D, root: THREE.Object3D): THREE.Object3D | null {
  if (hit.userData.kind === "scene") {
    if (gizmoState.pick === "component") {
      for (let cur: THREE.Object3D | null = hit; cur && cur !== root; cur = cur.parent) {
        const path = cur.userData.primPath as string | undefined;
        if (path && robot?.stage?.GetPrimAtPath(path)?.GetKind() === "component") return cur;
      }
    }
    return hit;
  }
  return unitOf(hit);
}

/** Tree selection → the clicked prim's subtree (links → the whole robot). */
function objectForPrim(path: string): THREE.Object3D | null {
  if (!robot) return null;
  const link = robot.getLinkObjectsByPath().get(path);
  if (link) return unitOf(link);
  let obj: THREE.Object3D | null = null;
  robot.traverse((o) => {
    if (!obj && o.userData.primPath === path) obj = o;
  });
  if (!obj) return null;
  // Scene groups/meshes move as exactly what was clicked; a robot's visual or
  // collision mesh must not leave its link, so take the whole robot instead.
  return (obj as THREE.Object3D).userData.kind === "scene" ? obj : unitOf(obj);
}

function deselect() {
  selection.select(null);
  treePanel?.select(null);
}

const gizmoState = {
  mode: "translate" as GizmoMode,
  space: "world" as "world" | "local",
  pick: "component" as "component" | "mesh",
};
const gizmoFolder = gui.addFolder("Gizmo");
const modeCtrl = gizmoFolder
  .add(gizmoState, "mode", ["translate", "rotate", "scale"])
  .onChange((mode: GizmoMode) => selection.setMode(mode));
gizmoFolder
  .add(gizmoState, "space", ["world", "local"])
  .onChange((space: "world" | "local") => selection.setSpace(space));
gizmoFolder.add(gizmoState, "pick", ["component", "mesh"]);
gizmoFolder.add({ deselect }, "deselect").name("deselect (Esc)");

const lighting = {
  fallback: true,
  toneMapping: "ACES" as ToneMappingPreset,
  exposure: 1,
  environment: 1,
  // `?ao=0` starts without the GTAO composer (automation on software GL).
  ambientOcclusion: params.get("ao") !== "0",
};
/**
 * Exposure for photometric (Omniverse-scaled) stages lit by their own rig.
 * The loader's ×0.001 keeps lights, dome and emissives in balance; this sets
 * the absolute level. Measured with scripts/reference/compare.py against
 * Isaac Sim's official Simple Room render: with the interior dome fraction
 * below, the floor luminance matches within 5 % at 0.8 (M32).
 */
const PHOTOMETRIC_EXPOSURE = 0.8;
/**
 * Image-based lighting cannot be occluded by the scene: inside a closed room
 * the dome shines through the walls at full strength, while RTX only lets it
 * in through openings. When a stage brings fixtures (rect / disk / sphere
 * lights) and no distant sun — an interior — the dome is applied at this
 * fraction; the Lighting panel exposes the resulting value.
 */
const INTERIOR_DOME_FRACTION = 0.3;
const lightingFolder = gui.addFolder("Lighting");
const fallbackCtrl = lightingFolder
  .add(lighting, "fallback")
  .name("fallback rig")
  .onChange((on: boolean) => {
    fallbackLights.visible = on;
  });
lightingFolder
  .add(lighting, "toneMapping", ["ACES", "AgX", "neutral", "none"])
  .name("tone mapping")
  .onChange((preset: ToneMappingPreset) => {
    applyRenderDefaults(renderer, { toneMapping: preset });
  });
const exposureCtrl = lightingFolder
  .add(lighting, "exposure", 0.05, 4, 0.05)
  .onChange((value: number) => {
    renderer.toneMappingExposure = value;
  });
const environmentCtrl = lightingFolder
  .add(lighting, "environment", 0, 3, 0.05)
  .name("environment")
  .onChange((value: number) => {
    scene.environmentIntensity = value;
    if (scene.background && !(scene.background as THREE.Color).isColor) {
      scene.backgroundIntensity = value;
    }
  });

// Post-processing stays app-side by design (see docs/lighting.md) — this is
// the recipe: RenderPass → GTAOPass → OutputPass on an MSAA target (so the
// anti-aliasing survives the composer), on by default since M30 — Isaac's
// renderers always compute ambient occlusion.
let composer: EffectComposer | null = null;
let gtaoPass: GTAOPass | null = null;
function ensureComposer(): EffectComposer {
  if (!composer) {
    const target = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    composer = new EffectComposer(renderer, target);
    composer.setPixelRatio(window.devicePixelRatio);
    composer.addPass(new RenderPass(scene, camera));
    gtaoPass = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
    composer.addPass(gtaoPass);
    composer.addPass(new OutputPass());
  }
  return composer;
}
lightingFolder
  .add(lighting, "ambientOcclusion")
  .name("GTAO (post)")
  .onChange((on: boolean) => {
    if (on) ensureComposer();
    if (scene.background === DEFAULT_BACKGROUND || scene.background === COMPOSER_BACKGROUND) {
      scene.background = defaultBackground();
    }
  });
if (lighting.ambientOcclusion) ensureComposer();
scene.background = defaultBackground();
lightingFolder.close();

/** The RoomEnvironment PMREM, built once, for stages without a DomeLight (M30). */
let roomEnvironment: THREE.Texture | null = null;

window.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) {
    return;
  }
  const mode = ({ t: "translate", r: "rotate", s: "scale" } as const)[event.key];
  if (mode) {
    gizmoState.mode = mode;
    selection.setMode(mode);
    modeCtrl.updateDisplay();
  } else if (event.key === "Escape") {
    deselect();
  }
});

/** Re-export whatever is loaded, straight from the browser. */
const exports = {
  usda: () => {
    if (robot) download("robot.usda", serializeUsda(exportThreeUsdRobot(robot)), "text/plain");
  },
  usdz: () => {
    if (!robot) return;
    const usda = serializeUsda(exportThreeUsdRobot(robot));
    // .slice() re-backs the view with a plain ArrayBuffer, as Blob requires.
    download("robot.usdz", writeUsdz({ "robot.usda": usda }).slice(), "model/vnd.usdz+zip");
  },
};
const exportFolder = gui.addFolder("Export USD");
exportFolder.add(exports, "usda").name("download .usda");
exportFolder.add(exports, "usdz").name("download .usdz");
exportFolder.close();

// ---------------------------------------------------------------------------
// Load / reload
// ---------------------------------------------------------------------------

async function load(url: string) {
  setStatus("loading…");
  tick = undefined;
  detachTcp();
  selection.select(null);
  treePanel?.dispose();
  treePanel = undefined;
  jointFolder?.destroy();
  playbackFolder?.destroy();
  cameraFolder?.destroy();
  jointFolder = undefined;
  playbackFolder = undefined;
  cameraFolder = undefined;

  try {
    // Isaac assets are variant-driven and multi-layer; the loader composes them.
    // `loadSceneGeometry` also draws scenery that belongs to no link.
    const next = await new ThreeUsdRobotLoader({ loadSceneGeometry: true }).loadAsync(url);
    if (robot) {
      scene.remove(robot);
      dispose(robot);
    }
    robot = next;
    scene.add(next);
    next.showJointAxes = true;
    frame(next);
    setupTcp(next);
    // Intensity calibration is the loader's job now: `lightIntensityScale`
    // defaults to "auto" (photometric Omniverse stages → ×0.001).

    // Stages that bring a lighting setup (a dome, or several lights) render
    // with it; a single stray light — Franka ships one SphereLight — keeps the
    // fallback rig too. Toggle either way from the Lighting folder.
    lighting.fallback = next.domeLights.length === 0 && next.lights.length < 2;
    fallbackLights.visible = lighting.fallback;
    fallbackCtrl.updateDisplay();

    if (next.stage) {
      treePanel = createUsdTreePanel(treeEl, inspectorEl, next.stage, {
        onSelect: (prim) => selection.select(objectForPrim(prim.GetPath())),
      });
    }

    jointFolder = gui.addFolder("Joints");
    const panel = createJointSliderPanel(next, jointFolder);

    // USD cameras (sensor or authored viewpoints): jump the viewer into them.
    if (next.cameras.length > 0) {
      cameraFolder = gui.addFolder("Cameras");
      for (const usdCam of next.cameras) {
        cameraFolder
          .add({ view: () => viewFromUsdCamera(usdCam) }, "view")
          .name(usdCam.name || (usdCam.userData.primPath as string));
      }
      cameraFolder.close();
    }
    const lightNote =
      next.lights.length + next.domeLights.length > 0
        ? `, ${next.lights.length} lights${next.domeLights.length > 0 ? " + dome" : ""}`
        : "";
    const statusText = `${next.robot.name} — ${next.getLinkNames().length} links, ${next.getJointNames().length} joints${lightNote}`;
    setStatus(statusText);

    // Stages lit by their own photometric rig sit next to Isaac's default
    // look at a lower exposure; anything on the fallback rig stays at 1.
    lighting.exposure =
      !lighting.fallback && (next.lightIntensityScale ?? 1) < 1 ? PHOTOMETRIC_EXPOSURE : 1;
    renderer.toneMappingExposure = lighting.exposure;
    exposureCtrl.updateDisplay();

    // DomeLight → IBL: environment map (+ background), oriented and scaled
    // consistently with the bound lights. HDRIs can be tens of MB, so keep the
    // viewer interactive and note the fetch in the status line. Stages without
    // a dome get three's RoomEnvironment instead (M30), so metals and glossy
    // plastics have something to reflect.
    resetEnvironment();
    if (next.domeLights.length > 0) setStatus(`${statusText} — fetching dome environment…`);
    const interior =
      next.lights.some((l) => !(l as THREE.DirectionalLight).isDirectionalLight) &&
      !next.lights.some((l) => (l as THREE.DirectionalLight).isDirectionalLight);
    const env = await applyUsdEnvironment(next, scene, {
      background: true,
      fallback: roomEnvironment ?? "room",
      fallbackIntensity: 0.8, // a white robot under a white studio box clips at 1
      renderer,
      ...(interior ? { intensityScale: (next.lightIntensityScale ?? 1) * INTERIOR_DOME_FRACTION } : {}),
      onWarn: (m) => console.warn(`[three-usd-robot] ${m}`),
    });
    if (env?.source === "room") roomEnvironment = env.texture;
    // The user may have switched assets while the HDRI streamed in.
    if (robot !== next) {
      resetEnvironment();
      return;
    }
    lighting.environment = env?.intensity ?? 1;
    environmentCtrl.updateDisplay();
    setStatus(statusText);

    // Playback controls appear only for animated assets.
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
  } catch (err) {
    console.error(err);
    setStatus(`failed to load ${url}: ${(err as Error).message}`);
  }
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer?.setSize(window.innerWidth, window.innerHeight);
});

function renderFrame() {
  tick?.();
  controls.update();
  selection.update();
  if (lighting.ambientOcclusion && composer) composer.render();
  else renderer.render(scene, camera);
}

// Viewer internals for automated tooling (screenshot scripts, e2e checks):
// `renderOnce()` stops the loop and draws one deterministic frame, so a
// software-GL headless browser can read the canvas without racing it.
Object.assign(window as unknown as Record<string, unknown>, {
  __usdViewer: {
    scene,
    camera,
    controls,
    renderer,
    lighting,
    get robot() {
      return robot;
    },
    get gtaoPass() {
      return gtaoPass;
    },
    get tcpHandle() {
      return tcpHandle;
    },
    tcpControls,
    tcpState,
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
