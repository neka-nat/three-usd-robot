import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { Stage, ThreeUsdRobotLoader, extractRobotDescription } from "../src/index.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

describe("M9 — up-axis & unit normalization", () => {
  it("auto-converts a Z-up asset into the Y-up scene", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM); // default upAxisConversion: "auto"
    // link1 sits at stage +Z 1; after Z-up -> Y-up it lands at world +Y 1.
    const p = robot.getLinkWorldPosition("link1");
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(1, 9);
    expect(p.z).toBeCloseTo(0, 9);
  });

  it('leaves orientation as-authored with "none"', async () => {
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(ARM);
    const p = robot.getLinkWorldPosition("link1");
    expect([p.x, p.y, p.z]).toEqual([0, 0, 1]);
  });

  it("applies unitScale × metersPerUnit at the root", async () => {
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none", unitScale: 3 }).parse(
      ARM,
    );
    expect(robot.scale.x).toBeCloseTo(3, 9);
    expect(robot.getLinkWorldPosition("link1").z).toBeCloseTo(3, 9);
  });

  it("scales centimetre assets by metersPerUnit", async () => {
    const cm = `#usda 1.0
(defaultPrim = "W" upAxis = "Y" metersPerUnit = 0.01)
def Xform "W"
{
    def Xform "base" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def PhysicsFixedJoint "rj" { rel physics:body1 = </W/base> }
}`;
    const robot = await new ThreeUsdRobotLoader().parse(cm);
    expect(robot.scale.x).toBeCloseTo(0.01, 9);
  });
});

describe("M9 — initial pose", () => {
  const DRIVE = `#usda 1.0
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
    }
}`;

  it("seeds joints from drive targets by default", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(DRIVE);
    expect(robot.getJointValue("j")).toBeCloseTo(Math.PI / 2, 9);
  });

  it("can be disabled", async () => {
    const robot = await new ThreeUsdRobotLoader({ applyDriveTargetsAsInitialPose: false }).parse(
      DRIVE,
    );
    expect(robot.getJointValue("j")).toBe(0);
  });
});

describe("M9 — purpose-based classification", () => {
  it("routes guide/proxy meshes to collision, not visual", () => {
    const usda = `#usda 1.0
def Xform "W"
{
    def Xform "base" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] )
    {
        def Mesh "vis" { point3f[] points = [(0,0,0), (1,0,0), (0,1,0)] }
        def Mesh "col"
        {
            uniform token purpose = "guide"
            point3f[] points = [(0,0,0), (1,0,0), (0,1,0)]
        }
    }
    def PhysicsFixedJoint "rj" { rel physics:body1 = </W/base> }
}`;
    const robot = extractRobotDescription(Stage.OpenFromString(usda));
    expect(robot.links.base?.visualPrims).toEqual(["/W/base/vis"]);
    expect(robot.links.base?.collisionPrims).toEqual(["/W/base/col"]);
  });
});

describe("M9 — USDZ", () => {
  const MAIN = `#usda 1.0
(defaultPrim = "World" upAxis = "Z" metersPerUnit = 1.0)
def Xform "World"
{
    def Xform "base_link" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
        prepend references = @./parts/link.usda@</geom_root>
    ) {}
    def PhysicsFixedJoint "root_joint" { rel physics:body1 = </World/base_link> }
}`;
  const LINK = `#usda 1.0
(defaultPrim = "geom_root")
def Xform "geom_root"
{
    def Mesh "geom"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0,0,0), (1,0,0), (0,1,0)]
    }
}`;

  it("loads a zipped package and composes across its entries", async () => {
    const bytes = zipSync({ "robot.usda": strToU8(MAIN), "parts/link.usda": strToU8(LINK) });
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parseUsdz(bytes);

    expect(robot.getKinematicTree().root).toBe("base_link");
    const meshes = robot
      .getLinkObject("base_link")!
      .children.filter((c) => (c as { isMesh?: boolean }).isMesh);
    expect(meshes).toHaveLength(1); // referenced mesh pulled from another zip entry
  });
});
