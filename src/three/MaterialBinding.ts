/**
 * Resolves `UsdShade` material bindings to flat PBR parameters.
 *
 * Follows a prim's (or an ancestor's) `material:binding` to a `Material`, finds
 * its surface `Shader`, and reads constant color/metalness/roughness/opacity/
 * emissive inputs plus the **texture** asset paths for the diffuse, normal,
 * roughness, metallic, occlusion and emissive channels. Handles both
 * `UsdPreviewSurface` (constant inputs or a connected `UsdUVTexture` network)
 * and the Omniverse MDL material families (M20): `OmniPBR` (and derivatives
 * such as `OmniPBR_Opacity`), `OmniPBR_ClearCoat`, `OmniGlass`, and an
 * `OmniSurface(Lite)` constants subset. MDL shaders are identified by
 * `info:mdl:sourceAsset` / `:subIdentifier`; when the referenced `.mdl` module
 * text is available (see `loadMdlModules`), parameter values fall back from
 * authored USD inputs to the module's wrapper arguments and declaration
 * defaults. Executing MDL remains out of scope.
 *
 * MaterialX networks authored natively in UsdShade (M21) resolve here too:
 * `ND_standard_surface_surfaceshader` has a dedicated reader (see
 * `MaterialXBinding.ts`), while the `ND_Usd*` compatibility nodes share
 * `UsdPreviewSurface` input names and reuse the generic reads.
 */

import { AssetPath, type Vec2, type Vec3 } from "../parser/ast.js";
import { joinPosix } from "../usd/AssetResolver.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";
import { type MdlModuleProvider, type MdlValue, isMdlTexture } from "../usd/mdl/parseMdl.js";
import {
  MTLX_STANDARD_SURFACE,
  MTLX_USD_PREVIEW_SURFACE,
  readStandardSurface,
} from "./MaterialXBinding.js";

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
  /**
   * UV-set (primvar) name the texture reads, resolved through the `inputs:st`
   * connection to a `UsdPrimvarReader_float2.inputs:varname`. Absent ⇒ `"st"`.
   */
  uvSet?: string;
  /**
   * Direct UV channel index (MaterialX `ND_texcoord_*.inputs:index`, M21).
   * Beats `uvSet`; channel N is the mesh's N-th UV set in `meshUvSetNames`
   * order (`st` first, extras sorted).
   */
  uvChannel?: number;
  /** `inputs:sourceColorSpace` — overrides the per-channel colorspace default. */
  sourceColorSpace?: "raw" | "sRGB" | "auto";
  /**
   * Which output the consuming input connects to (`outputs:r` → `"r"`, …).
   * three.js samples fixed channels (roughness = G, metalness = B, ao = R);
   * a mismatch is surfaced as a load warning.
   */
  outputChannel?: "r" | "g" | "b" | "a" | "rgb";
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
  /** `inputs:ior` — promotes the three material to `MeshPhysicalMaterial`. */
  ior?: number;
  /** `inputs:clearcoat` (physical promotion). */
  clearcoat?: number;
  /** `inputs:clearcoatRoughness` (physical promotion). */
  clearcoatRoughness?: number;
  /** `inputs:specularColor`, only when `inputs:useSpecularWorkflow = 1`. */
  specularColor?: Vec3;
  /** OmniPBR `inputs:emissive_intensity` — multiplies the emissive color. */
  emissiveIntensity?: number;
  /** OmniGlass — `1` marks a transmissive dielectric (physical promotion, M20). */
  transmission?: number;
  /** OmniGlass `inputs:depth` — refraction volume thickness (scene units, M20). */
  thickness?: number;
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
  /** OmniPBR_ClearCoat `clearcoat_normalmap_texture` (physical promotion, M20). */
  clearcoatNormalTexture?: ResolvedTexture;
};

// Input names below are bare (no `inputs:` prefix) so the same name reaches
// both the authored USD attribute and the `.mdl` declaration value.
const DIFFUSE_INPUTS = [
  "diffuseColor", // UsdPreviewSurface
  "diffuse_color_constant", // OmniPBR
  "diffuse_tint",
  "base_color",
  "baseColor",
];
const OPACITY_INPUTS = ["opacity", "opacity_constant"];
const OPACITY_THRESHOLD_INPUTS = ["opacityThreshold", "opacity_threshold"];
const METALLIC_INPUTS = ["metallic", "metallic_constant"];
const ROUGHNESS_INPUTS = ["roughness", "reflection_roughness_constant"];
const EMISSIVE_INPUTS = ["emissiveColor", "emissive_color"];

const SURFACE_OUTPUTS = ["outputs:surface", "outputs:mdl:surface", "outputs:mtlx:surface"];

/**
 * Per-channel texture lookup: `surface` names are `UsdPreviewSurface` inputs
 * that connect to a `UsdUVTexture` (we follow the connection to its
 * `inputs:file`); `direct` names are OmniPBR-style MDL asset-valued texture
 * inputs (authored in USD or carried by the `.mdl` declaration).
 */
type TextureLookup = { surface: string[]; direct: string[] };

const TEXTURE_LOOKUPS: Record<
  "color" | "opacity" | "normal" | "roughness" | "metalness" | "occlusion" | "emissive",
  TextureLookup
> = {
  color: {
    surface: ["diffuseColor"],
    direct: ["diffuse_texture", "diffuse_color_texture", "glass_color_texture"],
  },
  opacity: {
    surface: ["opacity"],
    direct: ["opacity_texture", "opacity_color_texture"],
  },
  normal: {
    surface: ["normal"],
    direct: ["normalmap_texture", "normal_texture", "normal_map_texture"],
  },
  roughness: {
    surface: ["roughness"],
    direct: ["reflectionroughness_texture", "roughness_texture"],
  },
  metalness: {
    surface: ["metallic"],
    direct: ["metallic_texture"],
  },
  occlusion: {
    surface: ["occlusion"],
    direct: ["ao_texture", "occlusion_texture"],
  },
  emissive: {
    surface: ["emissiveColor"],
    direct: ["emissive_color_texture", "emissive_mask_texture"],
  },
};

export type ResolveMaterialOptions = {
  /** Parsed `.mdl` modules for MDL family detection and value fallback (M20). */
  mdl?: MdlModuleProvider;
  /** Receives diagnostics (unknown MDL material families). */
  onWarn?: (message: string) => void;
};

/** Resolve the bound material's flat parameters for `prim`, or `undefined`. */
export function resolveBoundMaterial(
  stage: Stage,
  prim: Prim,
  options: ResolveMaterialOptions = {},
): ResolvedMaterial | undefined {
  const materialPath = findBinding(prim);
  if (!materialPath) return undefined;
  const material = stage.GetPrimAtPath(materialPath);
  if (!material) return undefined;
  const shader = findSurfaceShader(material);
  if (!shader) return undefined;

  // MaterialX (M21): standard_surface gets a dedicated reader; other ND_*
  // surface shaders fall through to the generic best-effort reads (the
  // ND_UsdPreviewSurface compatibility node matches them by construction).
  const infoId = shader.GetAttribute("info:id").Get();
  if (typeof infoId === "string" && infoId.startsWith("ND_")) {
    if (infoId === MTLX_STANDARD_SURFACE) {
      const result: ResolvedMaterial = { name: material.GetName() };
      readStandardSurface(shader, result, options.onWarn);
      return result;
    }
    if (infoId !== MTLX_USD_PREVIEW_SURFACE) {
      options.onWarn?.(
        `${material.GetPath()}: unknown MaterialX surface shader "${infoId}"; applying the best-effort UsdPreviewSurface mapping`,
      );
    }
  }

  const mdlSource = readMdlShaderSource(shader, options.mdl);
  if (mdlSource && !mdlSource.family) {
    options.onWarn?.(
      `${material.GetPath()}: unknown MDL material "${mdlSource.id}" (${mdlSource.assetPath}); applying the best-effort OmniPBR mapping`,
    );
  }
  const sv: ShaderValues = { shader };
  if (mdlSource?.values) sv.mdl = mdlSource.values;
  if (mdlSource) sv.mdlAssetPath = mdlSource.assetPath;

  const result: ResolvedMaterial = { name: material.GetName() };
  const color = firstColor(sv, DIFFUSE_INPUTS);
  if (color) result.color = color;
  const opacity = firstNumber(sv, OPACITY_INPUTS);
  if (opacity !== undefined) result.opacity = opacity;
  const opacityThreshold = firstNumber(sv, OPACITY_THRESHOLD_INPUTS);
  if (opacityThreshold !== undefined) result.opacityThreshold = opacityThreshold;
  const metalness = firstNumber(sv, METALLIC_INPUTS);
  if (metalness !== undefined) result.metalness = metalness;
  const roughness = firstNumber(sv, ROUGHNESS_INPUTS);
  if (roughness !== undefined) result.roughness = roughness;

  const emissive = firstColor(sv, EMISSIVE_INPUTS);
  // OmniPBR gates emission behind `inputs:enable_emission`; UsdPreviewSurface
  // has no such input (undefined ⇒ honoured).
  if (emissive && svBoolean(sv, "enable_emission") !== false) {
    result.emissiveColor = emissive;
    const intensity = svNumber(sv, "emissive_intensity");
    if (intensity !== undefined) result.emissiveIntensity = intensity;
  }

  // UsdPreviewSurface physical inputs — their presence promotes the three
  // material from Standard to Physical.
  const ior = svNumber(sv, "ior");
  if (ior !== undefined) result.ior = ior;
  const clearcoat = svNumber(sv, "clearcoat");
  if (clearcoat !== undefined) result.clearcoat = clearcoat;
  const clearcoatRoughness = svNumber(sv, "clearcoatRoughness");
  if (clearcoatRoughness !== undefined) result.clearcoatRoughness = clearcoatRoughness;
  if (svNumber(sv, "useSpecularWorkflow") === 1) {
    const specular = svColor(sv, "specularColor");
    if (specular) result.specularColor = specular;
  }

  const colorTex = findTexture(sv, TEXTURE_LOOKUPS.color);
  if (colorTex !== undefined) result.colorTexture = colorTex;
  const opacityTex = findTexture(sv, TEXTURE_LOOKUPS.opacity);
  if (opacityTex !== undefined) result.opacityTexture = opacityTex;
  const normal = findTexture(sv, TEXTURE_LOOKUPS.normal);
  if (normal !== undefined) result.normalTexture = normal;
  const roughTex = findTexture(sv, TEXTURE_LOOKUPS.roughness);
  if (roughTex !== undefined) result.roughnessTexture = roughTex;
  const metalTex = findTexture(sv, TEXTURE_LOOKUPS.metalness);
  if (metalTex !== undefined) result.metalnessTexture = metalTex;
  const aoTex = findTexture(sv, TEXTURE_LOOKUPS.occlusion);
  if (aoTex !== undefined) result.occlusionTexture = aoTex;
  const emissiveTex = findTexture(sv, TEXTURE_LOOKUPS.emissive);
  if (emissiveTex !== undefined) result.emissiveTexture = emissiveTex;

  // OmniPBR packed ORM: when enabled it replaces the per-channel lookups.
  // Its layout (AO = R, roughness = G, metalness = B) matches what three.js
  // samples, so the channels line up by construction.
  const orm = directTexture(sv, "ORM_texture") ?? mdlValueTexture(sv, "ORM_texture");
  if (svBoolean(sv, "enable_ORM_texture") === true && orm) {
    result.occlusionTexture = { ...orm, outputChannel: "r" };
    result.roughnessTexture = { ...orm, outputChannel: "g" };
    result.metalnessTexture = { ...orm, outputChannel: "b" };
  }

  // Family-specific parameter names on top of the generic reads (M20).
  switch (mdlSource?.family) {
    case "glass":
      readOmniGlass(sv, result);
      break;
    case "clearcoat":
      readOmniClearCoat(sv, result);
      break;
    case "surface":
      readOmniSurface(sv, result);
      break;
    default:
      break; // "pbr" and unknown families are covered by the generic reads
  }

  return result;
}

/**
 * The `Shader` prim driving `prim`'s bound material surface, or `undefined`.
 * Follows the same binding/surface-output resolution as
 * {@link resolveBoundMaterial} — exposed for custom material factories (M22)
 * that need the raw shader network rather than the flattened parameters.
 */
export function findBoundSurfaceShader(stage: Stage, prim: Prim): Prim | undefined {
  const materialPath = findBinding(prim);
  if (!materialPath) return undefined;
  const material = stage.GetPrimAtPath(materialPath);
  if (!material) return undefined;
  return findSurfaceShader(material);
}

/** Omniverse MDL material family driving the family-specific parameter reads. */
type OmniMdlFamily = "pbr" | "clearcoat" | "glass" | "surface";

function classifyOmniMdl(name: string | undefined): OmniMdlFamily | undefined {
  if (!name) return undefined;
  if (name.startsWith("OmniGlass")) return "glass";
  if (name.startsWith("OmniPBR_ClearCoat")) return "clearcoat";
  if (name.startsWith("OmniPBR")) return "pbr"; // OmniPBR_Opacity & co. fall back here
  if (name.startsWith("OmniSurface")) return "surface";
  return undefined;
}

type MdlShaderSource = {
  /** Authored `info:mdl:sourceAsset` path. */
  assetPath: string;
  /** Material name inside the module (`subIdentifier`, else the file stem). */
  id: string;
  family?: OmniMdlFamily;
  /** Declaration defaults overlaid with wrapper-call arguments. */
  values?: Map<string, MdlValue>;
};

/**
 * Identify an MDL shader (`info:mdl:sourceAsset` + `:subIdentifier`) and merge
 * its `.mdl` declaration values when the module is available. A wrapper
 * declaration (`export material X(*) = OmniPBR(...)`) also resolves the family
 * through its base material.
 */
function readMdlShaderSource(
  shader: Prim,
  provider: MdlModuleProvider | undefined,
): MdlShaderSource | undefined {
  const asset = shader.GetAttribute("info:mdl:sourceAsset").Get();
  if (!(asset instanceof AssetPath) || !asset.path) return undefined;
  const sub = shader.GetAttribute("info:mdl:sourceAsset:subIdentifier").Get();
  const stem = (asset.path.split("/").pop() ?? "").replace(/\.mdl$/i, "");
  const id = typeof sub === "string" && sub.length > 0 ? sub : stem;
  const decl = provider?.(asset.path)?.materials.get(id);
  const family = classifyOmniMdl(decl?.base) ?? classifyOmniMdl(id) ?? classifyOmniMdl(stem);
  const source: MdlShaderSource = { assetPath: asset.path, id };
  if (family) source.family = family;
  if (decl && (decl.defaults.size > 0 || decl.args.size > 0)) {
    // Wrapper args beat the declaration's own defaults; authored USD inputs
    // beat both (enforced by the accessors, which try USD first).
    source.values = new Map([...decl.defaults, ...decl.args]);
  }
  return source;
}

/**
 * `OmniGlass` — a transmissive dielectric. Canonical MDL defaults are baked in
 * (`glass_ior` 1.491, smooth, colorless) so an input-less glass shader still
 * reads as glass instead of the gray mesh fallback.
 */
function readOmniGlass(sv: ShaderValues, result: ResolvedMaterial): void {
  result.transmission = 1;
  result.metalness = 0;
  result.color = svColor(sv, "glass_color") ?? [1, 1, 1];
  result.ior = svNumber(sv, "glass_ior") ?? 1.491;
  result.roughness = svNumber(sv, "frosting_roughness") ?? 0;
  const depth = svNumber(sv, "depth");
  if (svBoolean(sv, "thin_walled") !== true && depth !== undefined) result.thickness = depth;
  const cutout = svNumber(sv, "cutout_opacity");
  if (cutout !== undefined && cutout < 1) result.opacity = cutout;
}

/**
 * `OmniPBR_ClearCoat` — OmniPBR plus a lacquer layer. The generic reads cover
 * the OmniPBR base; this adds three's clearcoat (weight 1 unless explicitly
 * disabled — the coat's presence is the material's point).
 */
function readOmniClearCoat(sv: ShaderValues, result: ResolvedMaterial): void {
  if (svBoolean(sv, "enable_clearcoat") === false) return;
  result.clearcoat = 1;
  const roughness = svNumber(sv, "clearcoat_reflection_roughness");
  if (roughness !== undefined) result.clearcoatRoughness = roughness;
  const normal =
    directTexture(sv, "clearcoat_normalmap_texture") ??
    mdlValueTexture(sv, "clearcoat_normalmap_texture");
  if (normal && svBoolean(sv, "enable_clearcoat_normalmap_texture") !== false) {
    result.clearcoatNormalTexture = normal;
  }
}

/**
 * `OmniSurface` / `OmniSurfaceLite` — constants-only subset of the ~100-input
 * Standard-Surface-style material. Texture-driven inputs are shader-graph
 * connections in real assets and stay out of scope; unsupported inputs are
 * ignored.
 */
function readOmniSurface(sv: ShaderValues, result: ResolvedMaterial): void {
  const color = svColor(sv, "diffuse_reflection_color");
  if (color) result.color = color;
  const metalness = svNumber(sv, "metalness");
  if (metalness !== undefined) result.metalness = metalness;
  const roughness = svNumber(sv, "specular_reflection_roughness");
  if (roughness !== undefined) result.roughness = roughness;
  const ior = svNumber(sv, "specular_reflection_ior");
  if (ior !== undefined) result.ior = ior;
  const coat = svNumber(sv, "coat_weight");
  if (coat !== undefined && coat > 0) {
    result.clearcoat = coat;
    const coatRoughness = svNumber(sv, "coat_roughness");
    if (coatRoughness !== undefined) result.clearcoatRoughness = coatRoughness;
  }
  const emissionWeight = svNumber(sv, "emission_weight");
  const emissionColor = svColor(sv, "emission_color");
  if (emissionWeight !== undefined && emissionWeight > 0 && emissionColor) {
    result.emissiveColor = emissionColor;
    result.emissiveIntensity = emissionWeight;
  }
  if (svBoolean(sv, "enable_opacity") === true) {
    const opacity = svNumber(sv, "geometry_opacity");
    if (opacity !== undefined) result.opacity = opacity;
  }
}

/**
 * Shader parameter view (M20): each accessor tries the authored USD input
 * (`inputs:<name>`) first, then the merged `.mdl` declaration values.
 */
type ShaderValues = {
  shader: Prim;
  mdl?: ReadonlyMap<string, MdlValue>;
  /** Authored module path — anchors module-relative texture paths. */
  mdlAssetPath?: string;
};

function authored(sv: ShaderValues, name: string): unknown {
  return sv.shader.GetAttribute(`inputs:${name}`).Get();
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asVec(v: unknown, length: number): number[] | undefined {
  if (Array.isArray(v) && v.length >= length && v.every((n) => typeof n === "number")) {
    return (v as number[]).slice(0, length);
  }
  return undefined;
}

function svNumber(sv: ShaderValues, name: string): number | undefined {
  return asNumber(authored(sv, name)) ?? asNumber(sv.mdl?.get(name));
}

function svBoolean(sv: ShaderValues, name: string): boolean | undefined {
  return asBoolean(authored(sv, name)) ?? asBoolean(sv.mdl?.get(name));
}

function svColor(sv: ShaderValues, name: string): Vec3 | undefined {
  const v = asVec(authored(sv, name), 3) ?? asVec(sv.mdl?.get(name), 3);
  return v ? (v as Vec3) : undefined;
}

function svVec2(sv: ShaderValues, name: string): Vec2 | undefined {
  const v = asVec(authored(sv, name), 2) ?? asVec(sv.mdl?.get(name), 2);
  return v ? (v as Vec2) : undefined;
}

/** First authored value across `names`, then the first `.mdl` value. */
function firstNumber(sv: ShaderValues, names: string[]): number | undefined {
  for (const name of names) {
    const v = asNumber(authored(sv, name));
    if (v !== undefined) return v;
  }
  for (const name of names) {
    const v = asNumber(sv.mdl?.get(name));
    if (v !== undefined) return v;
  }
  return undefined;
}

function firstColor(sv: ShaderValues, names: string[]): Vec3 | undefined {
  for (const name of names) {
    const v = asVec(authored(sv, name), 3);
    if (v) return v as Vec3;
  }
  for (const name of names) {
    const v = asVec(sv.mdl?.get(name), 3);
    if (v) return v as Vec3;
  }
  return undefined;
}

/** An authored direct asset input (`inputs:<name> = @path@`) as a texture. */
function directTexture(sv: ShaderValues, name: string): ResolvedTexture | undefined {
  const v = authored(sv, name);
  if (v instanceof AssetPath && v.path) return withMdlTransform(sv, { path: v.path });
  return undefined;
}

/** A `texture_2d` literal from the `.mdl` declaration as a texture. */
function mdlValueTexture(sv: ShaderValues, name: string): ResolvedTexture | undefined {
  const v = sv.mdl?.get(name);
  if (!isMdlTexture(v)) return undefined;
  const texture: ResolvedTexture = { path: resolveMdlRelative(sv.mdlAssetPath, v.assetPath) };
  if (v.sourceColorSpace) texture.sourceColorSpace = v.sourceColorSpace;
  return withMdlTransform(sv, texture);
}

/**
 * Texture paths inside a `.mdl` file are relative to the **module**, not the
 * USD layer — rebase them onto the module's authored path so the texture
 * provider (which resolves against the layer) finds them.
 */
function resolveMdlRelative(modulePath: string | undefined, path: string): string {
  if (!modulePath || path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  return joinPosix(modulePath, path);
}

function withMdlTransform(sv: ShaderValues, texture: ResolvedTexture): ResolvedTexture {
  const transform = mdlTextureTransform(sv);
  return transform ? { ...texture, transform } : texture;
}

/**
 * Resolve a channel's texture, in authoring-strength order: an authored
 * OmniPBR direct asset input, then a `UsdPreviewSurface` input's connection to
 * a `UsdUVTexture` (path + sampler/transform state + connected output
 * channel), then a `texture_2d` value from the `.mdl` declaration.
 */
function findTexture(sv: ShaderValues, lookup: TextureLookup): ResolvedTexture | undefined {
  for (const name of lookup.direct) {
    const texture = directTexture(sv, name);
    if (texture) return texture;
  }
  for (const name of lookup.surface) {
    const conn = sv.shader.GetAttribute(`inputs:${name}`).GetConnections()[0];
    if (!conn) continue;
    const texPrim = sv.shader.GetStage().GetPrimAtPath(conn.split(".")[0] as string);
    if (!texPrim) continue;
    const file = texPrim.GetAttribute("inputs:file").Get();
    if (file instanceof AssetPath && file.path) {
      const tex = readUvTexture(texPrim, file.path);
      const channel = outputChannelOf(conn);
      if (channel) tex.outputChannel = channel;
      return tex;
    }
  }
  for (const name of lookup.direct) {
    const texture = mdlValueTexture(sv, name);
    if (texture) return texture;
  }
  return undefined;
}

/** The `outputs:*` suffix of a connection path, normalized to a channel tag. */
function outputChannelOf(connection: string): ResolvedTexture["outputChannel"] | undefined {
  const m = /\.outputs:(\w+)$/.exec(connection);
  switch (m?.[1]) {
    case "r":
    case "g":
    case "b":
    case "a":
      return m[1];
    case "rgb":
    case "rgba":
      return "rgb";
    default:
      return undefined;
  }
}

/**
 * OmniPBR MDL shader-level UV transform (`inputs:texture_translate` /
 * `texture_rotate` / `texture_scale`) — applies to the shader's textures.
 * Values may come from authored inputs or the `.mdl` declaration.
 */
function mdlTextureTransform(sv: ShaderValues): TextureTransform | undefined {
  const transform: TextureTransform = {};
  const translation = svVec2(sv, "texture_translate");
  if (translation) transform.translation = translation;
  const scale = svVec2(sv, "texture_scale");
  if (scale) transform.scale = scale;
  const rotation = svNumber(sv, "texture_rotate");
  if (rotation !== undefined) transform.rotation = rotation;
  return Object.keys(transform).length > 0 ? transform : undefined;
}

const WRAP_VALUES = new Set(["repeat", "clamp", "mirror", "black"]);

/** Read a `UsdUVTexture` prim's wrap modes, scale/bias, colorspace, and `st` chain. */
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

  const sourceColorSpace = texPrim.GetAttribute("inputs:sourceColorSpace").Get();
  if (sourceColorSpace === "raw" || sourceColorSpace === "sRGB" || sourceColorSpace === "auto") {
    tex.sourceColorSpace = sourceColorSpace;
  }

  const st = readStChain(texPrim);
  if (st.transform) tex.transform = st.transform;
  if (st.uvSet) tex.uvSet = st.uvSet;
  return tex;
}

/** Follow a shader input's connection to its source prim. */
function connectedPrim(prim: Prim, input: string): Prim | null {
  const conn = prim.GetAttribute(input).GetConnections()[0];
  if (!conn) return null;
  return prim.GetStage().GetPrimAtPath(conn.split(".")[0] as string);
}

// The MaterialX `ND_Usd*` compatibility nodes mirror the native node inputs.
const TRANSFORM2D_IDS = new Set(["UsdTransform2d", "ND_UsdTransform2d"]);
const PRIMVAR_READER_IDS = new Set(["UsdPrimvarReader_float2", "ND_UsdPrimvarReader_vector2"]);

/**
 * Walk the `inputs:st` chain: an optional `UsdTransform2d` (translate /
 * rotate / scale) feeding from a `UsdPrimvarReader_float2`, whose
 * `inputs:varname` names the UV set the texture samples.
 */
function readStChain(texPrim: Prim): { transform?: TextureTransform; uvSet?: string } {
  const out: { transform?: TextureTransform; uvSet?: string } = {};
  let node = connectedPrim(texPrim, "inputs:st");
  if (node && TRANSFORM2D_IDS.has(node.GetAttribute("info:id").Get() as string)) {
    const transform: TextureTransform = {};
    const translation = numArray(node, "inputs:translation", 2);
    if (translation) transform.translation = translation as Vec2;
    const scale = numArray(node, "inputs:scale", 2);
    if (scale) transform.scale = scale as Vec2;
    const rotation = node.GetAttribute("inputs:rotation").Get();
    if (typeof rotation === "number") transform.rotation = rotation;
    if (Object.keys(transform).length > 0) out.transform = transform;
    node = connectedPrim(node, "inputs:in");
  }
  if (node && PRIMVAR_READER_IDS.has(node.GetAttribute("info:id").Get() as string)) {
    const varname = node.GetAttribute("inputs:varname").Get();
    if (typeof varname === "string" && varname.length > 0) out.uvSet = varname;
  }
  return out;
}

/** Read a numeric attribute as a fixed-length array, or `undefined`. */
function numArray(prim: Prim, name: string, length: number): number[] | undefined {
  return asVec(prim.GetAttribute(name).Get(), length);
}

/**
 * Resolve the bound material path for `prim` (UsdShade semantics, preview
 * rendering): at each prim, `material:binding:preview` beats the all-purpose
 * `material:binding`. Walking rootward, the nearest binding wins — unless an
 * ancestor authors `bindMaterialAs = "strongerThanDescendants"`, which
 * overrides everything below it (topmost such binding is final).
 */
function findBinding(prim: Prim): string | undefined {
  let chosen: string | undefined;
  let p: Prim | null = prim;
  while (p) {
    for (const name of ["material:binding:preview", "material:binding"]) {
      const rel = p.GetRelationship(name);
      const target = rel.GetTargets()[0];
      if (!target) continue;
      const stronger = rel.GetMetadata("bindMaterialAs") === "strongerThanDescendants";
      if (chosen === undefined || stronger) chosen = target;
      break; // preview found — don't let the all-purpose binding of the same prim override
    }
    p = p.GetParent();
  }
  return chosen;
}

function findSurfaceShader(material: Prim): Prim | undefined {
  // Prefer the shader connected to a surface output.
  for (const out of SURFACE_OUTPUTS) {
    const conn = material.GetAttribute(out).GetConnections()[0];
    if (conn) {
      const shaderPath = conn.split(".")[0] as string;
      const shader = material.GetStage().GetPrimAtPath(shaderPath);
      if (shader) return shader;
    }
  }
  // Fallback: the first child Shader prim.
  return material.GetChildren().find((c) => c.GetTypeName() === "Shader") ?? undefined;
}
