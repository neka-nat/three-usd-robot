/**
 * Simulation-readiness checks for a {@link RobotDescription} (M16).
 *
 * Validates what Isaac Sim's Asset Validator cares about that is visible from
 * the IR (plus, optionally, the export geometry): graph connectivity, limit
 * sanity, mass properties, and collision setup. `error` issues break
 * simulation; `warning` issues are quality gaps a physics engine tolerates
 * but misbehaves on.
 */

import type { RobotGeometryProvider } from "../export/GeometryProvider.js";
import { decomposeRigid } from "../kinematics/transforms.js";
import type { RobotDescription } from "./RobotDescription.js";
import { buildKinematicTree } from "./buildKinematicTree.js";

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  severity: ValidationSeverity;
  /** Stable machine-readable code (e.g. `unknown-link`, `no-collision`). */
  code: string;
  message: string;
  /** Link or joint key the issue refers to, when applicable. */
  subject?: string;
};

export type ValidateRobotOptions = {
  /** Enables mesh-level checks (collision presence / approximation). */
  geometry?: RobotGeometryProvider;
};

/** Check a robot IR for simulation-readiness; returns errors first. */
export function validateRobotDescription(
  desc: RobotDescription,
  options: ValidateRobotOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (severity: ValidationSeverity, code: string, message: string, subject?: string) =>
    issues.push({ severity, code, message, ...(subject !== undefined ? { subject } : {}) });

  if (Object.keys(desc.links).length === 0) {
    add("error", "no-links", "robot has no links");
  }

  for (const [key, joint] of Object.entries(desc.joints)) {
    if (joint.parent !== "" && !desc.links[joint.parent]) {
      add(
        "error",
        "unknown-link",
        `joint "${key}" references unknown parent "${joint.parent}"`,
        key,
      );
    }
    if (!desc.links[joint.child]) {
      add("error", "unknown-link", `joint "${key}" references unknown child "${joint.child}"`, key);
    }
    if (joint.lower !== undefined && joint.upper !== undefined && joint.lower > joint.upper) {
      add(
        "error",
        "invalid-limits",
        `joint "${key}" lower limit ${joint.lower} exceeds upper ${joint.upper}`,
        key,
      );
    }
    if (
      joint.initialValue !== undefined &&
      ((joint.lower !== undefined && joint.initialValue < joint.lower) ||
        (joint.upper !== undefined && joint.initialValue > joint.upper))
    ) {
      add(
        "warning",
        "initial-out-of-limits",
        `joint "${key}" initial value ${joint.initialValue} is outside its limits`,
        key,
      );
    }
    const frames = [
      ["jointFrame0", joint.jointFrame0],
      ["jointFrame1", joint.jointFrame1],
    ] as const;
    for (const [label, frame] of frames) {
      if (!decomposeRigid(frame).rigid) {
        add(
          "warning",
          "non-rigid-frame",
          `joint "${key}" ${label} carries scale/shear/reflection (discarded on export)`,
          key,
        );
      }
    }
  }

  const tree = buildKinematicTree(desc);
  for (const jointKey of tree.loopJoints) {
    add(
      "warning",
      "closed-loop",
      `joint "${jointKey}" closes a kinematic loop (dropped from the spanning tree)`,
      jointKey,
    );
  }
  for (const linkKey of tree.isolatedLinks) {
    add(
      "warning",
      "isolated-link",
      `link "${linkKey}" is unreachable from root "${tree.root}"`,
      linkKey,
    );
  }
  if ((desc.articulationRoots ?? []).length === 0 && !tree.rootJoint) {
    add(
      "warning",
      "no-articulation-root",
      "no ArticulationRootAPI link and no world-fixed joint — the base will float",
    );
  }

  for (const [key, link] of Object.entries(desc.links)) {
    const inertial = link.inertial;
    if (!inertial || (inertial.mass === undefined && inertial.density === undefined)) {
      add("warning", "no-inertial", `link "${key}" has no mass or density (PhysicsMassAPI)`, key);
    }
    if (inertial?.mass !== undefined && inertial.mass <= 0) {
      add("error", "bad-mass", `link "${key}" has non-positive mass ${inertial.mass}`, key);
    }
    if (inertial?.diagonalInertia?.some((v) => v < 0)) {
      add("error", "bad-inertia", `link "${key}" has a negative diagonal-inertia component`, key);
    }
    if (inertial?.principalAxes && !inertial.diagonalInertia) {
      add(
        "warning",
        "inertia-pairing",
        `link "${key}" authors principalAxes without diagonalInertia (dropped on export)`,
        key,
      );
    }

    if (options.geometry) {
      const meshes = options.geometry(key, link);
      const collisions = meshes.filter((mesh) => mesh.kind === "collision");
      if (collisions.length === 0) {
        add("warning", "no-collision", `link "${key}" has no collision geometry`, key);
      }
      for (const mesh of collisions) {
        if (!mesh.collisionApproximation) {
          add(
            "warning",
            "collision-approximation",
            `link "${key}" collision mesh "${mesh.name}" has no physics:approximation (PhysX dynamic bodies need a convex or primitive approximation)`,
            key,
          );
        }
      }
    }
  }

  return issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}
