import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ThreeUsdRobotLoader } from "../src/index.js";

// Z-up stage; link1 sits at authored (0, 0, 1).
const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

// Y-up stage; tip sits at authored (0, 1, 0).
const YUP = `#usda 1.0
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

    def Xform "tip" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </World/base>
    }

    def PhysicsRevoluteJoint "j1"
    {
        uniform token physics:axis = "X"
        rel physics:body0 = </World/base>
        rel physics:body1 = </World/tip>
        point3f physics:localPos0 = (0, 1, 0)
    }
}
`;

const pos = async (
  text: string,
  link: string,
  options?: ConstructorParameters<typeof ThreeUsdRobotLoader>[0],
) => {
  const robot = await new ThreeUsdRobotLoader(options).parse(text);
  return robot
    .getLinkWorldPosition(link)
    .toArray()
    .map((v) => +v.toFixed(6));
};

describe("worldUp — target world up-axis", () => {
  it('normalizes a Z-up stage to Y-up by default (≡ worldUp: "Y")', async () => {
    expect(await pos(ARM, "link1")).toEqual([0, 1, 0]);
    expect(await pos(ARM, "link1", { worldUp: "Y" })).toEqual([0, 1, 0]);
  });

  it('worldUp: "Z" leaves a Z-up stage as authored', async () => {
    expect(await pos(ARM, "link1", { worldUp: "Z" })).toEqual([0, 0, 1]);
  });

  it('worldUp: "Z" rotates a Y-up stage into a Z-up world', async () => {
    expect(await pos(YUP, "tip", { worldUp: "Z" })).toEqual([0, 0, 1]);
    // ... and "Y" / default leave it alone (already Y-up).
    expect(await pos(YUP, "tip")).toEqual([0, 1, 0]);
    expect(await pos(YUP, "tip", { worldUp: "Y" })).toEqual([0, 1, 0]);
  });

  it('worldUp: "keep" leaves the authored orientation', async () => {
    expect(await pos(ARM, "link1", { worldUp: "keep" })).toEqual([0, 0, 1]);
  });

  it("takes precedence over the deprecated upAxisConversion", async () => {
    expect(await pos(ARM, "link1", { worldUp: "keep", upAxisConversion: "auto" })).toEqual([
      0, 0, 1,
    ]);
    // Legacy option alone still works.
    expect(await pos(ARM, "link1", { upAxisConversion: "none" })).toEqual([0, 0, 1]);
  });

  it("exposes the authored stage metadata on the robot", async () => {
    const zUp = await new ThreeUsdRobotLoader().parse(ARM);
    expect(zUp.upAxis).toBe("Z");
    expect(zUp.metersPerUnit).toBe(1);

    const yUp = await new ThreeUsdRobotLoader({ worldUp: "Z" }).parse(YUP);
    expect(yUp.upAxis).toBe("Y"); // authored value, not the normalized target
  });
});
