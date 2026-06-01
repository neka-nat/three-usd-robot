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
