import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  createGhostRobot,
  getLinkMeshes,
  highlightLink,
  restoreAllLinkMaterials,
  restoreLinkMaterials,
  setLinkMaterial,
} from "../src/helpers.js";
import { ThreeUsdRobotLoader } from "../src/index.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

// One link with a visual sphere and a guide-purpose collision cube.
const MIXED = `#usda 1.0
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

        def Cube "hitbox" (
            prepend apiSchemas = ["PhysicsCollisionAPI"]
        )
        {
            uniform token purpose = "guide"
            double size = 0.5
        }
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </World/base>
    }
}
`;

const std = (mesh: THREE.Mesh): THREE.MeshStandardMaterial =>
  mesh.material as THREE.MeshStandardMaterial;

describe("highlightLink / restoreLinkMaterials", () => {
  it("tints only the addressed link and restores the exact originals", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const link1Mesh = getLinkMeshes(robot, "link1")[0]!;
    const baseMesh = getLinkMeshes(robot, "base_link")[0]!;
    const original = link1Mesh.material;
    const baseOriginal = baseMesh.material;

    expect(highlightLink(robot, "link1")).toBe(true);
    expect(link1Mesh.material).not.toBe(original);
    expect(std(link1Mesh).emissive.getHex()).toBe(0xff4444);
    expect(baseMesh.material).toBe(baseOriginal); // untouched

    restoreLinkMaterials(robot, "link1");
    expect(link1Mesh.material).toBe(original);
  });

  it("re-highlights from the original material instead of stacking", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const mesh = getLinkMeshes(robot, "link1")[0]!;
    const original = mesh.material;

    highlightLink(robot, "link1", { color: 0xff0000 });
    const first = mesh.material;
    highlightLink(robot, "link1", { color: 0x0000ff, opacity: 0.5 });
    expect(mesh.material).not.toBe(first);
    expect(std(mesh).emissive.getHex()).toBe(0x0000ff);
    expect(std(mesh).opacity).toBe(0.5);
    expect(std(mesh).transparent).toBe(true);

    restoreLinkMaterials(robot, "link1");
    expect(mesh.material).toBe(original);
  });

  it("accepts prim paths and reports missing meshes", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    expect(highlightLink(robot, "/World/link1")).toBe(true);
    expect(highlightLink(robot, "link2")).toBe(false); // link without meshes
    expect(highlightLink(robot, "/nope")).toBe(false);
    restoreAllLinkMaterials(robot);
    expect(std(getLinkMeshes(robot, "link1")[0]!).emissive.getHex()).toBe(0x000000);
  });

  it("targets visual/collision meshes via the kind option", async () => {
    const robot = await new ThreeUsdRobotLoader({ loadCollisions: true }).parse(MIXED);
    const [skin] = getLinkMeshes(robot, "base", "visual");
    const [hitbox] = getLinkMeshes(robot, "base", "collision");
    expect(skin?.name).toBe("skin");
    expect(hitbox?.name).toBe("hitbox");

    highlightLink(robot, "base", { kind: "collision", color: 0x00ff00 });
    expect(std(hitbox!).emissive.getHex()).toBe(0x00ff00);
    expect(std(skin!).emissive.getHex()).toBe(0x000000);

    highlightLink(robot, "base", { kind: "all", color: 0xffff00 });
    expect(std(skin!).emissive.getHex()).toBe(0xffff00);
    expect(std(hitbox!).emissive.getHex()).toBe(0xffff00);
  });
});

describe("setLinkMaterial", () => {
  it("swaps in a shared caller-owned material and restores", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const mesh = getLinkMeshes(robot, "link1")[0]!;
    const original = mesh.material;

    const flat = new THREE.MeshBasicMaterial({ color: 0x123456, wireframe: true });
    expect(setLinkMaterial(robot, "link1", flat)).toBe(true);
    expect(mesh.material).toBe(flat);

    restoreLinkMaterials(robot, "link1");
    expect(mesh.material).toBe(original);
    expect(flat.color.getHex()).toBe(0x123456); // never disposed / mutated
  });

  it("survives highlight → replace → restore round trips", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const mesh = getLinkMeshes(robot, "link1")[0]!;
    const original = mesh.material;

    highlightLink(robot, "link1");
    setLinkMaterial(robot, "link1", new THREE.MeshBasicMaterial());
    restoreLinkMaterials(robot, "link1");
    expect(mesh.material).toBe(original);
  });
});

describe("createGhostRobot", () => {
  it("clones shared geometry with one translucent ghost material", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const ghost = createGhostRobot(robot);

    const srcMeshes = [...getLinkMeshes(robot, "base_link"), ...getLinkMeshes(robot, "link1")];
    const ghostMeshes = [
      ...getLinkMeshes(ghost, "base_link", "all"),
      ...getLinkMeshes(ghost, "link1", "all"),
    ];
    expect(ghostMeshes).toHaveLength(0); // ghost meshes are kind "ghost", not visual

    let found: THREE.Mesh[] = [];
    ghost.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) found.push(o as THREE.Mesh);
    });
    found = found.filter((m) => m.userData.kind === "ghost");
    expect(found).toHaveLength(srcMeshes.length);
    const srcGeometries = new Set(srcMeshes.map((m) => m.geometry));
    expect(found.every((m) => srcGeometries.has(m.geometry))).toBe(true); // shared, not copied
    const material = found[0]!.material as THREE.MeshStandardMaterial;
    expect(found.every((m) => m.material === material)).toBe(true);
    expect(material.transparent).toBe(true);
    expect(material.opacity).toBeCloseTo(0.35, 6);
  });

  it("mirrors the source pose and root transform, with FK parity", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    robot.position.set(1, 2, 3);
    robot.setJointValue("joint1", 0.4);

    const ghost = createGhostRobot(robot);
    expect(ghost.getJointValue("joint1")).toBeCloseTo(0.4, 6);
    expect(ghost.position.toArray()).toEqual([1, 2, 3]);

    const a = robot.getLinkWorldPosition("link1");
    const b = ghost.getLinkWorldPosition("link1");
    expect(b.distanceTo(a)).toBeLessThan(1e-6);
  });

  it("applies joint overrides and drives independently of the source", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    robot.setJointValue("joint1", 0.4);

    const ghost = createGhostRobot(robot, { jointValues: { joint1: -0.2 } });
    expect(ghost.getJointValue("joint1")).toBeCloseTo(-0.2, 6);
    expect(robot.getJointValue("joint1")).toBeCloseTo(0.4, 6);

    ghost.setJointValue("joint1", 1.0);
    expect(robot.getJointValue("joint1")).toBeCloseTo(0.4, 6);
  });

  it("is immune to the source's showVisual toggle", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const ghost = createGhostRobot(robot);
    robot.add(ghost); // worst case: nested under the source

    robot.showVisual = false;
    let ghostVisible = true;
    ghost.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.userData.kind === "ghost") {
        ghostVisible = ghostVisible && o.visible;
      }
    });
    expect(ghostVisible).toBe(true);
  });
});
