/**
 * Bridges a parsed crate ({@link CrateReader}) into the in-memory {@link UsdaFile}
 * AST, so the rest of the pipeline (Stage / composition / extractor / runtime)
 * works on binary `.usd` exactly like ASCII `.usda`.
 */

import type {
  AttributeSpec,
  MetadataMap,
  PrimSpec,
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

const SPECIFIERS: Specifier[] = ["def", "over", "class"];

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
  const rootPrims: PrimSpec[] = [];
  let layerMetadata: MetadataMap = {};

  // Pass 1: create prim specs.
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

  // Pass 2: attributes & relationships.
  for (const spec of specs) {
    if (spec.specType !== SPEC_ATTRIBUTE && spec.specType !== SPEC_RELATIONSHIP) continue;
    const split = splitProperty(paths[spec.pathIndex] ?? "");
    if (!split) continue;
    const prim = primByPath.get(split.primPath);
    if (!prim) continue;

    const fm = fieldsOf(spec.fieldSetIndex);
    prim.properties.push(
      spec.specType === SPEC_ATTRIBUTE
        ? buildAttribute(crate, split.propName, fm)
        : buildRelationship(crate, split.propName, fm),
    );
  }

  // Pass 3: link prims into a tree.
  for (const [path, prim] of primByPath) {
    const parentPath = parentOf(path);
    if (parentPath === "/") rootPrims.push(prim);
    else primByPath.get(parentPath)?.children.push(prim);
  }

  return { version: crate.version.join("."), metadata: layerMetadata, prims: rootPrims };
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
