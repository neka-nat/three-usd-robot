import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type RobotDescription,
  Stage,
  extractRobotDescription,
  getTranslation,
} from "../src/core.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

describe("extractRobotDescription — two-link arm", () => {
  let robot: RobotDescription;
  beforeAll(() => {
    robot = extractRobotDescription(Stage.OpenFromString(ARM));
  });

  it("names the robot from the default prim", () => {
    expect(robot.name).toBe("World");
    expect(robot.upAxis).toBe("Z");
    expect(robot.metersPerUnit).toBe(1);
    expect(robot.warnings).toBeUndefined();
  });

  it("collects the three links with the expected keys", () => {
    expect(Object.keys(robot.links).sort()).toEqual(["base_link", "link1", "link2"]);
    expect(robot.links.base_link?.primPath).toBe("/World/base_link");
  });

  it("gathers visual mesh descendants per link", () => {
    expect(robot.links.base_link?.visualPrims).toEqual(["/World/base_link/geom"]);
    expect(robot.links.link1?.visualPrims).toEqual(["/World/link1/geom"]);
    expect(robot.links.link2?.visualPrims).toEqual([]);
  });

  it("picks base_link as the (world-fixed) root", () => {
    expect(robot.rootLink).toBe("base_link");
  });

  it("extracts joints with type, parent and child", () => {
    expect(Object.keys(robot.joints).sort()).toEqual(["joint1", "joint2", "root_joint"]);

    expect(robot.joints.root_joint?.type).toBe("fixed");
    expect(robot.joints.root_joint?.parent).toBe(""); // world
    expect(robot.joints.root_joint?.child).toBe("base_link");

    expect(robot.joints.joint1?.type).toBe("revolute");
    expect(robot.joints.joint1?.parent).toBe("base_link");
    expect(robot.joints.joint1?.child).toBe("link1");

    expect(robot.joints.joint2?.type).toBe("prismatic");
    expect(robot.joints.joint2?.parent).toBe("link1");
    expect(robot.joints.joint2?.child).toBe("link2");
  });

  it("keeps axis as a token", () => {
    expect(robot.joints.joint1?.axis).toBe("Z");
    expect(robot.joints.joint2?.axis).toBe("X");
  });

  it("normalizes revolute limits to radians, leaves prismatic in linear units", () => {
    expect(robot.joints.joint1?.lower).toBeCloseTo(-Math.PI / 2, 12);
    expect(robot.joints.joint1?.upper).toBeCloseTo(Math.PI / 2, 12);

    expect(robot.joints.joint2?.lower).toBe(0);
    expect(robot.joints.joint2?.upper).toBe(0.5);
  });

  it("builds jointFrame0/1 from localPos/localRot", () => {
    expect(getTranslation(robot.joints.joint1!.jointFrame0)).toEqual([0, 0, 1]);
    expect(getTranslation(robot.joints.joint1!.jointFrame1)).toEqual([0, 0, 0]);
    expect(getTranslation(robot.joints.joint2!.jointFrame0)).toEqual([0, 0, 1]);
  });
});

describe("extractRobotDescription — joint type refinement", () => {
  it("treats a limitless revolute joint as continuous", () => {
    const usda = `#usda 1.0
def Xform "W"
{
    def Xform "a" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def Xform "b" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def PhysicsRevoluteJoint "spin"
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </W/a>
        rel physics:body1 = </W/b>
    }
}`;
    const robot = extractRobotDescription(Stage.OpenFromString(usda));
    expect(robot.joints.spin?.type).toBe("continuous");
    expect(robot.joints.spin?.lower).toBeUndefined();
    expect(robot.joints.spin?.upper).toBeUndefined();
  });

  it("reads a drive target as the initial value (degrees -> radians)", () => {
    const usda = `#usda 1.0
def Xform "W"
{
    def Xform "a" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def Xform "b" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def PhysicsRevoluteJoint "j" ( prepend apiSchemas = ["PhysicsDriveAPI:angular"] )
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </W/a>
        rel physics:body1 = </W/b>
        float physics:lowerLimit = -180
        float physics:upperLimit = 180
        float drive:angular:physics:targetPosition = 90
        float drive:angular:physics:stiffness = 1000
    }
}`;
    const robot = extractRobotDescription(Stage.OpenFromString(usda));
    expect(robot.joints.j?.initialValue).toBeCloseTo(Math.PI / 2, 12);
    expect(robot.joints.j?.drive?.targetPosition).toBeCloseTo(Math.PI / 2, 12);
    expect(robot.joints.j?.drive?.stiffness).toBe(1000); // gain kept as authored
  });
});
