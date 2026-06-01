import { readFileSync } from "node:fs";
import * as THREE from "three";
import { beforeEach, describe, expect, it } from "vitest";
import {
  JointAxisHelper,
  JointLimitHelper,
  LinkFrameHelper,
  addJointAxisHelpers,
  addJointLimitHelpers,
  addLinkFrameHelpers,
} from "../src/helpers.js";
import { type ThreeUsdRobot, ThreeUsdRobotLoader } from "../src/index.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

describe("display toggles", () => {
  let robot: ThreeUsdRobot;
  beforeEach(async () => {
    robot = await new ThreeUsdRobotLoader().parse(ARM);
  });

  const visualMeshes = () => {
    const out: THREE.Object3D[] = [];
    robot.traverse((o) => {
      if ((o.userData as { kind?: string }).kind === "visual") out.push(o);
    });
    return out;
  };

  it("hides and shows visual meshes", () => {
    expect(visualMeshes().every((m) => m.visible)).toBe(true);
    robot.showVisual = false;
    expect(visualMeshes().every((m) => !m.visible)).toBe(true);
    robot.showVisual = true;
    expect(visualMeshes().every((m) => m.visible)).toBe(true);
  });

  it("adds joint-axis helpers on demand", () => {
    robot.showJointAxes = true;
    const helpers: THREE.Object3D[] = [];
    robot.traverse((o) => {
      if (o instanceof THREE.AxesHelper && o.name.endsWith(":axes")) helpers.push(o);
    });
    expect(helpers).toHaveLength(robot.getJointNames().length); // one per articulated joint
    expect(helpers.every((h) => h.visible)).toBe(true);

    robot.showJointAxes = false;
    expect(helpers.every((h) => !h.visible)).toBe(true);
  });

  it("adds link-frame helpers on demand", () => {
    robot.showLinkFrames = true;
    let count = 0;
    robot.traverse((o) => {
      if (o instanceof THREE.AxesHelper && o.name.endsWith(":frame")) count++;
    });
    expect(count).toBe(robot.getLinkNames().length);
  });
});

describe("helper classes", () => {
  it("JointAxisHelper points along the joint axis", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const joint = robot.getJointObject("joint1")!; // axis Z
    const helper = new JointAxisHelper(joint);
    expect(helper).toBeInstanceOf(THREE.ArrowHelper);
    // ArrowHelper orients its child line via quaternion; check the stored axis.
    expect(joint.axis.toArray()).toEqual([0, 0, 1]);
    expect(helper.name).toBe("joint1:axis");
  });

  it("LinkFrameHelper is an axes gizmo", () => {
    expect(new LinkFrameHelper(0.3)).toBeInstanceOf(THREE.AxesHelper);
  });

  it("JointLimitHelper builds an arc for revolute and a segment for prismatic", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const revolute = new JointLimitHelper(robot.getJointObject("joint1")!);
    expect(revolute).toBeInstanceOf(THREE.Line);
    expect(revolute.geometry.getAttribute("position").count).toBeGreaterThan(2); // arc

    const prismatic = new JointLimitHelper(robot.getJointObject("joint2")!);
    expect(prismatic.geometry.getAttribute("position").count).toBe(2); // segment
  });
});

describe("attach helpers", () => {
  it("attaches one helper per joint/link", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    expect(addJointAxisHelpers(robot)).toHaveLength(2); // joint1, joint2
    expect(addJointLimitHelpers(robot)).toHaveLength(2);
    expect(addLinkFrameHelpers(robot)).toHaveLength(3); // base_link, link1, link2
  });
});
