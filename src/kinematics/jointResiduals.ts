/**
 * Closed-form decomposition of a joint's observed parent→child transform
 * against its ideal single-DOF model (baked-playback diagnostics, M23).
 *
 * A UsdPhysics joint constrains child body1 to parent body0 through its two
 * authored frames: `inv(Wp) · Wc = F0 · M(q) · inv(F1)`, where `M(q)` rotates
 * about the joint axis (revolute / continuous), slides along it (prismatic),
 * or is identity (fixed). Observed world transforms therefore yield
 *
 *     D = inv(F0) · inv(Wp) · Wc · F1
 *
 * which equals `M(q)` exactly for a constraint-consistent pose. This module
 * extracts `q` from `D` and reports what remains as residuals: translation at
 * the joint anchor (`anchorError`, stage linear units) and rotation off the
 * DOF (`axisError`, radians — the swing of a swing–twist split for revolute
 * joints). Inputs must be rigid stage-space transforms, before any
 * `metersPerUnit` or up-axis normalization.
 */

import { type Mat4, decomposeRigid, invert, multiplyAll } from "./transforms.js";

/** The slice of a joint description the decomposition needs (structurally satisfied by `JointDescription`). */
export type JointDofInput = {
  type: "fixed" | "revolute" | "continuous" | "prismatic";
  /** Axis token as authored (`physics:axis`). */
  axis: "X" | "Y" | "Z";
  /** Joint frame in the parent (body0) local space. */
  jointFrame0: Mat4;
  /** Joint frame in the child (body1) local space. */
  jointFrame1: Mat4;
};

export type JointRelativeDecomposition = {
  /** Joint value along the DOF (radians / stage length units; `0` for fixed). */
  q: number;
  /** Translation residual at the joint anchor (stage linear units). */
  anchorError: number;
  /** Rotation residual off the DOF (radians). */
  axisError: number;
};

const AXIS_INDEX = { X: 0, Y: 1, Z: 2 } as const;

/** Decompose `inv(Wp)·Wc` against the joint's single-DOF model (see module docs). */
export function decomposeJointRelative(
  joint: JointDofInput,
  parentWorld: Mat4,
  childWorld: Mat4,
): JointRelativeDecomposition {
  const d = multiplyAll([
    invert(joint.jointFrame0),
    invert(parentWorld),
    childWorld,
    joint.jointFrame1,
  ]);
  const t: [number, number, number] = [d[12]!, d[13]!, d[14]!];

  // Principal-branch (w ≥ 0) unit quaternion of D's rotation block.
  const { orientation } = decomposeRigid(d);
  const sign = orientation.real < 0 ? -1 : 1;
  const w = sign * orientation.real;
  const vx = sign * orientation.imaginary[0];
  const vy = sign * orientation.imaginary[1];
  const vz = sign * orientation.imaginary[2];
  const rotationAngle = 2 * Math.atan2(Math.hypot(vx, vy, vz), w);

  const i = AXIS_INDEX[joint.axis];
  if (joint.type === "prismatic") {
    const anchor = Math.hypot(i === 0 ? 0 : t[0], i === 1 ? 0 : t[1], i === 2 ? 0 : t[2]);
    return { q: t[i], anchorError: anchor, axisError: rotationAngle };
  }
  if (joint.type === "fixed") {
    return { q: 0, anchorError: Math.hypot(...t), axisError: rotationAngle };
  }

  // Revolute / continuous — swing–twist about the axis: the twist is the joint
  // value, the swing is the violation. With d normalized and w ≥ 0 the twist
  // is (w, proj·axis)/‖(w, proj)‖ and cos(swing/2) = ‖(w, proj)‖.
  const proj = i === 0 ? vx : i === 1 ? vy : vz;
  const twistNorm = Math.hypot(w, proj);
  const q = twistNorm > 1e-12 ? 2 * Math.atan2(proj, w) : 0;
  const swing = 2 * Math.atan2(Math.sqrt(Math.max(0, 1 - twistNorm * twistNorm)), twistNorm);
  return { q, anchorError: Math.hypot(...t), axisError: swing };
}

/**
 * Move `q` to the 2πk branch nearest `previous` — frame-to-frame continuity
 * past ±π for revolute/continuous joints (`opts.previous` of
 * `jointValuesFromLinkTransforms`).
 */
export function nearestAngleBranch(q: number, previous: number): number {
  const TWO_PI = 2 * Math.PI;
  return q + TWO_PI * Math.round((previous - q) / TWO_PI);
}
