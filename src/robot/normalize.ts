/** SI normalization for joint values. */

import { DEG2RAD, RAD2DEG } from "../kinematics/transforms.js";
import type { JointType } from "./RobotDescription.js";

const isFinite_ = (x: number | undefined): x is number => x !== undefined && Number.isFinite(x);

/**
 * Normalize raw joint limits to SI: revolute/continuous degrees → radians;
 * prismatic kept in stage linear units (global metersPerUnit scaling is applied
 * at the root in M9). Non-finite or unauthored limits become `undefined`.
 */
export function normalizeJointLimits(
  type: JointType,
  rawLower: number | undefined,
  rawUpper: number | undefined,
): { lower?: number; upper?: number } {
  const angular = type === "revolute" || type === "continuous";
  const conv = (x: number | undefined): number | undefined => {
    if (!isFinite_(x)) return undefined;
    return angular ? x * DEG2RAD : x;
  };
  const lower = conv(rawLower);
  const upper = conv(rawUpper);
  return {
    ...(lower !== undefined ? { lower } : {}),
    ...(upper !== undefined ? { upper } : {}),
  };
}

/** Convert an authored joint value to SI (angular degrees → radians). */
export function jointValueToSI(angular: boolean, raw: number): number {
  return angular ? raw * DEG2RAD : raw;
}

/** Convert an SI joint value back to authored units (angular radians → degrees, M13 export). */
export function jointValueFromSI(angular: boolean, si: number): number {
  return angular ? si * RAD2DEG : si;
}

/**
 * A revolute joint with no finite limits is a continuous (unbounded) joint.
 * Returns the refined joint type.
 */
export function refineJointType(
  base: JointType,
  lower: number | undefined,
  upper: number | undefined,
): JointType {
  if (base === "revolute" && lower === undefined && upper === undefined) return "continuous";
  return base;
}
