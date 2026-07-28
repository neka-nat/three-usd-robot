/**
 * Bridges a parsed crate ({@link CrateReader}) into the in-memory {@link UsdaFile}
 * AST, so the rest of the pipeline (Stage / composition / extractor / runtime)
 * works on binary `.usd` exactly like ASCII `.usda`.
 */

import { AssetPath } from "../../parser/ast.js";
import type {
  AttributeSpec,
  MetadataMap,
  PrimSpec,
  PropertySpec,
  RelationshipSpec,
  Specifier,
  UsdValue,
  UsdaFile,
} from "../../parser/ast.js";
import type { CrateReader } from "./CrateReader.js";
import { decodeRepBits } from "./valueTypes.js";

// SdfSpecType values.
const SPEC_PRIM = 6;
const SPEC_PSEUDO_ROOT = 7;
const SPEC_ATTRIBUTE = 1;
const SPEC_RELATIONSHIP = 8;
const SPEC_VARIANT = 10;

const SPECIFIERS: Specifier[] = ["def", "over", "class"];

/** Anything that can hold properties and child prims: a prim, or one variant. */
type Container = { properties: PropertySpec[]; children: PrimSpec[]; metadata: MetadataMap };

export function crateToUsdaFile(crate: CrateReader): UsdaFile {
  const paths = crate.getPaths();
  const specs = crate.getSpecs();
  const fields = crate.getFields();

  const fieldsOf = (fieldSetIndex: number): Map<string, bigint> => {
    const map = new Map<string, bigint>();
    for (const fi of crate.getFieldSet(fieldSetIndex)) {
      const f = fields[fi];
      if (f) map.set(crate.getToken(f.nameIndex), f.rep);
    }
    return map;
  };

  const primByPath = new Map<string, PrimSpec>();
  /** Variant nodes (`/robot{Mesh=Performance}`) keyed by their crate path. */
  const variantByPath = new Map<string, Container>();
  const rootPrims: PrimSpec[] = [];
  let layerMetadata: MetadataMap = {};

  /**
   * The container a path denotes — a prim, or the variant node it names.
   * Variant containers are created on demand under their owning prim.
   */
  const containerAt = (path: string): Container | undefined => {
    const prim = primByPath.get(path);
    if (prim) return prim;
    const cached = variantByPath.get(path);
    if (cached) return cached;

    const selection = variantNode(path);
    if (!selection) return undefined;
    const owner = primByPath.get(selection.owner);
    if (!owner) return undefined;

    owner.variantSets ??= {};
    owner.variantSets[selection.setName] ??= {};
    const set = owner.variantSets[selection.setName]!;
    set[selection.variantName] ??= { properties: [], children: [], metadata: {} };
    const content = set[selection.variantName]!;
    variantByPath.set(path, content);
    return content;
  };

  // Pass 1: create prim specs (including variant-scoped ones).
  for (const spec of specs) {
    const path = paths[spec.pathIndex] ?? "";
    if (spec.specType === SPEC_PSEUDO_ROOT) {
      layerMetadata = buildLayerMetadata(crate, fieldsOf(spec.fieldSetIndex));
      continue;
    }
    if (spec.specType !== SPEC_PRIM) continue;

    const fm = fieldsOf(spec.fieldSetIndex);
    primByPath.set(path, {
      specifier: SPECIFIERS[asNumber(crate, fm.get("specifier")) ?? 0] ?? "def",
      typeName: asString(crate, fm.get("typeName")) ?? "",
      name: leaf(path),
      metadata: buildPrimMetadata(crate, fm),
      properties: [],
      children: [],
      line: 0,
    });
  }

  // Pass 2: declare variant nodes in authored order, keeping their own metadata
  // — Isaac Sim assets routinely hang the robot off a reference authored on the
  // variant itself rather than on a child prim.
  for (const spec of specs) {
    if (spec.specType !== SPEC_VARIANT) continue;
    const content = containerAt(paths[spec.pathIndex] ?? "");
    if (content)
      Object.assign(content.metadata, buildPrimMetadata(crate, fieldsOf(spec.fieldSetIndex)));
  }

  // Pass 3: attributes & relationships (they may live on a variant node).
  for (const spec of specs) {
    if (spec.specType !== SPEC_ATTRIBUTE && spec.specType !== SPEC_RELATIONSHIP) continue;
    const split = splitProperty(paths[spec.pathIndex] ?? "");
    if (!split) continue;
    const owner = containerAt(split.primPath);
    if (!owner) continue;

    const fm = fieldsOf(spec.fieldSetIndex);
    owner.properties.push(
      spec.specType === SPEC_ATTRIBUTE
        ? buildAttribute(crate, split.propName, fm)
        : buildRelationship(crate, split.propName, fm),
    );
  }

  // Pass 4: link prims into a tree (a variant's children hang off the variant).
  for (const [path, prim] of primByPath) {
    const parentPath = parentOf(path);
    if (parentPath === "/") rootPrims.push(prim);
    else containerAt(parentPath)?.children.push(prim);
  }

  return { version: crate.version.join("."), metadata: layerMetadata, prims: rootPrims };
}

/**
 * Split a variant node path (`/robot{Mesh=Performance}`) into its owning prim
 * and selection. Returns `null` for prim paths and for variant *set* nodes
 * (`/robot{Mesh=}`), which carry no content of their own.
 */
function variantNode(path: string): { owner: string; setName: string; variantName: string } | null {
  if (!path.endsWith("}")) return null;
  const open = path.lastIndexOf("{");
  if (open < 0) return null;
  const selection = path.slice(open + 1, -1);
  const eq = selection.indexOf("=");
  if (eq < 0) return null;
  const variantName = selection.slice(eq + 1);
  if (variantName === "") return null;
  return { owner: path.slice(0, open), setName: selection.slice(0, eq), variantName };
}

function buildAttribute(crate: CrateReader, name: string, fm: Map<string, bigint>): AttributeSpec {
  const defaultRep = fm.get("default");
  // Crate type names carry the array suffix (`token[]`); the USDA AST keeps
  // the base name in `typeName` and the suffix in `isArray` (parser convention).
  const rawType = asString(crate, fm.get("typeName")) ?? "";
  const isArrayType = rawType.endsWith("[]");
  const attr: AttributeSpec = {
    kind: "attribute",
    name,
    typeName: isArrayType ? rawType.slice(0, -2) : rawType,
    isArray: isArrayType || (defaultRep !== undefined ? decodeRepBits(defaultRep).isArray : false),
    variability: asNumber(crate, fm.get("variability")) === 1 ? "uniform" : "varying",
    custom: false,
    metadata: {},
    line: 0,
  };
  if (defaultRep !== undefined) {
    const value = crate.getValue(defaultRep);
    if (value !== undefined) attr.value = value;
  }
  return attr;
}

function buildRelationship(
  crate: CrateReader,
  name: string,
  fm: Map<string, bigint>,
): RelationshipSpec {
  const targetsValue = fm.has("targetPaths") ? crate.getValue(fm.get("targetPaths")!) : undefined;
  const targets = Array.isArray(targetsValue)
    ? (targetsValue.filter((t) => typeof t === "string") as string[])
    : [];
  return {
    kind: "relationship",
    name,
    custom: false,
    listOp: "explicit",
    targets,
    metadata: {},
    line: 0,
  };
}

const ARC_FIELDS = ["references", "payload", "payloads", "inherits", "specializes"];

function buildPrimMetadata(crate: CrateReader, fm: Map<string, bigint>): MetadataMap {
  const meta: MetadataMap = {};
  const apiSchemas = fm.has("apiSchemas") ? crate.getValue(fm.get("apiSchemas")!) : undefined;
  if (Array.isArray(apiSchemas)) meta.apiSchemas = apiSchemas as UsdValue[];
  const kind = asString(crate, fm.get("kind"));
  if (kind !== undefined) meta.kind = kind;
  // Variant selections drive which variant the composer grafts.
  const variants = fm.has("variantSelection")
    ? crate.getValue(fm.get("variantSelection")!)
    : undefined;
  if (variants && typeof variants === "object" && !Array.isArray(variants)) {
    meta.variants = variants as UsdValue;
  }
  // Composition arcs (references / payloads / inherits) for the M8 composer.
  for (const key of ARC_FIELDS) {
    if (!fm.has(key)) continue;
    const arcs = crate.getValue(fm.get(key)!);
    if (Array.isArray(arcs) && arcs.length > 0) meta[key] = arcs as UsdValue[];
  }
  return meta;
}

function buildLayerMetadata(crate: CrateReader, fm: Map<string, bigint>): MetadataMap {
  const meta: MetadataMap = {};
  // Sublayers are asset paths; the composer folds them in under this layer.
  const subLayers = fm.has("subLayers") ? crate.getValue(fm.get("subLayers")!) : undefined;
  if (Array.isArray(subLayers)) {
    const paths = subLayers.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (paths.length > 0) meta.subLayers = paths.map((p) => new AssetPath(p));
  }
  const upAxis = asString(crate, fm.get("upAxis"));
  if (upAxis !== undefined) meta.upAxis = upAxis;
  const defaultPrim = asString(crate, fm.get("defaultPrim"));
  if (defaultPrim !== undefined) meta.defaultPrim = defaultPrim;
  const metersPerUnit = asNumber(crate, fm.get("metersPerUnit"));
  if (metersPerUnit !== undefined) meta.metersPerUnit = metersPerUnit;
  return meta;
}

function asString(crate: CrateReader, rep: bigint | undefined): string | undefined {
  if (rep === undefined) return undefined;
  const v = crate.getValue(rep);
  return typeof v === "string" ? v : undefined;
}

function asNumber(crate: CrateReader, rep: bigint | undefined): number | undefined {
  if (rep === undefined) return undefined;
  const v = crate.getValue(rep);
  return typeof v === "number" ? v : undefined;
}

/** `/a/b.attr` → `{ primPath: "/a/b", propName: "attr" }`; `null` for non-property paths. */
function splitProperty(path: string): { primPath: string; propName: string } | null {
  const slash = path.lastIndexOf("/");
  const dot = path.indexOf(".", slash < 0 ? 0 : slash);
  if (dot === -1) return null;
  // Skip relationship-target / connection sub-paths (contain brackets).
  if (path.includes("[")) return null;
  return { primPath: path.slice(0, dot), propName: path.slice(dot + 1) };
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function leaf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
