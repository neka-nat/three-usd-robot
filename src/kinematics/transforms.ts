/**
 * Minimal 4×4 matrix math, Three.js-independent.
 *
 * ## Convention
 *
 * A {@link Mat4} is a flat 16-element array in **column-major** order — the
 * exact layout of `THREE.Matrix4.elements`, so a `Mat4` can be handed to
 * `matrix4.fromArray(m)` with no transposition. Transforms use the
 * column-vector convention `v' = M · v`; the translation lives at indices
 * `[12, 13, 14]`.
 *
 * Conveniently, OpenUSD stores `GfMatrix4d` **row-major** with a row-vector
 * convention (`v' = v · M`). The two raw 16-number arrays for the *same*
 * transform are therefore bit-identical, which is why {@link fromUsdMatrix} is
 * a plain copy. See the module test for a worked example.
 */

import type { Quat, UsdMatrix, Vec3 } from "../parser/ast.js";

/** Column-major 4×4 matrix (Three.js `elements` layout). */
export type Mat4 = number[];

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function identity4(): Mat4 {
  // biome-ignore format: matrix layout
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

/** Matrix product `a · b` (column-major), matching `THREE.Matrix4.multiplyMatrices`. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const a11 = a[0]!,
    a21 = a[1]!,
    a31 = a[2]!,
    a41 = a[3]!;
  const a12 = a[4]!,
    a22 = a[5]!,
    a32 = a[6]!,
    a42 = a[7]!;
  const a13 = a[8]!,
    a23 = a[9]!,
    a33 = a[10]!,
    a43 = a[11]!;
  const a14 = a[12]!,
    a24 = a[13]!,
    a34 = a[14]!,
    a44 = a[15]!;

  const b11 = b[0]!,
    b21 = b[1]!,
    b31 = b[2]!,
    b41 = b[3]!;
  const b12 = b[4]!,
    b22 = b[5]!,
    b32 = b[6]!,
    b42 = b[7]!;
  const b13 = b[8]!,
    b23 = b[9]!,
    b33 = b[10]!,
    b43 = b[11]!;
  const b14 = b[12]!,
    b24 = b[13]!,
    b34 = b[14]!,
    b44 = b[15]!;

  return [
    a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41,
    a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41,
    a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41,
    a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41,

    a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42,
    a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42,
    a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42,
    a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42,

    a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43,
    a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43,
    a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43,
    a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43,

    a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44,
    a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44,
    a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44,
    a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44,
  ];
}

/** Product of a list of matrices, left-to-right (`m[0] · m[1] · …`). */
export function multiplyAll(matrices: Mat4[]): Mat4 {
  let m = identity4();
  for (const next of matrices) m = multiply(m, next);
  return m;
}

/** Inverse (column-major), matching `THREE.Matrix4.invert`. Throws if singular. */
export function invert(m: Mat4): Mat4 {
  const n11 = m[0]!,
    n21 = m[1]!,
    n31 = m[2]!,
    n41 = m[3]!;
  const n12 = m[4]!,
    n22 = m[5]!,
    n32 = m[6]!,
    n42 = m[7]!;
  const n13 = m[8]!,
    n23 = m[9]!,
    n33 = m[10]!,
    n43 = m[11]!;
  const n14 = m[12]!,
    n24 = m[13]!,
    n34 = m[14]!,
    n44 = m[15]!;

  const t11 =
    n23 * n34 * n42 -
    n24 * n33 * n42 +
    n24 * n32 * n43 -
    n22 * n34 * n43 -
    n23 * n32 * n44 +
    n22 * n33 * n44;
  const t12 =
    n14 * n33 * n42 -
    n13 * n34 * n42 -
    n14 * n32 * n43 +
    n12 * n34 * n43 +
    n13 * n32 * n44 -
    n12 * n33 * n44;
  const t13 =
    n13 * n24 * n42 -
    n14 * n23 * n42 +
    n14 * n22 * n43 -
    n12 * n24 * n43 -
    n13 * n22 * n44 +
    n12 * n23 * n44;
  const t14 =
    n14 * n23 * n32 -
    n13 * n24 * n32 -
    n14 * n22 * n33 +
    n12 * n24 * n33 +
    n13 * n22 * n34 -
    n12 * n23 * n34;

  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (det === 0) throw new Error("cannot invert a singular matrix");
  const idet = 1 / det;

  return [
    t11 * idet,
    (n24 * n33 * n41 -
      n23 * n34 * n41 -
      n24 * n31 * n43 +
      n21 * n34 * n43 +
      n23 * n31 * n44 -
      n21 * n33 * n44) *
      idet,
    (n22 * n34 * n41 -
      n24 * n32 * n41 +
      n24 * n31 * n42 -
      n21 * n34 * n42 -
      n22 * n31 * n44 +
      n21 * n32 * n44) *
      idet,
    (n23 * n32 * n41 -
      n22 * n33 * n41 -
      n23 * n31 * n42 +
      n21 * n33 * n42 +
      n22 * n31 * n43 -
      n21 * n32 * n43) *
      idet,

    t12 * idet,
    (n13 * n34 * n41 -
      n14 * n33 * n41 +
      n14 * n31 * n43 -
      n11 * n34 * n43 -
      n13 * n31 * n44 +
      n11 * n33 * n44) *
      idet,
    (n14 * n32 * n41 -
      n12 * n34 * n41 -
      n14 * n31 * n42 +
      n11 * n34 * n42 +
      n12 * n31 * n44 -
      n11 * n32 * n44) *
      idet,
    (n12 * n33 * n41 -
      n13 * n32 * n41 +
      n13 * n31 * n42 -
      n11 * n33 * n42 -
      n12 * n31 * n43 +
      n11 * n32 * n43) *
      idet,

    t13 * idet,
    (n14 * n23 * n41 -
      n13 * n24 * n41 -
      n14 * n21 * n43 +
      n11 * n24 * n43 +
      n13 * n21 * n44 -
      n11 * n23 * n44) *
      idet,
    (n12 * n24 * n41 -
      n14 * n22 * n41 +
      n14 * n21 * n42 -
      n11 * n24 * n42 -
      n12 * n21 * n44 +
      n11 * n22 * n44) *
      idet,
    (n13 * n22 * n41 -
      n12 * n23 * n41 -
      n13 * n21 * n42 +
      n11 * n23 * n42 +
      n12 * n21 * n43 -
      n11 * n22 * n43) *
      idet,

    t14 * idet,
    (n13 * n24 * n31 -
      n14 * n23 * n31 +
      n14 * n21 * n33 -
      n11 * n24 * n33 -
      n13 * n21 * n34 +
      n11 * n23 * n34) *
      idet,
    (n14 * n22 * n31 -
      n12 * n24 * n31 -
      n14 * n21 * n32 +
      n11 * n24 * n32 +
      n12 * n21 * n34 -
      n11 * n22 * n34) *
      idet,
    (n12 * n23 * n31 -
      n13 * n22 * n31 +
      n13 * n21 * n32 -
      n11 * n23 * n32 -
      n12 * n21 * n33 +
      n11 * n22 * n33) *
      idet,
  ];
}

export function makeTranslation([x, y, z]: Vec3): Mat4 {
  // biome-ignore format: matrix layout
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, y, z, 1,
  ];
}

export function makeScale([x, y, z]: Vec3): Mat4 {
  // biome-ignore format: matrix layout
  return [
    x, 0, 0, 0,
    0, y, 0, 0,
    0, 0, z, 0,
    0, 0, 0, 1,
  ];
}

export function makeRotationX(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // biome-ignore format: matrix layout
  return [
    1, 0, 0, 0,
    0, c, s, 0,
    0, -s, c, 0,
    0, 0, 0, 1,
  ];
}

export function makeRotationY(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // biome-ignore format: matrix layout
  return [
    c, 0, -s, 0,
    0, 1, 0, 0,
    s, 0, c, 0,
    0, 0, 0, 1,
  ];
}

export function makeRotationZ(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  // biome-ignore format: matrix layout
  return [
    c, s, 0, 0,
    -s, c, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}

/** Rotation matrix from a (normalized) quaternion, matching `THREE.Matrix4.compose`. */
export function makeRotationFromQuat(q: Quat): Mat4 {
  let x = q.imaginary[0];
  let y = q.imaginary[1];
  let z = q.imaginary[2];
  let w = q.real;
  const len = Math.hypot(x, y, z, w);
  if (len > 0 && Math.abs(len - 1) > 1e-9) {
    x /= len;
    y /= len;
    z /= len;
    w /= len;
  }

  const x2 = x + x,
    y2 = y + y,
    z2 = z + z;
  const xx = x * x2,
    xy = x * y2,
    xz = x * z2;
  const yy = y * y2,
    yz = y * z2,
    zz = z * z2;
  const wx = w * x2,
    wy = w * y2,
    wz = w * z2;

  // biome-ignore format: matrix layout
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

/**
 * Euler rotation matrix for the given axis order (e.g. `"XYZ"`), with per-axis
 * angles in **radians** indexed by axis (`angles[0]`=X, `[1]`=Y, `[2]`=Z).
 *
 * Follows OpenUSD's `rotate<ORDER>` semantics: the first listed axis is applied
 * first to the geometry, so `"XYZ"` yields `Rz · Ry · Rx` in column-vector form.
 */
export function makeEuler(angles: Vec3, order: string): Mat4 {
  const perAxis: Record<string, Mat4> = {
    X: makeRotationX(angles[0]),
    Y: makeRotationY(angles[1]),
    Z: makeRotationZ(angles[2]),
  };
  let m = identity4();
  for (let i = order.length - 1; i >= 0; i--) {
    const axis = perAxis[order[i]!];
    if (!axis)
      throw new Error(
        `invalid euler axis ${JSON.stringify(order[i])} in order ${JSON.stringify(order)}`,
      );
    m = multiply(m, axis);
  }
  return m;
}

/**
 * Copy a USD matrix into a {@link Mat4}. USD's row-major storage is identical to
 * Three.js column-major elements for the same transform (see module docs), so
 * this is a straight copy after a dimension check.
 */
export function fromUsdMatrix(m: UsdMatrix): Mat4 {
  if (m.dim !== 4 || m.values.length !== 16) {
    throw new Error(`expected a 4x4 matrix but got dim=${m.dim}, length=${m.values.length}`);
  }
  return [...m.values];
}

/** Extract the translation component `[x, y, z]` from a {@link Mat4}. */
export function getTranslation(m: Mat4): Vec3 {
  return [m[12]!, m[13]!, m[14]!];
}
