/**
 * Resolves a prim's `xformOpOrder` into a single local transform matrix.
 *
 * Supports `translate`, `scale`, `orient` (quat), `transform` (matrix4d),
 * single-axis `rotateX|Y|Z`, and the six `rotate<ORDER>` Euler ops, plus the
 * `!invert!` op prefix and the `!resetXformStack!` sentinel. Rotation op values
 * are in degrees and converted to radians here.
 */

import {
  DEG2RAD,
  type Mat4,
  fromUsdMatrix,
  identity4,
  invert,
  makeEuler,
  makeRotationFromQuat,
  makeRotationX,
  makeRotationY,
  makeRotationZ,
  makeScale,
  makeTranslation,
  multiply,
} from "../kinematics/transforms.js";
import type { Quat, UsdMatrix, UsdValue, Vec3 } from "../parser/ast.js";
import type { Prim } from "./Prim.js";

const INVERT_PREFIX = "!invert!";
const RESET_STACK = "!resetXformStack!";
const ROTATE_ORDERS = new Set([
  "rotateXYZ",
  "rotateXZY",
  "rotateYXZ",
  "rotateYZX",
  "rotateZXY",
  "rotateZYX",
]);

export type ResolvedXform = {
  /** Local-to-parent transform (column-major {@link Mat4}). */
  matrix: Mat4;
  /**
   * True if `xformOpOrder` began with `!resetXformStack!`, meaning this prim
   * does not inherit its parent's transform. Honored by FK in M5.
   */
  resetsXformStack: boolean;
};

/**
 * Compute a prim's local transform from its `xformOpOrder`. Returns identity
 * when the prim authors no `xformOpOrder`.
 */
/**
 * Accumulated transform from the stage root down to `prim` — the prim's world
 * placement as authored (`UsdGeomXformCache::GetLocalToWorldTransform`-like).
 */
export function computeWorldTransform(prim: Prim): Mat4 {
  const chain: Prim[] = [];
  for (let p: Prim | null = prim; p && !p.IsPseudoRoot(); p = p.GetParent()) chain.push(p);
  let m = identity4();
  for (let i = chain.length - 1; i >= 0; i--) {
    m = multiply(m, computeLocalTransform(chain[i]!).matrix);
  }
  return m;
}

export function computeLocalTransform(prim: Prim): ResolvedXform {
  const orderAttr = prim.GetAttribute("xformOpOrder");
  const order = orderAttr.Get();
  if (!Array.isArray(order)) {
    return { matrix: identity4(), resetsXformStack: false };
  }

  let matrix = identity4();
  let resetsXformStack = false;

  for (const entry of order) {
    if (typeof entry !== "string") continue;
    if (entry === RESET_STACK) {
      resetsXformStack = true;
      continue;
    }

    let opName = entry;
    let doInvert = false;
    if (opName.startsWith(INVERT_PREFIX)) {
      doInvert = true;
      opName = opName.slice(INVERT_PREFIX.length);
    }

    // A listed op with no authored attribute is malformed, but shipped assets
    // do contain it (an op removed while the order was left behind). USD treats
    // the op as identity rather than failing the whole stage, so do the same.
    const attr = prim.GetAttribute(opName);
    if (!attr.IsValid()) continue;

    // No resolvable value (e.g. time-sampled only — M10 reads defaults) → identity.
    const opValue = attr.Get();
    if (opValue === undefined) continue;

    let opMatrix = opMatrixFor(parseOpType(opName), opValue, `${prim.GetPath()}.${opName}`);
    if (doInvert) opMatrix = invert(opMatrix);
    // Post-multiply in list order: M = op0 · op1 · … so the LAST-listed op is
    // applied first to the geometry (innermost). For [translate, orient, scale]
    // this yields the usual scale-then-rotate-then-translate.
    matrix = multiply(matrix, opMatrix);
  }

  return { matrix, resetsXformStack };
}

/** Extract the op type token from an op attribute name (`xformOp:translate:pivot` → `translate`). */
export function parseOpType(opName: string): string {
  const body = opName.startsWith("xformOp:") ? opName.slice("xformOp:".length) : opName;
  return body.split(":")[0] ?? body;
}

function opMatrixFor(opType: string, value: UsdValue | undefined, where: string): Mat4 {
  switch (opType) {
    case "translate":
      return makeTranslation(asVec3(value, where));
    case "scale":
      return makeScale(asVec3(value, where));
    case "orient":
      return makeRotationFromQuat(asQuat(value, where));
    case "transform":
      return fromUsdMatrix(asMatrix(value, where));
    case "rotateX":
      return makeRotationX(asNumber(value, where) * DEG2RAD);
    case "rotateY":
      return makeRotationY(asNumber(value, where) * DEG2RAD);
    case "rotateZ":
      return makeRotationZ(asNumber(value, where) * DEG2RAD);
    default:
      if (ROTATE_ORDERS.has(opType)) {
        const [x, y, z] = asVec3(value, where);
        return makeEuler([x * DEG2RAD, y * DEG2RAD, z * DEG2RAD], opType.slice("rotate".length));
      }
      throw new Error(`${where}: unsupported xformOp type "${opType}"`);
  }
}

function asVec3(v: UsdValue | undefined, where: string): Vec3 {
  if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number")) {
    return v as Vec3;
  }
  throw new Error(`${where}: expected a 3-component value`);
}

function asNumber(v: UsdValue | undefined, where: string): number {
  if (typeof v === "number") return v;
  throw new Error(`${where}: expected a number`);
}

function asQuat(v: UsdValue | undefined, where: string): Quat {
  if (v && typeof v === "object" && "real" in v && "imaginary" in v) return v as Quat;
  throw new Error(`${where}: expected a quaternion`);
}

function asMatrix(v: UsdValue | undefined, where: string): UsdMatrix {
  if (v && typeof v === "object" && "values" in v && "dim" in v) return v as UsdMatrix;
  throw new Error(`${where}: expected a matrix`);
}
