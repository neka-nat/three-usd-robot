import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ThreeUsdRobotLoader } from "../src/index.js";
import { applyUsdEnvironment } from "../src/rendering.js";

// M30: viewer light — shadow proxies for area lights, shadow focus, and the
// dome-less environment fallback.

function room(lights: string, extra = ""): string {
  return `#usda 1.0
(
    defaultPrim = "Room"
    metersPerUnit = 1.0
    upAxis = "Y"
)
def Xform "Room"
{
    def Mesh "floor"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(-2, 0, -2), (2, 0, -2), (2, 0, 2), (-2, 0, 2)]
    }
${lights}
${extra}
}
`;
}

const PANEL = `    def RectLight "panel"
    {
        float inputs:width = 2
        float inputs:height = 0.5
        float inputs:intensity = 15000
        double3 xformOp:translate = (0, 3, 0)
        double3 xformOp:rotateXYZ = (-90, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ"]
    }`;

const lightByName = (robot: THREE.Object3D, name: string) =>
  (robot as unknown as { lights: THREE.Light[] }).lights.find((l) => l.name === name)!;

describe("area-light shadow proxies (M30)", () => {
  it("adds a shadow-casting spot under a RectLight carrying half of its emission", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(room(PANEL));
    expect(robot.lights).toHaveLength(1); // proxies are children, not bound lights
    const panel = lightByName(robot, "panel") as THREE.RectAreaLight;
    expect(panel.isRectAreaLight).toBe(true);
    // 15 000 × 0.001 ("auto") = 15 nits, split in half.
    expect(panel.intensity).toBeCloseTo(7.5, 9);

    const proxy = panel.userData.shadowProxy as THREE.SpotLight;
    expect(proxy.isSpotLight).toBe(true);
    expect(proxy.parent).toBe(panel);
    expect(proxy.name).toBe("panel_shadow");
    expect(proxy.userData.shadowProxy).toBe(true);
    expect(proxy.userData.primPath).toBe("/Room/panel");
    // On-axis candela of a Lambertian 2 m × 0.5 m panel at 15 nits: L × A, halved.
    expect(proxy.intensity).toBeCloseTo(0.5 * 15 * 1.0, 9);
    expect(proxy.decay).toBe(2);
    expect(proxy.castShadow).toBe(true);
    expect(proxy.shadow.mapSize.x).toBe(2048);
    expect(proxy.angle).toBeGreaterThan(0.3);
    expect(proxy.angle).toBeLessThan(Math.PI / 2);
    // Aimed along the panel's −Z like every UsdLux emitter.
    expect(proxy.target.position.z).toBe(-1);

    // The world-space cone points down at the floor (panel rotated −90° about X).
    robot.updateMatrixWorld(true);
    const from = proxy.getWorldPosition(new THREE.Vector3());
    const to = proxy.target.getWorldPosition(new THREE.Vector3());
    expect(to.sub(from).normalize().y).toBeCloseTo(-1, 5);
  });

  it("honors share / mapSize, ShadowAPI, and the off switch", async () => {
    const tuned = await new ThreeUsdRobotLoader({
      areaLightShadows: { share: 0.3, mapSize: 512 },
    }).parse(room(PANEL));
    const panel = lightByName(tuned, "panel") as THREE.RectAreaLight;
    expect(panel.intensity).toBeCloseTo(15 * 0.7, 9);
    const proxy = panel.userData.shadowProxy as THREE.SpotLight;
    expect(proxy.intensity).toBeCloseTo(0.3 * 15, 9);
    expect(proxy.shadow.mapSize.x).toBe(512);

    const off = await new ThreeUsdRobotLoader({ areaLightShadows: false }).parse(room(PANEL));
    const plain = lightByName(off, "panel") as THREE.RectAreaLight;
    expect(plain.intensity).toBeCloseTo(15, 9);
    expect(plain.userData.shadowProxy).toBeUndefined();
    expect(plain.children.filter((c) => (c as THREE.SpotLight).isSpotLight)).toHaveLength(0);

    const noShadows = await new ThreeUsdRobotLoader({ shadows: false }).parse(room(PANEL));
    expect(lightByName(noShadows, "panel").userData.shadowProxy).toBeUndefined();

    const disabled = await new ThreeUsdRobotLoader().parse(
      room(
        PANEL.replace(
          "float inputs:intensity = 15000",
          "float inputs:intensity = 15000\n        bool inputs:shadow:enable = false",
        ),
      ),
    );
    const unlit = lightByName(disabled, "panel") as THREE.RectAreaLight;
    expect(unlit.userData.shadowProxy).toBeUndefined();
    expect(unlit.intensity).toBeCloseTo(15, 9);
  });

  it("gives DiskLights a proxy sized by the disc area", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(
      room(`    def DiskLight "disk"
    {
        float inputs:radius = 1
        float inputs:intensity = 4000
    }`),
    );
    const disk = lightByName(robot, "disk") as THREE.RectAreaLight;
    // 4 nits × π/4 on the 2 m square, halved; the proxy gets 0.5 × 4 × π × 1² cd.
    expect(disk.intensity).toBeCloseTo((4 * (Math.PI / 4)) / 2, 9);
    expect((disk.userData.shadowProxy as THREE.SpotLight).intensity).toBeCloseTo(
      0.5 * 4 * Math.PI,
      9,
    );
  });
});

/** A two-link arm standing on a 100 m floor, lit by a distant light. */
const ARM_IN_HALL = `#usda 1.0
(
    defaultPrim = "Cell"
    metersPerUnit = 1.0
    upAxis = "Z"
)
def Xform "Cell"
{
    def Mesh "floor"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(-50, -50, 0), (50, -50, 0), (50, 50, 0), (-50, 50, 0)]
    }
    def DistantLight "sun"
    {
        float inputs:intensity = 3000
        double3 xformOp:rotateXYZ = (30, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]
    }
    def Xform "Arm" (
        prepend apiSchemas = ["PhysicsArticulationRootAPI"]
    )
    {
        def Xform "base_link" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] )
        {
            def Mesh "geom"
            {
                int[] faceVertexCounts = [3]
                int[] faceVertexIndices = [0, 1, 2]
                point3f[] points = [(0, 0, 0), (0.2, 0, 0), (0, 0.2, 0.3)]
            }
        }
        def Xform "link1" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] )
        {
            double3 xformOp:translate = (0, 0, 0.3)
            uniform token[] xformOpOrder = ["xformOp:translate"]
            def Mesh "geom"
            {
                int[] faceVertexCounts = [3]
                int[] faceVertexIndices = [0, 1, 2]
                point3f[] points = [(0, 0, 0), (0.2, 0, 0), (0, 0.2, 0.4)]
            }
        }
        def PhysicsFixedJoint "root_joint"
        {
            rel physics:body1 = </Cell/Arm/base_link>
        }
        def PhysicsRevoluteJoint "joint1"
        {
            uniform token physics:axis = "Z"
            rel physics:body0 = </Cell/Arm/base_link>
            rel physics:body1 = </Cell/Arm/link1>
            point3f physics:localPos0 = (0, 0, 0.3)
            point3f physics:localPos1 = (0, 0, 0)
        }
    }
}
`;

describe("shadow focus (M30)", () => {
  it("fits shadow cameras to the robot's links instead of the whole hall", async () => {
    const scene = await new ThreeUsdRobotLoader({ loadSceneGeometry: true }).parse(ARM_IN_HALL);
    const hallSun = lightByName(scene, "sun") as THREE.DirectionalLight;
    expect(hallSun.castShadow).toBe(true);
    const hallExtent = hallSun.shadow.camera.right;
    expect(hallExtent).toBeGreaterThan(50); // 100 m floor → ~70 m bounding sphere

    const focused = await new ThreeUsdRobotLoader({
      loadSceneGeometry: true,
      shadowFocus: "robot",
    }).parse(ARM_IN_HALL);
    const robotSun = lightByName(focused, "sun") as THREE.DirectionalLight;
    const robotExtent = robotSun.shadow.camera.right;
    expect(robotExtent).toBeLessThan(2); // the two links span well under a metre
    expect(robotExtent).toBeGreaterThan(0.5); // never below the 0.5 m floor radius × 1.5
  });
});

describe("environment fallback (M30)", () => {
  const ROBOT_ONLY = `#usda 1.0
(
    defaultPrim = "World"
)
def Xform "World"
{
    def Mesh "geom"
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}
`;

  it("leaves a dome-less scene untouched by default", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ROBOT_ONLY);
    const scene = new THREE.Scene();
    expect(await applyUsdEnvironment(robot, scene)).toBeNull();
    expect(scene.environment).toBeNull();
  });

  it("installs a given texture when the stage has no DomeLight", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ROBOT_ONLY);
    const scene = new THREE.Scene();
    const texture = new THREE.Texture();
    const env = await applyUsdEnvironment(robot, scene, {
      fallback: texture,
      fallbackIntensity: 0.8,
      background: true,
    });
    expect(env?.source).toBe("texture");
    expect(env?.dome).toBeUndefined();
    expect(scene.environment).toBe(texture);
    expect(scene.environmentIntensity).toBeCloseTo(0.8, 9);
    expect(scene.background).toBeNull(); // backgrounds are for domes only
  });

  it('needs a renderer for fallback: "room" and says so', async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ROBOT_ONLY);
    const scene = new THREE.Scene();
    const warnings: string[] = [];
    const env = await applyUsdEnvironment(robot, scene, {
      fallback: "room",
      onWarn: (m) => warnings.push(m),
    });
    expect(env).toBeNull();
    expect(scene.environment).toBeNull();
    expect(warnings.some((w) => w.includes("renderer"))).toBe(true);
  });

  it("prefers the stage's dome over any fallback", async () => {
    const robot = await new ThreeUsdRobotLoader({ loadSceneGeometry: false }).parse(`#usda 1.0
(
    defaultPrim = "World"
)
def Xform "World"
{
    def DomeLight "sky"
    {
        color3f inputs:color = (0.2, 0.4, 0.8)
    }
}
`);
    const scene = new THREE.Scene();
    const env = await applyUsdEnvironment(robot, scene, { fallback: new THREE.Texture() });
    expect(env?.source).toBe("dome");
    expect(env?.dome?.name).toBe("sky");
  });
});
