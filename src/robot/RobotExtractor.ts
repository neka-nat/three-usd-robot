/**
 * Extracts a {@link RobotDescription} from a USD {@link Stage}.
 *
 * Collects links (rigid bodies / joint-referenced prims) and the
 * Fixed/Revolute/Prismatic joints connecting them, resolves `body0`/`body1` to
 * link keys, and normalizes limits to SI. The authoritative root link and
 * closed-loop detection come from {@link buildKinematicTree} (M4), whose result
 * is written back into `rootLink` / `loopJoints`.
 */

import type { Mat4 } from "../kinematics/transforms.js";
import { gatherGprimDescendants, isNonVisualPurpose } from "../schemas/usdGeom.js";
import {
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
} from "../schemas/usdPhysics.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";
import { computeWorldTransform } from "../usd/xformOps.js";
import type {
  JointDescription,
  JointDriveDescription,
  LinkDescription,
  RobotDescription,
} from "./RobotDescription.js";
import { buildKinematicTree } from "./buildKinematicTree.js";
import { jointValueToSI, normalizeJointLimits, refineJointType } from "./normalize.js";

export type ExtractOptions = {
  /** Override the robot name (defaults to the stage default prim or first root prim). */
  robotName?: string;
  /** Receives non-fatal diagnostics; also collected into `RobotDescription.warnings`. */
  onWarn?: (message: string) => void;
};

/** World sentinel for a joint parent (fixed to world, `body0` empty). */
const WORLD = "";

export function extractRobotDescription(
  stage: Stage,
  options: ExtractOptions = {},
): RobotDescription {
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    options.onWarn?.(m);
  };

  // 1. Find joint prims.
  const jointPrims = stage.Traverse().filter((p) => getJointType(p) !== null);

  // 2. Collect link prim paths: joint-referenced bodies + rigid bodies.
  const linkPaths = new Set<string>();
  for (const jp of jointPrims) {
    const { body0, body1 } = getJointBodies(jp);
    if (body0) linkPaths.add(body0);
    if (body1) linkPaths.add(body1);
  }
  for (const p of stage.Traverse()) {
    if (hasRigidBodyAPI(p)) linkPaths.add(p.GetPath());
  }

  // 3. Choose stable keys (leaf name when unique, else full path).
  const linkKeyByPath = buildKeyMap([...linkPaths]);

  // 4. Build link descriptions; note articulation-root links.
  const links: Record<string, LinkDescription> = {};
  const articulationRoots: string[] = [];
  for (const path of linkPaths) {
    const key = linkKeyByPath.get(path)!;
    const prim = stage.GetPrimAtPath(path);
    links[key] = buildLink(path, prim);
    if (prim && hasArticulationRootAPI(prim)) articulationRoots.push(key);
  }

  // 5. Build joint descriptions.
  const joints: Record<string, JointDescription> = {};
  const jointKeyByPath = buildKeyMap(jointPrims.map((p) => p.GetPath()));
  for (const jp of jointPrims) {
    const joint = buildJoint(jp, linkKeyByPath, warn);
    if (joint) joints[jointKeyByPath.get(jp.GetPath())!] = joint;
  }

  const name =
    options.robotName ??
    stage.GetDefaultPrim()?.GetName() ??
    stage.GetPseudoRoot().GetChildren()[0]?.GetName() ??
    "robot";

  const robot: RobotDescription = {
    name,
    rootLink: "",
    links,
    joints,
    upAxis: stage.GetUpAxis(),
    metersPerUnit: stage.GetMetersPerUnit(),
    timeCodesPerSecond: stage.GetTimeCodesPerSecond(),
    ...(articulationRoots.length ? { articulationRoots } : {}),
  };
  const startTimeCode = stage.GetStartTimeCode();
  if (startTimeCode !== undefined) robot.startTimeCode = startTimeCode;
  const endTimeCode = stage.GetEndTimeCode();
  if (endTimeCode !== undefined) robot.endTimeCode = endTimeCode;

  // 6. Build the spanning tree to set the authoritative root + loop joints.
  const tree = buildKinematicTree(robot, { onWarn: warn });
  robot.rootLink = tree.root;
  if (tree.loopJoints.length) robot.loopJoints = tree.loopJoints;
  if (warnings.length) robot.warnings = warnings;

  return robot;
}

function buildLink(path: string, prim: Prim | null): LinkDescription {
  const name = leafName(path);
  if (!prim) return { name, primPath: path, visualPrims: [] };

  // Classify each gprim (Mesh or Cube/Sphere/Cylinder/Capsule/Cone solid).
  // `purpose` decides whether it renders (USD semantics), and
  // `PhysicsCollisionAPI` whether it collides — a gprim can be both, which
  // is how Isaac Sim assets usually ship: one mesh per link, drawn *and*
  // collided with. Only guide/proxy purposes are collision-only.
  const visualPrims: string[] = [];
  const collisionPrims: string[] = [];
  for (const meshPath of gatherGprimDescendants(prim)) {
    const mp = prim.GetStage().GetPrimAtPath(meshPath);
    if (!mp) continue;
    const nonVisual = isNonVisualPurpose(mp);
    if (!nonVisual) visualPrims.push(meshPath);
    if (nonVisual || hasCollisionAPI(mp)) collisionPrims.push(meshPath);
  }
  const inertial = getMassProperties(prim);
  const worldTransform = computeWorldTransform(prim);
  return {
    name,
    primPath: path,
    visualPrims,
    ...(collisionPrims.length ? { collisionPrims } : {}),
    ...(inertial ? { inertial } : {}),
    ...(isIdentityMat4(worldTransform) ? {} : { worldTransform }),
  };
}

function isIdentityMat4(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) {
    if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
  }
  return true;
}

function buildJoint(
  prim: Prim,
  linkKeyByPath: Map<string, string>,
  warn: (m: string) => void,
): JointDescription | null {
  const base = getJointType(prim);
  if (!base) return null;

  const path = prim.GetPath();
  const { body0, body1 } = getJointBodies(prim);
  if (!body1) {
    warn(`${path}: joint has no physics:body1 target; skipping`);
    return null;
  }

  const parent = body0 ? (linkKeyByPath.get(body0) ?? body0) : WORLD;
  const child = linkKeyByPath.get(body1) ?? body1;

  const raw = getJointLimits(prim);
  const { lower, upper } = normalizeJointLimits(base, raw.lower, raw.upper);
  const type = refineJointType(base, lower, upper);

  const joint: JointDescription = {
    name: leafName(path),
    primPath: path,
    type,
    parent,
    child,
    axis: getJointAxis(prim),
    jointFrame0: getJointLocalFrame(prim, 0),
    jointFrame1: getJointLocalFrame(prim, 1),
    ...(lower !== undefined ? { lower } : {}),
    ...(upper !== undefined ? { upper } : {}),
  };

  // Initial pose + drive (read here; applied as initial pose in M9).
  const kind = driveKindFor(type);
  const angular = kind === "angular";
  const drive = getJointDrive(prim, kind);
  const statePos = getJointStatePosition(prim, kind);

  const initialValue =
    statePos !== undefined
      ? jointValueToSI(angular, statePos)
      : drive.targetPosition !== undefined
        ? jointValueToSI(angular, drive.targetPosition)
        : undefined;
  if (initialValue !== undefined) joint.initialValue = initialValue;

  const driveDesc: JointDriveDescription = {
    ...(drive.targetPosition !== undefined
      ? { targetPosition: jointValueToSI(angular, drive.targetPosition) }
      : {}),
    ...(drive.stiffness !== undefined ? { stiffness: drive.stiffness } : {}),
    ...(drive.damping !== undefined ? { damping: drive.damping } : {}),
    ...(drive.maxForce !== undefined ? { maxForce: drive.maxForce } : {}),
  };
  if (Object.keys(driveDesc).length > 0) joint.drive = driveDesc;

  // Time-sampled trajectory: prefer joint-state position, else the drive target.
  const stateSamples = prim.GetAttribute(`state:${kind}:physics:position`).GetTimeSamples();
  const driveSamples = prim.GetAttribute(`drive:${kind}:physics:targetPosition`).GetTimeSamples();
  const samples = stateSamples.size > 0 ? stateSamples : driveSamples;
  if (samples.size > 0) {
    const times = [...samples.keys()].sort((a, b) => a - b);
    const values = times.map((t) => {
      const v = samples.get(t);
      return typeof v === "number" ? jointValueToSI(angular, v) : 0;
    });
    joint.valueSamples = { times, values };
  }

  return joint;
}

/** Map each path to a stable key: leaf name when unique, else the full path. */
function buildKeyMap(paths: string[]): Map<string, string> {
  const leafCounts = new Map<string, number>();
  for (const p of paths) {
    const leaf = leafName(p);
    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);
  }
  const map = new Map<string, string>();
  for (const p of paths) {
    const leaf = leafName(p);
    map.set(p, leafCounts.get(leaf) === 1 ? leaf : p);
  }
  return map;
}

function leafName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
