/**
 * Minimal USD composition: flattens references, payloads and sublayers into a
 * single {@link UsdaFile} so the rest of the pipeline keeps working on one layer.
 *
 * Scope (M8): the arcs robots actually use. References and payloads pull a prim
 * subtree from another asset (weaker than local opinions); sublayers overlay a
 * weaker layer stack. Inherits / variants / specializes are out of scope (M10).
 * This is not a full LIVRPS implementation — it is a pragmatic flattener.
 */

import {
  AssetPath,
  type AttributeSpec,
  type CompositionArc,
  type MetadataMap,
  type PrimSpec,
  type PropertySpec,
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

/** Composition-arc metadata keys that pull external prim content. */
const ARC_KEYS = ["references", "payload", "payloads"] as const;

/**
 * Parse and fully compose a layer: resolve its sublayers and every prim's
 * references/payloads (recursively), returning a flattened layer. Unresolvable
 * arcs are reported via `onWarn` and skipped.
 */
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
    const sub = await loadComposedFile(subLayers[i]!, baseUrl, resolver, options, stack, warn);
    if (sub) weak = mergePrimLists(weak, sub.prims);
  }

  // Resolve each root prim's arcs.
  const resolved: PrimSpec[] = [];
  for (const prim of file.prims) {
    resolved.push(await resolvePrimArcs(prim, baseUrl, resolver, options, stack, warn));
  }

  const prims = weak.length > 0 ? mergePrimLists(weak, resolved) : resolved;
  return { version: file.version, metadata: stripKeys(file.metadata, ["subLayers"]), prims };
}

async function resolvePrimArcs(
  spec: PrimSpec,
  baseUrl: string,
  resolver: AssetResolver,
  options: ComposeOptions,
  stack: ReadonlySet<string>,
  warn: (m: string) => void,
): Promise<PrimSpec> {
  // Resolve local children first (they belong to this layer's base URL).
  const children: PrimSpec[] = [];
  for (const child of spec.children) {
    children.push(await resolvePrimArcs(child, baseUrl, resolver, options, stack, warn));
  }
  const local: PrimSpec = { ...spec, children, metadata: stripKeys(spec.metadata, ARC_KEYS) };

  const arcs = ARC_KEYS.flatMap((k) => toArcs(spec.metadata[k]));
  if (arcs.length === 0) return local;

  // Compose referenced prims (strongest-first), all weaker than local opinions.
  let base: PrimSpec | null = null;
  for (const arc of arcs) {
    const target = await loadReferencedPrim(arc, baseUrl, resolver, options, stack, warn);
    if (!target) continue;
    base = base ? mergePrim(target, base) : target;
  }
  return base ? mergePrim(base, local) : local;
}

async function loadReferencedPrim(
  arc: CompositionArc,
  baseUrl: string,
  resolver: AssetResolver,
  options: ComposeOptions,
  stack: ReadonlySet<string>,
  warn: (m: string) => void,
): Promise<PrimSpec | null> {
  if (!arc.assetPath) {
    warn(`internal references (no asset path) are not supported yet: <${arc.primPath ?? "?"}>`);
    return null;
  }
  const composed = await loadComposedFile(arc, baseUrl, resolver, options, stack, warn);
  if (!composed) return null;

  const target = arc.primPath
    ? findPrimByPath(composed, arc.primPath)
    : defaultPrim(composed, warn);
  if (!target) {
    warn(`reference target ${arc.primPath ?? "(defaultPrim)"} not found in ${arc.assetPath.path}`);
    return null;
  }
  return target;
}

/** Resolve, fetch and fully compose the file an arc points at (with cycle/depth guards). */
async function loadComposedFile(
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
    // `over` (def) wins; a pure `over` opinion keeps the base's specifier.
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
  if (base.kind !== over.kind) return over; // kind change: stronger wins outright
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
  // apiSchemas accumulate (union, base order first).
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
  if (typeof name === "string") {
    return file.prims.find((p) => p.name === name) ?? null;
  }
  const first = file.prims[0];
  if (first) warn(`referenced layer has no defaultPrim; using first root prim "${first.name}"`);
  return first ?? null;
}

/** Normalize references/payloads/sublayers metadata into a list of arcs. */
function toArcs(value: UsdValue | undefined): CompositionArc[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const arcs: CompositionArc[] = [];
  for (const v of list) {
    if (v instanceof AssetPath) arcs.push({ assetPath: v });
    else if (v && typeof v === "object" && "assetPath" in v) arcs.push(v as CompositionArc);
  }
  return arcs;
}

function stripKeys(meta: MetadataMap, keys: readonly string[]): MetadataMap {
  const out: MetadataMap = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}
