/**
 * Robot intermediate representation (IR) — Three.js-independent.
 *
 * The extractor (`RobotExtractor`) turns a USD {@link Stage} into a
 * {@link RobotDescription}; the kinematics builder (M4) trees it; the Three.js
 * runtime (M5) realizes it as an `Object3D` hierarchy. Keeping the IR free of
 * Three.js lets the same data drive tooling, validation, and (later) IK.
 *
 * See concept.md §9 for the rationale behind each field.
 */

import type { SampleChannel } from "../kinematics/sampling.js";
import type { Mat4 } from "../kinematics/transforms.js";
import type { Quat, Vec3 } from "../parser/ast.js";

export type JointType = "fixed" | "revolute" | "continuous" | "prismatic";

/** Joint axis token as authored in USD (`physics:axis`); never a vector here. */
export type Axis = "X" | "Y" | "Z";

export type RobotDescription = {
  name: string;
  /** Key of the root link (see {@link LinkDescription} keys). */
  rootLink: string;
  links: Record<string, LinkDescription>;
  joints: Record<string, JointDescription>;
  /** Link keys whose prim carries `PhysicsArticulationRootAPI` (root hint for M4). */
  articulationRoots?: string[];
  /** Joints dropped from the spanning tree to break closed loops (filled in M4). */
  loopJoints?: string[];
  /** Stage up axis, for the M9 up-axis correction. */
  upAxis: "Y" | "Z";
  /** Stage linear unit, for the M9 scale normalization. */
  metersPerUnit: number;
  /** Playback rate (time codes per second); defaults to 24 when unauthored. */
  timeCodesPerSecond?: number;
  /** Authored animation range (time codes), if any. */
  startTimeCode?: number;
  endTimeCode?: number;
  /** Non-fatal extraction diagnostics. */
  warnings?: string[];
};

export type LinkDescription = {
  /** Display name (leaf prim name). */
  name: string;
  primPath: string;
  /** Renderable gprim paths (Mesh / Cube / Sphere / Cylinder / Capsule / Cone). */
  visualPrims: string[];
  /** Gprim paths flagged with a collision API (or a non-visual purpose). */
  collisionPrims?: string[];
  /** Mass properties (`UsdPhysicsMassAPI`), if authored (M16). */
  inertial?: LinkInertialDescription;
  /**
   * Authored stage (world) transform of the link prim, when not identity.
   * Joint chains place tree links; this places floating roots and links that
   * are isolated from the chosen tree (e.g. other machines / free bodies on a
   * multi-articulation stage).
   */
  worldTransform?: Mat4;
};

/** Mass properties as authored by `UsdPhysicsMassAPI` (stage units). */
export type LinkInertialDescription = {
  /** Mass in kilograms. */
  mass?: number;
  /** Center of mass in the link frame (stage linear units). */
  centerOfMass?: Vec3;
  /** Principal moments of inertia. */
  diagonalInertia?: Vec3;
  /** Orientation of the principal inertia axes in the link frame. */
  principalAxes?: Quat;
  /** Density — the physics engine derives mass from it when `mass` is absent. */
  density?: number;
};

export type JointDescription = {
  /** Display name (leaf prim name). */
  name: string;
  primPath: string;
  type: JointType;
  /** Parent link key (body0). Empty string `""` means fixed to the world. */
  parent: string;
  /** Child link key (body1). */
  child: string;

  axis: Axis;

  // Limits are normalized to SI: revolute/continuous in radians, prismatic in
  // stage linear units (global metersPerUnit scaling is applied at the root in
  // M9). `undefined` means unlimited.
  lower?: number;
  upper?: number;
  effort?: number;
  velocity?: number;

  /** Joint frame in the parent (body0) local space: `(localPos0, localRot0)`. */
  jointFrame0: Mat4;
  /** Joint frame in the child (body1) local space: `(localPos1, localRot1)`. */
  jointFrame1: Mat4;

  /** Initial joint value (SI) from JointStateAPI or a drive target, if authored. */
  initialValue?: number;
  /** Time-sampled joint value trajectory (SI), if authored — drives playback. */
  valueSamples?: SampleChannel;
  drive?: JointDriveDescription;
};

/** Authored joint drive parameters (`UsdPhysicsDriveAPI`), as read in M3. */
export type JointDriveDescription = {
  /** Target position in SI (radians for angular, linear units for linear). */
  targetPosition?: number;
  /** Gains/limits as authored (not unit-normalized). */
  stiffness?: number;
  damping?: number;
  maxForce?: number;
};
