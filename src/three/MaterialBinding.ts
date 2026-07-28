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

import { AssetPath, type Vec2, type Vec3 } from "../parser/ast.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";

/** `UsdUVTexture` wrap mode for one axis (`black` ≈ clamp; three has no border). */
export type TextureWrap = "repeat" | "clamp" | "mirror" | "black";

/** `UsdTransform2d` applied to the `st` coords feeding a texture. */
export type TextureTransform = {
  /** `inputs:translation` (UV offset). */
  translation?: Vec2;
  /** `inputs:rotation` in degrees (CCW about the origin). */
  rotation?: number;
  /** `inputs:scale` (UV tiling). */
  scale?: Vec2;
};

/** A resolved texture reference plus its `UsdUVTexture` sampler/transform state. */
export type ResolvedTexture = {
  /** Authored asset path of the image. */
  path: string;
  wrapS?: TextureWrap;
  wrapT?: TextureWrap;
  /** `UsdTransform2d` on the `st` input, if any. */
  transform?: TextureTransform;
  /** `inputs:scale` — multiplies the sampled value (folded into material factors). */
  scale?: [number, number, number, number];
  /** `inputs:bias` — added to the sampled value. */
  bias?: [number, number, number, number];
};

export type ResolvedMaterial = {
  /** Name of the bound `Material` prim, for round-tripping and debugging. */
  name?: string;
  color?: Vec3;
  opacity?: number;
  metalness?: number;
  roughness?: number;
  emissiveColor?: Vec3;
  /**
   * `inputs:opacityThreshold`. When `> 0`, opacity is a binary mask (alpha
   * clip / cutout); when `0`/absent, sub-unit opacity blends translucently.
   */
  opacityThreshold?: number;
  /** Diffuse/albedo texture, if any. */
  colorTexture?: ResolvedTexture;
  /** Opacity / alpha texture (may be the same image as `colorTexture`). */
  opacityTexture?: ResolvedTexture;
  /** Tangent-space normal map, if any. */
  normalTexture?: ResolvedTexture;
  /** Roughness map, if any. */
  roughnessTexture?: ResolvedTexture;
  /** Metallic map, if any. */
  metalnessTexture?: ResolvedTexture;
  /** Ambient-occlusion map, if any. */
  occlusionTexture?: ResolvedTexture;
  /** Emissive map, if any. */
  emissiveTexture?: ResolvedTexture;
};

const DIFFUSE_INPUTS = [
  "inputs:diffuseColor", // UsdPreviewSurface
  "inputs:diffuse_color_constant", // OmniPBR
  "inputs:diffuse_tint",
  "inputs:base_color",
  "inputs:baseColor",
];
const OPACITY_INPUTS = ["inputs:opacity", "inputs:opacity_constant"];
const OPACITY_THRESHOLD_INPUTS = ["inputs:opacityThreshold", "inputs:opacity_threshold"];
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
  "color" | "opacity" | "normal" | "roughness" | "metalness" | "occlusion" | "emissive",
  TextureLookup
> = {
  color: {
    surface: ["inputs:diffuseColor"],
    direct: ["inputs:diffuse_texture", "inputs:diffuse_color_texture"],
  },
  opacity: {
    surface: ["inputs:opacity"],
    direct: ["inputs:opacity_texture", "inputs:opacity_color_texture"],
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

  const result: ResolvedMaterial = { name: material.GetName() };
  const color = firstColor(shader, DIFFUSE_INPUTS);
  if (color) result.color = color;
  const opacity = firstNumber(shader, OPACITY_INPUTS);
  if (opacity !== undefined) result.opacity = opacity;
  const opacityThreshold = firstNumber(shader, OPACITY_THRESHOLD_INPUTS);
  if (opacityThreshold !== undefined) result.opacityThreshold = opacityThreshold;
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
  const opacityTex = findTexture(shader, TEXTURE_LOOKUPS.opacity);
  if (opacityTex !== undefined) result.opacityTexture = opacityTex;
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
 * Resolve a channel's texture: an OmniPBR direct asset input takes precedence
 * (path only), else follow a `UsdPreviewSurface` input's connection to a
 * `UsdUVTexture` and read its `inputs:file` plus sampler/transform state.
 */
function findTexture(shader: Prim, lookup: TextureLookup): ResolvedTexture | undefined {
  for (const name of lookup.direct) {
    const v = shader.GetAttribute(name).Get();
    if (v instanceof AssetPath && v.path) return { path: v.path };
  }
  for (const name of lookup.surface) {
    const conn = shader.GetAttribute(name).GetConnections()[0];
    if (!conn) continue;
    const texPrim = shader.GetStage().GetPrimAtPath(conn.split(".")[0]!);
    if (!texPrim) continue;
    const file = texPrim.GetAttribute("inputs:file").Get();
    if (file instanceof AssetPath && file.path) return readUvTexture(texPrim, file.path);
  }
  return undefined;
}

const WRAP_VALUES = new Set(["repeat", "clamp", "mirror", "black"]);

/** Read a `UsdUVTexture` prim's wrap modes, scale/bias, and `st` transform. */
function readUvTexture(texPrim: Prim, path: string): ResolvedTexture {
  const tex: ResolvedTexture = { path };

  const wrapS = texPrim.GetAttribute("inputs:wrapS").Get();
  if (typeof wrapS === "string" && WRAP_VALUES.has(wrapS)) tex.wrapS = wrapS as TextureWrap;
  const wrapT = texPrim.GetAttribute("inputs:wrapT").Get();
  if (typeof wrapT === "string" && WRAP_VALUES.has(wrapT)) tex.wrapT = wrapT as TextureWrap;

  const scale = numArray(texPrim, "inputs:scale", 4);
  if (scale) tex.scale = scale as [number, number, number, number];
  const bias = numArray(texPrim, "inputs:bias", 4);
  if (bias) tex.bias = bias as [number, number, number, number];

  const transform = readTransform2d(texPrim);
  if (transform) tex.transform = transform;
  return tex;
}

/** Follow `inputs:st` to a `UsdTransform2d` node and read its translate/rotate/scale. */
function readTransform2d(texPrim: Prim): TextureTransform | undefined {
  const conn = texPrim.GetAttribute("inputs:st").GetConnections()[0];
  if (!conn) return undefined;
  const node = texPrim.GetStage().GetPrimAtPath(conn.split(".")[0]!);
  if (!node || node.GetAttribute("info:id").Get() !== "UsdTransform2d") return undefined;

  const transform: TextureTransform = {};
  const translation = numArray(node, "inputs:translation", 2);
  if (translation) transform.translation = translation as Vec2;
  const scale = numArray(node, "inputs:scale", 2);
  if (scale) transform.scale = scale as Vec2;
  const rotation = node.GetAttribute("inputs:rotation").Get();
  if (typeof rotation === "number") transform.rotation = rotation;
  return Object.keys(transform).length > 0 ? transform : undefined;
}

/** Read a numeric attribute as a fixed-length array, or `undefined`. */
function numArray(prim: Prim, name: string, length: number): number[] | undefined {
  const v = prim.GetAttribute(name).Get();
  if (Array.isArray(v) && v.length >= length && v.every((n) => typeof n === "number")) {
    return (v as number[]).slice(0, length);
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
