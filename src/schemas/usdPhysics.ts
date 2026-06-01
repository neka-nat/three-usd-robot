/**
 * UsdPhysics schema helpers for robot extraction.
 *
 * Reads the joint/body attributes that matter for kinematics. Values are
 * returned as authored (degrees for revolute limits, stage units for lengths);
 * SI normalization happens in `robot/normalize.ts`.
 */

import {
  type Mat4,
  makeRotationFromQuat,
  makeTranslation,
  multiply,
} from "../kinematics/transforms.js";
import { Quat, type SdfPath, type Vec3 } from "../parser/ast.js";
import type { Axis, JointType } from "../robot/RobotDescription.js";
import type { Prim } from "../usd/Prim.js";

const JOINT_TYPE_BY_SCHEMA: Record<string, JointType> = {
  PhysicsFixedJoint: "fixed",
  PhysicsRevoluteJoint: "revolute",
  PhysicsPrismaticJoint: "prismatic",
};

export const ARTICULATION_ROOT_API = "PhysicsArticulationRootAPI";
export const RIGID_BODY_API = "PhysicsRigidBodyAPI";
export const COLLISION_API = "PhysicsCollisionAPI";

/** Base joint type from the prim's schema type, or `null` if not a joint. */
export function getJointType(prim: Prim): JointType | null {
  return JOINT_TYPE_BY_SCHEMA[prim.GetTypeName()] ?? null;
}

/** Resolve `physics:body0` / `physics:body1` target paths (first target each). */
export function getJointBodies(prim: Prim): { body0?: SdfPath; body1?: SdfPath } {
  const body0 = prim.GetRelationship("physics:body0").GetTargets()[0];
  const body1 = prim.GetRelationship("physics:body1").GetTargets()[0];
  return {
    ...(body0 !== undefined ? { body0 } : {}),
    ...(body1 !== undefined ? { body1 } : {}),
  };
}

/** Joint axis token (`physics:axis`); defaults to `"X"` per UsdPhysics. */
export function getJointAxis(prim: Prim): Axis {
  const v = prim.GetAttribute("physics:axis").Get();
  return v === "Y" || v === "Z" ? v : "X";
}

/** Raw joint limits as authored (degrees for revolute; `undefined` if unauthored). */
export function getJointLimits(prim: Prim): { lower?: number; upper?: number } {
  const lower = readNumber(prim, "physics:lowerLimit");
  const upper = readNumber(prim, "physics:upperLimit");
  return {
    ...(lower !== undefined ? { lower } : {}),
    ...(upper !== undefined ? { upper } : {}),
  };
}

/**
 * The joint frame relative to body `index` (0 or 1), as a column-major matrix
 * `T(localPos) · R(localRot)`. Missing components default to identity.
 */
export function getJointLocalFrame(prim: Prim, index: 0 | 1): Mat4 {
  const pos = readVec3(prim, `physics:localPos${index}`, [0, 0, 0]);
  const rot = readQuat(prim, `physics:localRot${index}`, Quat.identity());
  return multiply(makeTranslation(pos), makeRotationFromQuat(rot));
}

export function hasArticulationRootAPI(prim: Prim): boolean {
  return prim.HasAPI(ARTICULATION_ROOT_API);
}

export function hasRigidBodyAPI(prim: Prim): boolean {
  return prim.HasAPI(RIGID_BODY_API);
}

export function hasCollisionAPI(prim: Prim): boolean {
  return prim.HasAPI(COLLISION_API);
}

/** Drive instance name for a joint type (`angular` for revolute, `linear` otherwise). */
export function driveKindFor(type: JointType): "angular" | "linear" {
  return type === "prismatic" ? "linear" : "angular";
}

/** Read `UsdPhysicsDriveAPI` parameters for the given instance, as authored. */
export function getJointDrive(
  prim: Prim,
  kind: "angular" | "linear",
): { targetPosition?: number; stiffness?: number; damping?: number; maxForce?: number } {
  const targetPosition = readNumber(prim, `drive:${kind}:physics:targetPosition`);
  const stiffness = readNumber(prim, `drive:${kind}:physics:stiffness`);
  const damping = readNumber(prim, `drive:${kind}:physics:damping`);
  const maxForce = readNumber(prim, `drive:${kind}:physics:maxForce`);
  return {
    ...(targetPosition !== undefined ? { targetPosition } : {}),
    ...(stiffness !== undefined ? { stiffness } : {}),
    ...(damping !== undefined ? { damping } : {}),
    ...(maxForce !== undefined ? { maxForce } : {}),
  };
}

/** Read `PhysicsJointStateAPI` position for the given instance, as authored. */
export function getJointStatePosition(prim: Prim, kind: "angular" | "linear"): number | undefined {
  return readNumber(prim, `state:${kind}:physics:position`);
}

// --- typed readers ---------------------------------------------------------

function readNumber(prim: Prim, name: string): number | undefined {
  const v = prim.GetAttribute(name).Get();
  return typeof v === "number" ? v : undefined;
}

function readVec3(prim: Prim, name: string, def: Vec3): Vec3 {
  const v = prim.GetAttribute(name).Get();
  if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number")) {
    return v as Vec3;
  }
  return def;
}

function readQuat(prim: Prim, name: string, def: Quat): Quat {
  const v = prim.GetAttribute(name).Get();
  return v instanceof Quat ? v : def;
}
