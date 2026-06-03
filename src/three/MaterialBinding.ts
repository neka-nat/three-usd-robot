/**
 * Resolves `UsdShade` material bindings to flat PBR parameters.
 *
 * Follows a prim's (or an ancestor's) `material:binding` to a `Material`, finds
 * its surface `Shader`, and reads constant color/metalness/roughness/opacity
 * inputs. Handles both `UsdPreviewSurface` (`inputs:diffuseColor`, …) and
 * Omniverse `OmniPBR` MDL (`inputs:diffuse_color_constant`, …) input names.
 * Texture inputs and shading networks are not evaluated — constants only.
 */

import type { Vec3 } from "../parser/ast.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";

export type ResolvedMaterial = {
  color?: Vec3;
  opacity?: number;
  metalness?: number;
  roughness?: number;
};

const DIFFUSE_INPUTS = [
  "inputs:diffuseColor", // UsdPreviewSurface
  "inputs:diffuse_color_constant", // OmniPBR
  "inputs:diffuse_tint",
  "inputs:base_color",
  "inputs:baseColor",
];
const OPACITY_INPUTS = ["inputs:opacity", "inputs:opacity_constant"];
const METALLIC_INPUTS = ["inputs:metallic", "inputs:metallic_constant"];
const ROUGHNESS_INPUTS = ["inputs:roughness", "inputs:reflection_roughness_constant"];

const SURFACE_OUTPUTS = ["outputs:surface", "outputs:mdl:surface"];

/** Resolve the bound material's flat parameters for `prim`, or `undefined`. */
export function resolveBoundMaterial(stage: Stage, prim: Prim): ResolvedMaterial | undefined {
  const materialPath = findBinding(prim);
  if (!materialPath) return undefined;
  const material = stage.GetPrimAtPath(materialPath);
  if (!material) return undefined;
  const shader = findSurfaceShader(material);
  if (!shader) return undefined;

  const result: ResolvedMaterial = {};
  const color = firstColor(shader, DIFFUSE_INPUTS);
  if (color) result.color = color;
  const opacity = firstNumber(shader, OPACITY_INPUTS);
  if (opacity !== undefined) result.opacity = opacity;
  const metalness = firstNumber(shader, METALLIC_INPUTS);
  if (metalness !== undefined) result.metalness = metalness;
  const roughness = firstNumber(shader, ROUGHNESS_INPUTS);
  if (roughness !== undefined) result.roughness = roughness;
  return result;
}

/** Walk up from `prim` to the first ancestor with a `material:binding`. */
function findBinding(prim: Prim): string | undefined {
  let p: Prim | null = prim;
  while (p) {
    const targets = p.GetRelationship("material:binding").GetTargets();
    if (targets.length > 0) return targets[0];
    p = p.GetParent();
  }
  return undefined;
}

function findSurfaceShader(material: Prim): Prim | undefined {
  // Prefer the shader connected to a surface output.
  for (const out of SURFACE_OUTPUTS) {
    const conn = material.GetAttribute(out).GetConnections()[0];
    if (conn) {
      const shaderPath = conn.split(".")[0]!;
      const shader = material.GetStage().GetPrimAtPath(shaderPath);
      if (shader) return shader;
    }
  }
  // Fallback: the first child Shader prim.
  return material.GetChildren().find((c) => c.GetTypeName() === "Shader") ?? undefined;
}

function firstColor(shader: Prim, names: string[]): Vec3 | undefined {
  for (const name of names) {
    const v = shader.GetAttribute(name).Get();
    if (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === "number")) {
      return [v[0], v[1], v[2]] as Vec3;
    }
  }
  return undefined;
}

function firstNumber(shader: Prim, names: string[]): number | undefined {
  for (const name of names) {
    const v = shader.GetAttribute(name).Get();
    if (typeof v === "number") return v;
  }
  return undefined;
}
