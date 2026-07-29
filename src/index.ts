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
  bindSceneMeshes,
  buildGprimGeometry,
  buildMeshGeometry,
  buildMeshMaterial,
  type MeshKind,
} from "./three/MeshBinding.js";
export {
  type ResolvedMaterial,
  type ResolvedTexture,
  resolveBoundMaterial,
  type TextureTransform,
  type TextureWrap,
} from "./three/MaterialBinding.js";
export {
  createTextureProvider,
  type TextureColorSpace,
  type TextureOptions,
  type TextureProvider,
} from "./three/TextureBinding.js";
export {
  ThreeUsdRobot,
  type ThreeUsdRobotOptions,
  type WorldUpAxis,
} from "./three/ThreeUsdRobot.js";
export {
  ThreeUsdRobotLoader,
  type ThreeUsdRobotLoaderOptions,
} from "./three/ThreeUsdRobotLoader.js";

// Authoring & export (M14)
export {
  type AddJointOptions,
  type AddLinkOptions,
  RobotBuilder,
  type RobotBuilderOptions,
  type WorldFrame,
} from "./three/RobotBuilder.js";
export {
  exportThreeUsdRobot,
  type ExportThreeUsdRobotOptions,
  geometryToExportMesh,
  type GeometryToExportMeshOptions,
  materialToExportMaterial,
  threeGeometryProvider,
} from "./three/exportThreeUsdRobot.js";

// Re-export the Three.js-independent core surface.
export * from "./core.js";
