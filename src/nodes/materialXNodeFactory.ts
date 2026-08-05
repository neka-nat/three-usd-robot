/**
 * MaterialX → TSL conversion (M22): executes natively-authored UsdShade
 * `ND_*` shader graphs — the procedural nodes the M21 parameter mapping can
 * only warn about — by building a three.js `MeshPhysicalNodeMaterial`
 * (WebGPURenderer). Plugs into the core through the `materialFactory` hook;
 * any node outside the conversion table makes the factory return `null` with
 * a warning, so the material falls back to the M21 parameter mapping. MDL
 * remains out of scope (a language, not a graph — executing it needs an MDL
 * SDK-class compiler).
 */

import * as TSL from "three/tsl";
import type { ShaderNodeObject } from "three/tsl";
import { MeshPhysicalNodeMaterial, type Node } from "three/webgpu";
import { findBoundSurfaceShader } from "../three/MaterialBinding.js";
import { MTLX_STANDARD_SURFACE, readMtlxImage } from "../three/MaterialXBinding.js";
import type { MaterialFactory } from "../three/MeshBinding.js";
import type { TextureProvider } from "../three/TextureBinding.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";

export type MaterialXNodeFactoryOptions = {
  /** Resolves image-node asset paths to `THREE.Texture` (reuse the core provider). */
  textureProvider?: TextureProvider;
  /** Receives diagnostics: graphs that fall back to the M21 parameter mapping. */
  onWarn?: (message: string) => void;
};

/**
 * A {@link MaterialFactory} that converts `ND_standard_surface_surfaceshader`
 * networks to TSL node materials. Returns `null` (⇒ the default `UsdShade`
 * resolution) for every other material, and — with a warning — for graphs
 * containing nodes outside the conversion table.
 */
export function createMaterialXNodeFactory(
  options: MaterialXNodeFactoryOptions = {},
): MaterialFactory {
  return (prim, stage) => {
    const shader = findBoundSurfaceShader(stage, prim);
    if (!shader || shader.GetAttribute("info:id").Get() !== MTLX_STANDARD_SURFACE) return null;
    try {
      return buildStandardSurfaceNodeMaterial(shader, options.textureProvider);
    } catch (error) {
      if (error instanceof UnsupportedMtlxNodeError) {
        options.onWarn?.(
          `${prim.GetPath()}: ${error.message}; falling back to the parameter mapping`,
        );
        return null;
      }
      throw error;
    }
  };
}

/** A TSL node plus its component count (drives broadcasts and conversions). */
type TslNode = ShaderNodeObject<Node>;
type Size = 1 | 2 | 3 | 4;
type TslValue = { node: TslNode; size: Size };

/** Walking hit a node/input the conversion table cannot express. */
class UnsupportedMtlxNodeError extends Error {}

type BuildContext = {
  stage: Stage;
  textures: TextureProvider | undefined;
  /** Converted node outputs by `path.output` — preserves shared subgraphs. */
  cache: Map<string, TslValue>;
};

/**
 * Convert one `ND_standard_surface_surfaceshader` prim into a
 * `MeshPhysicalNodeMaterial`. Only authored inputs are mapped (unauthored ⇒
 * three.js defaults, matching the M21 rule); throws
 * `UnsupportedMtlxNodeError` when the graph leaves the conversion table.
 */
export function buildStandardSurfaceNodeMaterial(
  shader: Prim,
  textureProvider?: TextureProvider,
): MeshPhysicalNodeMaterial {
  const ctx: BuildContext = {
    stage: shader.GetStage(),
    textures: textureProvider,
    cache: new Map(),
  };
  const input = (name: string) => inputValue(shader, name, ctx, 0);
  const material = new MeshPhysicalNodeMaterial();

  // `base × base_color` → color (nodedef default base_color is 0.8 gray).
  const base = input("base");
  const baseColor = input("base_color");
  if (baseColor) {
    material.colorNode = base ? TSL.mul(base.node, baseColor.node) : baseColor.node;
  } else if (base) {
    material.colorNode = TSL.mul(base.node, TSL.color(0.8, 0.8, 0.8));
  }

  const metalness = input("metalness");
  if (metalness) material.metalnessNode = toFloat(metalness);
  const roughness = input("specular_roughness");
  if (roughness) material.roughnessNode = toFloat(roughness);
  const ior = input("specular_IOR");
  if (ior) material.iorNode = toFloat(ior);
  const transmission = input("transmission");
  if (transmission) material.transmissionNode = toFloat(transmission);
  const coat = input("coat");
  if (coat) material.clearcoatNode = toFloat(coat);
  const coatRoughness = input("coat_roughness");
  if (coatRoughness) material.clearcoatRoughnessNode = toFloat(coatRoughness);

  const emission = input("emission");
  if (emission) {
    const emissionColor = input("emission_color");
    material.emissiveNode = emissionColor
      ? TSL.mul(emission.node, emissionColor.node)
      : emission.node;
  }

  const opacity = input("opacity");
  if (opacity) {
    material.opacityNode = toFloat(opacity);
    material.transparent = true;
  }

  const normal = input("normal");
  if (normal) material.normalNode = normal.node;

  return material;
}

/** Scalar view of a value — vectors average their components (color3 opacity). */
function toFloat(value: TslValue): TslNode {
  const n = value.node;
  if (value.size === 1) return n;
  if (value.size === 2) return TSL.add(n.x, n.y).div(2);
  if (value.size === 3) return TSL.add(n.x, n.y, n.z).div(3);
  return TSL.add(n.x, n.y, n.z, n.w).div(4);
}

/** Resolve `inputs:<name>` — a connected node (recursively) or an authored constant. */
function inputValue(prim: Prim, name: string, ctx: BuildContext, depth: number): TslValue | null {
  const attr = prim.GetAttribute(`inputs:${name}`);
  const connection = attr.GetConnections()[0];
  if (connection) {
    const [path, output] = splitConnection(connection);
    const source = ctx.stage.GetPrimAtPath(path);
    if (!source) throw new UnsupportedMtlxNodeError(`unresolvable connection "${connection}"`);
    return nodeValue(source, output, ctx, depth + 1);
  }
  const value = attr.Get();
  if (value === undefined) return null;
  return constantValue(value, attr.GetTypeName());
}

function splitConnection(connection: string): [string, string] {
  const dot = connection.indexOf(".");
  if (dot < 0) return [connection, "out"];
  return [connection.slice(0, dot), connection.slice(dot + 1).replace(/^outputs:/, "")];
}

/** An authored USD value as a TSL constant (`color3f` → `color`, else vectors). */
function constantValue(value: unknown, typeName: string): TslValue {
  if (typeof value === "number") return { node: TSL.float(value), size: 1 };
  if (typeof value === "boolean") return { node: TSL.float(value ? 1 : 0), size: 1 };
  if (Array.isArray(value) && value.every((n) => typeof n === "number")) {
    const [x = 0, y = 0, z = 0, w = 0] = value as number[];
    if (value.length === 2) return { node: TSL.vec2(x, y), size: 2 };
    if (value.length === 3) {
      const isColor = typeName.toLowerCase().includes("color");
      return { node: isColor ? TSL.color(x, y, z) : TSL.vec3(x, y, z), size: 3 };
    }
    if (value.length === 4) return { node: TSL.vec4(x, y, z, w), size: 4 };
  }
  throw new UnsupportedMtlxNodeError(`unsupported constant value type "${typeName}"`);
}

/** Component counts by MaterialX type suffix (incl. the `*FA` mixed variants). */
const TYPE_SIZE: Record<string, Size> = {
  float: 1,
  integer: 1,
  boolean: 1,
  vector2: 2,
  vector2FA: 2,
  color3: 3,
  color3FA: 3,
  vector3: 3,
  vector3FA: 3,
  color4: 4,
  color4FA: 4,
  vector4: 4,
  vector4FA: 4,
};

/** `ND_noise2d_color3` → op `noise2d`, size 3, type token `color3`. */
function parseNodeId(id: string): { op: string; size: Size; type: string } {
  const body = id.startsWith("ND_") ? id.slice(3) : id;
  const cut = body.lastIndexOf("_");
  if (cut > 0) {
    const type = body.slice(cut + 1);
    const size = TYPE_SIZE[type];
    if (size) return { op: body.slice(0, cut), size, type };
  }
  return { op: body, size: 1, type: "float" };
}

const UNARY: Record<string, (n: TslNode) => TslNode> = {
  absval: TSL.abs,
  floor: TSL.floor,
  ceil: TSL.ceil,
  sin: TSL.sin,
  cos: TSL.cos,
  tan: TSL.tan,
  exp: TSL.exp,
  ln: TSL.log,
  sqrt: TSL.sqrt,
  sign: TSL.sign,
  normalize: TSL.normalize,
};

const BINARY: Record<string, { fn: (a: TslNode, b: TslNode) => TslNode; neutral: number }> = {
  add: { fn: TSL.add, neutral: 0 },
  subtract: { fn: TSL.sub, neutral: 0 },
  multiply: { fn: TSL.mul, neutral: 1 },
  divide: { fn: TSL.div, neutral: 1 },
  power: { fn: TSL.pow, neutral: 1 },
  modulo: { fn: TSL.mod, neutral: 1 },
  min: { fn: TSL.min, neutral: 0 },
  max: { fn: TSL.max, neutral: 0 },
};

const COMPONENTS = ["x", "y", "z", "w"] as const;
/** `outx`/`outr` → 0, `outy`/`outg` → 1, … (separate-node output names). */
const OUTPUT_COMPONENT: Record<string, number> = {
  outx: 0,
  outy: 1,
  outz: 2,
  outw: 3,
  outr: 0,
  outg: 1,
  outb: 2,
  outa: 3,
};

function component(node: TslNode, index: number): TslNode {
  return node[COMPONENTS[Math.max(0, Math.min(index, 3))] as "x"];
}

/** Recursion guard — real MaterialX graphs are shallow; cycles are authoring errors. */
const MAX_NODE_DEPTH = 16;

/** Convert one MaterialX node prim's `output` into a TSL value (cached). */
function nodeValue(node: Prim, output: string, ctx: BuildContext, depth: number): TslValue {
  const key = `${node.GetPath()}.${output}`;
  const cached = ctx.cache.get(key);
  if (cached) return cached;
  if (depth > MAX_NODE_DEPTH) {
    throw new UnsupportedMtlxNodeError(`graph too deep at ${node.GetPath()} (cycle?)`);
  }
  const value = convertNode(node, output, ctx, depth);
  ctx.cache.set(key, value);
  return value;
}

function convertNode(node: Prim, output: string, ctx: BuildContext, depth: number): TslValue {
  const id = node.GetAttribute("info:id").Get();
  if (typeof id !== "string") {
    throw new UnsupportedMtlxNodeError(`${node.GetPath()} has no info:id`);
  }
  const { op, size, type } = parseNodeId(id);
  const opt = (name: string) => inputValue(node, name, ctx, depth);
  const req = (name: string) => {
    const value = opt(name);
    if (!value) throw new UnsupportedMtlxNodeError(`node "${id}" is missing input "${name}"`);
    return value;
  };
  const scalar = (name: string, fallback: number) =>
    opt(name) ?? { node: TSL.float(fallback), size: 1 as Size };

  // ---- images (procedural UV warps ride the texcoord connection)
  if (op === "image" || op === "tiledimage") {
    return imageValue(node, op === "tiledimage", size, type, ctx, depth);
  }

  // ---- math
  const unary = UNARY[op];
  if (unary) {
    const in_ = req("in");
    return { node: unary(in_.node), size: in_.size };
  }
  const binary = BINARY[op];
  if (binary) {
    const in1 = req("in1");
    const in2 = scalar("in2", binary.neutral);
    return { node: binary.fn(in1.node, in2.node), size: maxSize(in1, in2) };
  }
  switch (op) {
    case "invert": {
      const in_ = req("in");
      return { node: TSL.sub(scalar("amount", 1).node, in_.node), size: in_.size };
    }
    case "magnitude":
      return { node: TSL.length(req("in").node), size: 1 };
    case "dotproduct":
      return { node: TSL.dot(req("in1").node, req("in2").node), size: 1 };
    case "crossproduct":
      return { node: TSL.cross(req("in1").node, req("in2").node), size: 3 };
    case "clamp": {
      const in_ = req("in");
      const node = TSL.clamp(in_.node, scalar("low", 0).node, scalar("high", 1).node);
      return { node, size: in_.size };
    }
    case "mix": {
      const bg = scalar("bg", 0);
      const fg = scalar("fg", 0);
      // MaterialX mix: out = fg×mix + bg×(1−mix) ⇒ TSL mix(bg, fg, t).
      return { node: TSL.mix(bg.node, fg.node, scalar("mix", 0).node), size: maxSize(bg, fg) };
    }
    case "smoothstep": {
      const in_ = req("in");
      const node = TSL.smoothstep(scalar("low", 0).node, scalar("high", 1).node, in_.node);
      return { node, size: in_.size };
    }
    case "remap": {
      const in_ = req("in");
      const node = TSL.remap(
        in_.node,
        scalar("inlow", 0).node,
        scalar("inhigh", 1).node,
        scalar("outlow", 0).node,
        scalar("outhigh", 1).node,
      );
      return { node, size: in_.size };
    }
    case "ifgreater": {
      const in1 = req("in1");
      const in2 = scalar("in2", 0);
      const cond = TSL.greaterThan(scalar("value1", 1).node, scalar("value2", 0).node);
      return { node: TSL.select(cond, in1.node, in2.node), size: maxSize(in1, in2) };
    }

    // ---- ramps & splits
    case "ramplr":
    case "ramptb": {
      const l = scalar(op === "ramplr" ? "valuel" : "valuet", 0);
      const r = scalar(op === "ramplr" ? "valuer" : "valueb", 0);
      const fn = op === "ramplr" ? TSL.mx_ramplr : TSL.mx_ramptb;
      return { node: fn(l.node, r.node, texcoordOf(node, ctx, depth)), size: maxSize(l, r) };
    }
    case "splitlr":
    case "splittb": {
      const l = scalar(op === "splitlr" ? "valuel" : "valuet", 0);
      const r = scalar(op === "splitlr" ? "valuer" : "valueb", 0);
      const fn = op === "splitlr" ? TSL.mx_splitlr : TSL.mx_splittb;
      const split = fn(l.node, r.node, scalar("center", 0.5).node, texcoordOf(node, ctx, depth));
      return { node: split, size: maxSize(l, r) };
    }

    // ---- noise
    case "noise2d":
    case "noise3d": {
      const coord =
        opt("texcoord")?.node ??
        opt("position")?.node ??
        (op === "noise2d" ? TSL.uv() : TSL.positionLocal);
      const amplitude = scalar("amplitude", 1).node;
      const pivot = scalar("pivot", 0).node;
      if (size === 1) return { node: TSL.mx_noise_float(coord, amplitude, pivot), size: 1 };
      if (size === 4) return { node: TSL.mx_noise_vec4(coord, amplitude, pivot), size: 4 };
      const vec3Noise = TSL.mx_noise_vec3(coord, amplitude, pivot);
      return size === 2 ? { node: vec3Noise.xy, size: 2 } : { node: vec3Noise, size: 3 };
    }
    case "fractal3d": {
      const position = opt("position")?.node ?? TSL.positionLocal;
      const octaves = scalar("octaves", 3).node;
      const lacunarity = scalar("lacunarity", 2).node;
      const diminish = scalar("diminish", 0.5).node;
      const amplitude = scalar("amplitude", 1).node;
      const fn =
        size === 1
          ? TSL.mx_fractal_noise_float
          : size === 2
            ? TSL.mx_fractal_noise_vec2
            : size === 4
              ? TSL.mx_fractal_noise_vec4
              : TSL.mx_fractal_noise_vec3;
      return { node: fn(position, octaves, lacunarity, diminish, amplitude), size };
    }
    case "cellnoise2d":
    case "cellnoise3d":
      return { node: TSL.mx_cell_noise_float(texcoordOf(node, ctx, depth)), size: 1 };
    case "worleynoise2d":
    case "worleynoise3d": {
      const coord = texcoordOf(node, ctx, depth);
      const jitter = scalar("jitter", 1).node;
      const fn =
        size === 2
          ? TSL.mx_worley_noise_vec2
          : size === 3
            ? TSL.mx_worley_noise_vec3
            : TSL.mx_worley_noise_float;
      return { node: fn(coord, jitter), size: size === 2 || size === 3 ? size : 1 };
    }

    // ---- color
    case "hsvtorgb":
      return { node: TSL.mx_hsvtorgb(req("in").node), size: 3 };
    case "rgbtohsv":
      return { node: TSL.mx_rgbtohsv(req("in").node), size: 3 };
    case "luminance":
      return { node: TSL.luminance(req("in").node), size: 1 };
    case "saturate": {
      const in_ = req("in");
      return { node: TSL.saturation(in_.node, scalar("amount", 1).node), size: in_.size };
    }
    case "contrast": {
      const in_ = req("in");
      const node = TSL.mx_contrast(in_.node, scalar("amount", 1).node, scalar("pivot", 0.5).node);
      return { node, size: in_.size };
    }

    // ---- geometry & time
    case "texcoord":
      return { node: TSL.uv(intInput(node, "index")), size: 2 };
    case "geompropvalue": {
      const geomprop = node.GetAttribute("inputs:geomprop").Get();
      const match = typeof geomprop === "string" ? /^st(\d*)$/.exec(geomprop) : null;
      if (!match) {
        throw new UnsupportedMtlxNodeError(`geomprop "${String(geomprop)}" has no TSL mapping`);
      }
      return { node: TSL.uv(match[1] ? Number(match[1]) : 0), size: 2 };
    }
    case "position":
      return {
        node:
          node.GetAttribute("inputs:space").Get() === "world"
            ? TSL.positionWorld
            : TSL.positionLocal,
        size: 3,
      };
    case "normal":
      return {
        node:
          node.GetAttribute("inputs:space").Get() === "world" ? TSL.normalWorld : TSL.normalLocal,
        size: 3,
      };
    case "time":
      return { node: TSL.time, size: 1 };

    // ---- plumbing
    case "constant":
      return req("value");
    case "dot":
      return req("in");
    case "combine2":
      return { node: TSL.vec2(req("in1").node, req("in2").node), size: 2 };
    case "combine3": {
      const node3 = TSL.vec3(req("in1").node, req("in2").node, req("in3").node);
      return { node: node3, size: 3 };
    }
    case "combine4": {
      const node4 = TSL.vec4(req("in1").node, req("in2").node, req("in3").node, req("in4").node);
      return { node: node4, size: 4 };
    }
    case "extract":
      return { node: component(req("in").node, intInput(node, "index")), size: 1 };
    case "separate2":
    case "separate3":
    case "separate4":
      return { node: component(req("in").node, OUTPUT_COMPONENT[output] ?? 0), size: 1 };
    case "normalmap": {
      const in_ = req("in");
      const scale = opt("scale");
      const scaleNode = scale
        ? scale.size === 1
          ? TSL.vec2(scale.node, scale.node)
          : scale.node
        : undefined;
      return {
        node: scaleNode ? TSL.normalMap(in_.node, scaleNode) : TSL.normalMap(in_.node),
        size: 3,
      };
    }
    default:
      break;
  }
  if (op.startsWith("convert")) {
    return resize(req("in"), size);
  }
  throw new UnsupportedMtlxNodeError(`MaterialX node "${id}" has no TSL conversion`);
}

function maxSize(a: TslValue, b: TslValue): Size {
  return (a.size >= b.size ? a.size : b.size) as Size;
}

function intInput(node: Prim, name: string): number {
  const value = node.GetAttribute(`inputs:${name}`).Get();
  return typeof value === "number" ? value : 0;
}

/** Change a value's component count (broadcast scalars, pad with 0 / alpha 1). */
function resize(value: TslValue, size: Size): TslValue {
  if (value.size === size) return value;
  const n = value.node;
  if (size === 1) return { node: value.size === 1 ? n : n.x, size: 1 };
  if (value.size === 1) {
    const node =
      size === 2 ? TSL.vec2(n, n) : size === 3 ? TSL.vec3(n, n, n) : TSL.vec4(n, n, n, n);
    return { node, size };
  }
  if (size === 2) return { node: n.xy, size: 2 };
  if (size === 3) return { node: value.size === 4 ? n.xyz : TSL.vec3(n.x, n.y, 0), size: 3 };
  return { node: TSL.vec4(resize(value, 3).node, 1), size: 4 };
}

/** An image node's `texcoord` input as a TSL coord (default `uv()`). */
function texcoordOf(node: Prim, ctx: BuildContext, depth: number): TslNode {
  return inputValue(node, "texcoord", ctx, depth)?.node ?? TSL.uv();
}

/**
 * `ND_image_*` / `ND_tiledimage_*` → a TSL texture sample. Static sampler
 * state (wrap, uvtiling, texcoord index) reuses the M21 reader and the core
 * texture provider; a *computed* `texcoord` connection becomes the sample's
 * uv node — the procedural-warp case the parameter mapping cannot express.
 */
function imageValue(
  node: Prim,
  tiled: boolean,
  size: Size,
  type: string,
  ctx: BuildContext,
  depth: number,
): TslValue {
  const rt = readMtlxImage(node, tiled);
  if (!rt) throw new UnsupportedMtlxNodeError(`image node ${node.GetPath()} authors no file`);
  if (!ctx.textures) {
    throw new UnsupportedMtlxNodeError(`no texture provider for "${rt.path}"`);
  }
  let channel = rt.uvChannel;
  if (rt.uvSet !== undefined) {
    // Without the mesh at hand, primvar names resolve like the geompropvalue
    // node: `st`/`stN` → channel N; anything else needs the parameter mapping.
    const match = /^st(\d*)$/.exec(rt.uvSet);
    if (!match) {
      throw new UnsupportedMtlxNodeError(`UV set "${rt.uvSet}" needs mesh primvar resolution`);
    }
    channel = match[1] ? Number(match[1]) : 0;
  }
  const texture = ctx.textures(rt.path, {
    colorSpace: type.startsWith("color") ? "srgb" : "linear",
    ...(rt.wrapS ? { wrapS: rt.wrapS } : {}),
    ...(rt.wrapT ? { wrapT: rt.wrapT } : {}),
    ...(rt.transform ? { transform: rt.transform } : {}),
    ...(channel ? { channel } : {}),
  });
  if (!texture) throw new UnsupportedMtlxNodeError(`texture "${rt.path}" failed to load`);

  // A texcoord connection to anything but the static UV readers is a
  // computed coordinate — feed it to the sampler as the uv node.
  let uvNode: TslNode | undefined;
  const connection = node.GetAttribute("inputs:texcoord").GetConnections()[0];
  if (connection) {
    const [path, output] = splitConnection(connection);
    const source = ctx.stage.GetPrimAtPath(path);
    const sourceId = source?.GetAttribute("info:id").Get();
    if (
      source &&
      typeof sourceId === "string" &&
      !sourceId.startsWith("ND_texcoord_") &&
      !sourceId.startsWith("ND_geompropvalue_")
    ) {
      uvNode = nodeValue(source, output, ctx, depth + 1).node;
    }
  }
  const sample = uvNode ? TSL.texture(texture, uvNode) : TSL.texture(texture);
  if (size === 1) return { node: sample.r, size: 1 };
  if (size === 2) return { node: sample.xy, size: 2 };
  if (size === 4) return { node: sample.rgba, size: 4 };
  return { node: sample.rgb, size: 3 };
}
