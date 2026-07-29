import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ThreeUsdRobotLoader } from "../src/index.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

// Two arms whose links and joints share leaf names ("seg", "j1") — the
// extractor's naming contract keys those by full prim path instead.
const DUAL = `#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1.0
    upAxis = "Y"
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

    def Xform "armL"
    {
        def Xform "seg" (
            prepend apiSchemas = ["PhysicsRigidBodyAPI"]
        )
        {
        }

        def PhysicsRevoluteJoint "j1"
        {
            uniform token physics:axis = "Z"
            rel physics:body0 = </World/base>
            rel physics:body1 = </World/armL/seg>
            point3f physics:localPos0 = (-0.5, 0, 0)
            float physics:lowerLimit = -90
            float physics:upperLimit = 90
        }
    }

    def Xform "armR"
    {
        def Xform "seg" (
            prepend apiSchemas = ["PhysicsRigidBodyAPI"]
        )
        {
        }

        def PhysicsRevoluteJoint "j1"
        {
            uniform token physics:axis = "Z"
            rel physics:body0 = </World/base>
            rel physics:body1 = </World/armR/seg>
            point3f physics:localPos0 = (0.5, 0, 0)
            float physics:lowerLimit = -90
            float physics:upperLimit = 90
        }
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </World/base>
    }
}
`;

describe("naming contract — prim path addressing", () => {
  it("drives and reads joints by full prim path", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    expect(robot.setJointValue("/World/joint1", 0.4)).toBe(true);
    expect(robot.getJointValue("joint1")).toBeCloseTo(0.4, 6);

    robot.setJointValues({ "/World/joint2": 0.2, joint1: -0.1 });
    expect(robot.getJointValue("/World/joint2")).toBeCloseTo(0.2, 6);
    expect(robot.getJointValue("/World/joint1")).toBeCloseTo(-0.1, 6);
  });

  it("resolves link/joint objects identically by key and by path", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    expect(robot.getJointObject("/World/joint1")).toBe(robot.getJointObject("joint1"));
    expect(robot.getLinkObject("/World/link1")).toBe(robot.getLinkObject("link1"));
    expect(robot.getLinkWorldMatrix("/World/link1").equals(robot.getLinkWorldMatrix("link1"))).toBe(
      true,
    );
    expect(robot.getLinkObject("/nope")).toBeUndefined();
  });

  it("exposes path-keyed tables mapping onto the same objects", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);

    const links = robot.getLinkObjectsByPath();
    expect([...links.keys()].sort()).toEqual(["/World/base_link", "/World/link1", "/World/link2"]);
    expect(links.get("/World/link1")).toBe(robot.getLinkObject("link1"));
    for (const [path, obj] of links) expect(obj.primPath).toBe(path);

    const joints = robot.getJointObjectsByPath();
    expect(joints.get("/World/joint1")).toBe(robot.getJointObject("joint1"));
    expect(joints.get("/World/joint1")!.primPath).toBe("/World/joint1");
  });

  it("keys colliding leaf names by full path, addressable only by path", async () => {
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(DUAL);

    expect(robot.getJointNames().sort()).toEqual(["/World/armL/j1", "/World/armR/j1"]);
    expect([...robot.getLinkNames()].sort()).toEqual([
      "/World/armL/seg",
      "/World/armR/seg",
      "base",
    ]);

    // The ambiguous leaf is not a key; the paths are.
    expect(robot.getLinkObject("seg")).toBeUndefined();
    expect(robot.getLinkObject("/World/armL/seg")).toBeDefined();
    expect(robot.getJointObject("/World/armL/j1")).not.toBe(robot.getJointObject("/World/armR/j1"));
  });

  it("drives colliding joints independently via their paths", async () => {
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(DUAL);

    expect(robot.setJointValue("/World/armL/j1", 0.5)).toBe(true);
    expect(robot.getJointValue("/World/armL/j1")).toBeCloseTo(0.5, 6);
    expect(robot.getJointValue("/World/armR/j1")).toBe(0);

    // FK queries by path reach the right seg on each side.
    expect(robot.getLinkWorldPosition("/World/armL/seg").x).toBeCloseTo(-0.5, 6);
    expect(robot.getLinkWorldPosition("/World/armR/seg").x).toBeCloseTo(0.5, 6);
  });
});
