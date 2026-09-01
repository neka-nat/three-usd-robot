import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  ThreeUsdRobotLoader,
  computeCameraExposureScale,
  conformCameraAspect,
} from "../src/index.js";

// Isaac-style cm stage with an authored sensor camera and an ortho camera.
const SCENE = `#usda 1.0
(
    defaultPrim = "Room"
    metersPerUnit = 0.01
    upAxis = "Z"
)

def Xform "Room"
{
    def Camera "cam"
    {
        float focalLength = 18.147562
        float horizontalAperture = 20.955
        float verticalAperture = 15.2908
        float2 clippingRange = (10, 100000)
        float fStop = 2.8
        float focusDistance = 400
        double3 xformOp:translate = (0, 0, 170)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }

    def Camera "top"
    {
        token projection = "orthographic"
        float horizontalAperture = 5000
        float verticalAperture = 2500
        float2 clippingRange = (1, 1000)
    }

    def Camera "hidden"
    {
        token visibility = "invisible"
    }
}
`;

// One revolute joint; a camera mounted on the moving link.
const ROBOT = `#usda 1.0
(
    defaultPrim = "W"
    metersPerUnit = 1.0
    upAxis = "Y"
)

def Xform "W" (
    prepend apiSchemas = ["PhysicsArticulationRootAPI"]
)
{
    def Xform "a" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] )
    {
    }
    def Xform "b" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] )
    {
        def Camera "eye"
        {
            double3 xformOp:translate = (1, 0, 0)
            uniform token[] xformOpOrder = ["xformOp:translate"]
        }
    }
    def PhysicsRevoluteJoint "j"
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </W/a>
        rel physics:body1 = </W/b>
    }
}
`;

const EXPOSED = `#usda 1.0
(
    defaultPrim = "W"
)

def Xform "W"
{
    def Camera "cam"
    {
        float exposure = 1
        float exposure:iso = 200
        float exposure:time = 0.02
        float exposure:fStop = 2
    }
}
`;

describe("UsdGeomCamera (M27)", () => {
  it("binds a perspective camera with USD film metrics", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(SCENE);
    expect(robot.cameras.map((c) => c.name).sort()).toEqual(["cam", "top"]);

    const cam = robot.cameras.find((c) => c.name === "cam") as THREE.PerspectiveCamera;
    expect(cam.isPerspectiveCamera).toBe(true);
    // fov = 2·atan(vAperture / 2f)
    const expectedFov = THREE.MathUtils.radToDeg(2 * Math.atan(15.2908 / (2 * 18.147562)));
    expect(cam.fov).toBeCloseTo(expectedFov, 5);
    expect(cam.aspect).toBeCloseTo(20.955 / 15.2908, 6);
    // clippingRange is stage units: cm stage → meters.
    expect(cam.near).toBeCloseTo(0.1, 6);
    expect(cam.far).toBeCloseTo(1000, 4);
    expect(cam.filmGauge).toBeCloseTo(20.955, 6);
    expect(cam.focus).toBeCloseTo(4, 6); // 400 cm

    expect(cam.userData.kind).toBe("camera");
    expect(cam.userData.primPath).toBe("/Room/cam");
    expect(cam.userData.usdCamera.fStop).toBeCloseTo(2.8, 6);
  });

  it("binds an orthographic camera with tenth-unit apertures", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(SCENE);
    const top = robot.cameras.find((c) => c.name === "top") as THREE.OrthographicCamera;
    expect(top.isOrthographicCamera).toBe(true);
    // 5000 tenths → 500 cm → 5 m wide.
    expect(top.right).toBeCloseTo(2.5, 6);
    expect(top.left).toBeCloseTo(-2.5, 6);
    expect(top.top).toBeCloseTo(1.25, 6);
    expect(top.near).toBeCloseTo(0.01, 6);
    expect(top.far).toBeCloseTo(10, 6);
  });

  it("skips invisible cameras and honors loadCameras: false", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(SCENE);
    expect(robot.cameras.some((c) => c.name === "hidden")).toBe(false);

    const off = await new ThreeUsdRobotLoader({ loadCameras: false }).parse(SCENE);
    expect(off.cameras).toHaveLength(0);
  });

  it("matches three's viewing convention: an unrotated camera in a Z-up stage looks down", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(SCENE);
    robot.updateMatrixWorld(true);
    const cam = robot.cameras.find((c) => c.name === "cam")!;

    const position = cam.getWorldPosition(new THREE.Vector3());
    expect(position.y).toBeCloseTo(1.7, 6); // stage (0,0,170cm) → world +Y

    const direction = cam.getWorldDirection(new THREE.Vector3());
    expect(direction.x).toBeCloseTo(0, 6);
    expect(direction.y).toBeCloseTo(-1, 6); // stage −Z (down) stays down
    expect(direction.z).toBeCloseTo(0, 6);
  });

  it("mounts link cameras on the link so they move with the joints", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ROBOT);
    const eye = robot.cameras.find((c) => c.name === "eye")!;
    expect(eye.parent).toBe(robot.getLinkObject("b"));

    robot.updateKinematics();
    const before = eye.getWorldPosition(new THREE.Vector3());
    robot.setJointValue("j", Math.PI / 2);
    robot.updateKinematics();
    robot.updateMatrixWorld(true);
    const after = eye.getWorldPosition(new THREE.Vector3());
    expect(after.length()).toBeCloseTo(1, 6);
    expect(after.distanceTo(before)).toBeGreaterThan(0.5);
  });

  it("computes the 24.11 linear exposure scale (defaults → 1)", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ROBOT);
    const eye = robot.cameras.find((c) => c.name === "eye")!;
    expect(computeCameraExposureScale(eye.userData.usdCamera)).toBeCloseTo(1, 9);

    const exposed = await new ThreeUsdRobotLoader().parse(EXPOSED);
    const desc = exposed.cameras[0]!.userData.usdCamera;
    // time 0.02 × iso 200/100 ÷ fStop² 4 × 2^1
    expect(computeCameraExposureScale(desc)).toBeCloseTo(0.02, 9);
  });

  it("conforms the aperture to a viewport aspect per UsdRender policy", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(SCENE);
    const cam = robot.cameras.find((c) => c.name === "cam") as THREE.PerspectiveCamera;
    const vFov = 2 * Math.atan(15.2908 / (2 * 18.147562));
    const hFov = 2 * Math.atan(20.955 / (2 * 18.147562));

    // Wider viewport, expandAperture: vertical view kept, width follows.
    conformCameraAspect(cam, 2);
    expect(cam.aspect).toBe(2);
    expect(cam.fov).toBeCloseTo(THREE.MathUtils.radToDeg(vFov), 5);

    // Narrower-than-aperture viewport: horizontal view kept, height expands.
    conformCameraAspect(cam, 1);
    expect(cam.fov).toBeCloseTo(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hFov / 2))), 5);

    // cropAperture on a wider viewport pins the horizontal view instead.
    conformCameraAspect(cam, 2, "cropAperture");
    expect(cam.fov).toBeCloseTo(THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hFov / 2) / 2)), 5);

    // Orthographic: expand keeps the vertical half-extent on a wide viewport.
    const top = robot.cameras.find((c) => c.name === "top") as THREE.OrthographicCamera;
    conformCameraAspect(top, 4);
    expect(top.top).toBeCloseTo(1.25, 6);
    expect(top.right).toBeCloseTo(5, 6);
  });
});
