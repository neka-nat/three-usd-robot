import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ThreeUsdRobotLoader } from "../src/index.js";

// A lit static room, Isaac-style: cm units, Z-up, a scaled RectLight prim,
// legacy+namespaced input spellings live in LEGACY below.
const SCENE = `#usda 1.0
(
    defaultPrim = "Room"
    metersPerUnit = 0.01
    upAxis = "Z"
)

def Xform "Room"
{
    def Mesh "floor"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(0, 0, 0), (100, 0, 0), (100, 100, 0), (0, 100, 0)]
    }

    def DistantLight "sun"
    {
        float inputs:intensity = 100
        float inputs:exposure = 2
        color3f inputs:color = (1, 0.5, 0.25)
    }

    def RectLight "panel"
    {
        float inputs:width = 500
        float inputs:height = 50
        float inputs:intensity = 15000
        double3 xformOp:translate = (0, 0, 300)
        float3 xformOp:scale = (0.01, 0.01, 0.01)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]
    }

    def SphereLight "bulb"
    {
        float inputs:radius = 5
        float inputs:intensity = 30000
    }

    def SphereLight "spot"
    {
        float inputs:intensity = 8
        float inputs:shaping:cone:angle = 30
        float inputs:shaping:cone:softness = 0.5
    }

    def SphereLight "wide"
    {
        float inputs:shaping:cone:angle = 180
    }

    def DiskLight "disk"
    {
        float inputs:radius = 100
        float inputs:intensity = 4
    }

    def CylinderLight "tube1"
    {
    }

    def CylinderLight "tube2"
    {
    }

    def DomeLight "sky"
    {
        float inputs:intensity = 1000
        asset inputs:texture:file = @sky/env.hdr@
        token inputs:texture:format = "latlong"
    }

    def PortalLight "portal"
    {
    }

    def SphereLight "hidden"
    {
        token visibility = "invisible"
    }

    def SphereLight "guides"
    {
        uniform token purpose = "guide"
    }
}
`;

// Pre-21.02 spelling: no inputs: namespace — stock Isaac DomeLights still
// author texture:file this way.
const LEGACY = `#usda 1.0
(
    defaultPrim = "Room"
    metersPerUnit = 1.0
    upAxis = "Y"
)

def Xform "Room"
{
    def SphereLight "old"
    {
        float intensity = 7
    }

    def DomeLight "sky"
    {
        asset texture:file = @env.hdr@
    }
}
`;

const DEFAULTS = `#usda 1.0
(
    defaultPrim = "Room"
    metersPerUnit = 1.0
    upAxis = "Y"
)

def Xform "Room"
{
    def DistantLight "sun"
    {
    }

    def DistantLight "noShadow"
    {
        bool inputs:shadow:enable = false
    }

    def SphereLight "shadowBulb"
    {
        bool inputs:shadow:enable = true
    }

    def SphereLight "warm"
    {
        bool inputs:enableColorTemperature = true
        float inputs:colorTemperature = 3000
    }

    def SphereLight "neutral"
    {
        bool inputs:enableColorTemperature = true
        float inputs:colorTemperature = 6500
    }
}
`;

// One revolute joint; a lamp mounted on the moving link.
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
        def Cube "skin"
        {
            double size = 0.1
        }
    }
    def Xform "b" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] )
    {
        def SphereLight "lamp"
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

function lightByName(robot: { lights: THREE.Light[] }, name: string): THREE.Light {
  const light = robot.lights.find((l) => l.name === name);
  expect(light, `light ${name}`).toBeDefined();
  return light!;
}

describe("UsdLux lights (M25)", () => {
  it("binds each supported light type to its Three.js counterpart", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(SCENE);

    expect(robot.lights.map((l) => l.name).sort()).toEqual([
      "bulb",
      "disk",
      "panel",
      "spot",
      "sun",
      "tube1",
      "tube2",
      "wide",
    ]);

    const sun = lightByName(robot, "sun") as THREE.DirectionalLight;
    expect(sun.isDirectionalLight).toBe(true);
    expect(sun.intensity).toBeCloseTo(400, 6); // 100 × 2^2
    expect(sun.color.r).toBeCloseTo(1, 6);
    expect(sun.color.g).toBeCloseTo(0.5, 6);
    expect(sun.color.b).toBeCloseTo(0.25, 6);

    expect((lightByName(robot, "bulb") as THREE.PointLight).isPointLight).toBe(true);
    expect((lightByName(robot, "wide") as THREE.PointLight).isPointLight).toBe(true); // 180° cone = no coning
    expect((lightByName(robot, "tube1") as THREE.PointLight).isPointLight).toBe(true);

    const spot = lightByName(robot, "spot") as THREE.SpotLight;
    expect(spot.isSpotLight).toBe(true);
    expect(spot.angle).toBeCloseTo(Math.PI / 6, 6);
    expect(spot.penumbra).toBeCloseTo(0.5, 6);

    // userData mirrors the gprim conventions and carries the description.
    expect(sun.userData.kind).toBe("light");
    expect(sun.userData.primPath).toBe("/Room/sun");
    expect(sun.userData.usdLight.kind).toBe("distant");

    // Lights anchor into the mirrored scenery hierarchy.
    expect(sun.parent?.userData.primPath).toBe("/Room");
  });

  it("emits along -Z: an unrotated distant light in a Z-up stage points world-down", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(SCENE);
    robot.updateMatrixWorld(true);

    const sun = lightByName(robot, "sun") as THREE.DirectionalLight;
    const from = sun.getWorldPosition(new THREE.Vector3());
    const to = sun.target.getWorldPosition(new THREE.Vector3());
    const dir = to.sub(from).normalize();
    expect(dir.x).toBeCloseTo(0, 6);
    expect(dir.y).toBeCloseTo(-1, 6);
    expect(dir.z).toBeCloseTo(0, 6);
  });

  it("sizes area lights in world meters (prim scale × metersPerUnit)", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(SCENE);

    // 500 × own scale 0.01 × metersPerUnit 0.01 — Three.js ignores ancestor
    // scale for RectAreaLight sizes, so the binder pre-multiplies it.
    const panel = lightByName(robot, "panel") as THREE.RectAreaLight;
    expect(panel.isRectAreaLight).toBe(true);
    expect(panel.width).toBeCloseTo(0.05, 6);
    expect(panel.height).toBeCloseTo(0.005, 6);
    expect(panel.intensity).toBeCloseTo(15000, 6);

    // Disk → square of side 2r with π/4 area compensation.
    const disk = lightByName(robot, "disk") as THREE.RectAreaLight;
    expect(disk.isRectAreaLight).toBe(true);
    expect(disk.width).toBeCloseTo(2, 6);
    expect(disk.height).toBeCloseTo(2, 6);
    expect(disk.intensity).toBeCloseTo(4 * (Math.PI / 4), 6);
  });

  it("collects DomeLights for IBL instead of faking a Three.js light", async () => {
    const warnings: string[] = [];
    const robot = await new ThreeUsdRobotLoader({ onWarn: (m) => warnings.push(m) }).parse(SCENE);

    expect(robot.lights.some((l) => l.name === "sky")).toBe(false);
    expect(robot.domeLights).toHaveLength(1);
    const sky = robot.domeLights[0]!;
    expect(sky.primPath).toBe("/Room/sky");
    expect(sky.intensity).toBeCloseTo(1000, 6);
    expect(sky.textureFile).toBe("sky/env.hdr");
    expect(sky.textureFormat).toBe("latlong");
    expect(warnings.some((m) => m.includes("DomeLight") && m.includes("robot.domeLights"))).toBe(
      true,
    );
  });

  it("warns once per unsupported or approximated light type", async () => {
    const warnings: string[] = [];
    await new ThreeUsdRobotLoader({ onWarn: (m) => warnings.push(m) }).parse(SCENE);

    expect(warnings.filter((m) => m.includes("PortalLight"))).toHaveLength(1);
    // Two CylinderLights, one diagnostic.
    expect(warnings.filter((m) => m.includes("CylinderLight"))).toHaveLength(1);
  });

  it("skips invisible and guide-purpose lights", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(SCENE);
    expect(robot.lights.some((l) => l.name === "hidden")).toBe(false);
    expect(robot.lights.some((l) => l.name === "guides")).toBe(false);
  });

  it("falls back to legacy un-namespaced input names", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(LEGACY);
    expect((lightByName(robot, "old") as THREE.PointLight).intensity).toBeCloseTo(7, 6);
    expect(robot.domeLights[0]?.textureFile).toBe("env.hdr");
  });

  it("applies schema fallbacks and ShadowAPI gating", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(DEFAULTS);

    // DistantLight's schema fallback intensity is 50000.
    const sun = lightByName(robot, "sun") as THREE.DirectionalLight;
    expect(sun.intensity).toBeCloseTo(50000, 3);

    // shadow:enable defaults on for directional; authored false wins.
    expect(sun.castShadow).toBe(true);
    expect(lightByName(robot, "noShadow").castShadow).toBe(false);

    // Point lights render six shadow faces — cast only when explicitly authored.
    expect(lightByName(robot, "shadowBulb").castShadow).toBe(true);
    expect(lightByName(robot, "warm").castShadow).toBe(false);
  });

  it("tints by color temperature when enabled", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(DEFAULTS);

    const warm = lightByName(robot, "warm") as THREE.PointLight;
    expect(warm.color.r).toBeGreaterThan(warm.color.g);
    expect(warm.color.g).toBeGreaterThan(warm.color.b);

    const neutral = lightByName(robot, "neutral") as THREE.PointLight;
    expect(neutral.color.r).toBeCloseTo(1, 6);
    expect(neutral.color.g).toBeCloseTo(1, 6);
    expect(neutral.color.b).toBeCloseTo(1, 6);
  });

  it("mounts link lights on the link so they move with the joints", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ROBOT);

    const lamp = lightByName(robot, "lamp");
    expect(robot.getLinkObject("b")).toBeDefined();
    expect(lamp.parent).toBe(robot.getLinkObject("b"));

    robot.updateKinematics();
    const before = lamp.getWorldPosition(new THREE.Vector3());
    expect(before.x).toBeCloseTo(1, 6);

    robot.setJointValue("j", Math.PI / 2);
    robot.updateKinematics();
    robot.updateMatrixWorld(true);
    const after = lamp.getWorldPosition(new THREE.Vector3());
    expect(after.length()).toBeCloseTo(1, 6);
    expect(after.distanceTo(before)).toBeGreaterThan(0.5);
  });

  it("flags meshes for shadows by default, but never collision meshes", async () => {
    const scene = await new ThreeUsdRobotLoader().parse(SCENE);
    const floor = scene.getObjectByName("floor") as THREE.Mesh;
    expect(floor.castShadow).toBe(true);
    expect(floor.receiveShadow).toBe(true);
  });

  it("honors loadLights / lightIntensityScale / shadows options", async () => {
    const noLights = await new ThreeUsdRobotLoader({ loadLights: false }).parse(SCENE);
    expect(noLights.lights).toHaveLength(0);
    expect(noLights.domeLights).toHaveLength(0);

    const scaled = await new ThreeUsdRobotLoader({ lightIntensityScale: 0.001 }).parse(SCENE);
    expect((lightByName(scaled, "sun") as THREE.DirectionalLight).intensity).toBeCloseTo(0.4, 6);
    // The description keeps the authored value for consumers doing their own mapping.
    expect(lightByName(scaled, "sun").userData.usdLight.intensity).toBeCloseTo(400, 6);

    const noShadows = await new ThreeUsdRobotLoader({ shadows: false }).parse(SCENE);
    expect(lightByName(noShadows, "sun").castShadow).toBe(false);
    const floor = noShadows.getObjectByName("floor") as THREE.Mesh;
    expect(floor.castShadow).toBe(false);
    expect(floor.receiveShadow).toBe(false);
  });
});
