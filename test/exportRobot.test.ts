import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CrateReader,
  type PrimSpec,
  type RobotDescription,
  Stage,
  ThreeUsdRobot,
  UsdMatrix,
  buildKinematicTree,
  crateToUsdaFile,
  exportRobotUsda,
  extractRobotDescription,
  parseUsda,
  serializeUsda,
  stageGeometryProvider,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TWO_LINK = new URL("../test-assets/two_link_arm.usda", import.meta.url);

/** Export `desc` (+stage geometry) and re-extract the IR from the USDA text. */
function roundTripDesc(
  desc: RobotDescription,
  stage?: Stage,
): { text: string; reDesc: RobotDescription } {
  const file = exportRobotUsda(desc, stage ? { geometry: stageGeometryProvider(stage) } : {});
  const text = serializeUsda(file);
  return { text, reDesc: extractRobotDescription(Stage.OpenFromString(text)) };
}

/** Assert both robots produce identical link world matrices for each pose. */
function expectSameFK(
  a: RobotDescription,
  b: RobotDescription,
  poses: Record<string, number>[],
): void {
  const ra = new ThreeUsdRobot(a, buildKinematicTree(a));
  const rb = new ThreeUsdRobot(b, buildKinematicTree(b));
  expect(rb.getLinkNames().sort()).toEqual(ra.getLinkNames().sort());
  for (const pose of poses) {
    ra.setJointValues(pose);
    rb.setJointValues(pose);
    for (const link of ra.getLinkNames()) {
      const ma = ra.getLinkWorldMatrix(link).elements;
      const mb = rb.getLinkWorldMatrix(link).elements;
      for (let i = 0; i < 16; i++) expect(mb[i]).toBeCloseTo(ma[i]!, 10);
    }
  }
}

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

// ---------------------------------------------------------------------------
// FK golden round-trip (two_link_arm)
// ---------------------------------------------------------------------------

describe("exportRobotUsda — FK golden round-trip", () => {
  const src = readFileSync(TWO_LINK, "utf8");
  const stage = Stage.OpenFromString(src);
  const desc = extractRobotDescription(stage);

  it("re-loaded robot matches the original FK at several poses", () => {
    const { reDesc } = roundTripDesc(desc, stage);
    expectSameFK(desc, reDesc, [
      {},
      { joint1: 0.5, joint2: 0.2 },
      { joint1: -1.2, joint2: 0.45 },
      { joint1: Math.PI / 2, joint2: 0.5 },
    ]);
  });

  it("preserves joints, limits, and meshes across the round-trip", () => {
    const { reDesc } = roundTripDesc(desc, stage);

    expect(Object.keys(reDesc.links).sort()).toEqual(Object.keys(desc.links).sort());
    expect(Object.keys(reDesc.joints).sort()).toEqual(Object.keys(desc.joints).sort());
    for (const [key, joint] of Object.entries(desc.joints)) {
      const re = reDesc.joints[key]!;
      expect(re.type).toBe(joint.type);
      expect(re.parent).toBe(joint.parent);
      expect(re.child).toBe(joint.child);
      if (joint.lower === undefined) expect(re.lower).toBeUndefined();
      else expect(re.lower).toBeCloseTo(joint.lower, 10);
      if (joint.upper === undefined) expect(re.upper).toBeUndefined();
      else expect(re.upper).toBeCloseTo(joint.upper, 10);
      for (let i = 0; i < 16; i++) {
        expect(re.jointFrame0[i]).toBeCloseTo(joint.jointFrame0[i]!, 10);
        expect(re.jointFrame1[i]).toBeCloseTo(joint.jointFrame1[i]!, 10);
      }
    }
    // Meshes rode along (base_link/geom, link1/geom).
    expect(reDesc.links.base_link!.visualPrims).toHaveLength(1);
    expect(reDesc.links.link1!.visualPrims).toHaveLength(1);
  });

  it("writes zero-pose link placements and authored-degree limits", () => {
    const file = exportRobotUsda(desc, { geometry: stageGeometryProvider(stage) });
    const root = file.prims[0]!;
    expect(root.name).toBe("World"); // desc.name from defaultPrim
    expect(file.metadata.defaultPrim).toBe("World");
    expect(file.metadata.upAxis).toBe("Z");

    // link2 zero-pose world position is (0, 0, 2): joint1 offset + joint2 offset.
    const link2Xf = propValue(child(root, "link2"), "xformOp:transform");
    expect(link2Xf).toBeInstanceOf(UsdMatrix);
    const values = (link2Xf as UsdMatrix).values;
    expect(values[12]).toBeCloseTo(0, 12);
    expect(values[13]).toBeCloseTo(0, 12);
    expect(values[14]).toBeCloseTo(2, 12);

    // Limits are re-authored in degrees; bodies point at the exported link paths.
    const joint1 = child(root, "joint1");
    expect(propValue(joint1, "physics:lowerLimit")).toBeCloseTo(-90, 10);
    expect(propValue(joint1, "physics:upperLimit")).toBeCloseTo(90, 10);
    expect(propValue(joint1, "physics:localPos0")).toEqual([0, 0, 1]);
    expect(relTargets(joint1, "physics:body0")).toEqual(["/World/base_link"]);
    expect(relTargets(joint1, "physics:body1")).toEqual(["/World/link1"]);

    // The world-fixed root joint keeps body1 only.
    const rootJoint = child(root, "root_joint");
    expect(relTargets(rootJoint, "physics:body0")).toBeUndefined();
    expect(relTargets(rootJoint, "physics:body1")).toEqual(["/World/base_link"]);

    // No link-level articulation roots in the IR → the container carries it.
    expect(root.metadata.apiSchemas).toEqual(["PhysicsArticulationRootAPI"]);
  });

  it("emits an AST that survives parse(serialize(·)) unchanged", () => {
    const file = exportRobotUsda(desc, { geometry: stageGeometryProvider(stage) });
    const re = parseUsda(serializeUsda(file));
    expect(strip(re)).toEqual(strip(file));
  });
});

/** Drop `line` fields for structural comparison. */
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v instanceof Map) return new Map([...v].map(([k, val]) => [k, strip(val)]));
  if (v && typeof v === "object") {
    if (v.constructor !== Object) return v;
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== "line")
        .map(([k, val]) => [k, strip(val)]),
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Initial pose, drive, and animation
// ---------------------------------------------------------------------------

const POSED_BOT = `#usda 1.0
(
    defaultPrim = "bot"
    metersPerUnit = 1
    upAxis = "Z"
    timeCodesPerSecond = 24
    startTimeCode = 0
    endTimeCode = 48
)

def Xform "bot" (
    prepend apiSchemas = ["PhysicsArticulationRootAPI"]
)
{
    def Xform "base" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def Xform "arm" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </bot/base>
    }

    def PhysicsRevoluteJoint "j1" (
        prepend apiSchemas = ["PhysicsDriveAPI:angular", "PhysicsJointStateAPI:angular"]
    )
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </bot/base>
        rel physics:body1 = </bot/arm>
        point3f physics:localPos0 = (0, 0, 0.5)
        float physics:lowerLimit = -120
        float physics:upperLimit = 120
        float state:angular:physics:position = 30
        float state:angular:physics:position.timeSamples = {
            0: 0,
            24: 45,
            48: 90,
        }
        float drive:angular:physics:targetPosition = 15
        float drive:angular:physics:stiffness = 1000
        float drive:angular:physics:damping = 100
    }
}
`;

describe("exportRobotUsda — joint state, drive, and animation", () => {
  const desc = extractRobotDescription(Stage.OpenFromString(POSED_BOT));

  it("reads a split default + timeSamples statement pair as one attribute", () => {
    // Regression for the Prim-level merge: both opinions must survive.
    expect(desc.joints.j1!.initialValue).toBeCloseTo(Math.PI / 6, 12);
    expect(desc.joints.j1!.valueSamples?.times).toEqual([0, 24, 48]);
  });

  it("authors the initial value as JointState, not baked into link transforms", () => {
    const { text, reDesc } = roundTripDesc(desc);
    const root = parseUsda(text).prims[0]!;

    // The link sits at the zero pose (translation only, identity rotation).
    const xf = propValue(child(root, "arm"), "xformOp:transform") as UsdMatrix;
    const expected = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1];
    for (let i = 0; i < 16; i++) expect(xf.values[i]).toBeCloseTo(expected[i]!, 12);

    // The 30° initial value lives in the joint state (degrees) and re-imports once.
    expect(propValue(child(root, "j1"), "state:angular:physics:position")).toBeCloseTo(30, 10);
    expect(reDesc.joints.j1!.initialValue).toBeCloseTo(Math.PI / 6, 12);
    expect(child(root, "j1").metadata.apiSchemas).toContain("PhysicsJointStateAPI:angular");
  });

  it("round-trips drive parameters and the sampled trajectory", () => {
    const { reDesc } = roundTripDesc(desc);
    const j1 = reDesc.joints.j1!;

    expect(j1.drive?.targetPosition).toBeCloseTo(Math.PI / 12, 12);
    expect(j1.drive?.stiffness).toBe(1000);
    expect(j1.drive?.damping).toBe(100);

    expect(j1.valueSamples?.times).toEqual([0, 24, 48]);
    const expected = [0, Math.PI / 4, Math.PI / 2];
    j1.valueSamples?.values.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 12));

    expect(reDesc.timeCodesPerSecond).toBe(24);
    expect(reDesc.startTimeCode).toBe(0);
    expect(reDesc.endTimeCode).toBe(48);
  });

  it("keeps FK parity including the applied initial pose", () => {
    const { reDesc } = roundTripDesc(desc);
    expectSameFK(desc, reDesc, [{}, { j1: 1.0 }, { j1: -2.0 }]);
  });
});

// ---------------------------------------------------------------------------
// Name sanitization
// ---------------------------------------------------------------------------

describe("exportRobotUsda — naming", () => {
  it("sanitizes invalid prim names and warns", () => {
    const desc = extractRobotDescription(Stage.OpenFromString(POSED_BOT));
    const warnings: string[] = [];
    const file = exportRobotUsda(desc, {
      robotName: "my robot/2",
      onWarn: (m) => warnings.push(m),
    });
    expect(file.prims[0]!.name).toBe("my_robot_2");
    expect(file.metadata.defaultPrim).toBe("my_robot_2");
    // Still parses and re-extracts.
    const reDesc = extractRobotDescription(Stage.OpenFromString(serializeUsda(file)));
    expect(Object.keys(reDesc.links).sort()).toEqual(["arm", "base"]);
  });
});

// ---------------------------------------------------------------------------
// Texture networks (M15)
// ---------------------------------------------------------------------------

const TEXTURED_BOT = `#usda 1.0
(
    defaultPrim = "tex_bot"
    metersPerUnit = 1
    upAxis = "Z"
)

def Xform "tex_bot" (
    prepend apiSchemas = ["PhysicsArticulationRootAPI"]
)
{
    def Xform "base" (
        prepend apiSchemas = ["PhysicsRigidBodyAPI"]
    )
    {
        def Mesh "geom" (
            prepend apiSchemas = ["MaterialBindingAPI"]
        )
        {
            int[] faceVertexCounts = [3]
            int[] faceVertexIndices = [0, 1, 2]
            point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
            texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)] (
                interpolation = "vertex"
            )
            rel material:binding = </tex_bot/Looks/wood>
        }
    }

    def PhysicsFixedJoint "root_joint"
    {
        rel physics:body1 = </tex_bot/base>
    }

    def Scope "Looks"
    {
        def Material "wood"
        {
            token outputs:surface.connect = </tex_bot/Looks/wood/PreviewSurface.outputs:surface>

            def Shader "PreviewSurface"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (0.8, 0.6, 0.4)
                color3f inputs:diffuseColor.connect = </tex_bot/Looks/wood/diffuseTexture.outputs:rgb>
                float inputs:roughness.connect = </tex_bot/Looks/wood/roughTexture.outputs:r>
                token outputs:surface
            }

            def Shader "diffuseTexture"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./textures/wood.png@
                float3 outputs:rgb
            }

            def Shader "roughTexture"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./textures/rough.png@
                float outputs:r
            }
        }
    }
}
`;

describe("exportRobotUsda — texture networks", () => {
  it("carries texture asset paths through the exported UsdPreviewSurface network", async () => {
    const { resolveBoundMaterial } = await import("../src/index.js");
    const stage = Stage.OpenFromString(TEXTURED_BOT);
    const desc = extractRobotDescription(stage);
    const { text, reDesc } = roundTripDesc(desc, stage);

    // The mesh, its UVs, and its binding all survive.
    expect(reDesc.links.base!.visualPrims).toHaveLength(1);
    const stage2 = Stage.OpenFromString(text);
    const meshPrim = stage2.GetPrimAtPath("/tex_bot/base/geom");
    expect(meshPrim).not.toBeNull();

    const bound = resolveBoundMaterial(stage2, meshPrim!);
    expect(bound?.color).toEqual([0.8, 0.6, 0.4]);
    expect(bound?.colorTexture?.path).toBe("./textures/wood.png");
    expect(bound?.roughnessTexture?.path).toBe("./textures/rough.png");
  });
});

// ---------------------------------------------------------------------------
// Real-asset integration (skipped when the crate asset is absent)
// ---------------------------------------------------------------------------

const TOROBO = new URL("../data/torobo2_standard_planar_move.usd", import.meta.url);
const toroboPresent = existsSync(TOROBO);

describe.skipIf(!toroboPresent)("exportRobotUsda — torobo2 integration", () => {
  it("round-trips the full robot with FK parity", () => {
    const bytes = new Uint8Array(readFileSync(TOROBO));
    const stage = Stage.OpenFromFile(crateToUsdaFile(new CrateReader(bytes)));
    const desc = extractRobotDescription(stage);
    const { reDesc } = roundTripDesc(desc, stage);

    expect(Object.keys(reDesc.links).sort()).toEqual(Object.keys(desc.links).sort());
    expect(Object.keys(reDesc.joints).sort()).toEqual(Object.keys(desc.joints).sort());

    // Zero pose + a mid-range pose over every articulated joint.
    const pose: Record<string, number> = {};
    for (const [key, joint] of Object.entries(desc.joints)) {
      if (joint.type === "fixed") continue;
      const lo = joint.lower ?? -0.5;
      const hi = joint.upper ?? 0.5;
      pose[key] = lo + (hi - lo) * 0.37;
    }
    expectSameFK(desc, reDesc, [{}, pose]);
  });
});
