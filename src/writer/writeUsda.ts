/**
 * Serializes a {@link UsdaFile} AST back to USDA text — the write-direction
 * counterpart of `parseUsda` (M12).
 *
 * Formatting follows `usdcat` conventions: 4-space indent, layer metadata in a
 * parenthesized block, one property statement per line, multi-line
 * dictionaries and time-sample blocks.
 *
 * Round-trip guarantee: for any `file` produced by `parseUsda`,
 * `parseUsda(serializeUsda(file))` is structurally equal to `file` (source
 * line numbers aside), and the serializer is idempotent from the first
 * re-parse on. Spellings the parser normalizes away serialize in normalized
 * form: list-op qualifiers on metadata keys are dropped (values emit as
 * explicit lists), dictionary entry types are re-inferred from the value, and
 * path-valued attribute defaults degrade to strings.
 */

import {
  AssetPath,
  type AttributeSpec,
  type CompositionArc,
  type MetadataMap,
  type PrimSpec,
  type PropertySpec,
  Quat,
  type RelationshipSpec,
  type SdfPath,
  type UsdDictionary,
  UsdMatrix,
  type UsdValue,
  type UsdaFile,
  type VariantSetMap,
} from "../parser/ast.js";

const INDENT = "    ";
const BARE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Serialize a parsed (or authored) USDA layer to text. */
export function serializeUsda(file: UsdaFile): string {
  const out: string[] = [`#usda ${file.version}`];

  const meta = Object.entries(file.metadata);
  if (meta.length > 0) {
    out.push("(");
    for (const [key, value] of meta) pushMetaEntry(out, key, value, 1);
    out.push(")");
  }

  for (const prim of file.prims) {
    out.push("");
    pushPrim(out, prim, 0);
  }
  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Prims
// ---------------------------------------------------------------------------

function pushPrim(out: string[], prim: PrimSpec, level: number): void {
  const pad = INDENT.repeat(level);
  const type = prim.typeName ? `${prim.typeName} ` : "";
  pushWithMetadata(
    out,
    `${pad}${prim.specifier} ${type}${quoteString(prim.name)}`,
    prim.metadata,
    level,
  );
  out.push(`${pad}{`);
  pushPrimBody(out, prim.properties, prim.children, prim.variantSets, level + 1);
  out.push(`${pad}}`);
}

function pushPrimBody(
  out: string[],
  properties: PropertySpec[],
  children: PrimSpec[],
  variantSets: VariantSetMap | undefined,
  level: number,
): void {
  for (const prop of properties) pushProperty(out, prop, level);

  if (variantSets) {
    const pad = INDENT.repeat(level);
    for (const [setName, variants] of Object.entries(variantSets)) {
      out.push(`${pad}variantSet ${quoteString(setName)} = {`);
      for (const [variantName, content] of Object.entries(variants)) {
        out.push(`${pad}${INDENT}${quoteString(variantName)} {`);
        pushPrimBody(out, content.properties, content.children, undefined, level + 2);
        out.push(`${pad}${INDENT}}`);
      }
      out.push(`${pad}}`);
    }
  }

  for (let i = 0; i < children.length; i++) {
    if (i > 0 || properties.length > 0 || variantSets) out.push("");
    pushPrim(out, children[i]!, level);
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function pushProperty(out: string[], prop: PropertySpec, level: number): void {
  if (prop.kind === "relationship") pushRelationship(out, prop, level);
  else pushAttribute(out, prop, level);
}

function pushRelationship(out: string[], rel: RelationshipSpec, level: number): void {
  const pad = INDENT.repeat(level);
  const custom = rel.custom ? "custom " : "";
  const listOp = rel.listOp !== "explicit" ? `${rel.listOp} ` : "";
  let head = `${pad}${custom}${listOp}rel ${rel.name}`;
  // `rel name` with no `=` and `rel name = None` both parse to zero targets;
  // emit the bare declaration for that normalized state.
  if (rel.targets.length > 0) head += ` = ${formatTargets(rel.targets)}`;
  pushWithMetadata(out, head, rel.metadata, level);
}

/**
 * Emit an attribute spec. A spec may carry a default value, time samples, and
 * connections at once (crate-built ASTs author all three on one spec); each
 * serializes as its own statement, with the metadata block attached to the
 * first one — the parser then merges them back by property name.
 */
function pushAttribute(out: string[], attr: AttributeSpec, level: number): void {
  const pad = INDENT.repeat(level);
  const custom = attr.custom ? "custom " : "";
  const uniform = attr.variability === "uniform" ? "uniform " : "";
  const decl = `${pad}${custom}${uniform}${attr.typeName}${attr.isArray ? "[]" : ""} ${attr.name}`;

  let first = true;
  const attach = (head: string) => {
    if (first) pushWithMetadata(out, head, attr.metadata, level);
    else out.push(head);
    first = false;
  };

  if (attr.value !== undefined) {
    attach(`${decl} = ${formatAttrValue(attr.value, attr.isArray)}`);
  }
  if (attr.timeSamples) {
    out.push(`${decl}.timeSamples = {`);
    for (const [time, value] of attr.timeSamples) {
      out.push(`${pad}${INDENT}${formatNumber(time)}: ${formatAttrValue(value, attr.isArray)},`);
    }
    attach(`${pad}}`);
  }
  if (attr.connections) {
    // Zero connections (`.connect = None`) must keep the statement, unlike rels.
    attach(
      `${decl}.connect = ${attr.connections.length > 0 ? formatTargets(attr.connections) : "None"}`,
    );
  }
  if (first) attach(decl);
}

/** One target as `<path>`, several as `[<a>, <b>]`. */
function formatTargets(targets: SdfPath[]): string {
  if (targets.length === 1) return `<${targets[0]}>`;
  return `[${targets.map((t) => `<${t}>`).join(", ")}]`;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Push `head (` + metadata entries + `)`, or just `head` when the map is empty. */
function pushWithMetadata(out: string[], head: string, meta: MetadataMap, level: number): void {
  const entries = Object.entries(meta);
  if (entries.length === 0) {
    out.push(head);
    return;
  }
  out.push(`${head} (`);
  for (const [key, value] of entries) pushMetaEntry(out, key, value, level + 1);
  out.push(`${INDENT.repeat(level)})`);
}

function pushMetaEntry(out: string[], key: string, value: UsdValue, level: number): void {
  const pad = INDENT.repeat(level);
  if (isDictionary(value)) {
    out.push(`${pad}${key} = {`);
    pushDictEntries(out, value, level + 1);
    out.push(`${pad}}`);
    return;
  }
  out.push(`${pad}${key} = ${formatMetaValue(value)}`);
}

/**
 * Dictionary entries are typed in USDA (`string foo = "bar"`) but the parser
 * discards the declared type, so it is re-inferred from the value's shape.
 * Entries are newline-separated (the dictionary grammar has no commas).
 */
function pushDictEntries(out: string[], dict: UsdDictionary, level: number): void {
  const pad = INDENT.repeat(level);
  for (const [key, value] of Object.entries(dict)) {
    const keyText = BARE_KEY_RE.test(key) ? key : quoteString(key);
    if (isDictionary(value)) {
      out.push(`${pad}dictionary ${keyText} = {`);
      pushDictEntries(out, value, level + 1);
      out.push(`${pad}}`);
    } else {
      out.push(`${pad}${dictEntryTypeName(value)} ${keyText} = ${formatMetaValue(value)}`);
    }
  }
}

function dictEntryTypeName(v: UsdValue): string {
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return isInt32(v) ? "int" : "double";
  if (typeof v === "bigint") return "int64";
  if (v instanceof AssetPath) return "asset";
  if (v instanceof Quat) return "quatd";
  if (v instanceof UsdMatrix) return v.dim === 4 ? "matrix4d" : "matrix3d";
  if (Array.isArray(v)) {
    const elems: UsdValue[] = v;
    if (elems.every((e) => typeof e === "boolean")) return "bool[]";
    let allInt = true;
    for (const e of elems) {
      if (typeof e !== "number") return "string[]"; // strings / mixed — syntax-only here
      if (!isInt32(e)) allInt = false;
    }
    return allInt ? "int[]" : "double[]";
  }
  return "string"; // null and other oddities — any type token parses
}

function isInt32(v: number): boolean {
  return Number.isInteger(v) && Math.abs(v) <= 0x7fffffff;
}

/** Format a value in untyped (metadata) context: tuples have collapsed to arrays. */
function formatMetaValue(v: UsdValue): string {
  if (v === null) return "None";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return quoteString(v);
  if (v instanceof AssetPath) return formatAsset(v.path);
  if (v instanceof Quat) return formatQuat(v);
  if (v instanceof UsdMatrix) return formatMatrix(v);
  if (Array.isArray(v)) return `[${v.map(formatMetaValue).join(", ")}]`;
  if (isCompositionArc(v)) return formatArc(v);
  throw new Error("cannot serialize a nested dictionary in list/value context");
}

function formatArc(arc: CompositionArc): string {
  const asset = arc.assetPath ? formatAsset(arc.assetPath.path) : "";
  const prim = arc.primPath !== undefined ? `<${arc.primPath}>` : "";
  return `${asset}${prim}`;
}

// ---------------------------------------------------------------------------
// Attribute values
// ---------------------------------------------------------------------------

/**
 * Format a typed attribute (or time-sample) value. The authored syntax is
 * fully determined by the value's shape: declared-array attributes bracket the
 * outer list, and any plain array in a scalar slot is a tuple (`Vec*`,
 * matrices-as-rows, or an unknown-typed tuple the parser passed through).
 */
function formatAttrValue(v: UsdValue, isArray: boolean): string {
  if (v === null) return "None";
  if (isArray && Array.isArray(v)) {
    return `[${v.map((el) => formatAttrScalar(el)).join(", ")}]`;
  }
  return formatAttrScalar(v);
}

function formatAttrScalar(v: UsdValue): string {
  if (v === null) return "None";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return quoteString(v);
  if (v instanceof Quat) return formatQuat(v);
  if (v instanceof UsdMatrix) return formatMatrix(v);
  if (v instanceof AssetPath) return formatAsset(v.path);
  if (Array.isArray(v)) return `(${v.map((el) => formatAttrScalar(el)).join(", ")})`;
  throw new Error("cannot serialize a dictionary as an attribute value");
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

function formatQuat(q: Quat): string {
  const [i, j, k] = q.imaginary;
  return `(${formatNumber(q.real)}, ${formatNumber(i)}, ${formatNumber(j)}, ${formatNumber(k)})`;
}

/** Rows as nested tuples, row-major — the exact inverse of the value parser. */
function formatMatrix(m: UsdMatrix): string {
  const rows: string[] = [];
  for (let r = 0; r < m.dim; r++) {
    const row = m.values.slice(r * m.dim, (r + 1) * m.dim).map(formatNumber);
    rows.push(`(${row.join(", ")})`);
  }
  return `( ${rows.join(", ")} )`;
}

function formatNumber(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (v === Number.POSITIVE_INFINITY) return "inf";
  if (v === Number.NEGATIVE_INFINITY) return "-inf";
  if (Object.is(v, -0)) return "-0";
  return String(v);
}

function quoteString(s: string): string {
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function formatAsset(path: string): string {
  return path.includes("@") ? `@@@${path}@@@` : `@${path}@`;
}

// ---------------------------------------------------------------------------
// Value classification
// ---------------------------------------------------------------------------

function isDictionary(v: UsdValue): v is UsdDictionary {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Quat) &&
    !(v instanceof UsdMatrix) &&
    !(v instanceof AssetPath) &&
    !isCompositionArc(v)
  );
}

/** An object holding only `assetPath` / `primPath` keys is a composition arc. */
function isCompositionArc(v: object): v is CompositionArc {
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k === "assetPath" || k === "primPath");
}
