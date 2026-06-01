/**
 * `three-usd-robot`
 *
 * Kinematic OpenUSD robot loader for Three.js. The main entry exposes the
 * Three.js runtime; the Three.js-independent core (USDA parser, robot IR,
 * transform math) lives at `three-usd-robot/core` and is re-exported
 * here for convenience.
 *
 * See MILESTONES.md for the implementation roadmap.
 */

export { PACKAGE_NAME, VERSION } from "./version.js";

// Three.js runtime
export { axisVector } from "./three/axis.js";
export { JointObject } from "./three/JointObject.js";
export { LinkObject } from "./three/LinkObject.js";
export {
  type BindMeshesOptions,
  bindRobotMeshes,
  buildMeshGeometry,
  buildMeshMaterial,
  type MeshKind,
} from "./three/MeshBinding.js";
export { ThreeUsdRobot, type ThreeUsdRobotOptions } from "./three/ThreeUsdRobot.js";
export {
  ThreeUsdRobotLoader,
  type ThreeUsdRobotLoaderOptions,
} from "./three/ThreeUsdRobotLoader.js";

// Re-export the Three.js-independent core surface.
export * from "./core.js";
