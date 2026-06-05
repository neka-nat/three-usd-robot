import { Suspense } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vitest";
import { type ThreeUsdRobot, createMemoryResolver } from "../src/index.js";
import { UsdRobot, clearUsdRobotCache, preloadUsdRobot, useUsdRobot } from "../src/react.js";

const ARM = `#usda 1.0
def Xform "W"
{
    def Xform "a" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def Xform "b" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def PhysicsRevoluteJoint "joint1"
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </W/a>
        rel physics:body1 = </W/b>
        float physics:lowerLimit = -180
        float physics:upperLimit = 180
    }
}`;

const resolver = createMemoryResolver({ "/arm.usda": ARM });
const opts = { assetResolver: resolver, upAxisConversion: "none" as const };

afterEach(() => clearUsdRobotCache());

describe("<UsdRobot>", () => {
  it("loads under Suspense, fires onLoad, and applies controlled joint values", async () => {
    let robot: ThreeUsdRobot | undefined;
    await act(async () => {
      TestRenderer.create(
        <Suspense fallback={null}>
          <UsdRobot
            url="/arm.usda"
            loaderOptions={opts}
            jointValues={{ joint1: 0.5 }}
            onLoad={(r) => {
              robot = r;
            }}
          />
        </Suspense>,
      );
    });

    expect(robot).toBeDefined();
    expect(robot!.getJointNames()).toContain("joint1");
    expect(robot!.getJointValue("joint1")).toBeCloseTo(0.5, 9);
  });

  it("mounts the robot as a primitive object", async () => {
    let tree: TestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = TestRenderer.create(
        <Suspense fallback={null}>
          <UsdRobot url="/arm.usda" loaderOptions={opts} />
        </Suspense>,
      );
    });
    const primitive = tree!.root.findByType("primitive");
    expect((primitive.props.object as ThreeUsdRobot).isThreeUsdRobot).toBe(true);
  });
});

describe("cache", () => {
  it("returns the same robot instance for the same url", async () => {
    preloadUsdRobot("/arm.usda", opts);
    // Let the preload resolve.
    await act(async () => {
      await Promise.resolve();
    });

    const seen: ThreeUsdRobot[] = [];
    function Probe() {
      seen.push(useUsdRobot("/arm.usda", opts));
      return null;
    }
    await act(async () => {
      TestRenderer.create(
        <Suspense fallback={null}>
          <Probe />
          <Probe />
        </Suspense>,
      );
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});
