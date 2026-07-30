import type * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ThreeUsdRobotLoader, type ThreeUsdRobotLoaderOptions } from "../src/index.js";

// M18: Points / BasisCurves gprims. Samples per cubic segment in MeshBinding.
const DIV = 8;

function findByName(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  let found: THREE.Object3D | undefined;
  root.traverse((o) => {
    if (!found && o.name === name) found = o;
  });
  return found;
}

function positionsOf(object: THREE.Object3D): THREE.BufferAttribute {
  const geometry = (object as THREE.Mesh).geometry as THREE.BufferGeometry;
  return geometry.getAttribute("position") as THREE.BufferAttribute;
}

/** Load a static scene whose `World` prim holds `body`. */
async function loadScene(
  body: string,
  options: ThreeUsdRobotLoaderOptions = {},
): Promise<THREE.Object3D> {
  return new ThreeUsdRobotLoader(options).parse(`#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1.0
    upAxis = "Y"
)

def Xform "World"
{
${body}
}
`);
}

describe("Points gprims", () => {
  it("builds THREE.Points with vertex colors and mean-width sizing", async () => {
    const scene = await loadScene(`
    def Points "cloud"
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)]
        float[] widths = [0.2, 0.4, 0.2, 0.4]
        color3f[] primvars:displayColor = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0)]
    }`);
    const cloud = findByName(scene, "cloud") as THREE.Points;
    expect(cloud?.type).toBe("Points");
    expect(positionsOf(cloud).count).toBe(4);

    const material = cloud.material as THREE.PointsMaterial;
    expect(material.vertexColors).toBe(true);
    expect((cloud.geometry as THREE.BufferGeometry).getAttribute("color")).toBeDefined();
    expect(material.size).toBeCloseTo(0.3, 9); // mean of the widths (diameters)
    expect(material.sizeAttenuation).toBe(true);
  });

  it("uses a constant displayColor and fixed pixel size without widths", async () => {
    const scene = await loadScene(`
    def Points "cloud"
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0)]
        color3f[] primvars:displayColor = [(1, 0, 0)]
    }`);
    const material = (findByName(scene, "cloud") as THREE.Points).material as THREE.PointsMaterial;
    expect(material.vertexColors).toBe(false);
    expect(material.color.getHex()).toBe(0xff0000);
    expect(material.sizeAttenuation).toBe(false);
  });
});

describe("BasisCurves gprims", () => {
  it("builds one THREE.Line per linear curve", async () => {
    const scene = await loadScene(`
    def BasisCurves "curves"
    {
        uniform token type = "linear"
        int[] curveVertexCounts = [3, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 0, 1), (0, 1, 1)]
        color3f[] primvars:displayColor = [(0, 1, 0)]
    }`);
    const group = findByName(scene, "curves")!;
    expect(group.children).toHaveLength(2);
    expect(group.children[0]!.type).toBe("Line");
    expect(positionsOf(group.children[0]!).count).toBe(3);
    expect(positionsOf(group.children[1]!).count).toBe(2);
    const material = (group.children[0] as THREE.Line).material as THREE.LineBasicMaterial;
    expect(material.color.getHex()).toBe(0x00ff00);
  });

  it("closes linear periodic curves with a LineLoop", async () => {
    const scene = await loadScene(`
    def BasisCurves "ring"
    {
        uniform token type = "linear"
        uniform token wrap = "periodic"
        int[] curveVertexCounts = [4]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
    }`);
    const loop = findByName(scene, "ring")!.children[0]!;
    expect(loop.type).toBe("LineLoop");
    expect(positionsOf(loop).count).toBe(4);
  });

  it("samples cubic bezier segments (vstep 3, endpoint-interpolating)", async () => {
    const scene = await loadScene(`
    def BasisCurves "bezier"
    {
        uniform token type = "cubic"
        uniform token basis = "bezier"
        int[] curveVertexCounts = [7]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (2, 0, 0), (3, 0, 0), (4, 0, 0), (5, 0, 0), (6, 0, 0)]
    }`);
    const line = findByName(scene, "bezier")!.children[0]!;
    const pos = positionsOf(line);
    expect(pos.count).toBe(2 * DIV + 1); // 7 CVs → 2 segments
    expect(pos.getX(0)).toBeCloseTo(0, 6); // bezier passes through its endpoints
    expect(pos.getX(pos.count - 1)).toBeCloseTo(6, 6);
  });

  it("samples uniform cubic bsplines", async () => {
    const scene = await loadScene(`
    def BasisCurves "bspline"
    {
        uniform token type = "cubic"
        uniform token basis = "bspline"
        int[] curveVertexCounts = [4]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (2, 0, 0), (3, 0, 0)]
    }`);
    const pos = positionsOf(findByName(scene, "bspline")!.children[0]!);
    expect(pos.count).toBe(DIV + 1); // 4 CVs → 1 segment
    expect(pos.getX(0)).toBeCloseTo(1, 6); // (P0 + 4·P1 + P2) / 6
    expect(pos.getX(pos.count - 1)).toBeCloseTo(2, 6); // (P1 + 4·P2 + P3) / 6
  });

  it("samples catmullRom through its interior CVs", async () => {
    const scene = await loadScene(`
    def BasisCurves "catmull"
    {
        uniform token type = "cubic"
        uniform token basis = "catmullRom"
        int[] curveVertexCounts = [4]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (2, 1, 0), (3, 0, 0)]
    }`);
    const pos = positionsOf(findByName(scene, "catmull")!.children[0]!);
    expect(pos.count).toBe(DIV + 1);
    expect(pos.getX(0)).toBeCloseTo(1, 6); // interpolates P1 …
    expect(pos.getX(pos.count - 1)).toBeCloseTo(2, 6); // … through P2
    expect(pos.getY(pos.count - 1)).toBeCloseTo(1, 6);
  });

  it("wraps periodic cubic curves into a LineLoop", async () => {
    const scene = await loadScene(`
    def BasisCurves "loop"
    {
        uniform token type = "cubic"
        uniform token basis = "catmullRom"
        uniform token wrap = "periodic"
        int[] curveVertexCounts = [4]
        point3f[] points = [(1, 0, 0), (0, 1, 0), (-1, 0, 0), (0, -1, 0)]
    }`);
    const loop = findByName(scene, "loop")!.children[0]!;
    expect(loop.type).toBe("LineLoop");
    expect(positionsOf(loop).count).toBe(4 * DIV); // 4 wrapped segments, no closing dupe
  });

  it("tessellates widths into tube meshes with the curveTubes option", async () => {
    const body = `
    def BasisCurves "hose"
    {
        uniform token type = "linear"
        int[] curveVertexCounts = [3]
        point3f[] points = [(0, 0, 0), (0.5, 0.2, 0), (1, 0, 0)]
        float[] widths = [0.1, 0.1, 0.1]
    }`;
    const asLines = await loadScene(body);
    expect(findByName(asLines, "hose")!.children[0]!.type).toBe("Line");

    const asTubes = await loadScene(body, { curveTubes: true });
    const tube = findByName(asTubes, "hose")!.children[0] as THREE.Mesh;
    expect(tube.type).toBe("Mesh");
    expect(tube.geometry.type).toBe("TubeGeometry");
    expect((tube.geometry as THREE.TubeGeometry).parameters.radius).toBeCloseTo(0.05, 9);
  });
});

describe("point/curve gprims on robot links", () => {
  it("attaches them as visual geometry under the owning link", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(`#usda 1.0
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
        def Points "cloud"
        {
            point3f[] points = [(0, 0, 0), (1, 1, 1)]
        }

        def BasisCurves "wire"
        {
            uniform token type = "linear"
            int[] curveVertexCounts = [2]
            point3f[] points = [(0, 0, 0), (0, 0, 1)]
        }
    }

    def PhysicsFixedJoint "root"
    {
        rel physics:body1 = </World/base>
    }
}
`);
    const link = (robot as unknown as { getLinkObject(n: string): THREE.Object3D }).getLinkObject(
      "base",
    );
    const cloud = findByName(link, "cloud")!;
    expect(cloud.type).toBe("Points");
    expect(cloud.userData.kind).toBe("visual");
    const wire = findByName(link, "wire")!;
    expect(wire.userData.kind).toBe("visual");
    expect(wire.children[0]!.type).toBe("Line");
  });
});

describe("unsupported curve/patch gprims", () => {
  it("skips NurbsCurves with a warning", async () => {
    const warnings: string[] = [];
    const scene = await loadScene(
      `
    def Cube "box"
    {
        double size = 1
    }

    def NurbsCurves "nurbs"
    {
        int[] curveVertexCounts = [4]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (2, 0, 0), (3, 0, 0)]
    }`,
      { onWarn: (m) => warnings.push(m) },
    );
    expect(findByName(scene, "box")).toBeDefined();
    expect(findByName(scene, "nurbs")).toBeUndefined();
    expect(warnings.some((w) => w.includes("NurbsCurves"))).toBe(true);
  });
});
