import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AssetPath,
  ParseError,
  Quat,
  Stage,
  TokenizeError,
  UsdMatrix,
  type Vec3,
  parseUsda,
  tokenize,
} from "../src/core.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

describe("tokenize", () => {
  it("scans paths, assets, numbers, strings and namespaced idents", () => {
    const tokens = tokenize(
      "rel physics:body0 = </World/link0>\nasset a = @./m.usd@\nfloat x = -1.5e-2",
    );
    const types = tokens.map((t) => t.type);
    expect(types).toContain("path");
    expect(types).toContain("asset");
    expect(tokens.find((t) => t.type === "path")?.value).toBe("/World/link0");
    expect(tokens.find((t) => t.type === "asset")?.value).toBe("./m.usd");
    const num = tokens.find((t) => t.type === "number" && t.value.includes("e"));
    expect(num?.num).toBeCloseTo(-0.015);
  });

  it("parses inf / -inf / nan numbers", () => {
    const t = tokenize("a = inf\nb = -inf\nc = nan");
    const nums = t.filter((x) => x.type === "number").map((x) => x.num);
    expect(nums[0]).toBe(Number.POSITIVE_INFINITY);
    expect(nums[1]).toBe(Number.NEGATIVE_INFINITY);
    expect(Number.isNaN(nums[2] as number)).toBe(true);
  });
});

describe("parseUsda — AST", () => {
  it("reads the magic version and layer metadata", () => {
    const file = parseUsda(ARM);
    expect(file.version).toBe("1.0");
    expect(file.metadata.defaultPrim).toBe("World");
    expect(file.metadata.upAxis).toBe("Z");
    expect(file.metadata.metersPerUnit).toBe(1);
    expect(file.metadata.doc).toMatch(/two-link arm/);
    expect(file.prims).toHaveLength(1);
  });

  it("coerces an asset-path metadatum", () => {
    const file = parseUsda('def "X" (\n  assetInfo = { asset identifier = @./x.usd@ }\n)\n{\n}');
    expect(file.prims[0]?.name).toBe("X");
  });
});

describe("Stage / Prim API (pxr-conformant shape)", () => {
  let stage: Stage;
  beforeAll(() => {
    stage = Stage.OpenFromString(ARM);
  });

  it("exposes stage metadata helpers", () => {
    expect(stage.GetUpAxis()).toBe("Z");
    expect(stage.GetMetersPerUnit()).toBe(1);
    expect(stage.GetDefaultPrim()?.GetName()).toBe("World");
  });

  it("resolves prims by absolute path", () => {
    const world = stage.GetPrimAtPath("/World");
    expect(world?.GetTypeName()).toBe("Xform");
    expect(stage.GetPrimAtPath("/World/Looks")?.GetTypeName()).toBe("Scope");
    expect(stage.GetPrimAtPath("/nope")).toBeNull();
  });

  it("builds the prim hierarchy", () => {
    const world = stage.GetPrimAtPath("/World");
    expect(world?.GetChildren().map((p) => p.GetName())).toEqual([
      "Looks",
      "base_link",
      "link1",
      "link2",
      "root_joint",
      "joint1",
      "joint2",
    ]);
    expect(stage.GetPrimAtPath("/World/base_link/geom")?.GetParent()?.GetName()).toBe("base_link");
    // Pseudo-root + depth-first traversal count.
    expect(stage.GetPseudoRoot().IsPseudoRoot()).toBe(true);
    expect(stage.Traverse()).toHaveLength(10);
  });

  it("reads applied API schemas", () => {
    const world = stage.GetPrimAtPath("/World");
    expect(world?.GetAppliedSchemas()).toContain("PhysicsArticulationRootAPI");
    expect(world?.HasAPI("PhysicsArticulationRootAPI")).toBe(true);
    expect(world?.HasAPI("PhysicsRigidBodyAPI")).toBe(false);
    expect(stage.GetPrimAtPath("/World/base_link")?.HasAPI("PhysicsRigidBodyAPI")).toBe(true);
  });
});

describe("Attribute values & coercion", () => {
  const stage = Stage.OpenFromString(ARM);

  it("coerces float3 and token[] arrays", () => {
    const base = stage.GetPrimAtPath("/World/base_link");
    expect(base?.GetAttribute("xformOp:translate").Get()).toEqual([0, 0, 0]);

    const order = base?.GetAttribute("xformOpOrder");
    expect(order?.IsArray()).toBe(true);
    expect(order?.GetVariability()).toBe("uniform");
    expect(order?.Get()).toEqual(["xformOp:translate"]);
  });

  it("coerces quatf as (real, imaginary)", () => {
    const orient = stage.GetPrimAtPath("/World/link1")?.GetAttribute("xformOp:orient").Get();
    expect(orient).toBeInstanceOf(Quat);
    const q = orient as Quat;
    expect(q.real).toBe(1);
    expect(q.imaginary).toEqual([0, 0, 0]);
    expect(q.toXYZW()).toEqual([0, 0, 0, 1]); // Three.js order
  });

  it("coerces matrix4d flat in row-major order", () => {
    const m = stage.GetPrimAtPath("/World/link2")?.GetAttribute("xformOp:transform").Get();
    expect(m).toBeInstanceOf(UsdMatrix);
    const mat = m as UsdMatrix;
    expect(mat.dim).toBe(4);
    expect(mat.values).toHaveLength(16);
    // Last row carries the translation (z = 1) in USD's row-major layout.
    expect(mat.values.slice(12)).toEqual([0, 0, 1, 1]);
  });

  it("coerces mesh point/index arrays", () => {
    const geom = stage.GetPrimAtPath("/World/base_link/geom");
    expect(geom?.GetAttribute("faceVertexCounts").Get()).toEqual([3, 3]);
    expect(geom?.GetAttribute("faceVertexIndices").Get()).toEqual([0, 1, 2, 0, 2, 3]);
    const points = geom?.GetAttribute("points").Get() as Vec3[];
    expect(points).toHaveLength(4);
    expect(points[1]).toEqual([1, 0, 0]);
  });

  it("splits namespaced attribute names", () => {
    const axis = stage.GetPrimAtPath("/World/joint1")?.GetAttribute("physics:axis");
    expect(axis?.GetNamespace()).toBe("physics");
    expect(axis?.GetBaseName()).toBe("axis");
    expect(axis?.Get()).toBe("Z"); // token kept as string
    expect(axis?.GetVariability()).toBe("uniform");
  });

  it("returns an invalid attribute for missing names", () => {
    const missing = stage.GetPrimAtPath("/World")?.GetAttribute("nope");
    expect(missing?.IsValid()).toBe(false);
    expect(missing?.HasValue()).toBe(false);
    expect(missing?.Get()).toBeUndefined();
  });
});

describe("Physics joints & relationships", () => {
  const stage = Stage.OpenFromString(ARM);

  it("reads revolute joint axis and degree limits verbatim", () => {
    const j = stage.GetPrimAtPath("/World/joint1");
    expect(j?.GetTypeName()).toBe("PhysicsRevoluteJoint");
    expect(j?.GetAttribute("physics:axis").Get()).toBe("Z");
    // Limits are still in degrees here — SI normalization happens in M3.
    expect(j?.GetAttribute("physics:lowerLimit").Get()).toBe(-90);
    expect(j?.GetAttribute("physics:upperLimit").Get()).toBe(90);
    expect(j?.GetAttribute("physics:localRot0").Get()).toBeInstanceOf(Quat);
  });

  it("reads relationship targets", () => {
    const j = stage.GetPrimAtPath("/World/joint1");
    expect(j?.GetRelationship("physics:body0").GetTargets()).toEqual(["/World/base_link"]);
    expect(j?.GetRelationship("physics:body1").GetTargets()).toEqual(["/World/link1"]);
  });

  it("treats a missing body0 (world-fixed) as an invalid relationship", () => {
    const root = stage.GetPrimAtPath("/World/root_joint");
    expect(root?.HasRelationship("physics:body0")).toBe(false);
    expect(root?.GetRelationship("physics:body0").IsValid()).toBe(false);
    expect(root?.GetRelationship("physics:body1").GetTargets()).toEqual(["/World/base_link"]);
  });
});

describe("error reporting", () => {
  it("throws ParseError with a line number for malformed prims", () => {
    let err: unknown;
    try {
      parseUsda("#usda 1.0\ndef Xform {\n}");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).line).toBe(2);
  });

  it("throws TokenizeError on an unterminated string", () => {
    expect(() => tokenize('def Xform "x" {\n  string s = "oops\n}')).toThrow(TokenizeError);
  });
});

// Keep an explicit reference so unused-import lint stays honest about exports.
describe("exports", () => {
  it("exposes AssetPath", () => {
    expect(new AssetPath("/x").path).toBe("/x");
  });
});
