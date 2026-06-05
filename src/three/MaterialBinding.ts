/**
 * Resolves `UsdShade` material bindings to flat PBR parameters.
 *
 * Follows a prim's (or an ancestor's) `material:binding` to a `Material`, finds
 * its surface `Shader`, and reads constant color/metalness/roughness/opacity/
 * emissive inputs plus the **texture** asset paths for the diffuse, normal,
 * roughness, metallic, occlusion and emissive channels. Handles both
 * `UsdPreviewSurface` (constant inputs or a connected `UsdUVTexture` network)
 * and Omniverse `OmniPBR` MDL (direct asset-valued texture inputs such as
 * `inputs:normalmap_texture`).
 */

import { AssetPath, type Vec3 } from "../parser/ast.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";

export type ResolvedMaterial = {
  color?: Vec3;
  opacity?: number;
  metalness?: number;
  roughness?: number;
  emissiveColor?: Vec3;
  /** Authored asset path of the diffuse/albedo texture, if any. */
  colorTexture?: string;
  /** Tangent-space normal map asset path, if any. */
  normalTexture?: string;
  /** Roughness map asset path, if any. */
  roughnessTexture?: string;
  /** Metallic map asset path, if any. */
  metalnessTexture?: string;
  /** Ambient-occlusion map asset path, if any. */
  occlusionTexture?: string;
  /** Emissive map asset path, if any. */
  emissiveTexture?: string;
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
const EMISSIVE_INPUTS = ["inputs:emissiveColor", "inputs:emissive_color"];

const SURFACE_OUTPUTS = ["outputs:surface", "outputs:mdl:surface"];

/**
 * Per-channel texture lookup: `surface` names are `UsdPreviewSurface` inputs
 * that connect to a `UsdUVTexture` (we follow the connection to its
 * `inputs:file`); `direct` names are OmniPBR MDL asset-valued texture inputs.
 */
type TextureLookup = { surface: string[]; direct: string[] };

const TEXTURE_LOOKUPS: Record<
  "color" | "normal" | "roughness" | "metalness" | "occlusion" | "emissive",
  TextureLookup
> = {
  color: {
    surface: ["inputs:diffuseColor"],
    direct: ["inputs:diffuse_texture", "inputs:diffuse_color_texture"],
  },
  normal: {
    surface: ["inputs:normal"],
    direct: ["inputs:normalmap_texture", "inputs:normal_texture"],
  },
  roughness: {
    surface: ["inputs:roughness"],
    direct: ["inputs:reflectionroughness_texture", "inputs:roughness_texture"],
  },
  metalness: {
    surface: ["inputs:metallic"],
    direct: ["inputs:metallic_texture"],
  },
  occlusion: {
    surface: ["inputs:occlusion"],
    direct: ["inputs:ao_texture", "inputs:occlusion_texture"],
  },
  emissive: {
    surface: ["inputs:emissiveColor"],
    direct: ["inputs:emissive_color_texture", "inputs:emissive_mask_texture"],
  },
};

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

  const emissive = firstColor(shader, EMISSIVE_INPUTS);
  // OmniPBR gates emission behind `inputs:enable_emission`; UsdPreviewSurface
  // has no such input (undefined ⇒ honoured).
  if (emissive && shader.GetAttribute("inputs:enable_emission").Get() !== false) {
    result.emissiveColor = emissive;
  }

  const colorTex = findTexture(shader, TEXTURE_LOOKUPS.color);
  if (colorTex !== undefined) result.colorTexture = colorTex;
  const normal = findTexture(shader, TEXTURE_LOOKUPS.normal);
  if (normal !== undefined) result.normalTexture = normal;
  const roughTex = findTexture(shader, TEXTURE_LOOKUPS.roughness);
  if (roughTex !== undefined) result.roughnessTexture = roughTex;
  const metalTex = findTexture(shader, TEXTURE_LOOKUPS.metalness);
  if (metalTex !== undefined) result.metalnessTexture = metalTex;
  const aoTex = findTexture(shader, TEXTURE_LOOKUPS.occlusion);
  if (aoTex !== undefined) result.occlusionTexture = aoTex;
  const emissiveTex = findTexture(shader, TEXTURE_LOOKUPS.emissive);
  if (emissiveTex !== undefined) result.emissiveTexture = emissiveTex;

  return result;
}

/**
 * Resolve a channel's texture asset path: an OmniPBR direct asset input takes
 * precedence, else follow a `UsdPreviewSurface` input's connection to the
 * `UsdUVTexture`'s `inputs:file`.
 */
function findTexture(shader: Prim, lookup: TextureLookup): string | undefined {
  for (const name of lookup.direct) {
    const v = shader.GetAttribute(name).Get();
    if (v instanceof AssetPath && v.path) return v.path;
  }
  for (const name of lookup.surface) {
    const conn = shader.GetAttribute(name).GetConnections()[0];
    if (!conn) continue;
    const texPrim = shader.GetStage().GetPrimAtPath(conn.split(".")[0]!);
    const file = texPrim?.GetAttribute("inputs:file").Get();
    if (file instanceof AssetPath && file.path) return file.path;
  }
  return undefined;
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
