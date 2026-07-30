/** UsdGeom schema helpers (type checks and geometry gathering). */

import type { Prim } from "../usd/Prim.js";

export function isXform(prim: Prim): boolean {
  return prim.GetTypeName() === "Xform";
}

export function isScope(prim: Prim): boolean {
  return prim.GetTypeName() === "Scope";
}

export function isMesh(prim: Prim): boolean {
  return prim.GetTypeName() === "Mesh";
}

/** Parametric solid gprim schemas — geometry defined by attributes, not topology. */
const SOLID_GPRIM_TYPES: ReadonlySet<string> = new Set([
  "Cube",
  "Sphere",
  "Cylinder",
  "Capsule",
  "Cone",
]);

/** True for a `Cube` / `Sphere` / `Cylinder` / `Capsule` / `Cone` prim. */
export function isSolidGprim(prim: Prim): boolean {
  return SOLID_GPRIM_TYPES.has(prim.GetTypeName());
}

/** True for a `Points` (point cloud) prim. */
export function isPoints(prim: Prim): boolean {
  return prim.GetTypeName() === "Points";
}

/** True for a `BasisCurves` (linear / cubic curve batch) prim. */
export function isBasisCurves(prim: Prim): boolean {
  return prim.GetTypeName() === "BasisCurves";
}

/** Point/curve/patch schemas recognized but not renderable yet (skipped with a warning). */
const UNSUPPORTED_GPRIM_TYPES: ReadonlySet<string> = new Set([
  "NurbsCurves",
  "HermiteCurves",
  "NurbsPatch",
]);

/** True for a gprim schema the runtime knows about but cannot render (yet). */
export function isUnsupportedGprim(prim: Prim): boolean {
  return UNSUPPORTED_GPRIM_TYPES.has(prim.GetTypeName());
}

/**
 * True for any gprim the runtime can render: a `Mesh`, a parametric solid,
 * a `Points` cloud, or a `BasisCurves` batch.
 */
export function isRenderableGprim(prim: Prim): boolean {
  return isMesh(prim) || isSolidGprim(prim) || isPoints(prim) || isBasisCurves(prim);
}

/** `UsdGeomImageable.purpose` token; defaults to `"default"`. */
export function getPurpose(prim: Prim): string {
  const v = prim.GetAttribute("purpose").Get();
  return typeof v === "string" ? v : "default";
}

/** Purposes that should not render as visual geometry (treated as collision/guide). */
export function isNonVisualPurpose(prim: Prim): boolean {
  const p = getPurpose(prim);
  return p === "guide" || p === "proxy";
}

/** A face subset of a mesh that carries its own material binding. */
export type MaterialSubset = {
  /** The `GeomSubset` prim — resolve its `material:binding` for the material. */
  prim: Prim;
  /** Indices into `faceVertexCounts` that this subset covers. */
  faces: number[];
};

/**
 * Face subsets of the `materialBind` family (`UsdGeomSubset`). Real assets
 * usually ship one mesh per link and paint it by subset, so this is where the
 * material assignments live rather than on the Mesh prim itself.
 */
export function getMaterialSubsets(meshPrim: Prim): MaterialSubset[] {
  const out: MaterialSubset[] = [];
  for (const child of meshPrim.GetChildren()) {
    if (child.GetTypeName() !== "GeomSubset") continue;
    // `elementType` defaults to "face"; other families aren't material bindings.
    const elementType = child.GetAttribute("elementType").Get();
    if (elementType !== undefined && elementType !== "face") continue;
    const family = child.GetAttribute("familyName").Get();
    if (family !== undefined && family !== "materialBind") continue;

    const indices = child.GetAttribute("indices").Get();
    if (!Array.isArray(indices)) continue;
    const faces: number[] = [];
    for (const i of indices) {
      if (typeof i === "number") faces.push(i);
    }
    if (faces.length > 0) out.push({ prim: child, faces });
  }
  return out;
}

/** Depth-first iterator over all descendant prims (excluding `prim` itself). */
export function* iterDescendants(prim: Prim): Generator<Prim> {
  for (const child of prim.GetChildren()) {
    yield child;
    yield* iterDescendants(child);
  }
}

/** Collect the prim paths of all Mesh descendants of a link prim. */
export function gatherMeshDescendants(prim: Prim): string[] {
  const paths: string[] = [];
  for (const d of iterDescendants(prim)) {
    if (isMesh(d)) paths.push(d.GetPath());
  }
  return paths;
}

/** Collect the prim paths of all renderable gprim descendants (meshes + solids). */
export function gatherGprimDescendants(prim: Prim): string[] {
  const paths: string[] = [];
  for (const d of iterDescendants(prim)) {
    if (isRenderableGprim(d)) paths.push(d.GetPath());
  }
  return paths;
}
