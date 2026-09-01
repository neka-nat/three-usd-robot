import GUI from "lil-gui";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";
import {
  exportThreeUsdRobot,
  serializeUsda,
  type ThreeUsdRobot,
  ThreeUsdRobotLoader,
  type UsdBoundCamera,
  writeUsdz,
} from "three-usd-robot";
import { createJointSliderPanel } from "three-usd-robot/extras";
import { applyUsdEnvironment } from "three-usd-robot/rendering";
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
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// RectAreaLight (USD RectLight/DiskLight) needs its LTC lookup tables in WebGL.
RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
const DEFAULT_BACKGROUND = new THREE.Color(0x202024);
scene.background = DEFAULT_BACKGROUND;

/** Drop any DomeLight environment from a previously loaded asset. */
function resetEnvironment() {
  scene.environment = null;
  scene.background = DEFAULT_BACKGROUND;
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
fallbackLights.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
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

const selection = createSelectionGizmo({
  scene,
  camera,
  domElement: renderer.domElement,
  orbit: controls,
  getRoot: () => robot,
  resolveUnit: unitForHit,
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

const lighting = { fallback: true };
const lightingFolder = gui.addFolder("Lighting");
const fallbackCtrl = lightingFolder
  .add(lighting, "fallback")
  .name("fallback rig")
  .onChange((on: boolean) => {
    fallbackLights.visible = on;
  });
lightingFolder.close();

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
    const next = await new ThreeUsdRobotLoader({
      loadSceneGeometry: true,
      // Omniverse authors photometric intensities (thousands of nits); scale
      // them into this renderer's exposure-1 range. See docs/lighting.md.
      ...(url.startsWith(ISAAC) ? { lightIntensityScale: 0.001 } : {}),
    }).loadAsync(url);
    if (robot) {
      scene.remove(robot);
      dispose(robot);
    }
    robot = next;
    scene.add(next);
    next.showJointAxes = true;
    frame(next);

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

    // DomeLight → IBL: environment map (+ background), oriented and scaled
    // consistently with the bound lights. HDRIs can be tens of MB, so keep the
    // viewer interactive and note the fetch in the status line.
    resetEnvironment();
    if (next.domeLights.length > 0) {
      setStatus(`${statusText} — fetching dome environment…`);
      await applyUsdEnvironment(next, scene, {
        background: true,
        onWarn: (m) => console.warn(`[three-usd-robot] ${m}`),
      });
      // The user may have switched assets while the HDRI streamed in.
      if (robot !== next) {
        resetEnvironment();
        return;
      }
      setStatus(statusText);
    }

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
});

renderer.setAnimationLoop(() => {
  tick?.();
  controls.update();
  selection.update();
  renderer.render(scene, camera);
});

void load(initialUrl);
