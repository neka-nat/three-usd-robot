import { describe, expect, it } from "vitest";
import {
  Stage,
  ThreeUsdRobotLoader,
  composeLayer,
  createMemoryResolver,
  extractRobotDescription,
  parseUsda,
  serializeUsda,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Variants that carry composition arcs
// ---------------------------------------------------------------------------

const ARM_LAYER = `#usda 1.0
(
    defaultPrim = "arm"
)

def Xform "arm"
{
    def Xform "base" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
        def Mesh "geom"
        {
            int[] faceVertexCounts = [3]
            int[] faceVertexIndices = [0, 1, 2]
            point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        }
    }

    def Xform "link" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def PhysicsRevoluteJoint "j1"
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </arm/base>
        rel physics:body1 = </arm/link>
        float physics:lowerLimit = -90
        float physics:upperLimit = 90
    }
}
`;

/** The Isaac Sim shape: the robot hangs off a payload on the *variant itself*. */
const ROOT_LAYER = `#usda 1.0
(
    defaultPrim = "robot"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "robot" (
    variants = {
        string Physics = "PhysX"
    }
    prepend variantSets = "Physics"
)
{
    variantSet "Physics" = {
        "None" {
        }
        "PhysX" (
            payload = @./arm.usda@</arm>
        )
        {
        }
    }
}
`;

describe("composition — arcs authored on a variant", () => {
  it("pulls the selected variant's payload into the prim", async () => {
    const resolver = createMemoryResolver({ "/root.usda": ROOT_LAYER, "/arm.usda": ARM_LAYER });
    const composed = await composeLayer(ROOT_LAYER, "/root.usda", resolver);
    const desc = extractRobotDescription(Stage.OpenFromString(serializeUsda(composed)));

    expect(Object.keys(desc.links).sort()).toEqual(["base", "link"]);
    expect(desc.joints.j1?.type).toBe("revolute");
    expect(desc.links.base?.visualPrims).toEqual(["/robot/base/geom"]);
  });

  it("ignores arcs on variants that are not selected", async () => {
    const other = ROOT_LAYER.replace('string Physics = "PhysX"', 'string Physics = "None"');
    const resolver = createMemoryResolver({ "/root.usda": other, "/arm.usda": ARM_LAYER });
    const composed = await composeLayer(other, "/root.usda", resolver);
    const desc = extractRobotDescription(Stage.OpenFromString(serializeUsda(composed)));
    expect(Object.keys(desc.links)).toEqual([]);
  });

  it("round-trips variant metadata through parse → write → parse", () => {
    const file = parseUsda(ROOT_LAYER);
    const variant = file.prims[0]!.variantSets!.Physics!.PhysX!;
    expect(variant.metadata.payload).toBeDefined();

    const reparsed = parseUsda(serializeUsda(file));
    expect(reparsed.prims[0]!.variantSets!.Physics!.PhysX!.metadata).toEqual(variant.metadata);
  });
});

// ---------------------------------------------------------------------------
// Layer cache
// ---------------------------------------------------------------------------

describe("composition — shared layer cache", () => {
  it("fetches a layer referenced by many prims exactly once", async () => {
    const shared = `#usda 1.0
(
    defaultPrim = "part"
)

def Xform "part"
{
    def Mesh "geom"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}
`;
    const links = [0, 1, 2, 3, 4]
      .map(
        (i) => `    def Xform "link${i}" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
        prepend references = @./part.usda@</part>
    )
    {
    }
`,
      )
      .join("");
    const root = `#usda 1.0
(
    defaultPrim = "robot"
)

def Xform "robot"
{
${links}}
`;

    const fetches: string[] = [];
    const base = createMemoryResolver({ "/root.usda": root, "/part.usda": shared });
    const resolver = {
      resolve: base.resolve,
      fetchText: (u: string) => {
        fetches.push(u);
        return base.fetchText(u);
      },
    };

    const composed = await composeLayer(root, "/root.usda", resolver);
    const desc = extractRobotDescription(Stage.OpenFromString(serializeUsda(composed)));

    expect(Object.keys(desc.links)).toHaveLength(5);
    expect(desc.links.link3?.visualPrims).toEqual(["/robot/link3/geom"]);
    // Five referrers, one fetch.
    expect(fetches).toEqual(["/part.usda"]);
  });
});

// ---------------------------------------------------------------------------
// Robustness against real-asset quirks
// ---------------------------------------------------------------------------

describe("loader robustness", () => {
  it("treats an empty asset path as an internal reference, not a self-cycle", async () => {
    const source = `#usda 1.0
(
    defaultPrim = "world"
)

def Xform "world"
{
    def Xform "proto"
    {
        def Mesh "geom"
        {
            int[] faceVertexCounts = [3]
            int[] faceVertexIndices = [0, 1, 2]
            point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        }
    }

    def Xform "base" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
        prepend references = @@</world/proto>
    )
    {
    }
}
`;
    const warnings: string[] = [];
    const composed = await composeLayer(source, "/root.usda", createMemoryResolver({}), {
      onWarn: (m) => warnings.push(m),
    });
    const desc = extractRobotDescription(Stage.OpenFromString(serializeUsda(composed)));

    expect(warnings.filter((w) => w.includes("cycle"))).toEqual([]);
    expect(desc.links.base?.visualPrims).toEqual(["/world/base/geom"]);
  });

  it("skips an xformOp listed in xformOpOrder but never authored", async () => {
    const source = `#usda 1.0
(
    defaultPrim = "world"
    metersPerUnit = 1
)

def Xform "world"
{
    def Xform "base" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
        double3 xformOp:translate = (1, 2, 3)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:orient"]
    }
}
`;
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(source);
    const p = robot.getLinkWorldPosition("base");
    expect([p.x, p.y, p.z]).toEqual([1, 2, 3]);
  });

  it("renders a mesh that is both drawn and collided with", async () => {
    // One mesh per link carrying PhysicsCollisionAPI at default purpose — the
    // usual Isaac Sim layout. Only guide/proxy purposes are collision-only.
    const source = `#usda 1.0
(
    defaultPrim = "world"
)

def Xform "world"
{
    def Xform "base" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
        def Mesh "geom" (
            prepend apiSchemas = ["PhysicsCollisionAPI"]
        )
        {
            int[] faceVertexCounts = [3]
            int[] faceVertexIndices = [0, 1, 2]
            point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        }

        def Mesh "hidden" (
            prepend apiSchemas = ["PhysicsCollisionAPI"]
        )
        {
            uniform token purpose = "guide"
            int[] faceVertexCounts = [3]
            int[] faceVertexIndices = [0, 1, 2]
            point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        }
    }
}
`;
    const desc = extractRobotDescription(Stage.OpenFromString(source));
    expect(desc.links.base?.visualPrims).toEqual(["/world/base/geom"]);
    expect(desc.links.base?.collisionPrims).toEqual(["/world/base/geom", "/world/base/hidden"]);

    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(source);
    const meshes = robot
      .getLinkObject("base")!
      .children.filter((c) => (c as { isMesh?: boolean }).isMesh);
    expect(meshes).toHaveLength(1);
  });
});
