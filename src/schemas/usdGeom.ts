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
