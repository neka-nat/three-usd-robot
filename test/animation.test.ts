import { describe, expect, it } from "vitest";
import { ThreeUsdRobotLoader, interpolate } from "../src/index.js";

describe("interpolate", () => {
  const ch = { times: [0, 10, 20], values: [0, 100, 50] };
  it("linearly interpolates between samples", () => {
    expect(interpolate(ch, 5)).toBeCloseTo(50);
    expect(interpolate(ch, 15)).toBeCloseTo(75);
    expect(interpolate(ch, 10)).toBe(100);
  });
  it("holds the endpoints outside the range", () => {
    expect(interpolate(ch, -5)).toBe(0);
    expect(interpolate(ch, 99)).toBe(50);
  });
});

// A revolute joint with a time-sampled drive target (degrees) → animated value.
const ANIMATED = `#usda 1.0
(
    startTimeCode = 0
    endTimeCode = 10
    timeCodesPerSecond = 30
)
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
        float drive:angular:physics:targetPosition.timeSamples = {
            0: 0,
            10: 90,
        }
    }
}`;

describe("ThreeUsdRobot — animation playback", () => {
  it("exposes the time range and rate", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ANIMATED);
    expect(robot.hasAnimation()).toBe(true);
    expect(robot.getTimeRange()).toEqual({ start: 0, end: 10 });
    expect(robot.getTimeCodesPerSecond()).toBe(30);
  });

  it("samples the joint trajectory at a given time (deg→rad)", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ANIMATED);
    robot.setTime(0);
    expect(robot.getJointValue("j")).toBeCloseTo(0, 9);
    robot.setTime(5); // halfway → 45°
    expect(robot.getJointValue("j")).toBeCloseTo(Math.PI / 4, 9);
    robot.setTime(10);
    expect(robot.getJointValue("j")).toBeCloseTo(Math.PI / 2, 9);
  });

  it("reports no animation for a static robot", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(`#usda 1.0
def Xform "W"
{
    def Xform "a" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def PhysicsFixedJoint "rj" { rel physics:body1 = </W/a> }
}`);
    expect(robot.hasAnimation()).toBe(false);
    expect(robot.getTimeRange()).toBeNull();
  });
});
