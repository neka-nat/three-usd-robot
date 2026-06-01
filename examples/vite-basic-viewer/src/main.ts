import { ThreeUsdRobotLoader } from "three-usd-robot";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202024);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(2, 2, 2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);

scene.add(new THREE.GridHelper(4, 8, 0x444444, 0x303030));
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(3, 5, 2);
scene.add(sun);

async function main() {
  const robot = await new ThreeUsdRobotLoader().loadAsync("/robot.usda");
  scene.add(robot); // up-axis & units normalized by the loader (upAxisConversion: "auto")

  // A static rest-pose pose-set, just to show the API.
  robot.setJointValues({ joint1: 0.4, joint2: 0.25 });

  console.info("links:", robot.getLinkNames(), "joints:", robot.getJointNames());
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

main().catch((err) => {
  console.error(err);
});
