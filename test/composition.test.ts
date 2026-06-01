import { describe, expect, it } from "vitest";
import {
  Stage,
  ThreeUsdRobotLoader,
  composeLayer,
  createMemoryResolver,
  extractRobotDescription,
  joinPosix,
  parseUsda,
} from "../src/index.js";

// A robot whose base_link geometry lives in a separate, referenced asset.
const MAIN = `#usda 1.0
(
    defaultPrim = "World"
    upAxis = "Z"
    metersPerUnit = 1.0
)
def Xform "World"
{
    def Xform "base_link" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
        prepend references = @./parts/link.usda@</geom_root>
    )
    {
    }
    def Xform "link1" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def PhysicsFixedJoint "root_joint" { rel physics:body1 = </World/base_link> }
    def PhysicsRevoluteJoint "joint1"
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </World/base_link>
        rel physics:body1 = </World/link1>
    }
}`;

const LINK = `#usda 1.0
(
    defaultPrim = "geom_root"
)
def Xform "geom_root"
{
    def Mesh "geom"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`;

function memoryFiles(extra: Record<string, string> = {}) {
  return { "/robot/main.usda": MAIN, "/robot/parts/link.usda": LINK, ...extra };
}

describe("joinPosix", () => {
  it("resolves relative asset paths", () => {
    expect(joinPosix("/robot/main.usda", "./parts/link.usda")).toBe("/robot/parts/link.usda");
    expect(joinPosix("/robot/sub/main.usda", "../parts/link.usda")).toBe("/robot/parts/link.usda");
    expect(joinPosix("/robot/main.usda", "/abs/x.usda")).toBe("/abs/x.usda");
  });
});

describe("metadata arc-list parsing", () => {
  it("parses a bracketed reference list without choking", () => {
    const file = parseUsda(
      'def Xform "X" (\n  prepend references = [@a.usda@</A>, @b.usda@</B>]\n)\n{\n}',
    );
    const refs = file.prims[0]?.metadata.references;
    expect(Array.isArray(refs)).toBe(true);
    expect((refs as { primPath?: string }[]).map((a) => a.primPath)).toEqual(["/A", "/B"]);
  });

  it("still parses plain token arrays (apiSchemas)", () => {
    const file = parseUsda('def Xform "X" (\n  prepend apiSchemas = ["A", "B"]\n)\n{\n}');
    expect(file.prims[0]?.metadata.apiSchemas).toEqual(["A", "B"]);
  });
});

describe("composeLayer — references", () => {
  it("flattens a referenced subtree into the prim", async () => {
    const resolver = createMemoryResolver(memoryFiles());
    const file = await composeLayer(MAIN, "/robot/main.usda", resolver);
    const stage = Stage.OpenFromFile(file);

    // base_link gains geom_root's Mesh child; arc metadata is stripped.
    const mesh = stage.GetPrimAtPath("/World/base_link/geom");
    expect(mesh?.GetTypeName()).toBe("Mesh");
    expect(stage.GetPrimAtPath("/World/base_link")?.GetMetadata("references")).toBeUndefined();
    // Local apiSchemas survive the merge.
    expect(stage.GetPrimAtPath("/World/base_link")?.HasAPI("PhysicsRigidBodyAPI")).toBe(true);
  });

  it("produces the same robot IR as the equivalent single file", async () => {
    const resolver = createMemoryResolver(memoryFiles());
    const composed = await composeLayer(MAIN, "/robot/main.usda", resolver);
    const robot = extractRobotDescription(Stage.OpenFromFile(composed));

    expect(robot.rootLink).toBe("base_link");
    expect(Object.keys(robot.joints).sort()).toEqual(["joint1", "root_joint"]);
    expect(robot.links.base_link?.visualPrims).toEqual(["/World/base_link/geom"]);
  });

  it("warns and continues when a reference cannot be resolved", async () => {
    const warnings: string[] = [];
    // Provide main but NOT the referenced link file.
    const resolver = createMemoryResolver({ "/robot/main.usda": MAIN });
    const file = await composeLayer(MAIN, "/robot/main.usda", resolver, {
      onWarn: (m) => warnings.push(m),
    });
    const stage = Stage.OpenFromFile(file);

    expect(stage.GetPrimAtPath("/World/base_link/geom")).toBeNull(); // no geometry pulled in
    expect(warnings.some((w) => w.includes("cannot resolve"))).toBe(true);
  });
});

describe("loader composition integration", () => {
  it("loads a multi-file robot through the loader", async () => {
    const resolver = createMemoryResolver(memoryFiles());
    const loader = new ThreeUsdRobotLoader({ assetResolver: resolver });
    const robot = await loader.loadAsync("/robot/main.usda");

    expect(robot.getKinematicTree().root).toBe("base_link");
    const baseMeshes = robot
      .getLinkObject("base_link")!
      .children.filter((c) => (c as { isMesh?: boolean }).isMesh);
    expect(baseMeshes).toHaveLength(1); // referenced mesh rendered under base_link
  });
});
