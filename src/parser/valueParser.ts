/**
 * Parses USDA value literals from a token stream and coerces them into the
 * typed {@link UsdValue} model (tuples → `Vec*`, `(w,x,y,z)` → {@link Quat},
 * nested tuples → {@link UsdMatrix}, etc.).
 */

import {
  AssetPath,
  Quat,
  type SdfPath,
  UsdMatrix,
  type UsdValue,
  type Vec2,
  type Vec3,
  type Vec4,
} from "./ast.js";
import type { TokenReader } from "./reader.js";

/** Untyped literal as parsed from tokens, before type-name coercion. */
export type RawValue =
  | { t: "scalar"; v: number | boolean | string | null }
  | { t: "asset"; v: AssetPath }
  | { t: "path"; v: SdfPath }
  | { t: "tuple"; items: RawValue[] }
  | { t: "array"; items: RawValue[] };

/** Parse one literal (scalar, tuple `( )`, array `[ ]`, asset, or path). */
export function parseLiteral(r: TokenReader): RawValue {
  const t = r.peek();
  switch (t.type) {
    case "number":
      r.next();
      return { t: "scalar", v: t.num ?? Number(t.value) };
    case "string":
      r.next();
      return { t: "scalar", v: t.value };
    case "asset":
      r.next();
      return { t: "asset", v: new AssetPath(t.value) };
    case "path":
      r.next();
      return { t: "path", v: t.value };
    case "ident": {
      r.next();
      if (t.value === "true") return { t: "scalar", v: true };
      if (t.value === "false") return { t: "scalar", v: false };
      if (t.value === "None" || t.value === "none") return { t: "scalar", v: null };
      // Bare identifier value (rare; e.g. a token authored unquoted).
      return { t: "scalar", v: t.value };
    }
    case "lparen":
      return parseGroup(r, "lparen", "rparen", "tuple");
    case "lbracket":
      return parseGroup(r, "lbracket", "rbracket", "array");
    default:
      throw r.error(`unexpected token ${t.type} ${JSON.stringify(t.value)} while parsing a value`);
  }
}

function parseGroup(
  r: TokenReader,
  open: "lparen" | "lbracket",
  close: "rparen" | "rbracket",
  kind: "tuple" | "array",
): RawValue {
  r.expect(open);
  const items: RawValue[] = [];
  while (!r.is(close) && !r.atEnd()) {
    items.push(parseLiteral(r));
    if (!r.accept("comma")) break;
  }
  r.expect(close);
  return { t: kind, items };
}

/** Parse a literal and coerce it to the declared USD type. */
export function parseTypedValue(r: TokenReader, typeName: string, isArray: boolean): UsdValue {
  return coerceValue(typeName, isArray, parseLiteral(r));
}

/** Coerce a raw literal into a {@link UsdValue} for the given declared type. */
export function coerceValue(typeName: string, isArray: boolean, raw: RawValue): UsdValue {
  if (raw.t === "scalar" && raw.v === null) return null; // `None`

  if (isArray) {
    if (raw.t !== "array") {
      throw new TypeError(`expected an array literal for ${typeName}[] but got ${raw.t}`);
    }
    return raw.items.map((item) => coerceScalar(typeName, item));
  }
  return coerceScalar(typeName, raw);
}

function coerceScalar(typeName: string, raw: RawValue): UsdValue {
  // Quaternions: (real, i, j, k)
  if (QUAT_TYPES.has(typeName)) {
    const nums = expectNumberTuple(raw, 4, typeName);
    return new Quat(nums[0]!, [nums[1]!, nums[2]!, nums[3]!]);
  }
  // Matrices: tuple of row tuples → flat row-major.
  if (typeName === "matrix4d" || typeName === "matrix4f" || typeName === "frame4d") {
    return flattenMatrix(raw, 4, typeName);
  }
  if (typeName === "matrix3d" || typeName === "matrix3f") {
    return flattenMatrix(raw, 3, typeName);
  }
  // Fixed-width numeric vectors.
  const dim = VEC_DIM[typeName];
  if (dim !== undefined) {
    const nums = expectNumberTuple(raw, dim, typeName);
    return nums as Vec2 | Vec3 | Vec4;
  }
  // Asset paths.
  if (typeName === "asset") {
    if (raw.t === "asset") return raw.v;
    if (raw.t === "scalar" && typeof raw.v === "string") return new AssetPath(raw.v);
    throw new TypeError(`expected an asset path for ${typeName}`);
  }
  // Path-valued (rare as attribute, used for connections/relationship targets).
  if (raw.t === "path") return raw.v;

  // Scalars: bool / ints / floats / string / token.
  if (raw.t !== "scalar") {
    // A tuple/array reached a scalar slot — surface the raw numbers so callers
    // can still inspect it rather than silently dropping data.
    if (raw.t === "tuple") return raw.items.map((it) => coerceScalar(typeName, it));
    throw new TypeError(`expected a scalar for ${typeName} but got ${raw.t}`);
  }
  const v = raw.v;
  if (typeName === "bool") {
    if (typeof v === "boolean") return v;
    if (v === 1 || v === 0) return v === 1;
  }
  return v;
}

function expectNumberTuple(raw: RawValue, dim: number, typeName: string): number[] {
  if (raw.t !== "tuple") {
    throw new TypeError(`expected a ${dim}-tuple for ${typeName} but got ${raw.t}`);
  }
  if (raw.items.length !== dim) {
    throw new TypeError(`expected ${dim} components for ${typeName} but got ${raw.items.length}`);
  }
  return raw.items.map((it) => {
    if (it.t !== "scalar" || typeof it.v !== "number") {
      throw new TypeError(`expected a number component for ${typeName}`);
    }
    return it.v;
  });
}

function flattenMatrix(raw: RawValue, dim: 3 | 4, typeName: string): UsdMatrix {
  if (raw.t !== "tuple" || raw.items.length !== dim) {
    throw new TypeError(`expected ${dim} rows for ${typeName}`);
  }
  const values: number[] = [];
  for (const row of raw.items) {
    values.push(...expectNumberTuple(row, dim, typeName));
  }
  return new UsdMatrix(values, dim);
}

/** Coerce a raw literal without a declared type (used for metadata values). */
export function rawToUsdValue(raw: RawValue): UsdValue {
  switch (raw.t) {
    case "scalar":
      return raw.v;
    case "asset":
      return raw.v;
    case "path":
      return raw.v;
    case "tuple":
    case "array":
      return raw.items.map(rawToUsdValue);
  }
}

const QUAT_TYPES = new Set(["quatf", "quatd", "quath"]);

const VEC_DIM: Record<string, 2 | 3 | 4> = {
  float2: 2,
  double2: 2,
  half2: 2,
  int2: 2,
  texCoord2f: 2,
  texCoord2d: 2,
  texCoord2h: 2,
  float3: 3,
  double3: 3,
  half3: 3,
  int3: 3,
  point3f: 3,
  point3d: 3,
  point3h: 3,
  normal3f: 3,
  normal3d: 3,
  normal3h: 3,
  vector3f: 3,
  vector3d: 3,
  vector3h: 3,
  color3f: 3,
  color3d: 3,
  color3h: 3,
  texCoord3f: 3,
  float4: 4,
  double4: 4,
  half4: 4,
  int4: 4,
  color4f: 4,
  color4d: 4,
  color4h: 4,
};
