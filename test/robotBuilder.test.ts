import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  RobotBuilder,
  ThreeUsdRobotLoader,
  exportThreeUsdRobot,
  geometryToExportMesh,
  serializeUsda,
} from "../src/index.js";

const TWO_LINK = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

/**
 * Hand-built arm (Z-up, meters):
 *   base  — at the origin, with a gray box visual
 *   arm   — link frame at (0.2, 0, 0.5), red box visual 0.2 above the frame
 *   j1    — revolute about Z at world (0, 0, 0.5), limits ±π
 * Zero pose puts the arm at (0.2, 0, 0.5); rotating j1 by 90° about Z moves it
 * to (0, 0.2, 0.5).
 */
function buildArm(): RobotBuilder {
  const baseMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.2, 0.1),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.5, 0.5) }),
  );
  baseMesh.name = "base_visual";

  const armMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(1, 0, 0),
    metalness: 0.3,
    roughness: 0.6,
  });
  armMaterial.name = "arm_red";
  const armMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.4), armMaterial);
  armMesh.name = "arm_visual";
  armMesh.position.set(0.2, 0, 0.7); // world → 0.2 above the arm link frame

  const builder = new RobotBuilder({ name: "arm_bot" });
  builder.addLink({ name: "base", visuals: [baseMesh] });
  builder.addLink({
    name: "arm",
    frame: new THREE.Matrix4().makeTranslation(0.2, 0, 0.5),
    visuals: [armMesh],
  });
  builder.addFixedJoint({ name: "root_joint", child: "base" });
  builder.addRevoluteJoint({
    name: "j1",
    parent: "base",
    child: "arm",
    frame: new THREE.Matrix4().makeTranslation(0, 0, 0.5),
    axis: "Z",
    lower: -Math.PI,
    upper: Math.PI,
  });
  return builder;
}

describe("RobotBuilder — authoring", () => {
  it("derives both joint frames from one world-space frame", () => {
    const { desc, tree } = buildArm().build();
    expect(desc.rootLink).toBe("base");
    expect(tree.rootJoint).toBe("root_joint");

    const j1 = desc.joints.j1!;
    // frame0 = base⁻¹ · joint = T(0,0,0.5); frame1 = arm⁻¹ · joint = T(-0.2,0,0).
    expect([j1.jointFrame0[12], j1.jointFrame0[13], j1.jointFrame0[14]]).toEqual([0, 0, 0.5]);
    expect(j1.jointFrame1[12]).toBeCloseTo(-0.2, 12);
    expect(j1.jointFrame1[13]).toBeCloseTo(0, 12);
    expect(j1.jointFrame1[14]).toBeCloseTo(0, 12);

    expect(desc.upAxis).toBe("Z");
    expect(desc.metersPerUnit).toBe(1);
  });

  it("throws on duplicate names and unknown references", () => {
    const b = new RobotBuilder({ name: "x" });
    b.addLink({ name: "a" });
    expect(() => b.addLink({ name: "a" })).toThrow(/already defined/);
    b.addRevoluteJoint({ name: "j", parent: "a", child: "missing" });
    expect(() => b.build()).toThrow(/unknown child/);
  });

  it("exports non-indexed geometry as sequential triangles", () => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0], 3),
    );
    const mesh = geometryToExportMesh(geom, { name: "tri" });
    expect(mesh?.faceVertexCounts).toEqual([3, 3]);
    expect(mesh?.faceVertexIndices).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("RobotBuilder — export → reload acceptance", () => {
  it("reloads through the loader and the joint moves the arm", async () => {
    const usda = serializeUsda(buildArm().toUsda());
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(usda);

    expect(robot.getJointNames()).toEqual(["j1"]);
    expect(robot.getLinkNames().sort()).toEqual(["arm", "base"]);

    // Zero pose: arm frame at (0.2, 0, 0.5).
    let p = robot.getLinkWorldPosition("arm");
    expect(p.x).toBeCloseTo(0.2, 10);
    expect(p.y).toBeCloseTo(0, 10);
    expect(p.z).toBeCloseTo(0.5, 10);

    // 90° about Z at (0, 0, 0.5) → (0, 0.2, 0.5).
    robot.setJointValue("j1", Math.PI / 2);
    p = robot.getLinkWorldPosition("arm");
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.y).toBeCloseTo(0.2, 10);
    expect(p.z).toBeCloseTo(0.5, 10);

    // Limits survived in SI.
    expect(robot.robot.joints.j1!.lower).toBeCloseTo(-Math.PI, 10);
    expect(robot.robot.joints.j1!.upper).toBeCloseTo(Math.PI, 10);
  });

  it("carries mesh geometry, placement, and PBR material constants", async () => {
    const usda = serializeUsda(buildArm().toUsda());
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parse(usda);

    const armObj = robot.getLinkObject("arm")!;
    const mesh = armObj.children.find((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
    expect(mesh).toBeTruthy();

    // Box: 24 vertices, 12 triangles; sits 0.2 above the link origin.
    expect(mesh!.geometry.getAttribute("position").count).toBe(24);
    expect(mesh!.geometry.getIndex()!.count).toBe(36);
    expect(mesh!.matrix.elements[14]).toBeCloseTo(0.2, 10);

    const material = mesh!.material as THREE.MeshStandardMaterial;
    expect(material.color.r).toBeCloseTo(1, 5);
    expect(material.color.g).toBeCloseTo(0, 5);
    expect(material.color.b).toBeCloseTo(0, 5);
    expect(material.metalness).toBeCloseTo(0.3, 5);
    expect(material.roughness).toBeCloseTo(0.6, 5);
  });
});

describe("exportThreeUsdRobot — loaded-robot re-export", () => {
  it("re-exports from the Three.js scene with FK parity and meshes", async () => {
    const loader = new ThreeUsdRobotLoader({ upAxisConversion: "none" });
    const robot = await loader.parse(TWO_LINK);
    const usda = serializeUsda(exportThreeUsdRobot(robot));
    const robot2 = await loader.parse(usda);

    const pose = { joint1: 0.7, joint2: 0.3 };
    robot.setJointValues(pose);
    robot2.setJointValues(pose);
    for (const link of robot.getLinkNames()) {
      const a = robot.getLinkWorldMatrix(link).elements;
      const b = robot2.getLinkWorldMatrix(link).elements;
      for (let i = 0; i < 16; i++) expect(b[i]).toBeCloseTo(a[i]!, 10);
    }

    // Scene-harvested meshes came along.
    const base = robot2.getLinkObject("base_link")!;
    expect(base.children.some((c) => (c as THREE.Mesh).isMesh)).toBe(true);
  });
});
