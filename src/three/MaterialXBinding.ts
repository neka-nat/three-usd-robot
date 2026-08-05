/**
 * MaterialX surface networks (M21): natively-authored UsdShade `ND_*` shader
 * graphs resolved into the same flat PBR parameters as `UsdPreviewSurface` —
 * parameter mapping only, no graph execution. `ND_standard_surface_surfaceshader`
 * inputs map onto `ResolvedMaterial`; `ND_image_*` / `ND_tiledimage_*` (with
 * `ND_texcoord_*` / `ND_geompropvalue_*` UV sources and `ND_normalmap`) become
 * `ResolvedTexture`s; constant-only `ND_multiply_*` / `ND_mix_*` /
 * `ND_convert_*` (plus `ND_constant_*` values and the `ND_dot_*` passthrough)
 * fold to values. Any other node (noise, ramps, …) skips just that channel
 * with a warning — the rest of the material stays intact. External `.mtlx`
 * files are not read, and executing node graphs is out of scope (M22
 * delegates that to three's node materials).
 */

import { AssetPath, type Vec2, type Vec3 } from "../parser/ast.js";
import type { Prim } from "../usd/Prim.js";
import type {
  ResolvedMaterial,
  ResolvedTexture,
  TextureTransform,
  TextureWrap,
} from "./MaterialBinding.js";

/** The Autodesk standard-surface MaterialX nodedef. */
export const MTLX_STANDARD_SURFACE = "ND_standard_surface_surfaceshader";
/** The UsdPreviewSurface compatibility nodedef — same input names, so the
 * generic `UsdPreviewSurface` reads in `MaterialBinding.ts` handle it. */
export const MTLX_USD_PREVIEW_SURFACE = "ND_UsdPreviewSurface_surfaceshader";

type OnWarn = ((message: string) => void) | undefined;

/** A MaterialX input resolved without executing the graph. */
type MtlxResolved =
  | { kind: "value"; value: unknown }
  | { kind: "texture"; texture: ResolvedTexture };

/** Nodedef default `base_color` — used when only `base` is authored. */
const DEFAULT_BASE_COLOR: Vec3 = [0.8, 0.8, 0.8];

/**
 * Read an `ND_standard_surface_surfaceshader` into `result`. Only authored
 * inputs are mapped (unauthored ⇒ three.js defaults), with two nodedef-default
 * exceptions: `base` alone multiplies the default 0.8-gray `base_color`, and
 * `emission` (default weight 0) gates `emission_color`.
 */
export function readStandardSurface(shader: Prim, result: ResolvedMaterial, onWarn?: OnWarn): void {
  const input = (name: string) => resolveMtlxInput(shader, name, onWarn);

  // `base × base_color` → color. three multiplies material.color into the
  // map, so a textured base_color keeps `base` as a gray multiplier.
  const base = numberOf(input("base"));
  const baseColor = input("base_color");
  if (baseColor?.kind === "texture") {
    result.colorTexture = baseColor.texture;
    if (base !== undefined) result.color = [base, base, base];
  } else {
    const color = colorOf(baseColor) ?? (base !== undefined ? DEFAULT_BASE_COLOR : undefined);
    if (color) {
      const weight = base ?? 1;
      result.color = [color[0] * weight, color[1] * weight, color[2] * weight];
    }
  }

  const metalness = input("metalness");
  if (metalness?.kind === "texture") result.metalnessTexture = metalness.texture;
  const metalnessValue = numberOf(metalness);
  if (metalnessValue !== undefined) result.metalness = metalnessValue;

  const roughness = input("specular_roughness");
  if (roughness?.kind === "texture") result.roughnessTexture = roughness.texture;
  const roughnessValue = numberOf(roughness);
  if (roughnessValue !== undefined) result.roughness = roughnessValue;

  // Physical-promotion inputs (M19 rule: promote only when authored).
  const ior = numberOf(input("specular_IOR"));
  if (ior !== undefined) result.ior = ior;
  const transmission = numberOf(input("transmission"));
  if (transmission !== undefined) result.transmission = transmission;
  const coat = numberOf(input("coat"));
  if (coat !== undefined) {
    result.clearcoat = coat;
    const coatRoughness = numberOf(input("coat_roughness"));
    if (coatRoughness !== undefined) result.clearcoatRoughness = coatRoughness;
  }

  // `emission` is a weight gating `emission_color`.
  const emission = numberOf(input("emission"));
  if (emission !== undefined && emission > 0) {
    const emissionColor = input("emission_color");
    if (emissionColor?.kind === "texture") result.emissiveTexture = emissionColor.texture;
    result.emissiveColor = colorOf(emissionColor) ?? [1, 1, 1];
    result.emissiveIntensity = emission;
  }

  // standard_surface `opacity` is a color3 — three's scalar opacity takes the mean.
  const opacity = input("opacity");
  if (opacity?.kind === "texture") result.opacityTexture = opacity.texture;
  const opacityValue = numberOf(opacity) ?? mean3(colorOf(opacity));
  if (opacityValue !== undefined) result.opacity = opacityValue;

  const normal = input("normal");
  if (normal?.kind === "texture") result.normalTexture = normal.texture;
}

function resolveMtlxInput(shader: Prim, name: string, onWarn: OnWarn): MtlxResolved | undefined {
  return followMtlxInput(shader, name, name, onWarn, 0);
}

/** Resolve `inputs:<name>` — a connected node (recursively) or an authored value. */
function followMtlxInput(
  prim: Prim,
  name: string,
  channel: string,
  onWarn: OnWarn,
  depth: number,
): MtlxResolved | undefined {
  const attr = prim.GetAttribute(`inputs:${name}`);
  const connection = attr.GetConnections()[0];
  if (connection) {
    const source = prim.GetStage().GetPrimAtPath(connection.split(".")[0] as string);
    return source ? resolveMtlxNode(source, channel, onWarn, depth + 1) : undefined;
  }
  const value = attr.Get();
  return value === undefined ? undefined : { kind: "value", value };
}

/** Fold-recursion guard — real MaterialX graphs are shallow; cycles are authoring errors. */
const MAX_NODE_DEPTH = 8;

function resolveMtlxNode(
  node: Prim,
  channel: string,
  onWarn: OnWarn,
  depth: number,
): MtlxResolved | undefined {
  const id = node.GetAttribute("info:id").Get();
  if (typeof id !== "string" || depth > MAX_NODE_DEPTH) {
    onWarn?.(`${node.GetPath()}: unresolvable MaterialX node; skipping the "${channel}" channel`);
    return undefined;
  }
  if (id.startsWith("ND_image_") || id.startsWith("ND_tiledimage_")) {
    const texture = readMtlxImage(node, id.startsWith("ND_tiledimage_"));
    return texture ? { kind: "texture", texture } : undefined;
  }
  if (id.startsWith("ND_normalmap")) {
    const resolved = followMtlxInput(node, "in", channel, onWarn, depth);
    if (resolved?.kind !== "texture") return resolved;
    const scale = node.GetAttribute("inputs:scale").Get();
    if (typeof scale === "number") {
      // ResolvedTexture.scale follows the UsdUVTexture normal convention
      // (2 ≙ identity — MeshBinding halves it into normalScale).
      resolved.texture.scale = [2 * scale, 2 * scale, 2 * scale, 1];
    }
    return resolved;
  }
  if (id.startsWith("ND_constant_")) {
    const value = node.GetAttribute("inputs:value").Get();
    return value === undefined ? undefined : { kind: "value", value };
  }
  if (id.startsWith("ND_dot_")) {
    return followMtlxInput(node, "in", channel, onWarn, depth);
  }
  if (id.startsWith("ND_convert_")) {
    const resolved = followMtlxInput(node, "in", channel, onWarn, depth);
    if (resolved?.kind !== "value") return resolved;
    return { kind: "value", value: convertMtlxValue(resolved.value, id) };
  }
  if (id.startsWith("ND_multiply_")) {
    const in1 = operand(node, "in1", undefined, channel, onWarn, depth);
    const in2 = operand(node, "in2", [1], channel, onWarn, depth);
    const value = in1 && in2 ? broadcast([in1, in2], ([a, b]) => a! * b!) : undefined;
    return value ? { kind: "value", value: scalarize(value) } : undefined;
  }
  if (id.startsWith("ND_mix_")) {
    const bg = operand(node, "bg", [0], channel, onWarn, depth);
    const fg = operand(node, "fg", [0], channel, onWarn, depth);
    const mix = operand(node, "mix", [0], channel, onWarn, depth);
    const value =
      bg && fg && mix
        ? broadcast([fg, bg, mix], ([f, b, m]) => f! * m! + b! * (1 - m!))
        : undefined;
    return value ? { kind: "value", value: scalarize(value) } : undefined;
  }
  onWarn?.(
    `${node.GetPath()}: MaterialX node "${id}" needs graph execution; skipping the "${channel}" channel`,
  );
  return undefined;
}

/** MaterialX `uaddressmode`/`vaddressmode` → three-representable wrap modes. */
const MTLX_WRAP: Record<string, TextureWrap> = {
  periodic: "repeat",
  clamp: "clamp",
  mirror: "mirror",
  constant: "black", // no border-color sampling in three — clamp-to-black is closest
};

/** Also consumed by the TSL factory in `three-usd-robot/nodes` (M22). */
export function readMtlxImage(node: Prim, tiled: boolean): ResolvedTexture | undefined {
  const file = node.GetAttribute("inputs:file").Get();
  if (!(file instanceof AssetPath) || !file.path) return undefined;
  const texture: ResolvedTexture = { path: file.path };
  if (tiled) {
    // `tiledimage` repeats by construction; uvtiling/uvoffset are the transform.
    texture.wrapS = "repeat";
    texture.wrapT = "repeat";
    const transform: TextureTransform = {};
    const tiling = vec2Of(node.GetAttribute("inputs:uvtiling").Get());
    if (tiling) transform.scale = tiling;
    const offset = vec2Of(node.GetAttribute("inputs:uvoffset").Get());
    if (offset) transform.translation = offset;
    if (transform.scale || transform.translation) texture.transform = transform;
  } else {
    const uaddress = node.GetAttribute("inputs:uaddressmode").Get();
    const wrapS = typeof uaddress === "string" ? MTLX_WRAP[uaddress] : undefined;
    if (wrapS) texture.wrapS = wrapS;
    const vaddress = node.GetAttribute("inputs:vaddressmode").Get();
    const wrapT = typeof vaddress === "string" ? MTLX_WRAP[vaddress] : undefined;
    if (wrapT) texture.wrapT = wrapT;
  }
  readMtlxTexcoord(node, texture);
  return texture;
}

/** `inputs:texcoord` source: a UV-set index (`ND_texcoord_*`) or primvar name (`ND_geompropvalue_*`). */
function readMtlxTexcoord(node: Prim, texture: ResolvedTexture): void {
  const connection = node.GetAttribute("inputs:texcoord").GetConnections()[0];
  if (!connection) return;
  const source = node.GetStage().GetPrimAtPath(connection.split(".")[0] as string);
  const id = source?.GetAttribute("info:id").Get();
  if (!source || typeof id !== "string") return;
  if (id.startsWith("ND_texcoord_")) {
    const index = source.GetAttribute("inputs:index").Get();
    if (typeof index === "number" && index > 0) texture.uvChannel = index;
  } else if (id.startsWith("ND_geompropvalue_")) {
    const geomprop = source.GetAttribute("inputs:geomprop").Get();
    if (typeof geomprop === "string" && geomprop.length > 0) texture.uvSet = geomprop;
  }
}

/**
 * A fold node's operand as numbers: an authored constant, a folded upstream
 * value, or `fallback` when unauthored. Textured / unsupported operands make
 * the fold fail (`undefined`) — this is constant folding only.
 */
function operand(
  node: Prim,
  name: string,
  fallback: number[] | undefined,
  channel: string,
  onWarn: OnWarn,
  depth: number,
): number[] | undefined {
  const attr = node.GetAttribute(`inputs:${name}`);
  if (!attr.GetConnections()[0]) {
    const value = attr.Get();
    return value === undefined ? fallback : numsOf(value);
  }
  const resolved = followMtlxInput(node, name, channel, onWarn, depth);
  if (resolved?.kind === "value") return numsOf(resolved.value);
  if (resolved?.kind === "texture") {
    onWarn?.(
      `${node.GetPath()}: constant folding cannot take a textured "${name}"; skipping the "${channel}" channel`,
    );
  }
  return undefined; // unsupported sources have already warned
}

/** Component counts by MaterialX type-name suffix (`ND_convert_float_color3`). */
const MTLX_TYPE_SIZE: Record<string, number> = {
  float: 1,
  integer: 1,
  boolean: 1,
  vector2: 2,
  color3: 3,
  vector3: 3,
  color4: 4,
  vector4: 4,
};

function convertMtlxValue(value: unknown, id: string): unknown {
  const target = id.split("_").pop() ?? "";
  const size = MTLX_TYPE_SIZE[target];
  const nums = numsOf(value);
  if (!size || !nums) return value;
  if (size === 1) return nums[0];
  // Broadcast scalars; pad a color4 alpha with 1, anything else with 0.
  return Array.from({ length: size }, (_, i) =>
    i < nums.length
      ? nums[i]
      : nums.length === 1
        ? nums[0]
        : target === "color4" && i === 3
          ? 1
          : 0,
  );
}

/** Componentwise op with single-component broadcast (the `*FA` node variants). */
function broadcast(
  operands: number[][],
  op: (components: (number | undefined)[]) => number,
): number[] | undefined {
  const length = Math.max(...operands.map((o) => o.length));
  if (operands.some((o) => o.length !== 1 && o.length !== length)) return undefined;
  return Array.from({ length }, (_, i) => op(operands.map((o) => (o.length === 1 ? o[0] : o[i]))));
}

function scalarize(value: number[]): number | number[] {
  return value.length === 1 ? (value[0] as number) : value;
}

function numsOf(value: unknown): number[] | undefined {
  if (typeof value === "number") return [value];
  if (Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number")) {
    return value as number[];
  }
  return undefined;
}

function numberOf(resolved: MtlxResolved | undefined): number | undefined {
  if (resolved?.kind !== "value") return undefined;
  const v = resolved.value;
  if (typeof v === "number") return v;
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === "number") return v[0];
  return undefined;
}

function colorOf(resolved: MtlxResolved | undefined): Vec3 | undefined {
  if (resolved?.kind !== "value") return undefined;
  const v = resolved.value;
  if (typeof v === "number") return [v, v, v];
  if (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === "number")) {
    return [v[0], v[1], v[2]] as Vec3;
  }
  return undefined;
}

function mean3(v: Vec3 | undefined): number | undefined {
  return v ? (v[0] + v[1] + v[2]) / 3 : undefined;
}

function vec2Of(value: unknown): Vec2 | undefined {
  return Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
    ? [value[0], value[1]]
    : undefined;
}
