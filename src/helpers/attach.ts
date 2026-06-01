import type * as THREE from "three";
import type { ThreeUsdRobot } from "../three/ThreeUsdRobot.js";
import { JointAxisHelper } from "./JointAxisHelper.js";
import { JointLimitHelper } from "./JointLimitHelper.js";
import { LinkFrameHelper } from "./LinkFrameHelper.js";

/** Attach a {@link JointAxisHelper} to every articulated joint. Returns the helpers. */
export function addJointAxisHelpers(
  robot: ThreeUsdRobot,
  length?: number,
  color?: THREE.ColorRepresentation,
): JointAxisHelper[] {
  const out: JointAxisHelper[] = [];
  for (const name of robot.getJointNames()) {
    const joint = robot.getJointObject(name);
    if (!joint?.articulated) continue;
    const helper = new JointAxisHelper(joint, length, color);
    joint.add(helper);
    out.push(helper);
  }
  return out;
}

/** Attach a {@link JointLimitHelper} to every articulated joint. Returns the helpers. */
export function addJointLimitHelpers(
  robot: ThreeUsdRobot,
  radius?: number,
  color?: THREE.ColorRepresentation,
): JointLimitHelper[] {
  const out: JointLimitHelper[] = [];
  for (const name of robot.getJointNames()) {
    const joint = robot.getJointObject(name);
    if (!joint?.articulated) continue;
    const helper = new JointLimitHelper(joint, radius, color);
    joint.add(helper);
    out.push(helper);
  }
  return out;
}

/** Attach a {@link LinkFrameHelper} to every link. Returns the helpers. */
export function addLinkFrameHelpers(robot: ThreeUsdRobot, size?: number): LinkFrameHelper[] {
  const out: LinkFrameHelper[] = [];
  for (const name of robot.getLinkNames()) {
    const link = robot.getLinkObject(name);
    if (!link) continue;
    const helper = new LinkFrameHelper(size);
    link.add(helper);
    out.push(helper);
  }
  return out;
}
