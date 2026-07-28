import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Stage, ThreeUsdRobotLoader, buildMeshGeometry } from "../src/index.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

/** All THREE.Mesh descendants of an object (recursive). */
function meshes(obj: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

/** Only the direct Mesh children of a link object (child links nest deeper). */
function directMeshes(obj: THREE.Object3D): THREE.Mesh[] {
  return obj.children.filter((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh[];
}

describe("buildMeshGeometry", () => {
  it("triangulates a quad face into two triangles", () => {
    const stage = Stage.OpenFromString(ARM);
    const geom = buildMeshGeometry(stage.GetPrimAtPath("/World/link1/geom")!);
    expect(geom).not.toBeNull();
    // 4 points, one quad -> 2 triangles -> 6 indices.
    expect(geom!.getAttribute("position").count).toBe(4);
    expect(geom!.getIndex()?.count).toBe(6);
    // No authored normals -> computed.
    expect(geom!.getAttribute("normal")).toBeDefined();
  });

  it("keeps an already-triangulated face's index count", () => {
    const stage = Stage.OpenFromString(ARM);
    // base_link/geom: faceVertexCounts [3,3] -> 6 indices.
    const geom = buildMeshGeometry(stage.GetPrimAtPath("/World/base_link/geom")!);
    expect(geom!.getAttribute("position").count).toBe(4);
    expect(geom!.getIndex()?.count).toBe(6);
  });
});

describe("bindRobotMeshes (via loader)", () => {
  it("attaches visual meshes under their link objects by default", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);

    const baseMeshes = directMeshes(robot.getLinkObject("base_link")!);
    expect(baseMeshes).toHaveLength(1);
    expect(baseMeshes[0]?.name).toBe("geom");
    expect(baseMeshes[0]?.userData.kind).toBe("visual");

    expect(directMeshes(robot.getLinkObject("link1")!)).toHaveLength(1);
    expect(directMeshes(robot.getLinkObject("link2")!)).toHaveLength(0); // no geometry
  });

  it("places a link's mesh at the link's world pose", async () => {
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(ARM);
    robot.updateKinematics();
    // base_link/geom has no local xform, so the mesh sits at the link origin (0,0,0).
    const mesh = directMeshes(robot.getLinkObject("base_link")!)[0]!;
    const p = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    expect([p.x, p.y, p.z]).toEqual([0, 0, 0]);

    // link1/geom rides with link1 at (0,0,1).
    const link1Mesh = directMeshes(robot.getLinkObject("link1")!)[0]!;
    const q = new THREE.Vector3().setFromMatrixPosition(link1Mesh.matrixWorld);
    expect([q.x, q.y, q.z]).toEqual([0, 0, 1]);
  });

  it("loads no meshes when loadVisuals is false", async () => {
    const robot = await new ThreeUsdRobotLoader({ loadVisuals: false }).parse(ARM);
    expect(meshes(robot)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Per-face material assignment (`UsdGeomSubset`)
// ---------------------------------------------------------------------------

/** One mesh painted by two `materialBind` subsets — how real assets ship. */
const SUBSET_ROBOT = `#usda 1.0
(
    defaultPrim = "bot"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "bot"
{
    def Xform "base" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
        def Scope "Looks"
        {
            def Material "White"
            {
                token outputs:surface.connect = </bot/base/Looks/White/S.outputs:surface>

                def Shader "S"
                {
                    uniform token info:id = "UsdPreviewSurface"
                    color3f inputs:diffuseColor = (0.9, 0.9, 0.9)
                    token outputs:surface
                }
            }

            def Material "Black"
            {
                token outputs:surface.connect = </bot/base/Looks/Black/S.outputs:surface>

                def Shader "S"
                {
                    uniform token info:id = "UsdPreviewSurface"
                    color3f inputs:diffuseColor = (0.05, 0.05, 0.05)
                    token outputs:surface
                }
            }
        }

        def Mesh "geom"
        {
            int[] faceVertexCounts = [3, 3, 3]
            int[] faceVertexIndices = [0, 1, 2, 0, 2, 3, 0, 3, 1]
            point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)]

            def GeomSubset "white" (
                prepend apiSchemas = ["MaterialBindingAPI"]
            )
            {
                uniform token elementType = "face"
                uniform token familyName = "materialBind"
                int[] indices = [0, 2]
                rel material:binding = </bot/base/Looks/White>
            }

            def GeomSubset "black" (
                prepend apiSchemas = ["MaterialBindingAPI"]
            )
            {
                uniform token elementType = "face"
                uniform token familyName = "materialBind"
                int[] indices = [1]
                rel material:binding = </bot/base/Looks/Black>
            }
        }
    }
}
`;

describe("material subsets", () => {
  it("groups the geometry per subset and gives each its own material", async () => {
    const stage = Stage.OpenFromString(SUBSET_ROBOT);
    const geometry = buildMeshGeometry(stage.GetPrimAtPath("/bot/base/geom")!)!;
    // Two subsets (2 faces, then 1) — no unassigned faces, so no third group.
    expect(geometry.groups.map((g) => [g.start, g.count, g.materialIndex])).toEqual([
      [0, 6, 0],
      [6, 3, 1],
    ]);

    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(SUBSET_ROBOT);
    const mesh = meshes(robot)[0]!;
    const materials = mesh.material as THREE.MeshStandardMaterial[];
    expect(Array.isArray(materials)).toBe(true);
    expect(materials[0]!.name).toBe("White");
    expect(materials[1]!.name).toBe("Black");
    expect(materials[0]!.color.getHexString()).not.toBe(materials[1]!.color.getHexString());
  });

  it("exports one mesh per subset, keeping the material names", async () => {
    const { exportRobotUsda, extractRobotDescription, serializeUsda, stageGeometryProvider } =
      await import("../src/index.js");
    const stage = Stage.OpenFromString(SUBSET_ROBOT);
    const desc = extractRobotDescription(stage);
    const meshesOut = stageGeometryProvider(stage)("base", desc.links.base!);

    expect(meshesOut.map((m) => m.material?.name)).toEqual(["White", "Black"]);
    // Points are re-indexed onto the faces each piece covers.
    expect(meshesOut[0]!.faceVertexCounts).toEqual([3, 3]);
    expect(meshesOut[1]!.faceVertexCounts).toEqual([3]);
    expect(meshesOut[1]!.points).toHaveLength(3);

    const text = serializeUsda(exportRobotUsda(desc, { geometry: stageGeometryProvider(stage) }));
    const reDesc = extractRobotDescription(Stage.OpenFromString(text));
    expect(reDesc.links.base!.visualPrims).toHaveLength(2);
  });
});
