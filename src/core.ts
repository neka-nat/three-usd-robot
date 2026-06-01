/**
 * `three-usd-robot/core`
 *
 * Three.js-independent core: USDA parsing and a pxr-USD-style runtime API
 * (`Stage`, `Prim`, `Attribute`, `Relationship`). Importable on the server or
 * in tooling that never touches a Three.js scene.
 *
 * The robot IR and forward-kinematics math (M3–M4) land here next.
 */

export { PACKAGE_NAME, VERSION } from "./version.js";

// USDA value model & AST
export {
  AssetPath,
  type AttributeSpec,
  type CompositionArc,
  type ListOp,
  type MetadataMap,
  type PrimSpec,
  type PropertySpec,
  Quat,
  type RelationshipSpec,
  type SdfPath,
  type Specifier,
  type UsdaFile,
  type UsdDictionary,
  UsdMatrix,
  type UsdValue,
  type Variability,
  type Vec2,
  type Vec3,
  type Vec4,
} from "./parser/ast.js";

// Parser
export { parseUsda } from "./parser/parseUsda.js";
export { ParseError } from "./parser/reader.js";
export { tokenize, TokenizeError } from "./parser/tokenize.js";

// USD-conformant runtime API
export { Attribute, Relationship } from "./usd/Attribute.js";
export { Layer } from "./usd/Layer.js";
export { Prim } from "./usd/Prim.js";
export { DEFAULT_METERS_PER_UNIT, Stage, type UpAxis } from "./usd/Stage.js";

// Asset resolution & composition
export {
  type AssetResolver,
  createMemoryResolver,
  DefaultAssetResolver,
  joinPosix,
} from "./usd/AssetResolver.js";
export { type ComposeOptions, composeLayer } from "./usd/composition.js";
export { openUsdz, type UsdzPackage } from "./usd/usdz.js";
export { CrateReader } from "./usd/crate/CrateReader.js";
export { crateToUsdaFile } from "./usd/crate/toUsdaFile.js";

// Transform math (column-major Mat4, Three.js elements layout)
export {
  DEG2RAD,
  fromUsdMatrix,
  getTranslation,
  identity4,
  invert,
  type Mat4,
  makeEuler,
  makeRotationFromQuat,
  makeRotationX,
  makeRotationY,
  makeRotationZ,
  makeScale,
  makeTranslation,
  multiply,
  multiplyAll,
  RAD2DEG,
} from "./kinematics/transforms.js";

// xformOp resolution
export { computeLocalTransform, parseOpType, type ResolvedXform } from "./usd/xformOps.js";

// Robot IR + extraction
export type {
  Axis,
  JointDescription,
  JointDriveDescription,
  JointType,
  LinkDescription,
  RobotDescription,
} from "./robot/RobotDescription.js";
export { type ExtractOptions, extractRobotDescription } from "./robot/RobotExtractor.js";
export {
  type BuildTreeOptions,
  buildKinematicTree,
  type KinematicNode,
  type KinematicTree,
  type TreeEdge,
} from "./robot/buildKinematicTree.js";
export { jointValueToSI, normalizeJointLimits, refineJointType } from "./robot/normalize.js";

// USD schema accessors
export {
  gatherMeshDescendants,
  isMesh,
  isScope,
  isXform,
  iterDescendants,
} from "./schemas/usdGeom.js";
export {
  ARTICULATION_ROOT_API,
  COLLISION_API,
  driveKindFor,
  getJointAxis,
  getJointBodies,
  getJointDrive,
  getJointLimits,
  getJointLocalFrame,
  getJointStatePosition,
  getJointType,
  hasArticulationRootAPI,
  hasCollisionAPI,
  hasRigidBodyAPI,
  RIGID_BODY_API,
} from "./schemas/usdPhysics.js";
