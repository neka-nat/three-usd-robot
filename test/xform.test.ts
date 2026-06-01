import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEG2RAD,
  type Mat4,
  Stage,
  UsdMatrix,
  type Vec3,
  computeLocalTransform,
  fromUsdMatrix,
  getTranslation,
  identity4,
  invert,
  makeRotationX,
  makeRotationZ,
  makeTranslation,
  multiply,
  parseOpType,
} from "../src/core.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

/** Apply a column-major Mat4 to a point (w = 1). */
function transformPoint(m: Mat4, [x, y, z]: Vec3): Vec3 {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

function expectMatClose(a: Mat4, b: Mat4, digits = 9): void {
  expect(a).toHaveLength(16);
  for (let i = 0; i < 16; i++) expect(a[i]!).toBeCloseTo(b[i]!, digits);
}

/** Build a single prim from its xform ops and return it. */
function primWithOps(body: string) {
  const stage = Stage.OpenFromString(`#usda 1.0\ndef Xform "X"\n{\n${body}\n}\n`);
  const prim = stage.GetPrimAtPath("/X");
  if (!prim) throw new Error("missing prim");
  return prim;
}

describe("transforms — primitives", () => {
  it("multiply by identity is a no-op", () => {
    const m = makeTranslation([1, 2, 3]);
    expect(multiply(identity4(), m)).toEqual(m);
    expect(multiply(m, identity4())).toEqual(m);
  });

  it("invert undoes a transform", () => {
    const m = multiply(makeTranslation([3, -2, 5]), makeRotationZ(0.7));
    expectMatClose(multiply(m, invert(m)), identity4());
  });

  it("rotateZ(+90°) maps +X to +Y (right-handed)", () => {
    const out = transformPoint(makeRotationZ(90 * DEG2RAD), [1, 0, 0]);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
    expect(out[2]).toBeCloseTo(0);
  });

  it("fromUsdMatrix: USD row-major translation maps to Three.js column-major", () => {
    // Last row carries translation in USD's row-major layout.
    // biome-ignore format: matrix layout
    const usd = new UsdMatrix([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      3, 4, 5, 1,
    ], 4);
    expect(getTranslation(fromUsdMatrix(usd))).toEqual([3, 4, 5]);
  });
});

describe("parseOpType", () => {
  it("extracts the op type and ignores suffixes", () => {
    expect(parseOpType("xformOp:translate")).toBe("translate");
    expect(parseOpType("xformOp:translate:pivot")).toBe("translate");
    expect(parseOpType("xformOp:rotateXYZ")).toBe("rotateXYZ");
    expect(parseOpType("xformOp:orient")).toBe("orient");
  });
});

describe("computeLocalTransform — ordering", () => {
  it("returns identity when no xformOpOrder is authored", () => {
    const prim = primWithOps("float3 xformOp:translate = (9, 9, 9)");
    expect(computeLocalTransform(prim).matrix).toEqual(identity4());
  });

  it("applies the last-listed op first (scale before translate)", () => {
    const prim = primWithOps(
      "float3 xformOp:translate = (10, 0, 0)\n" +
        "float3 xformOp:scale = (2, 3, 4)\n" +
        'uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:scale"]',
    );
    // scale first: (1,1,1)->(2,3,4); then translate: ->(12,3,4)
    const p = transformPoint(computeLocalTransform(prim).matrix, [1, 1, 1]);
    expect(p[0]).toBeCloseTo(12);
    expect(p[1]).toBeCloseTo(3);
    expect(p[2]).toBeCloseTo(4);
  });

  it("honors the !invert! op prefix", () => {
    const prim = primWithOps(
      "float3 xformOp:translate = (1, 2, 3)\n" +
        'uniform token[] xformOpOrder = ["!invert!xformOp:translate"]',
    );
    expect(getTranslation(computeLocalTransform(prim).matrix)).toEqual([-1, -2, -3]);
  });

  it("honors !resetXformStack!", () => {
    const prim = primWithOps(
      "float3 xformOp:translate = (1, 0, 0)\n" +
        'uniform token[] xformOpOrder = ["!resetXformStack!", "xformOp:translate"]',
    );
    const r = computeLocalTransform(prim);
    expect(r.resetsXformStack).toBe(true);
    expect(getTranslation(r.matrix)).toEqual([1, 0, 0]);
  });
});

describe("computeLocalTransform — rotation ops", () => {
  it("rotateXYZ=(90,0,0) equals a single rotateX", () => {
    const prim = primWithOps(
      "float3 xformOp:rotateXYZ = (90, 0, 0)\n" +
        'uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]',
    );
    expectMatClose(computeLocalTransform(prim).matrix, makeRotationX(90 * DEG2RAD));
  });

  it("rotateXYZ composes as Rz·Ry·Rx (X applied first)", () => {
    const prim = primWithOps(
      "float3 xformOp:rotateXYZ = (90, 0, 90)\n" +
        'uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]',
    );
    const expected = multiply(makeRotationZ(90 * DEG2RAD), makeRotationX(90 * DEG2RAD));
    expectMatClose(computeLocalTransform(prim).matrix, expected);
  });

  it("orient quaternion is applied as a rotation", () => {
    // 90° about Z as a quat: (w, x, y, z) = (cos45, 0, 0, sin45)
    const h = Math.SQRT1_2;
    const prim = primWithOps(
      `quatf xformOp:orient = (${h}, 0, 0, ${h})\nuniform token[] xformOpOrder = ["xformOp:orient"]`,
    );
    const out = transformPoint(computeLocalTransform(prim).matrix, [1, 0, 0]);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(1);
  });
});

describe("computeLocalTransform — test asset", () => {
  const stage = Stage.OpenFromString(ARM);

  it("link1 TRS reduces to a pure +Z translation", () => {
    const link1 = stage.GetPrimAtPath("/World/link1")!;
    const r = computeLocalTransform(link1);
    expectMatClose(r.matrix, makeTranslation([0, 0, 1]));
  });

  it("link2 matrix4d transform yields its authored translation", () => {
    const link2 = stage.GetPrimAtPath("/World/link2")!;
    expect(getTranslation(computeLocalTransform(link2).matrix)).toEqual([0, 0, 1]);
  });

  it("base_link with zero translate is identity", () => {
    const base = stage.GetPrimAtPath("/World/base_link")!;
    expect(computeLocalTransform(base).matrix).toEqual(identity4());
  });
});
