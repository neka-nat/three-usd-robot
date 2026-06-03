/**
 * Minimal USD composition: flattens references, payloads, sublayers, variant
 * selections, and internal (intra-layer) reference/inherit arcs into a single
 * {@link UsdaFile} so the rest of the pipeline keeps working on one layer.
 *
 * Scope: the arcs robots actually use. References/payloads/inherits pull a prim
 * subtree (weaker than local opinions); a `variants` selection grafts the chosen
 * variant's content; internal arcs (`</Path>` with no asset) resolve within the
 * same layer — which is what `instanceable` prims use to pull a prototype.
 * Specializes ordering and live instancing are approximated. Not a full LIVRPS
 * engine — a pragmatic flattener.
 */

import {
  AssetPath,
  type AttributeSpec,
  type CompositionArc,
  type MetadataMap,
  type PrimSpec,
  type PropertySpec,
  Quat,
  UsdMatrix,
  type UsdValue,
  type UsdaFile,
} from "../parser/ast.js";
import { parseUsda } from "../parser/parseUsda.js";
import type { AssetResolver } from "./AssetResolver.js";

export type ComposeOptions = {
  onWarn?: (message: string) => void;
  /** Guard against pathological recursion (default 64). */
  maxDepth?: number;
};

/** Prim-metadata keys that pull external or internal prim content. */
const ARC_KEYS = ["references", "payload", "payloads", "inherits", "specializes"] as const;
/** Layer + prim metadata keys stripped from the flattened output. */
const STRIP_KEYS = [...ARC_KEYS, "variants", "variantSets"];

/** Per-composition context threaded through the recursion. */
type Ctx = {
  baseUrl: string;
  resolver: AssetResolver;
  options: ComposeOptions;
  warn: (m: string) => void;
  /** External file URLs currently being composed (cycle guard). */
  stack: ReadonlySet<string>;
  /** Raw prim specs of this layer, by absolute path (for internal arcs). */
  index: Map<string, PrimSpec>;
  /** Internal prim paths currently being resolved (cycle guard). */
  resolving: ReadonlySet<string>;
};

export async function composeLayer(
  text: string,
  baseUrl: string,
  resolver: AssetResolver,
  options: ComposeOptions = {},
  stack: ReadonlySet<string> = new Set(),
): Promise<UsdaFile> {
  const warn = options.onWarn ?? (() => {});
  const file = parseUsda(text);

  // Sublayers (weaker than this layer). Listed strongest-first; fold weakest-up.
  let weak: PrimSpec[] = [];
  const subLayers = toArcs(file.metadata.subLayers);
  for (let i = subLayers.length - 1; i >= 0; i--) {
    const sub = await loadExternalFile(subLayers[i]!, baseUrl, resolver, options, stack, warn);
    if (sub) weak = mergePrimLists(weak, sub.prims);
  }

  const ctx: Ctx = {
    baseUrl,
    resolver,
    options,
    warn,
    stack,
    index: buildPathIndex(file.prims),
    resolving: new Set(),
  };

  const resolved: PrimSpec[] = [];
  for (const prim of file.prims) resolved.push(await resolvePrim(prim, ctx));

  const prims = weak.length > 0 ? mergePrimLists(weak, resolved) : resolved;
  return { version: file.version, metadata: stripKeys(file.metadata, STRIP_KEYS), prims };
}

async function resolvePrim(spec: PrimSpec, ctx: Ctx): Promise<PrimSpec> {
  // 1. Graft the selected variant content (weaker than direct opinions).
  let properties = spec.properties;
  let children = spec.children;
  const selection = spec.metadata.variants;
  if (spec.variantSets && isDictionary(selection)) {
    for (const [setName, variantName] of Object.entries(selection)) {
      const variant = spec.variantSets[setName]?.[String(variantName)];
      if (!variant) continue;
      properties = mergeProperties(variant.properties, properties);
      children = mergePrimLists(variant.children, children);
    }
  }

  // 2. Resolve children (their own arcs/variants).
  const resolvedChildren: PrimSpec[] = [];
  for (const child of children) resolvedChildren.push(await resolvePrim(child, ctx));

  const local: PrimSpec = {
    specifier: spec.specifier,
    typeName: spec.typeName,
    name: spec.name,
    metadata: stripKeys(spec.metadata, STRIP_KEYS),
    properties,
    children: resolvedChildren,
    line: spec.line,
  };

  // 3. References / payloads / inherits (all weaker than local opinions).
  const arcs = ARC_KEYS.flatMap((k) => toArcs(spec.metadata[k]));
  let base: PrimSpec | null = null;
  for (const arc of arcs) {
    const target = await loadReferencedPrim(arc, ctx);
    if (target) base = base ? mergePrim(target, base) : target;
  }
  return base ? mergePrim(base, local) : local;
}

async function loadReferencedPrim(arc: CompositionArc, ctx: Ctx): Promise<PrimSpec | null> {
  if (arc.assetPath) {
    const composed = await loadExternalFile(
      arc,
      ctx.baseUrl,
      ctx.resolver,
      ctx.options,
      ctx.stack,
      ctx.warn,
    );
    if (!composed) return null;
    const target = arc.primPath
      ? findPrimByPath(composed, arc.primPath)
      : defaultPrim(composed, ctx.warn);
    if (!target) {
      ctx.warn(
        `reference target ${arc.primPath ?? "(defaultPrim)"} not found in ${arc.assetPath.path}`,
      );
      return null;
    }
    return target; // external targets are already fully composed
  }

  // Internal arc: a `</Path>` within this layer (used by instanceable prototypes).
  if (arc.primPath) {
    if (ctx.resolving.has(arc.primPath)) {
      ctx.warn(`internal composition cycle at ${arc.primPath}; skipping`);
      return null;
    }
    const target = ctx.index.get(arc.primPath);
    if (!target) {
      ctx.warn(`internal reference target ${arc.primPath} not found`);
      return null;
    }
    return resolvePrim(target, { ...ctx, resolving: new Set([...ctx.resolving, arc.primPath]) });
  }
  return null;
}

/** Resolve, fetch and fully compose the external file an arc points at. */
async function loadExternalFile(
  arc: CompositionArc,
  baseUrl: string,
  resolver: AssetResolver,
  options: ComposeOptions,
  stack: ReadonlySet<string>,
  warn: (m: string) => void,
): Promise<UsdaFile | null> {
  if (!arc.assetPath) return null;
  const url = resolver.resolve(arc.assetPath.path, baseUrl);

  if (stack.has(url)) {
    warn(`composition cycle detected at ${url}; skipping`);
    return null;
  }
  if (stack.size >= (options.maxDepth ?? 64)) {
    warn(`composition exceeded max depth at ${url}; skipping`);
    return null;
  }

  let text: string;
  try {
    text = await resolver.fetchText(url);
  } catch (err) {
    warn(`cannot resolve "${arc.assetPath.path}" -> ${url}: ${(err as Error).message}`);
    return null;
  }
  return composeLayer(text, url, resolver, options, new Set([...stack, url]));
}

// --- merge (weaker `base` under stronger `over`) ---------------------------

function mergePrim(base: PrimSpec, over: PrimSpec): PrimSpec {
  return {
    specifier: over.specifier === "over" ? base.specifier : over.specifier,
    typeName: over.typeName || base.typeName,
    name: over.name,
    metadata: mergeMetadata(base.metadata, over.metadata),
    properties: mergeProperties(base.properties, over.properties),
    children: mergePrimLists(base.children, over.children),
    line: over.line,
  };
}

function mergePrimLists(base: PrimSpec[], over: PrimSpec[]): PrimSpec[] {
  const byName = new Map<string, PrimSpec>();
  for (const p of base) byName.set(p.name, p);
  for (const p of over) {
    const existing = byName.get(p.name);
    byName.set(p.name, existing ? mergePrim(existing, p) : p);
  }
  return [...byName.values()];
}

function mergeProperties(base: PropertySpec[], over: PropertySpec[]): PropertySpec[] {
  const byName = new Map<string, PropertySpec>();
  for (const p of base) byName.set(p.name, p);
  for (const p of over) {
    const existing = byName.get(p.name);
    byName.set(p.name, existing ? mergeProperty(existing, p) : p);
  }
  return [...byName.values()];
}

function mergeProperty(base: PropertySpec, over: PropertySpec): PropertySpec {
  if (base.kind !== over.kind) return over;
  if (base.kind === "attribute" && over.kind === "attribute") {
    const merged: AttributeSpec = {
      ...over,
      typeName: over.typeName || base.typeName,
      metadata: mergeMetadata(base.metadata, over.metadata),
    };
    const value = over.value !== undefined ? over.value : base.value;
    if (value !== undefined) merged.value = value;
    const timeSamples = over.timeSamples ?? base.timeSamples;
    if (timeSamples) merged.timeSamples = timeSamples;
    const connections = over.connections ?? base.connections;
    if (connections) merged.connections = connections;
    return merged;
  }
  if (base.kind === "relationship" && over.kind === "relationship") {
    return {
      ...over,
      targets: over.targets.length > 0 ? over.targets : base.targets,
      metadata: mergeMetadata(base.metadata, over.metadata),
    };
  }
  return over;
}

function mergeMetadata(base: MetadataMap, over: MetadataMap): MetadataMap {
  const merged: MetadataMap = { ...base, ...over };
  const a = base.apiSchemas;
  const b = over.apiSchemas;
  if (Array.isArray(a) || Array.isArray(b)) {
    const seen = new Set<UsdValue>();
    const union: UsdValue[] = [];
    for (const v of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
      if (!seen.has(v)) {
        seen.add(v);
        union.push(v);
      }
    }
    merged.apiSchemas = union;
  }
  return merged;
}

// --- lookups & helpers -----------------------------------------------------

/** Index every prim spec in a tree by its absolute path. */
function buildPathIndex(
  prims: PrimSpec[],
  parent = "/",
  map = new Map<string, PrimSpec>(),
): Map<string, PrimSpec> {
  for (const p of prims) {
    const path = parent === "/" ? `/${p.name}` : `${parent}/${p.name}`;
    map.set(path, p);
    buildPathIndex(p.children, path, map);
  }
  return map;
}

function findPrimByPath(file: UsdaFile, path: string): PrimSpec | null {
  const segments = path.split("/").filter(Boolean);
  let level = file.prims;
  let found: PrimSpec | null = null;
  for (const seg of segments) {
    found = level.find((p) => p.name === seg) ?? null;
    if (!found) return null;
    level = found.children;
  }
  return found;
}

function defaultPrim(file: UsdaFile, warn: (m: string) => void): PrimSpec | null {
  const name = file.metadata.defaultPrim;
  if (typeof name === "string") return file.prims.find((p) => p.name === name) ?? null;
  const first = file.prims[0];
  if (first) warn(`referenced layer has no defaultPrim; using first root prim "${first.name}"`);
  return first ?? null;
}

/** Normalize references/payloads/inherits/sublayers metadata into a list of arcs. */
function toArcs(value: UsdValue | undefined): CompositionArc[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const arcs: CompositionArc[] = [];
  for (const v of list) {
    if (v instanceof AssetPath) arcs.push({ assetPath: v });
    else if (v && typeof v === "object" && ("assetPath" in v || "primPath" in v))
      arcs.push(v as CompositionArc);
  }
  return arcs;
}

/** A plain metadata dictionary (not a Vec/Quat/Matrix/AssetPath/array). */
function isDictionary(v: UsdValue | undefined): v is { [k: string]: UsdValue } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Quat) &&
    !(v instanceof UsdMatrix) &&
    !(v instanceof AssetPath)
  );
}

function stripKeys(meta: MetadataMap, keys: readonly string[]): MetadataMap {
  const out: MetadataMap = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}
