import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { createGhostRobot, pickLink, resolveLink } from "../src/helpers.js";
import { type ThreeUsdRobot, ThreeUsdRobotLoader } from "../src/index.js";

// Two links with real geometry at known places (Y-up, metres), one hidden
// guide-purpose collision box, and a scenery wall that belongs to no link.
const CELL = `#usda 1.0
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
        def Cube "body"
        {
            double size = 1
        }
    }

    def Xform "tool" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
        float3 xformOp:translate = (2, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]

        def Sphere "skin"
        {
            double radius = 0.3
        }

        def Cube "hitbox" (
            prepend apiSchemas = ["PhysicsCollisionAPI"]
        )
        {
            uniform token purpose = "guide"
            double size = 1
        }
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </World/base>
    }

    def PhysicsRevoluteJoint "joint1"
    {
        uniform token physics:axis = "Y"
        rel physics:body0 = </World/base>
        rel physics:body1 = </World/tool>
        point3f physics:localPos0 = (2, 0, 0)
    }

    def Cube "wall"
    {
        float3 xformOp:translate = (-2, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
        double size = 0.5
    }
}
`;

async function load(): Promise<ThreeUsdRobot> {
  // Collision meshes are opt-in; they load hidden and still raycast.
  const robot = await new ThreeUsdRobotLoader({
    loadSceneGeometry: true,
    loadCollisions: true,
  }).parse(CELL);
  robot.updateMatrixWorld(true);
  return robot;
}

function meshAt(robot: THREE.Object3D, primPath: string): THREE.Mesh {
  let found: THREE.Mesh | undefined;
  robot.traverse((o) => {
    if (!found && (o as THREE.Mesh).isMesh && o.userData.primPath === primPath)
      found = o as THREE.Mesh;
  });
  if (!found) throw new Error(`no mesh for ${primPath}`);
  return found;
}

function ray(
  origin: [number, number, number],
  direction: [number, number, number],
): THREE.Raycaster {
  return new THREE.Raycaster(
    new THREE.Vector3(...origin),
    new THREE.Vector3(...direction).normalize(),
  );
}

describe("resolveLink", () => {
  it("maps a visual mesh to its link with the mesh's own prim path", async () => {
    const robot = await load();
    const hit = resolveLink(robot, meshAt(robot, "/World/base/body"));
    expect(hit).not.toBeNull();
    expect(hit!.link.primPath).toBe("/World/base");
    expect(hit!.primPath).toBe("/World/base/body");
    expect(hit!.kind).toBe("visual");
    expect(hit!.robot).toBe(robot);
  });

  it("tags collision meshes, and a link object itself resolves with its own path", async () => {
    const robot = await load();
    expect(resolveLink(robot, meshAt(robot, "/World/tool/hitbox"))?.kind).toBe("collision");
    const link = robot.getLinkObject("tool")!;
    const hit = resolveLink(robot, link);
    expect(hit?.link).toBe(link);
    expect(hit?.primPath).toBe("/World/tool");
    expect(hit?.kind).toBe("unknown");
  });

  it("returns null for scenery, for objects outside the robot, and across robots", async () => {
    const robot = await load();
    expect(resolveLink(robot, meshAt(robot, "/World/wall"))).toBeNull();
    expect(resolveLink(robot, new THREE.Mesh())).toBeNull();
    const other = await load();
    expect(resolveLink(robot, meshAt(other, "/World/base/body"))).toBeNull();
  });

  it("resolves ghost meshes against the ghost, not the source", async () => {
    const robot = await load();
    const ghost = createGhostRobot(robot);
    const ghostMesh = meshAt(ghost, "/World/base/body");
    expect(resolveLink(ghost, ghostMesh)?.kind).toBe("ghost");
    expect(resolveLink(robot, ghostMesh)).toBeNull();
  });
});

describe("pickLink", () => {
  it("returns the nearest visual link along the ray with point and distance", async () => {
    const robot = await load();
    const pick = pickLink(robot, ray([2, 5, 0], [0, -1, 0]));
    expect(pick?.link.primPath).toBe("/World/tool");
    expect(pick?.kind).toBe("visual");
    expect(pick?.point.y).toBeCloseTo(0.3, 2);
    expect(pick?.distance).toBeCloseTo(4.7, 2);
    expect(pickLink(robot, ray([0, 5, 0], [0, -1, 0]))?.link.primPath).toBe("/World/base");
    expect(pickLink(robot, ray([0, 5, 5], [0, -1, 0]))).toBeNull();
  });

  it("ignores hidden collision meshes unless asked, and honours the kinds filter", async () => {
    const robot = await load();
    // The hidden hitbox (size 1) sits around the visible sphere (r 0.3).
    expect(pickLink(robot, ray([2, 5, 0], [0, -1, 0]), { kinds: ["collision"] })).toBeNull();
    const shown = pickLink(robot, ray([2, 5, 0], [0, -1, 0]), {
      kinds: ["collision"],
      visibleOnly: false,
    });
    expect(shown?.kind).toBe("collision");
    expect(shown?.point.y).toBeCloseTo(0.5, 6);
    robot.showCollision = true;
    expect(pickLink(robot, ray([2, 5, 0], [0, -1, 0]), { kinds: ["all"] })?.kind).toBe("collision");
    // Kinds that do not count are transparent: the visual sphere is picked through the box.
    expect(pickLink(robot, ray([2, 5, 0], [0, -1, 0]))?.kind).toBe("visual");
    robot.showVisual = false;
    expect(pickLink(robot, ray([2, 5, 0], [0, -1, 0]))).toBeNull();
  });

  it("picks across several robots", async () => {
    const a = await load();
    const b = await load();
    b.position.set(10, 0, 0);
    b.updateMatrixWorld(true);
    const pick = pickLink([a, b], ray([10, 5, 0], [0, -1, 0]));
    expect(pick?.robot).toBe(b);
    expect(pick?.link.primPath).toBe("/World/base");
    expect(pickLink([a, b], ray([0, 5, 0], [0, -1, 0]))?.robot).toBe(a);
  });

  it("is blocked by scenery (unless opted out) and by explicit occluders", async () => {
    const robot = await load();
    const through = ray([-5, 0, 0], [1, 0, 0]); // wall at x = −2, base at x = 0
    expect(pickLink(robot, through)).toBeNull();
    expect(pickLink(robot, through, { occludeScenery: false })?.link.primPath).toBe("/World/base");
    meshAt(robot, "/World/wall").visible = false;
    expect(pickLink(robot, through)?.link.primPath).toBe("/World/base");

    const fence = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2, 2));
    fence.position.set(-1, 0, 0);
    fence.updateMatrixWorld(true);
    expect(pickLink(robot, through, { occluders: [fence] })).toBeNull();
    fence.visible = false;
    expect(pickLink(robot, through, { occluders: [fence] })?.link.primPath).toBe("/World/base");
  });
});
