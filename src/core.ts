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

// Writer (M12) — the parse direction's inverse
export { serializeUsda } from "./writer/writeUsda.js";

// Robot exporter (M13) — IR → USDA layer
export { type ExportRobotOptions, exportRobotUsda } from "./export/exportRobot.js";
export {
  type CollisionApproximation,
  type ExportMaterial,
  type ExportMesh,
  type ExportPhysicsMaterial,
  type RobotGeometryProvider,
  stageGeometryProvider,
  type TextureChannel,
} from "./export/GeometryProvider.js";
export { writeUsdz } from "./export/writeUsdz.js";

// Simulation-readiness validation (M16)
export {
  type ValidateRobotOptions,
  type ValidationIssue,
  type ValidationSeverity,
  validateRobotDescription,
} from "./robot/RobotValidator.js";

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
export { type BinarySource, toBytes, type UsdSource } from "./usd/bytes.js";
export { type ComposeOptions, composeFile, composeLayer } from "./usd/composition.js";

// MDL declaration parsing (M20) — family/value fidelity for MDL materials
export { collectMdlAssetPaths, loadMdlModules } from "./usd/mdl/loadMdlModules.js";
export {
  isMdlTexture,
  type MdlMaterialDecl,
  type MdlModule,
  type MdlModuleProvider,
  type MdlTextureValue,
  type MdlValue,
  parseMdl,
  parseMdlLiteral,
} from "./usd/mdl/parseMdl.js";
export { computeWorldTransform } from "./usd/xformOps.js";
export { isZip, openUsdz, type UsdzPackage } from "./usd/usdz.js";
export { CrateReader } from "./usd/crate/CrateReader.js";
export { crateToUsdaFile } from "./usd/crate/toUsdaFile.js";

// Transform math (column-major Mat4, Three.js elements layout)
export {
  decomposeRigid,
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
  toUsdMatrix,
} from "./kinematics/transforms.js";

// xformOp resolution
export { computeLocalTransform, parseOpType, type ResolvedXform } from "./usd/xformOps.js";

// Time-sample interpolation
export { channelFromSamples, interpolate, type SampleChannel } from "./kinematics/sampling.js";

// Robot IR + extraction
export type {
  Axis,
  JointDescription,
  JointDriveDescription,
  JointType,
  LinkDescription,
  LinkInertialDescription,
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
export {
  jointValueFromSI,
  jointValueToSI,
  normalizeJointLimits,
  refineJointType,
} from "./robot/normalize.js";

// USD schema accessors
export {
  gatherGprimDescendants,
  gatherMeshDescendants,
  isBasisCurves,
  isMesh,
  isPoints,
  isRenderableGprim,
  isScope,
  isSolidGprim,
  isUnsupportedGprim,
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
  getMassProperties,
  hasArticulationRootAPI,
  hasCollisionAPI,
  hasRigidBodyAPI,
  MASS_API,
  MESH_COLLISION_API,
  PHYSICS_MATERIAL_API,
  RIGID_BODY_API,
} from "./schemas/usdPhysics.js";
