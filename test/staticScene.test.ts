import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ThreeUsdRobotLoader } from "../src/index.js";

// Pure static scene: no joints, no rigid bodies — just scenery.
const STATIC = `#usda 1.0
(
    defaultPrim = "Factory"
    metersPerUnit = 0.01
    upAxis = "Z"
)

def Xform "Factory"
{
    def Mesh "floor"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(0, 0, 0), (100, 0, 0), (100, 100, 0), (0, 100, 0)]
    }

    def Xform "rack"
    {
        float3 xformOp:translate = (10, 20, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]

        def Cube "frame"
        {
            double size = 50
        }
    }

    def Sphere "guard" (
        prepend apiSchemas = ["PhysicsCollisionAPI"]
    )
    {
        uniform token purpose = "guide"
        double radius = 5
    }
}
`;

// One-link robot plus free-standing scenery — scene geometry stays opt-in here.
const ROBOT_WITH_SCENERY = `#usda 1.0
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
        def Sphere "skin"
        {
            double radius = 0.2
        }
    }

    def Cube "decor"
    {
        double size = 1
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </World/base>
    }
}
`;

const EMPTY = `#usda 1.0
(
    defaultPrim = "Nothing"
)

def Xform "Nothing"
{
}
`;

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

describe("pure static scenes (no articulation)", () => {
  it("renders scene geometry by default, normalized like a robot stage", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(STATIC);

    const found = meshes(robot);
    expect(found.map((m) => `${m.name}:${m.userData.kind}`).sort()).toEqual([
      "floor:scene",
      "frame:scene",
    ]);
    expect(robot.getLinkNames()).toEqual([]);
    expect(robot.getJointNames()).toEqual([]);
    expect(robot.getKinematicTree().root).toBe("");

    // metersPerUnit 0.01 and Z-up → Y-up conversion apply at the root.
    robot.updateKinematics();
    const rack = found.find((m) => m.name === "frame")!;
    const p = new THREE.Vector3().setFromMatrixPosition(rack.matrixWorld);
    expect(p.x).toBeCloseTo(0.1, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(-0.2, 6);
  });

  it("mirrors the authored grouping so scenery moves as one subtree", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(STATIC);
    const factory = robot.children.find((c) => c.userData.primPath === "/Factory");
    expect(factory?.userData.kind).toBe("scene");
    const rack = factory!.children.find((c) => c.userData.primPath === "/Factory/rack")!;
    expect(rack.children.map((c) => c.name)).toEqual(["frame"]);

    // Translating the group carries its members: stage (10,20,0) → (110,20,0),
    // normalized by metersPerUnit 0.01 and the Z-up → Y-up root conversion.
    rack.matrix.multiply(new THREE.Matrix4().makeTranslation(100, 0, 0));
    robot.updateMatrixWorld(true);
    const p = new THREE.Vector3().setFromMatrixPosition(rack.children[0]!.matrixWorld);
    expect(p.x).toBeCloseTo(1.1, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(-0.2, 6);
  });

  it("emits a diagnostic when auto-enabling scene geometry", async () => {
    const warnings: string[] = [];
    await new ThreeUsdRobotLoader({ onWarn: (m) => warnings.push(m) }).parse(STATIC);
    expect(warnings.some((m) => m.includes("no articulation"))).toBe(true);
  });

  it("respects an explicit loadSceneGeometry: false opt-out", async () => {
    const warnings: string[] = [];
    const robot = await new ThreeUsdRobotLoader({
      loadSceneGeometry: false,
      onWarn: (m) => warnings.push(m),
    }).parse(STATIC);
    expect(meshes(robot)).toHaveLength(0);
    expect(warnings).toHaveLength(0); // explicit choice — no diagnostic
  });

  it("keeps scene geometry opt-in on articulated stages", async () => {
    const byDefault = await new ThreeUsdRobotLoader().parse(ROBOT_WITH_SCENERY);
    expect(meshes(byDefault).map((m) => m.name)).toEqual(["skin"]);

    const withScene = await new ThreeUsdRobotLoader({ loadSceneGeometry: true }).parse(
      ROBOT_WITH_SCENERY,
    );
    expect(
      meshes(withScene)
        .map((m) => m.name)
        .sort(),
    ).toEqual(["decor", "skin"]);
  });

  it("extracts an empty IR from a static scene", async () => {
    const desc = await new ThreeUsdRobotLoader().parseRobotDescription(STATIC);
    expect(desc.links).toEqual({});
    expect(desc.joints).toEqual({});
    expect(desc.rootLink).toBe("");
    expect(desc.name).toBe("Factory");
  });

  it("loads a stage with no gprims at all without crashing", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(EMPTY);
    expect(meshes(robot)).toHaveLength(0);
    expect(robot.children).toHaveLength(0);
  });
});
