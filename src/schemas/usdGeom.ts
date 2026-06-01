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
