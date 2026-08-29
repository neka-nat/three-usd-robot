import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RobotBuilder,
  type RobotDescription,
  Stage,
  ThreeUsdRobotLoader,
  extractRobotDescription,
  identity4,
  serializeUsda,
  validateRobotDescription,
} from "../src/index.js";

const DEG = Math.PI / 180;

/** Two-finger gripper: right_joint mirrors left_joint via NewtonMimicAPI. */
const GRIPPER = `#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1.0
    upAxis = "Z"
)

def Xform "World" (
    prepend apiSchemas = ["PhysicsArticulationRootAPI"]
)
{
    def Xform "palm" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def Xform "finger_left" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def Xform "finger_right" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </World/palm>
    }

    def PhysicsPrismaticJoint "left_joint" (
        prepend apiSchemas = ["PhysicsJointStateAPI:linear"]
    )
    {
        rel physics:body0 = </World/palm>
        rel physics:body1 = </World/finger_left>
        uniform token physics:axis = "Y"
        float physics:lowerLimit = 0
        float physics:upperLimit = 0.04
        float state:linear:physics:position = 0.02
        float state:linear:physics:position.timeSamples = {
            0: 0,
            10: 0.04,
        }
    }

    def PhysicsPrismaticJoint "right_joint" (
        prepend apiSchemas = ["NewtonMimicAPI"]
    )
    {
        rel physics:body0 = </World/palm>
        rel physics:body1 = </World/finger_right>
        uniform token physics:axis = "Y"
        float physics:lowerLimit = -0.04
        float physics:upperLimit = 0
        rel newton:mimicJoint = </World/left_joint>
        float newton:mimicCoef0 = 0
        float newton:mimicCoef1 = -1
        float state:linear:physics:position.timeSamples = {
            0: 0,
            10: 0.123,
        }
    }
}
`;

/** Revolute chain a → b (×2) → c (×0.5 + 90°), Newton form. */
const CHAIN = `#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1.0
    upAxis = "Z"
)

def Xform "World" (
    prepend apiSchemas = ["PhysicsArticulationRootAPI"]
)
{
    def Xform "base" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def Xform "l1" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def Xform "l2" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def Xform "l3" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </World/base>
    }

    def PhysicsRevoluteJoint "a"
    {
        rel physics:body0 = </World/base>
        rel physics:body1 = </World/l1>
        uniform token physics:axis = "Z"
    }

    def PhysicsRevoluteJoint "b" (
        prepend apiSchemas = ["NewtonMimicAPI"]
    )
    {
        rel physics:body0 = </World/l1>
        rel physics:body1 = </World/l2>
        uniform token physics:axis = "Z"
        rel newton:mimicJoint = </World/a>
        float newton:mimicCoef1 = 2
    }

    def PhysicsRevoluteJoint "c" (
        prepend apiSchemas = ["NewtonMimicAPI"]
    )
    {
        rel physics:body0 = </World/l2>
        rel physics:body1 = </World/l3>
        uniform token physics:axis = "Z"
        rel newton:mimicJoint = </World/b>
        float newton:mimicCoef0 = 90
        float newton:mimicCoef1 = 0.5
    }
}
`;

/** PhysX legacy form: q_this + gearing·q_ref + offset = 0. */
const PHYSX = `#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1.0
    upAxis = "Z"
)

def Xform "World" (
    prepend apiSchemas = ["PhysicsArticulationRootAPI"]
)
{
    def Xform "base" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def Xform "l1" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def Xform "l2" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </World/base>
    }

    def PhysicsRevoluteJoint "lead"
    {
        rel physics:body0 = </World/base>
        rel physics:body1 = </World/l1>
        uniform token physics:axis = "Z"
    }

    def PhysicsRevoluteJoint "follow" (
        prepend apiSchemas = ["PhysxMimicJointAPI:rotZ"]
    )
    {
        rel physics:body0 = </World/l1>
        rel physics:body1 = </World/l2>
        uniform token physics:axis = "Z"
        rel physxMimicJoint:rotZ:referenceJoint = </World/lead>
        float physxMimicJoint:rotZ:gearing = -1
        float physxMimicJoint:rotZ:offset = 10
    }
}
`;

describe("mimic extraction", () => {
  it("reads NewtonMimicAPI into the IR (offset SI-normalized)", () => {
    const desc = extractRobotDescription(Stage.OpenFromString(CHAIN));
    expect(desc.joints.b?.mimic).toEqual({ joint: "a", multiplier: 2, offset: 0 });
    expect(desc.joints.c?.mimic?.joint).toBe("b");
    expect(desc.joints.c?.mimic?.multiplier).toBe(0.5);
    expect(desc.joints.c?.mimic?.offset).toBeCloseTo(90 * DEG, 12);
    expect(desc.warnings).toBeUndefined();
  });

  it("keeps prismatic mimic offsets in linear units", () => {
    const desc = extractRobotDescription(Stage.OpenFromString(GRIPPER));
    expect(desc.joints.right_joint?.mimic).toEqual({
      joint: "left_joint",
      multiplier: -1,
      offset: 0,
    });
  });

  it("sign-flips the PhysX convention (q + G·q_ref + offset = 0)", () => {
    const desc = extractRobotDescription(Stage.OpenFromString(PHYSX));
    expect(desc.joints.follow?.mimic?.joint).toBe("lead");
    expect(desc.joints.follow?.mimic?.multiplier).toBe(1); // -gearing
    expect(desc.joints.follow?.mimic?.offset).toBeCloseTo(-10 * DEG, 12); // -offset, deg→rad
  });

  it("ignores a disabled Newton mimic", () => {
    const disabled = CHAIN.replace(
      "rel newton:mimicJoint = </World/a>",
      "bool newton:mimicEnabled = false\n        rel newton:mimicJoint = </World/a>",
    );
    const desc = extractRobotDescription(Stage.OpenFromString(disabled));
    expect(desc.joints.b?.mimic).toBeUndefined();
    expect(desc.joints.c?.mimic).toBeDefined();
  });

  it("drops a mimic to an unknown joint with a warning", () => {
    const broken = CHAIN.replace("</World/a>", "</World/nope>");
    const warnings: string[] = [];
    const desc = extractRobotDescription(Stage.OpenFromString(broken), {
      onWarn: (m) => warnings.push(m),
    });
    expect(desc.joints.b?.mimic).toBeUndefined();
    expect(warnings.some((w) => w.includes("mimic") && w.includes("nope"))).toBe(true);
  });

  it("drops a motion-kind mismatch with a warning", () => {
    const mismatch = GRIPPER.replace(
      'def PhysicsPrismaticJoint "right_joint"',
      'def PhysicsRevoluteJoint "right_joint"',
    );
    const warnings: string[] = [];
    const desc = extractRobotDescription(Stage.OpenFromString(mismatch), {
      onWarn: (m) => warnings.push(m),
    });
    expect(desc.joints.right_joint?.mimic).toBeUndefined();
    expect(warnings.some((w) => w.includes("mimic"))).toBe(true);
  });
});

describe("mimic runtime", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  const load = (usda: string) =>
    new ThreeUsdRobotLoader({
      upAxisConversion: "none",
      applyDriveTargetsAsInitialPose: false,
    }).parse(usda);

  it("applies the initial pose through the constraint", async () => {
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(GRIPPER);
    expect(robot.getJointValue("left_joint")).toBeCloseTo(0.02, 12);
    expect(robot.getJointValue("right_joint")).toBeCloseTo(-0.02, 12);
  });

  it("drives followers from the leader, through FK", async () => {
    const robot = await load(GRIPPER);
    expect(robot.setJointValue("left_joint", 0.03)).toBe(true);
    expect(robot.getJointValue("right_joint")).toBeCloseTo(-0.03, 12);

    const left = robot.getLinkWorldPosition("finger_left");
    const right = robot.getLinkWorldPosition("finger_right");
    expect(left.y).toBeCloseTo(0.03, 12);
    expect(right.y).toBeCloseTo(-0.03, 12);
  });

  it("propagates through chained mimics", async () => {
    const robot = await load(CHAIN);
    robot.setJointValue("a", 0.3);
    expect(robot.getJointValue("b")).toBeCloseTo(0.6, 12);
    expect(robot.getJointValue("c")).toBeCloseTo(0.3 + 90 * DEG, 12);
  });

  it("clamps propagated values to the follower's limits", async () => {
    const tight = GRIPPER.replace(
      "float physics:lowerLimit = -0.04",
      "float physics:lowerLimit = -0.01",
    );
    const clamped = await load(tight);
    clamped.setJointValue("left_joint", 0.04);
    expect(clamped.getJointValue("right_joint")).toBeCloseTo(-0.01, 12);
  });

  it("ignores direct sets on a follower (warn once)", async () => {
    const robot = await load(GRIPPER);
    robot.setJointValue("left_joint", 0.03);
    expect(robot.setJointValue("right_joint", 0.5)).toBe(false);
    robot.setJointValues({ right_joint: 0.5 });
    expect(robot.getJointValue("right_joint")).toBeCloseTo(-0.03, 12);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("mimic follower");
  });

  it("excludes followers from getJointNames, lists them via getMimicJointNames", async () => {
    const robot = await load(GRIPPER);
    expect(robot.getJointNames()).toEqual(["left_joint"]);
    expect(robot.getMimicJointNames()).toEqual(["right_joint"]);
    expect(robot.isMimicFollower("right_joint")).toBe(true);
    expect(robot.isMimicFollower("/World/right_joint")).toBe(true);
    expect(robot.isMimicFollower("left_joint")).toBe(false);
    expect(robot.getJointObject("right_joint")?.mimic?.joint).toBe("left_joint");
  });

  it("re-derives followers from the leader during setTime", async () => {
    const robot = await load(GRIPPER);
    robot.setTime(10);
    expect(robot.getJointValue("left_joint")).toBeCloseTo(0.04, 12);
    // The follower's own (deviating) samples are ignored; the constraint wins.
    expect(robot.getJointValue("right_joint")).toBeCloseTo(-0.04, 12);
  });

  it("excludes followers from jointValuesFromLinkTransforms values", async () => {
    const robot = await load(GRIPPER);
    const { values, residuals } = robot.jointValuesFromLinkTransforms({});
    expect(Object.keys(values)).toContain("/World/left_joint");
    expect(Object.keys(values)).not.toContain("/World/right_joint");
    expect(Object.keys(residuals)).toContain("/World/right_joint");
  });

  it("survives a mimic cycle without hanging", async () => {
    const cycle = CHAIN.replace(
      "rel newton:mimicJoint = </World/a>",
      "rel newton:mimicJoint = </World/c>",
    );
    const robot = await load(cycle);
    // b and c mimic each other's chain (b→c→b); no non-follower root exists,
    // so neither is commandable — but nothing loops forever.
    robot.setJointValue("a", 0.5);
    expect(robot.getJointValue("a")).toBeCloseTo(0.5, 12);
  });
});

describe("mimic export / round-trip", () => {
  it("RobotBuilder authors NewtonMimicAPI and it round-trips", async () => {
    const builder = new RobotBuilder({ name: "gripper" });
    builder.addLink({ name: "palm" });
    builder.addLink({ name: "fl" });
    builder.addLink({ name: "fr" });
    builder.addFixedJoint({ name: "root", child: "palm" });
    builder.addPrismaticJoint({
      name: "lead",
      parent: "palm",
      child: "fl",
      axis: "Y",
      lower: 0,
      upper: 0.04,
    });
    builder.addPrismaticJoint({
      name: "follow",
      parent: "palm",
      child: "fr",
      axis: "Y",
      lower: -0.04,
      upper: 0,
      mimic: { joint: "lead", multiplier: -1 },
    });

    const usda = serializeUsda(builder.toUsda());
    expect(usda).toContain("NewtonMimicAPI");
    expect(usda).toContain("newton:mimicJoint");

    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(usda);
    expect(robot.robot.joints.follow?.mimic).toEqual({
      joint: "lead",
      multiplier: -1,
      offset: 0,
    });
    robot.setJointValue("lead", 0.02);
    expect(robot.getJointValue("follow")).toBeCloseTo(-0.02, 12);
  });

  it("converts revolute offsets back to degrees on export", async () => {
    const desc = extractRobotDescription(Stage.OpenFromString(CHAIN));
    const { exportRobotUsda } = await import("../src/index.js");
    const usda = serializeUsda(exportRobotUsda(desc));
    expect(usda).toMatch(/newton:mimicCoef0 = 90\b/);
    const reloaded = extractRobotDescription(Stage.OpenFromString(usda));
    expect(reloaded.joints.c?.mimic?.offset).toBeCloseTo(90 * DEG, 6);
    expect(reloaded.joints.c?.mimic?.multiplier).toBe(0.5);
  });

  it("RobotBuilder rejects invalid mimic references", () => {
    const builder = new RobotBuilder({ name: "bad" });
    builder.addLink({ name: "a" });
    builder.addLink({ name: "b" });
    builder.addRevoluteJoint({ name: "j1", child: "a", axis: "Z" });
    builder.addPrismaticJoint({
      name: "j2",
      parent: "a",
      child: "b",
      mimic: { joint: "j1" },
    });
    expect(() => builder.build()).toThrow(/cannot mimic/);

    const missing = new RobotBuilder({ name: "bad2" });
    missing.addLink({ name: "a" });
    missing.addRevoluteJoint({ name: "j1", child: "a", axis: "Z", mimic: { joint: "nope" } });
    expect(() => missing.build()).toThrow(/unknown joint/);
  });
});

describe("mimic validation", () => {
  const baseJoint = {
    axis: "Z" as const,
    jointFrame0: identity4(),
    jointFrame1: identity4(),
  };
  const desc = (joints: RobotDescription["joints"]): RobotDescription => ({
    name: "r",
    rootLink: "a",
    links: {
      a: { name: "a", primPath: "/r/a", visualPrims: [] },
      b: { name: "b", primPath: "/r/b", visualPrims: [] },
      c: { name: "c", primPath: "/r/c", visualPrims: [] },
    },
    joints,
    upAxis: "Z",
    metersPerUnit: 1,
  });

  it("flags unknown leaders, kind mismatches, and cycles", () => {
    const issues = validateRobotDescription(
      desc({
        j1: {
          name: "j1",
          primPath: "/r/j1",
          type: "revolute",
          parent: "a",
          child: "b",
          ...baseJoint,
          mimic: { joint: "nope", multiplier: 1, offset: 0 },
        },
        j2: {
          name: "j2",
          primPath: "/r/j2",
          type: "prismatic",
          parent: "b",
          child: "c",
          ...baseJoint,
          mimic: { joint: "j1", multiplier: 1, offset: 0 },
        },
      }),
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain("mimic-unknown-joint");
    expect(codes).toContain("mimic-type-mismatch");
  });

  it("flags mimic cycles once per member", () => {
    const issues = validateRobotDescription(
      desc({
        j1: {
          name: "j1",
          primPath: "/r/j1",
          type: "revolute",
          parent: "a",
          child: "b",
          ...baseJoint,
          mimic: { joint: "j2", multiplier: 1, offset: 0 },
        },
        j2: {
          name: "j2",
          primPath: "/r/j2",
          type: "revolute",
          parent: "b",
          child: "c",
          ...baseJoint,
          mimic: { joint: "j1", multiplier: 1, offset: 0 },
        },
      }),
    );
    const cycles = issues.filter((issue) => issue.code === "mimic-cycle");
    expect(cycles.map((issue) => issue.subject).sort()).toEqual(["j1", "j2"]);
  });
});
