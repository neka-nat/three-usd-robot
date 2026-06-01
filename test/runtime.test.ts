import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { ThreeUsdRobot, ThreeUsdRobotLoader } from "../src/index.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

/**
 * Hand-derived FK for the test arm (Z-up, meters, no up-axis conversion):
 *   base   = (0, 0, 0)
 *   link1  = (0, 0, 1)                                   — invariant under q1
 *   link2  = (q2·cos q1, q2·sin q1, 2)
 * link1 sits at jointFrame0 (+Z 1) of joint1; link2 adds joint2's +Z 1 offset
 * plus the prismatic slide q2 along X, all rotated by q1 about Z.
 */
describe("ThreeUsdRobot — forward kinematics", () => {
  let robot: ThreeUsdRobot;
  beforeAll(async () => {
    // Disable up-axis conversion so FK is asserted in the raw (Z-up) stage frame.
    robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(ARM);
  });

  it("builds a controllable robot from USDA", () => {
    expect(robot).toBeInstanceOf(ThreeUsdRobot);
    expect(robot.getKinematicTree().root).toBe("base_link");
    // root_joint is a world-fixed attachment (folded into root placement), not
    // an articulated DOF — only the link→link joints are controllable.
    expect(robot.getJointNames().sort()).toEqual(["joint1", "joint2"]);
    expect(robot.getLinkNames().sort()).toEqual(["base_link", "link1", "link2"]);
  });

  it("places links at the rest pose (all joints zero)", () => {
    const base = robot.getLinkWorldPosition("base_link");
    expect([base.x, base.y, base.z]).toEqual([0, 0, 0]);

    const link1 = robot.getLinkWorldPosition("link1");
    expect([link1.x, link1.y, link1.z]).toEqual([0, 0, 1]);

    const link2 = robot.getLinkWorldPosition("link2");
    expect(link2.x).toBeCloseTo(0, 12);
    expect(link2.y).toBeCloseTo(0, 12);
    expect(link2.z).toBeCloseTo(2, 12);
  });

  it("matches hand-derived FK after setting joint values", () => {
    robot.setJointValues({ joint1: Math.PI / 2, joint2: 0.5 });

    // link1 origin is on the rotation axis, so it never moves.
    const link1 = robot.getLinkWorldPosition("link1");
    expect(link1.x).toBeCloseTo(0, 12);
    expect(link1.y).toBeCloseTo(0, 12);
    expect(link1.z).toBeCloseTo(1, 12);

    // link2 = (0.5·cos90, 0.5·sin90, 2) = (0, 0.5, 2)
    const link2 = robot.getLinkWorldPosition("link2");
    expect(link2.x).toBeCloseTo(0, 12);
    expect(link2.y).toBeCloseTo(0.5, 12);
    expect(link2.z).toBeCloseTo(2, 12);
  });

  it("rotates link2 around Z with joint1 (q2 fixed)", async () => {
    // joint1 is limited to ±90°, so use an unclamped robot to swing to ±90°.
    const free = await new ThreeUsdRobotLoader({
      clampJointLimits: false,
      upAxisConversion: "none",
    }).parse(ARM);

    free.setJointValues({ joint1: 0, joint2: 0.4 });
    let p = free.getLinkWorldPosition("link2");
    expect(p.x).toBeCloseTo(0.4, 12); // along +X
    expect(p.y).toBeCloseTo(0, 12);

    free.setJointValue("joint1", -Math.PI / 2); // -90°
    p = free.getLinkWorldPosition("link2");
    expect(p.x).toBeCloseTo(0, 12);
    expect(p.y).toBeCloseTo(-0.4, 12); // swung to -Y
    expect(p.z).toBeCloseTo(2, 12);
  });
});

describe("ThreeUsdRobot — joint values & limits", () => {
  it("clamps to authored limits by default", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    robot.setJointValue("joint1", 100); // upper is +90° = π/2
    expect(robot.getJointValue("joint1")).toBeCloseTo(Math.PI / 2, 12);
    robot.setJointValue("joint2", -5); // lower is 0
    expect(robot.getJointValue("joint2")).toBe(0);
  });

  it("respects clampJointLimits=false", async () => {
    const robot = await new ThreeUsdRobotLoader({ clampJointLimits: false }).parse(ARM);
    robot.setJointValue("joint1", 100);
    expect(robot.getJointValue("joint1")).toBe(100);
  });

  it("ignores world-fixed and unknown joints", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    // root_joint is world-fixed (not controllable); "nope" doesn't exist.
    expect(robot.setJointValue("root_joint", 5)).toBe(false);
    expect(robot.getJointValue("root_joint")).toBeUndefined();
    expect(robot.setJointValue("nope", 1)).toBe(false);
  });

  it("exposes the loader's parseRobotDescription", async () => {
    const desc = await new ThreeUsdRobotLoader().parseRobotDescription(ARM);
    expect(desc.rootLink).toBe("base_link");
    expect(Object.keys(desc.joints).length).toBe(3);
  });
});
