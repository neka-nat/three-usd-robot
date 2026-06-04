import { ThreeUsdRobotLoader } from "three-usd-robot";
import { createJointSliderPanel } from "three-usd-robot/extras";
import GUI from "lil-gui";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202024);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.001, 1000);
camera.position.set(2, 2, 2);

const controls = new OrbitControls(camera, renderer.domElement);

scene.add(new THREE.GridHelper(4, 8, 0x444444, 0x303030));
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(3, 5, 2);
scene.add(sun);

/** Move the camera so the whole robot is in frame. */
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
}

const clock = new THREE.Clock();
let tick: (() => void) | undefined;

async function main() {
  // Load `?asset=<url>` (e.g. a binary .usd) or fall back to the sample arm.
  const asset = new URLSearchParams(location.search).get("asset") ?? "/robot.usda";
  const robot = await new ThreeUsdRobotLoader().loadAsync(asset);
  scene.add(robot); // up-axis & units are normalized by the loader (upAxisConversion: "auto")
  robot.showJointAxes = true;
  frame(robot);

  const gui = new GUI({ title: "three-usd-robot" });
  const panel = createJointSliderPanel(robot, gui.addFolder("Joints"));
  console.info("links:", robot.getLinkNames().length, "joints:", robot.getJointNames().length);

  // Playback controls appear only for animated assets.
  const range = robot.getTimeRange();
  if (range) {
    const fps = robot.getTimeCodesPerSecond();
    const pb = { playing: true, time: range.start };
    const folder = gui.addFolder("Playback");
    folder.add(pb, "playing").name("play");
    const timeCtrl = folder.add(pb, "time", range.start, range.end, 0.01).onChange(() => {
      pb.playing = false;
      robot.setTime(pb.time);
      panel.update();
    });
    tick = () => {
      if (!pb.playing) return;
      pb.time += clock.getDelta() * fps;
      if (pb.time > range.end) pb.time = range.start;
      robot.setTime(pb.time);
      timeCtrl.updateDisplay();
      panel.update();
    };
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
  renderer.render(scene, camera);
});

main().catch((err) => {
  console.error(err);
});
