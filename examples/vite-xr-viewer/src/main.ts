/**
 * WebXR viewer (M33 PoC): walk around a USD robot or cell at real scale.
 *
 * WebGL path only — three renders straight into the XR layer, so the usual
 * viewer defaults (`applyRenderDefaults`: ACES + soft shadows) apply directly;
 * no post stack. The XR pieces come from `three-usd-robot/xr`: the origin
 * rig, controller-ray picking, and the grip binding of a TCP target handle
 * (no IK in this viewer — the handle snaps back to the link on release).
 *
 *   ?asset=<url> | ?isaac=<path>   any asset / NVIDIA CDN asset (like the other examples)
 *   ?up=Z                          Z-up application world (botrail's convention) — the
 *                                  origin rig is rotated, the content is not
 *   ?emulate=1                     install the IWER headset emulator (desktop / headless)
 *   ?anim=0                        do not advance time-sampled animation
 *   ?scale=<n>                     tabletop player scale toggled by the left grip (default 5)
 *
 * Teaching (src/teach.ts): the right grip near a link turns its joint, A
 * records a waypoint (ghost + tool path), B undoes, X plays the taught loop,
 * Y clears; the trajectory exports as USD time samples (panel / `E`).
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { type ThreeUsdRobot, ThreeUsdRobotLoader } from "three-usd-robot";
import {
  getLinkMeshes,
  highlightLink,
  restoreAllLinkMaterials,
  restoreLinkMaterials,
} from "three-usd-robot/helpers";
import { applyRenderDefaults, applyUsdEnvironment } from "three-usd-robot/rendering";
import {
  bindXrGrab,
  onXrInput,
  TcpTargetHandle,
  type XrWorldUp,
  XrOriginRig,
  XrRayPicker,
} from "three-usd-robot/xr";
import {
  type EmulatedButton,
  type Emulator,
  aimEmulatedController,
  installEmulator,
  placeEmulatedController,
  setEmulatedButton,
} from "./emulate";
import { TextLabel } from "./label";
import { TeachSession } from "./teach";

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const ISAAC = "https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1";
const PRESETS: Record<string, string> = {
  "Franka Panda (CDN)": `${ISAAC}/Isaac/Robots/FrankaRobotics/FrankaPanda/franka.usd`,
  "Kawasaki RS007N + gripper (CDN)": `${ISAAC}/Isaac/Robots/Kawasaki/RS007N/rs007n_onrobot_rg2.usd`,
  "Factory cell (local)": "/factory.usda",
  "Animated arm (local)": "/arm_anim.usda",
};

const params = new URLSearchParams(location.search);
const isaacPath = params.get("isaac");
const initialUrl =
  params.get("asset") ?? (isaacPath ? `${ISAAC}/${isaacPath}` : Object.values(PRESETS)[0]!);
const worldUp: XrWorldUp = params.get("up") === "Z" ? "Z" : "Y";
const emulate = params.get("emulate") === "1";
const TABLETOP_SCALE = Number(params.get("scale") ?? 5) || 5;
const PHOTOMETRIC_EXPOSURE = 0.8;

const UP = worldUp === "Z" ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
/**
 * A horizontal vector from two ground-plane components, whatever the up axis.
 * The loader's Z-up → Y-up normalization maps (x, y, z) to (x, z, −y), so the
 * Y-up (a, ·, b) and the Z-up (a, −b, ·) name the same side of the model.
 */
const horizontal = (a: number, b: number) =>
  worldUp === "Z" ? new THREE.Vector3(a, -b, 0) : new THREE.Vector3(a, 0, b);

// ---------------------------------------------------------------------------
// Renderer, scene, origin rig
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({
  antialias: true, // the XR layer inherits the canvas attributes
  preserveDrawingBuffer: emulate, // lets headless scripts read the canvas after a frame
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
applyRenderDefaults(renderer); // ACES tone mapping + soft shadow maps
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202024);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.02, 300);
const rig = new XrOriginRig(renderer, camera, { worldUp });
scene.add(rig);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// Controller visuals: the standard models on the grips, a ray on each target ray.
const modelFactory = new XRControllerModelFactory();
for (const grip of rig.grips) grip.add(modelFactory.createControllerModel(grip));
const rayGeometry = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, 0, -1),
]);
for (const controller of rig.controllers) {
  const ray = new THREE.Line(rayGeometry, new THREE.LineBasicMaterial({ color: 0x8fb4ff }));
  ray.name = "ray";
  ray.scale.z = 3;
  controller.add(ray);
}

// ---------------------------------------------------------------------------
// Lighting, floor, shadows (the inspector's rig, trimmed)
// ---------------------------------------------------------------------------

const fallbackLights = new THREE.Group();
fallbackLights.name = "fallbackLights";
fallbackLights.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.3));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.normalBias = 0.02;
fallbackLights.add(sun, sun.target);
scene.add(fallbackLights);

// A visible floor grid at the XR floor height (comfort reference in VR) and an
// invisible shadow catcher just under it. Both sit a hair below 0 so an
// authored floor still wins.
const floorGeometry = new THREE.PlaneGeometry(1, 1);
if (worldUp === "Y") floorGeometry.rotateX(-Math.PI / 2);
const shadowCatcher = new THREE.Mesh(floorGeometry, new THREE.ShadowMaterial({ opacity: 0.35 }));
shadowCatcher.receiveShadow = true;
shadowCatcher.scale.setScalar(40);
shadowCatcher.position.addScaledVector(UP, -0.002);
scene.add(shadowCatcher);

const grid = new THREE.GridHelper(20, 40, 0x50545c, 0x34373d);
if (worldUp === "Z") grid.rotation.x = Math.PI / 2;
grid.position.addScaledVector(UP, -0.001);
scene.add(grid);

let roomEnvironment: THREE.Texture | null = null;
function resetEnvironment() {
  scene.environment = null;
  scene.background = new THREE.Color(0x202024);
}

// ---------------------------------------------------------------------------
// Asset loading & framing
// ---------------------------------------------------------------------------

let robot: ThreeUsdRobot | null = null;
let timeRange: { start: number; end: number } | null = null;
let time = 0;
/** Where the player stands / looks when a session starts (world). */
const viewpoint = { standAt: horizontal(0, 1.5), lookAt: new THREE.Vector3(), radius: 1 };

const status = document.getElementById("status") as HTMLDivElement;
const setStatus = (text: string) => {
  status.textContent = text;
};

function dispose(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
  });
}

/** Fit the fallback sun, pick the XR stand point, and frame the desktop camera. */
function frame(object: THREE.Object3D) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

  // Stand back far enough to see the whole thing, on the floor, facing it.
  const back = horizontal(0.35, 1).setLength(Math.max(radius * 2.2, 1.2));
  viewpoint.standAt.copy(center).add(back).projectOnPlane(UP);
  viewpoint.lookAt.copy(center);
  viewpoint.radius = radius;

  // Desktop orbit view. OrbitControls works in the camera's parent space, so
  // express the eye and the target in rig-local coordinates.
  const eye = center.clone().add(horizontal(1, 1).setLength(radius * 2.5)).addScaledVector(UP, radius * 0.8);
  camera.position.copy(rig.worldToLocal(eye));
  controls.target.copy(rig.worldToLocal(center.clone()));
  controls.update();

  sun.position.copy(center).add(horizontal(1, 0.7).setLength(radius * 2)).addScaledVector(UP, radius * 3);
  sun.target.position.copy(center);
  sun.shadow.normalBias = 0.02 * Math.max(radius, 1);
  const extent = radius * 1.5;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = radius;
  sun.shadow.camera.far = radius * 8;
  sun.shadow.camera.updateProjectionMatrix();
}

async function load(url: string) {
  setStatus("loading…");
  clearHighlights();
  timeRange = null;
  try {
    const next = await new ThreeUsdRobotLoader({ loadSceneGeometry: true, worldUp }).loadAsync(url);
    if (robot) {
      scene.remove(robot);
      dispose(robot);
    }
    robot = next;
    scene.add(next);
    frame(next);
    setupTcpHandle(next, viewpoint.radius);
    teach?.dispose();
    teach = tcpHandle
      ? new TeachSession({
          scene,
          robot: next,
          toolLink: tcpHandle.link,
          onChange: () => {
            restyle();
            updateTeachHud();
          },
        })
      : null;
    updateTeachHud();

    const fallback = next.domeLights.length === 0 && next.lights.length < 2;
    fallbackLights.visible = fallback;
    renderer.toneMappingExposure = !fallback && (next.lightIntensityScale ?? 1) < 1 ? PHOTOMETRIC_EXPOSURE : 1;

    const lightNote =
      next.lights.length + next.domeLights.length > 0
        ? `, ${next.lights.length} lights${next.domeLights.length > 0 ? " + dome" : ""}`
        : "";
    const text = `${next.robot.name} — ${next.getLinkNames().length} links, ${next.getJointNames().length} joints${lightNote} · ${worldUp}-up`;
    setStatus(text);

    // DomeLight → IBL (+ background); stages without a dome get the RoomEnvironment
    // for reflections but keep the dark backdrop (a white box is harsh in a headset).
    resetEnvironment();
    const env = await applyUsdEnvironment(next, scene, {
      background: next.domeLights.length > 0,
      fallback: roomEnvironment ?? "room",
      fallbackIntensity: 0.8,
      renderer,
      onWarn: (m) => console.warn(`[three-usd-robot] ${m}`),
    });
    if (env?.source === "room") roomEnvironment = env.texture;
    if (robot !== next) return; // switched assets while the HDRI streamed in

    timeRange = next.getTimeRange();
    time = timeRange?.start ?? 0;
    setStatus(text + (timeRange ? " · animated" : ""));
  } catch (err) {
    console.error(err);
    setStatus(`failed to load ${url}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Picking: hover highlight + trigger selection, labels on the controllers
// ---------------------------------------------------------------------------

const HOVER = { color: 0xffc400, emissiveIntensity: 0.5 } as const;
const SELECTED = { color: 0xff4444, emissiveIntensity: 0.8 } as const;
const GRABBED = { color: 0x40ff80, emissiveIntensity: 0.6 } as const;
const AT_LIMIT = { color: 0xff4040, emissiveIntensity: 0.9 } as const;
let hovered: string | null = null;
let selected: string | null = null;
let teach: TeachSession | null = null;

function restyle() {
  if (!robot) return;
  const grabbed = teach?.grabbedLink ?? null;
  for (const path of robot.getLinkObjectsByPath().keys()) {
    if (path === grabbed) highlightLink(robot, path, teach?.limitExceeded ? AT_LIMIT : GRABBED);
    else if (path === selected) highlightLink(robot, path, SELECTED);
    else if (path === hovered) highlightLink(robot, path, HOVER);
    else restoreLinkMaterials(robot, path);
  }
}
function clearHighlights() {
  hovered = null;
  selected = null;
  if (robot) restoreAllLinkMaterials(robot);
}

const pickers = rig.controllers.map((controller) => {
  const picker = new XrRayPicker(controller, () => (robot ? [robot] : []), {
    kinds: ["visual"],
    maxDistance: 30,
  });
  const label = new TextLabel(0.22, 1);
  label.position.set(0, 0.06, -0.1);
  controller.add(label);
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.008, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xffc400, depthTest: false }),
  );
  dot.renderOrder = 99;
  dot.visible = false;
  scene.add(dot);

  picker.addEventListener("hover", ({ hit }) => {
    // One hover at a time is enough for a PoC: the latest ray wins.
    hovered = hit?.link.primPath ?? (pickers.some((p) => p.picker.current) ? hovered : null);
    label.setText(hit ? hit.link.linkName : "");
    restyle();
  });
  picker.addEventListener("select", ({ hit }) => {
    selected = selected === hit.link.primPath ? null : hit.link.primPath;
    restyle();
  });
  return { picker, label, dot, controller };
});

// ---------------------------------------------------------------------------
// TCP target handle on the tool link (deepest leaf). Squeezing the right grip
// within reach of it grabs it (`bindXrGrab`); without IK in this viewer the
// handle just follows the hand and snaps back to the link on release.
// ---------------------------------------------------------------------------

let tcpHandle: TcpTargetHandle | null = null;
let unbindGrab: (() => void) | null = null;
const tcp = { link: null as string | null, phase: "-", changes: 0, last: null as number[] | null };
const GRAB_REACH = 0.2; // metres at life size

function guessToolLink(next: ThreeUsdRobot): string | null {
  const leaves = Object.values(next.tree.nodes).filter((n) => n.children.length === 0);
  leaves.sort((a, b) => b.depth - a.depth);
  return leaves[0]?.link ?? null;
}

function withinReach(grip: THREE.Object3D): boolean {
  if (!tcpHandle) return false;
  grip.updateWorldMatrix(true, false);
  tcpHandle.updateWorldMatrix(true, false);
  const a = new THREE.Vector3().setFromMatrixPosition(grip.matrixWorld);
  const b = new THREE.Vector3().setFromMatrixPosition(tcpHandle.matrixWorld);
  return a.distanceTo(b) <= GRAB_REACH * rig.playerScale;
}

function bindGrab() {
  unbindGrab?.();
  unbindGrab = null;
  const grip = rig.grip("right");
  if (!grip || !tcpHandle) return;
  unbindGrab = bindXrGrab(tcpHandle, grip, { when: () => withinReach(grip) });
}

function setupTcpHandle(next: ThreeUsdRobot, radius: number) {
  unbindGrab?.();
  unbindGrab = null;
  tcpHandle?.dispose();
  tcpHandle = null;
  const link = guessToolLink(next);
  if (!link) return;
  const handle = new TcpTargetHandle(next, link, {
    size: THREE.MathUtils.clamp(radius * 0.12, 0.03, 0.3),
  });
  scene.add(handle);
  handle.addEventListener("grabstart", (e) => {
    tcp.phase = e.phase;
  });
  handle.addEventListener("change", (e) => {
    tcp.phase = e.phase;
    tcp.changes++;
    tcp.last = e.pose.position;
  });
  handle.addEventListener("grabend", (e) => {
    tcp.phase = e.phase;
  });
  tcpHandle = handle;
  tcp.link = handle.link;
  bindGrab();
}

// Handedness arrives with the input source: (re)bind the grab when it does.
for (const controller of rig.controllers) onXrInput(controller, "connected", () => bindGrab());

// Grips: left toggles the tabletop view, right teleports to where the ray
// meets the floor — unless it is grabbing the TCP handle.
const floorPlane = new THREE.Plane(UP.clone(), 0);
for (const { controller } of pickers) {
  controller.addEventListener("squeezestart", () => {
    const hand = rig.handednessOf(controller) ?? (controller === rig.controllers[0] ? "right" : "left");
    if (hand === "left") {
      rig.playerScale = rig.playerScale === 1 ? TABLETOP_SCALE : 1;
      // Keep the model in front at the new scale: stand proportionally further back.
      const back = viewpoint.standAt.clone().sub(viewpoint.lookAt.clone().projectOnPlane(UP));
      const standAt = viewpoint.lookAt.clone().projectOnPlane(UP).addScaledVector(back, rig.playerScale);
      rig.recenter(standAt, viewpoint.lookAt);
    } else {
      const grip = rig.grip("right") ?? rig.grips[rig.controllers.indexOf(controller)];
      if (grip && withinReach(grip)) return; // the grab binding takes this squeeze
      if (grip && teach?.tryGrabLink(grip, GRAB_REACH * rig.playerScale)) return; // turn a joint
      controller.updateMatrixWorld();
      const ray = new THREE.Ray(
        new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld),
        new THREE.Vector3(0, 0, -1).transformDirection(controller.matrixWorld),
      );
      const point = ray.intersectPlane(floorPlane, new THREE.Vector3());
      if (point) rig.teleport(point);
    }
  });
  controller.addEventListener("squeezeend", () => teach?.releaseLink());
}

// ---------------------------------------------------------------------------
// Teaching: A records, B undoes (right); X plays, Y clears (left). Buttons
// are not events in WebXR — poll the gamepads once per frame.
// ---------------------------------------------------------------------------

const teachEl = document.getElementById("teach") as HTMLSpanElement;
const teachActions = {
  record: () => teach?.record(),
  undo: () => teach?.undo(),
  play: () => teach?.togglePlay(),
  clear: () => teach?.clear(),
  export: () => {
    if (!teach || !robot) return;
    download(`${robot.robot.name || "robot"}_taught.usda`, teach.exportUsda(), "text/plain");
  },
};
for (const [name, action] of Object.entries(teachActions)) {
  document.getElementById(`teach-${name}`)?.addEventListener("click", action);
}
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  const key = event.key.toLowerCase();
  if (key === "r") teachActions.record();
  else if (key === "u") teachActions.undo();
  else if (key === "p") teachActions.play();
  else if (key === "c") teachActions.clear();
  else if (key === "e") teachActions.export();
});

function updateTeachHud() {
  const playBtn = document.getElementById("teach-play");
  if (playBtn) playBtn.textContent = teach?.playing ? "pause" : "play";
  teachEl.textContent = teach
    ? `${teach.waypoints.length} waypoints${teach.playing ? " · playing" : ""}${teach.grabbedLink ? ` · turning ${teach.grabbedLink.split("/").pop()}` : ""}`
    : "";
}

/** xr-standard gamepad: [4] = A / X, [5] = B / Y. Edge-triggered per hand. */
const BUTTON_ACTIONS: Record<string, Record<number, () => void>> = {
  right: { 4: teachActions.record, 5: teachActions.undo },
  left: { 4: teachActions.play, 5: teachActions.clear },
};
const buttonsDown = new Map<string, boolean>();
function pollButtons() {
  const session = renderer.xr.getSession();
  if (!session) return;
  for (const source of session.inputSources) {
    const actions = BUTTON_ACTIONS[source.handedness];
    const buttons = source.gamepad?.buttons;
    if (!actions || !buttons) continue;
    for (const [index, action] of Object.entries(actions)) {
      const id = `${source.handedness}:${index}`;
      const pressed = buttons[Number(index)]?.pressed ?? false;
      if (pressed && !buttonsDown.get(id)) action();
      buttonsDown.set(id, pressed);
    }
  }
}

function download(filename: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Frame stats (DOM HUD + a label on the left controller)
// ---------------------------------------------------------------------------

const statsEl = document.getElementById("stats") as HTMLDivElement;
const statsLabel = new TextLabel(0.26, 3);
statsLabel.position.set(0, 0.12, -0.08);
const frameTimes: number[] = [];
let lastFrameAt = performance.now();
let xrFrames = 0;
let lastStatsAt = 0;

function stats() {
  const n = frameTimes.length || 1;
  const avg = frameTimes.reduce((a, b) => a + b, 0) / n;
  const worst = frameTimes.reduce((a, b) => Math.max(a, b), 0);
  const session = renderer.xr.getSession() as (XRSession & { frameRate?: number }) | null;
  return {
    presenting: renderer.xr.isPresenting,
    xrFrames,
    frameMsAvg: Math.round(avg * 10) / 10,
    frameMsMax: Math.round(worst * 10) / 10,
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    sessionFrameRate: session?.frameRate ?? null,
    playerScale: rig.playerScale,
    worldUp,
    time,
    timeRange,
  };
}

function updateStatsHud(now: number) {
  if (now - lastStatsAt < 250) return;
  lastStatsAt = now;
  const s = stats();
  const budget = 1000 / 72;
  const line1 = `${s.frameMsAvg.toFixed(1)} ms avg · ${s.frameMsMax.toFixed(1)} max (72 Hz = ${budget.toFixed(1)})`;
  const line2 = `${s.drawCalls} draw calls · ${(s.triangles / 1000).toFixed(0)}k tris`;
  const line3 =
    (s.presenting
      ? `XR ${s.sessionFrameRate ? `${s.sessionFrameRate} Hz` : ""} · scale 1:${s.playerScale}`
      : "desktop") +
    (tcpHandle ? ` · tcp ${tcp.phase} ×${tcp.changes}` : "") +
    (teach ? ` · wp ${teach.waypoints.length}${teach.playing ? " ▶" : ""}` : "");
  statsEl.textContent = `${line1}\n${line2}\n${line3}`;
  statsLabel.setText(`${line1}\n${line2}\n${line3}`);
}

// ---------------------------------------------------------------------------
// XR session lifecycle & the frame loop
// ---------------------------------------------------------------------------

let pendingRecenter = false;
let animate = params.get("anim") !== "0";

renderer.xr.addEventListener("sessionstart", () => {
  controls.enabled = false;
  xrFrames = 0;
  pendingRecenter = true;
  // The stats label rides the left controller; fall back to the second slot.
  (rig.controller("left") ?? rig.controllers[1])?.add(statsLabel);
});
renderer.xr.addEventListener("sessionend", () => {
  controls.enabled = true;
  statsLabel.removeFromParent();
  rig.reset();
  for (const { label, dot } of pickers) {
    label.setText("");
    dot.visible = false;
  }
  hovered = null;
  restyle();
  if (robot) frame(robot);
});

function renderFrame() {
  const now = performance.now();
  const elapsed = now - lastFrameAt;
  frameTimes.push(elapsed);
  if (frameTimes.length > 90) frameTimes.shift();
  lastFrameAt = now;

  // Clamp the step so a tab that sat without frames does not leap ahead.
  const delta = Math.min(elapsed / 1000, 0.25);
  if (teach?.active) {
    teach.update(delta); // the grab projection or the taught playback
  } else if (robot && timeRange && animate) {
    time += delta * robot.getTimeCodesPerSecond();
    if (time > timeRange.end) time = timeRange.start;
    robot.setTime(time);
  }

  if (renderer.xr.isPresenting) {
    xrFrames++;
    pollButtons();
    // The XR camera pose lands on `camera` during render, so the first loop
    // iteration still sees the desktop pose: recenter from the second frame on.
    if (pendingRecenter && xrFrames >= 2) {
      pendingRecenter = false;
      rig.recenter(viewpoint.standAt, viewpoint.lookAt);
    }
    for (const { picker, dot, label } of pickers) {
      picker.maxDistance = 30 * rig.playerScale; // a giant's reach is longer
      picker.update();
      const hit = picker.current;
      dot.visible = hit !== null;
      if (hit) dot.position.copy(hit.point);
      label.billboard(camera);
    }
    statsLabel.billboard(camera);
  } else {
    controls.update();
  }

  updateStatsHud(now);
  renderer.render(scene, camera);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// HUD controls
// ---------------------------------------------------------------------------

const presetEl = document.getElementById("preset") as HTMLSelectElement;
for (const [label, url] of Object.entries(PRESETS)) {
  const option = document.createElement("option");
  option.value = url;
  option.textContent = label;
  presetEl.append(option);
}
if (!Object.values(PRESETS).includes(initialUrl)) {
  const option = document.createElement("option");
  option.value = initialUrl;
  option.textContent = `(custom) ${initialUrl.split("/").pop()}`;
  presetEl.append(option);
}
presetEl.value = initialUrl;
presetEl.addEventListener("change", () => {
  const url = new URL(location.href);
  url.searchParams.set("asset", presetEl.value);
  url.searchParams.delete("isaac");
  history.replaceState(null, "", url);
  void load(presetEl.value);
});
(document.getElementById("anim") as HTMLInputElement).addEventListener("change", (e) => {
  animate = (e.target as HTMLInputElement).checked;
});
(document.getElementById("grid") as HTMLInputElement).addEventListener("change", (e) => {
  grid.visible = (e.target as HTMLInputElement).checked;
});
const upEl = document.getElementById("up") as HTMLSelectElement;
upEl.value = worldUp;
upEl.addEventListener("change", () => {
  const url = new URL(location.href);
  url.searchParams.set("up", upEl.value);
  location.href = url.toString(); // the rig and the loader are built for one up axis
});

// ---------------------------------------------------------------------------
// Boot: emulator (optional) → XR button → load
// ---------------------------------------------------------------------------

let emulator: Emulator | null = null;

async function main() {
  if (emulate) {
    emulator = await installEmulator();
    setStatus("IWER headset emulator installed — loading…");
  }
  // VRButton, not XRButton: a Quest 3 also offers immersive-ar, which XRButton
  // would pick first — this viewer wants the opaque VR session.
  document.body.appendChild(
    VRButton.createButton(renderer, { optionalFeatures: ["hand-tracking"] }),
  );
  renderer.setAnimationLoop(renderFrame);
  await load(initialUrl);
}

/** Link table for automated checks: prim path, name, world position, joint above. */
function linksOf(target: ThreeUsdRobot | null) {
  if (!target) return [];
  target.updateMatrixWorld(true);
  return [...target.getLinkObjectsByPath()].map(([path, link]) => {
    const box = new THREE.Box3();
    for (const mesh of getLinkMeshes(target, path, "visual")) box.expandByObject(mesh);
    return {
      path,
      name: link.linkName,
      position: target.getLinkWorldPosition(path).toArray(),
      center: box.isEmpty() ? null : box.getCenter(new THREE.Vector3()).toArray(),
      joint: target.tree.nodes[link.linkName]?.jointToParent ?? null,
    };
  });
}

// Viewer internals for automated tooling (scripts/xr-capture.py).
Object.assign(window as unknown as Record<string, unknown>, {
  __xrViewer: {
    renderer,
    scene,
    camera,
    rig,
    controls,
    pickers,
    viewpoint,
    stats,
    get robot() {
      return robot;
    },
    get emulator() {
      return emulator;
    },
    get xrFrames() {
      return xrFrames;
    },
    get hovered() {
      return hovered;
    },
    get selected() {
      return selected;
    },
    /** Point an emulated controller at a world point (x, y, z). */
    aim(hand: "left" | "right", target: [number, number, number]) {
      if (emulator) aimEmulatedController(emulator, rig, hand, new THREE.Vector3(...target));
    },
    /** Press and release an emulated controller button (`trigger` | `squeeze`). */
    press(hand: "left" | "right", button: EmulatedButton) {
      const c = emulator?.controllers[hand];
      if (!c) return;
      c.updateButtonValue(button, 1);
      setTimeout(() => c.updateButtonValue(button, 0), 150);
    },
    /** Measurements for automated checks: head pose, robot footprint, rig placement. */
    report() {
      const head = camera.getWorldPosition(new THREE.Vector3());
      let box: THREE.Box3 | null = null;
      if (robot) {
        robot.updateMatrixWorld(true);
        box = new THREE.Box3().setFromObject(robot);
      }
      const upOf = (v: THREE.Vector3) => v.dot(UP);
      // The articulated links alone (a cell's bbox centre is usually empty air).
      const links = new THREE.Box3();
      if (robot) for (const link of robot.getLinkObjectsByPath().values()) links.expandByObject(link);
      const rays = rig.controllers.map((c) => {
        c.updateMatrixWorld();
        return {
          origin: new THREE.Vector3().setFromMatrixPosition(c.matrixWorld).toArray(),
          direction: new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld).toArray(),
        };
      });
      return {
        ...stats(),
        headLocal: camera.position.toArray(),
        headWorld: head.toArray(),
        headHeight: upOf(head),
        robotMin: box?.min.toArray() ?? null,
        robotMax: box?.max.toArray() ?? null,
        robotFloorGap: box ? upOf(box.min) : null,
        robotCenter: box?.getCenter(new THREE.Vector3()).toArray() ?? null,
        linksCenter: links.isEmpty() ? null : links.getCenter(new THREE.Vector3()).toArray(),
        controllerRays: rays,
        rig: { position: rig.position.toArray(), yaw: rig.yaw, scale: rig.playerScale },
        viewpoint: { standAt: viewpoint.standAt.toArray(), lookAt: viewpoint.lookAt.toArray() },
        hovered,
        selected,
        hoverNames: pickers.map((p) => p.picker.current?.link.linkName ?? null),
        tcp: {
          ...tcp,
          grabbed: tcpHandle?.grabbed ?? false,
          handleWorld: tcpHandle ? tcpHandle.getWorldPosition(new THREE.Vector3()).toArray() : null,
        },
        joints: robot
          ? Object.fromEntries(
              [...robot.getJointObjectsByPath()].map(([path, joint]) => [path, joint.value]),
            )
          : {},
        links: linksOf(robot),
        teach: teach
          ? {
              waypoints: teach.waypoints.length,
              playing: teach.playing,
              grabbing: teach.grabbedLink,
              limitExceeded: teach.limitExceeded,
              timeRange: robot?.getTimeRange() ?? null,
              time,
            }
          : null,
      };
    },
    teach: teachActions,
    /** The taught trajectory as USDA, parsed back through the loader for a self-check. */
    async verifyTaught() {
      if (!teach) return null;
      const usda = teach.exportUsda();
      const parsed = await new ThreeUsdRobotLoader({ worldUp }).parse(usda);
      const animated = parsed.getJointNames().filter((n) => parsed.robot.joints[n]?.valueSamples);
      const range = parsed.getTimeRange();
      const mid = range ? (range.start + range.end) / 2 : 0;
      parsed.setTime(mid);
      return {
        bytes: usda.length,
        hasTimeSamples: usda.includes("timeSamples"),
        animatedJoints: animated,
        timeRange: range,
        jointsAtMid: Object.fromEntries(animated.map((n) => [n, parsed.getJointValue(n)])),
      };
    },
    /** Move an emulated controller to a world point (x, y, z), keeping its aim. */
    place(hand: "left" | "right", point: [number, number, number]) {
      if (emulator) placeEmulatedController(emulator, rig, hand, new THREE.Vector3(...point));
    },
    /** Hold (true) or let go (false) of an emulated controller button. */
    hold(hand: "left" | "right", button: EmulatedButton, pressed: boolean) {
      if (emulator) setEmulatedButton(emulator, hand, button, pressed);
    },
    /** Start an immersive session without the button (for scripts). */
    async enterXR() {
      const session = await navigator.xr!.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor"],
      });
      await renderer.xr.setSession(session);
    },
  },
});

void main();
