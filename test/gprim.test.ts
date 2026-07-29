import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Stage, ThreeUsdRobotLoader, buildGprimGeometry } from "../src/index.js";

const GPRIMS = `#usda 1.0
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
        def Cube "box"
        {
            double size = 0.4
        }

        def Sphere "ball"
        {
            double radius = 0.3
            color3f[] primvars:displayColor = [(1, 0, 0)]
        }

        def Cylinder "roller"
        {
            uniform token axis = "X"
            double height = 1
            double radius = 0.2
        }

        def Capsule "pill"
        {
            double height = 0.4
            double radius = 0.1
        }

        def Cone "tip"
        {
            uniform token axis = "Y"
            double height = 0.6
            double radius = 0.2
        }

        def Sphere "defaults"
        {
        }

        def Cube "hitbox" (
            prepend apiSchemas = ["PhysicsCollisionAPI"]
        )
        {
            uniform token purpose = "guide"
            double size = 1
        }
    }

    def Sphere "decor"
    {
        double radius = 0.5
        float3 xformOp:translate = (3, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </World/base>
    }
}
`;

function meshByName(root: THREE.Object3D, name: string): THREE.Mesh | undefined {
  let found: THREE.Mesh | undefined;
  root.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh && o.name === name) found = o as THREE.Mesh;
  });
  return found;
}

/** Local-space bounding box of a mesh's geometry (transform-independent). */
function bbox(mesh: THREE.Mesh): THREE.Box3 {
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!;
}

function expectBox(box: THREE.Box3, x: number, y: number, z: number): void {
  expect(box.min.x).toBeCloseTo(-x, 5);
  expect(box.min.y).toBeCloseTo(-y, 5);
  expect(box.min.z).toBeCloseTo(-z, 5);
  expect(box.max.x).toBeCloseTo(x, 5);
  expect(box.max.y).toBeCloseTo(y, 5);
  expect(box.max.z).toBeCloseTo(z, 5);
}

describe("solid gprim rendering (Cube/Sphere/Cylinder/Capsule/Cone)", () => {
  it("attaches every visual solid under its link", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(GPRIMS);
    for (const name of ["box", "ball", "roller", "pill", "tip", "defaults"]) {
      const mesh = meshByName(robot, name);
      expect(mesh, name).toBeDefined();
      expect(mesh!.userData.kind).toBe("visual");
      expect(mesh!.visible).toBe(true);
    }
    // Collision-only prim is not loaded by default.
    expect(meshByName(robot, "hitbox")).toBeUndefined();
  });

  it("sizes a Cube by its edge length", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(GPRIMS);
    expectBox(bbox(meshByName(robot, "box")!), 0.2, 0.2, 0.2);
  });

  it("sizes a Sphere by radius and applies displayColor", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(GPRIMS);
    const ball = meshByName(robot, "ball")!;
    expectBox(bbox(ball), 0.3, 0.3, 0.3);
    const material = ball.material as THREE.MeshStandardMaterial;
    expect(material.color.r).toBeCloseTo(1, 5);
    expect(material.color.g).toBeCloseTo(0, 5);
    expect(material.color.b).toBeCloseTo(0, 5);
  });

  it("orients a Cylinder along its authored X axis", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(GPRIMS);
    expectBox(bbox(meshByName(robot, "roller")!), 0.5, 0.2, 0.2);
  });

  it("spans a Capsule by height + 2r along the default Z axis", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(GPRIMS);
    expectBox(bbox(meshByName(robot, "pill")!), 0.1, 0.1, 0.3);
  });

  it("orients a Cone along its authored Y axis", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(GPRIMS);
    expectBox(bbox(meshByName(robot, "tip")!), 0.2, 0.3, 0.2);
  });

  it("falls back to UsdGeom schema defaults (Sphere radius = 1)", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(GPRIMS);
    expectBox(bbox(meshByName(robot, "defaults")!), 1, 1, 1);
  });

  it("loads a guide-purpose collision solid hidden, toggled by showCollision", async () => {
    const robot = await new ThreeUsdRobotLoader({ loadCollisions: true }).parse(GPRIMS);
    const hitbox = meshByName(robot, "hitbox")!;
    expect(hitbox.userData.kind).toBe("collision");
    expect(hitbox.visible).toBe(false);
    robot.showCollision = true;
    expect(hitbox.visible).toBe(true);
    expectBox(bbox(hitbox), 0.5, 0.5, 0.5);
  });

  it("extracts solids into the robot IR's visual/collision prim lists", async () => {
    const desc = await new ThreeUsdRobotLoader().parseRobotDescription(GPRIMS);
    const base = desc.links.base!;
    for (const leaf of ["box", "ball", "roller", "pill", "tip", "defaults"]) {
      expect(base.visualPrims).toContain(`/World/base/${leaf}`);
    }
    expect(base.visualPrims).not.toContain("/World/base/hitbox");
    expect(base.collisionPrims).toEqual(["/World/base/hitbox"]);
  });

  it("attaches a linkless solid as scene geometry at its stage transform", async () => {
    const robot = await new ThreeUsdRobotLoader({ loadSceneGeometry: true }).parse(GPRIMS);
    const decor = meshByName(robot, "decor")!;
    expect(decor.userData.kind).toBe("scene");
    const p = new THREE.Vector3().setFromMatrixPosition(decor.matrix);
    expect([p.x, p.y, p.z]).toEqual([3, 0, 0]);
    expectBox(bbox(decor), 0.5, 0.5, 0.5);
  });

  it("buildGprimGeometry returns null for non-gprim prims", () => {
    const stage = Stage.OpenFromString(GPRIMS);
    expect(buildGprimGeometry(stage.GetPrimAtPath("/World")!)).toBeNull();
    expect(buildGprimGeometry(stage.GetPrimAtPath("/World/base/box")!)?.type).toBe("BoxGeometry");
  });
});
