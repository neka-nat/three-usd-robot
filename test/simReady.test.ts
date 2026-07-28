import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  type PrimSpec,
  Quat,
  RobotBuilder,
  Stage,
  exportRobotUsda,
  extractRobotDescription,
  serializeUsda,
  stageGeometryProvider,
  validateRobotDescription,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixture: robot with mass, physics material, and collision approximation
// ---------------------------------------------------------------------------

const SIM_BOT = `#usda 1.0
(
    defaultPrim = "sim_bot"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "sim_bot" (
    prepend apiSchemas = ["PhysicsArticulationRootAPI"]
)
{
    def Xform "base" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI", "PhysicsMassAPI"]
    )
    {
        float physics:mass = 2.5
        point3f physics:centerOfMass = (0, 0, 0.1)
        float3 physics:diagonalInertia = (0.01, 0.02, 0.03)
        quatf physics:principalAxes = (1, 0, 0, 0)

        def Mesh "collision" (
            prepend apiSchemas = ["PhysicsCollisionAPI", "PhysicsMeshCollisionAPI", "MaterialBindingAPI"]
        )
        {
            uniform token physics:approximation = "convexHull"
            int[] faceVertexCounts = [3]
            int[] faceVertexIndices = [0, 1, 2]
            point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
            rel material:binding:physics = </sim_bot/PhysicsMaterials/rubber>
        }
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </sim_bot/base>
    }

    def Scope "PhysicsMaterials"
    {
        def Material "rubber" (
            prepend apiSchemas = ["PhysicsMaterialAPI"]
        )
        {
            float physics:staticFriction = 0.9
            float physics:dynamicFriction = 0.7
            float physics:restitution = 0.4
        }
    }
}
`;

const child = (p: PrimSpec, name: string): PrimSpec => {
  const c = p.children.find((c) => c.name === name);
  if (!c) throw new Error(`prim child "${name}" not found under "${p.name}"`);
  return c;
};
const propValue = (p: PrimSpec, name: string) => {
  const prop = p.properties.find((pr) => pr.name === name);
  return prop?.kind === "attribute" ? prop.value : undefined;
};
const relTargets = (p: PrimSpec, name: string) => {
  const prop = p.properties.find((pr) => pr.name === name);
  return prop?.kind === "relationship" ? prop.targets : undefined;
};

describe("mass / physics material / collision approximation round-trip", () => {
  const stage = Stage.OpenFromString(SIM_BOT);
  const desc = extractRobotDescription(stage);

  it("extracts PhysicsMassAPI into LinkDescription.inertial", () => {
    const inertial = desc.links.base!.inertial!;
    expect(inertial.mass).toBe(2.5);
    expect(inertial.centerOfMass).toEqual([0, 0, 0.1]);
    expect(inertial.diagonalInertia).toEqual([0.01, 0.02, 0.03]);
    expect(inertial.principalAxes).toBeInstanceOf(Quat);
  });

  it("round-trips mass, approximation, and physics material through export", () => {
    const file = exportRobotUsda(desc, { geometry: stageGeometryProvider(stage) });
    const text = serializeUsda(file);
    const stage2 = Stage.OpenFromString(text);
    const desc2 = extractRobotDescription(stage2);

    expect(desc2.links.base!.inertial).toEqual(desc.links.base!.inertial);

    const meshes2 = stageGeometryProvider(stage2)("base", desc2.links.base!);
    const collision = meshes2.find((m) => m.kind === "collision")!;
    expect(collision.collisionApproximation).toBe("convexHull");
    expect(collision.physicsMaterial).toEqual({
      name: "rubber",
      staticFriction: 0.9,
      dynamicFriction: 0.7,
      restitution: 0.4,
    });
  });

  it("emits MassAPI apiSchemas and the physics-material scope", () => {
    const file = exportRobotUsda(desc, { geometry: stageGeometryProvider(stage) });
    const root = file.prims[0]!;

    const base = child(root, "base");
    expect(base.metadata.apiSchemas).toContain("PhysicsMassAPI");
    expect(propValue(base, "physics:mass")).toBe(2.5);

    const collision = child(base, "collision");
    expect(collision.metadata.apiSchemas).toEqual(
      expect.arrayContaining([
        "PhysicsCollisionAPI",
        "PhysicsMeshCollisionAPI",
        "MaterialBindingAPI",
      ]),
    );
    expect(propValue(collision, "physics:approximation")).toBe("convexHull");
    expect(relTargets(collision, "material:binding:physics")).toEqual([
      "/sim_bot/PhysicsMaterials/rubber",
    ]);

    const rubber = child(child(root, "PhysicsMaterials"), "rubber");
    expect(rubber.metadata.apiSchemas).toEqual(["PhysicsMaterialAPI"]);
    expect(propValue(rubber, "physics:staticFriction")).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// PhysX self-collision + Isaac Robot Schema options
// ---------------------------------------------------------------------------

describe("exportRobotUsda — enabledSelfCollisions / isaacRobotSchema", () => {
  const desc = extractRobotDescription(Stage.OpenFromString(SIM_BOT));

  it("authors physxArticulation:enabledSelfCollisions on the articulation root", () => {
    const file = exportRobotUsda(desc, { enabledSelfCollisions: false });
    const root = file.prims[0]!;
    expect(root.metadata.apiSchemas).toEqual(
      expect.arrayContaining(["PhysicsArticulationRootAPI", "PhysxArticulationAPI"]),
    );
    expect(propValue(root, "physxArticulation:enabledSelfCollisions")).toBe(false);
  });

  it("applies the Isaac Robot Schema with ordered link/joint relationships", () => {
    const file = exportRobotUsda(desc, { isaacRobotSchema: true });
    const root = file.prims[0]!;

    expect(root.metadata.apiSchemas).toContain("IsaacRobotAPI");
    expect(relTargets(root, "isaac:physics:robotLinks")).toEqual(["/sim_bot/base"]);
    expect(relTargets(root, "isaac:physics:robotJoints")).toEqual(["/sim_bot/root_joint"]);

    expect(child(root, "base").metadata.apiSchemas).toContain("IsaacLinkAPI");
    const rootJoint = child(root, "root_joint");
    expect(rootJoint.metadata.apiSchemas).toContain("IsaacJointAPI");
    // Fixed joints carry no DOF order.
    expect(propValue(rootJoint, "isaac:physics:DofOffsetOpOrder")).toBeUndefined();
  });

  it("orders DOFs per joint type and axis", () => {
    const builder = new RobotBuilder({ name: "dof_bot" });
    builder.addLink({ name: "a" });
    builder.addLink({ name: "b" });
    builder.addLink({ name: "c" });
    builder.addFixedJoint({ name: "world_a", child: "a" });
    builder.addRevoluteJoint({ name: "j_rot", parent: "a", child: "b", axis: "Z" });
    builder.addPrismaticJoint({ name: "j_slide", parent: "b", child: "c", axis: "X" });
    const file = builder.toUsda({ isaacRobotSchema: true });
    const root = file.prims[0]!;

    expect(propValue(child(root, "j_rot"), "isaac:physics:DofOffsetOpOrder")).toEqual(["RotZ"]);
    expect(propValue(child(root, "j_slide"), "isaac:physics:DofOffsetOpOrder")).toEqual(["TransX"]);
    expect(relTargets(root, "isaac:physics:robotJoints")).toEqual([
      "/dof_bot/world_a",
      "/dof_bot/j_rot",
      "/dof_bot/j_slide",
    ]);
  });
});

// ---------------------------------------------------------------------------
// RobotBuilder simulation options
// ---------------------------------------------------------------------------

describe("RobotBuilder — inertial / collision options", () => {
  it("exports builder-provided mass, approximation, and physics material", () => {
    const collisionMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2));
    collisionMesh.name = "base_col";

    const builder = new RobotBuilder({ name: "phys_bot" });
    builder.addLink({
      name: "base",
      collisions: [collisionMesh],
      inertial: { mass: 5, centerOfMass: [0, 0, 0.05], diagonalInertia: [0.1, 0.1, 0.05] },
      collisionApproximation: "convexHull",
      physicsMaterial: { name: "steel", staticFriction: 0.5, dynamicFriction: 0.4 },
    });
    builder.addFixedJoint({ name: "root_joint", child: "base" });

    const text = serializeUsda(builder.toUsda());
    const stage = Stage.OpenFromString(text);
    const desc = extractRobotDescription(stage);
    // The exporter completes the UsdPhysics pairing rule: a diagonal inertia
    // without principal axes gains the identity quaternion.
    expect(desc.links.base!.inertial).toEqual({
      mass: 5,
      centerOfMass: [0, 0, 0.05],
      diagonalInertia: [0.1, 0.1, 0.05],
      principalAxes: new Quat(1, [0, 0, 0]),
    });

    const meshes = stageGeometryProvider(stage)("base", desc.links.base!);
    const collision = meshes.find((m) => m.kind === "collision")!;
    expect(collision.collisionApproximation).toBe("convexHull");
    expect(collision.physicsMaterial?.name).toBe("steel");
    expect(collision.physicsMaterial?.staticFriction).toBe(0.5);
  });

  it("drops principalAxes authored without diagonalInertia (with a warning)", () => {
    const warnings: string[] = [];
    const builder = new RobotBuilder({ name: "pair_bot", onWarn: (m) => warnings.push(m) });
    builder.addLink({ name: "a", inertial: { mass: 1, principalAxes: new Quat(1, [0, 0, 0]) } });
    builder.addFixedJoint({ name: "root_joint", child: "a" });
    const file = builder.toUsda();
    const a = file.prims[0]!.children.find((c) => c.name === "a")!;
    expect(a.properties.some((p) => p.name === "physics:principalAxes")).toBe(false);
    expect(warnings.some((w) => w.includes("principalAxes"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

describe("validateRobotDescription", () => {
  it("flags structural errors (unknown links, inverted limits, bad mass)", () => {
    const desc = extractRobotDescription(Stage.OpenFromString(SIM_BOT));
    const broken = structuredClone(desc);
    broken.joints.bad = {
      ...broken.joints.root_joint!,
      name: "bad",
      primPath: "/x",
      child: "missing",
      lower: 1,
      upper: -1,
    };
    broken.links.base!.inertial = { mass: -2 };

    const issues = validateRobotDescription(broken);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("unknown-link");
    expect(codes).toContain("invalid-limits");
    expect(codes).toContain("bad-mass");
    // Errors sort first.
    expect(issues[0]!.severity).toBe("error");
  });

  it("warns about missing inertial / collision and floating bases", () => {
    const floating = `#usda 1.0
(
    defaultPrim = "f"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "f"
{
    def Xform "a" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def Xform "b" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def PhysicsRevoluteJoint "j"
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </f/a>
        rel physics:body1 = </f/b>
    }
}
`;
    const stage = Stage.OpenFromString(floating);
    const desc = extractRobotDescription(stage);
    const issues = validateRobotDescription(desc, { geometry: stageGeometryProvider(stage) });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain("no-articulation-root");
    expect(codes).toContain("no-inertial");
    expect(codes).toContain("no-collision");
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("reports a collision mesh without an approximation", () => {
    const noApprox = SIM_BOT.replace(
      `            uniform token physics:approximation = "convexHull"\n`,
      "",
    );
    const stage = Stage.OpenFromString(noApprox);
    const desc = extractRobotDescription(stage);
    const issues = validateRobotDescription(desc, { geometry: stageGeometryProvider(stage) });
    expect(issues.map((i) => i.code)).toContain("collision-approximation");
  });

  it("is quiet on a fully-specified robot", () => {
    const stage = Stage.OpenFromString(SIM_BOT);
    const desc = extractRobotDescription(stage);
    const issues = validateRobotDescription(desc, { geometry: stageGeometryProvider(stage) });
    expect(issues).toEqual([]);
  });

  it("round-trips through export without introducing issues", () => {
    const stage = Stage.OpenFromString(SIM_BOT);
    const desc = extractRobotDescription(stage);
    const text = serializeUsda(exportRobotUsda(desc, { geometry: stageGeometryProvider(stage) }));
    const stage2 = Stage.OpenFromString(text);
    const desc2 = extractRobotDescription(stage2);
    const issues = validateRobotDescription(desc2, { geometry: stageGeometryProvider(stage2) });
    expect(issues).toEqual([]);
  });
});
