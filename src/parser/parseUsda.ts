/**
 * Recursive-descent parser for the USDA (ASCII USD) format.
 *
 * Scope (M1): prims (`def`/`over`/`class`), nested prims, attributes
 * (`uniform`/`custom`/array/connections/time samples), relationships (with
 * list-op qualifiers), and layer/prim/property metadata blocks. References,
 * payloads and variant sets are tolerated as metadata but not resolved (M8/M10).
 */

import type {
  AttributeSpec,
  CompositionArc,
  ListOp,
  MetadataMap,
  PrimSpec,
  PropertySpec,
  RelationshipSpec,
  SdfPath,
  Specifier,
  UsdDictionary,
  UsdValue,
  UsdaFile,
  Variability,
} from "./ast.js";
import { AssetPath } from "./ast.js";
import { TokenReader } from "./reader.js";
import { tokenize } from "./tokenize.js";
import { parseLiteral, parseTypedValue, rawToUsdValue } from "./valueParser.js";

const SPECIFIERS = new Set(["def", "over", "class"]);
const LIST_OPS = new Set<ListOp>(["prepend", "append", "add", "delete", "reorder"]);
const MAGIC_RE = /^\s*#usda\s+(\S+)/;

export function parseUsda(text: string): UsdaFile {
  const magic = MAGIC_RE.exec(text);
  const version = magic?.[1] ?? "1.0";

  const r = new TokenReader(tokenize(text));

  // Optional layer metadata block immediately after the magic line.
  const metadata = r.is("lparen") ? parseMetadataBlock(r) : {};

  const prims: PrimSpec[] = [];
  while (!r.atEnd()) {
    prims.push(parsePrim(r));
  }
  return { version, metadata, prims };
}

// ---------------------------------------------------------------------------
// Prims
// ---------------------------------------------------------------------------

function parsePrim(r: TokenReader): PrimSpec {
  const head = r.peek();
  const specifier = r.expectIdent();
  if (!SPECIFIERS.has(specifier)) {
    throw r.error(
      `expected a prim specifier (def/over/class) but found ${JSON.stringify(specifier)}`,
    );
  }

  // Optional schema type name, then the (quoted) prim name.
  let typeName = "";
  if (r.is("ident")) typeName = r.expectIdent();
  const name = r.expect("string").value;

  const metadata = r.is("lparen") ? parseMetadataBlock(r) : {};

  const properties: PropertySpec[] = [];
  const children: PrimSpec[] = [];
  r.expect("lbrace");
  while (!r.is("rbrace") && !r.atEnd()) {
    if (r.is("ident") && SPECIFIERS.has(r.peek().value)) {
      children.push(parsePrim(r));
    } else {
      properties.push(parseProperty(r));
    }
  }
  r.expect("rbrace");

  return {
    specifier: specifier as Specifier,
    typeName,
    name,
    metadata,
    properties,
    children,
    line: head.line,
  };
}

// ---------------------------------------------------------------------------
// Properties (attributes & relationships)
// ---------------------------------------------------------------------------

function parseProperty(r: TokenReader): PropertySpec {
  const line = r.peek().line;
  let custom = false;
  let variability: Variability = "varying";
  let listOp: ListOp = "explicit";

  // Leading qualifiers, in any order.
  for (;;) {
    if (r.acceptIdent("custom")) {
      custom = true;
    } else if (r.acceptIdent("uniform")) {
      variability = "uniform";
    } else if (r.acceptIdent("varying")) {
      variability = "varying";
    } else if (r.is("ident") && LIST_OPS.has(r.peek().value as ListOp)) {
      listOp = r.expectIdent() as ListOp;
    } else {
      break;
    }
  }

  if (r.isIdent("rel")) {
    r.next();
    return parseRelationship(r, custom, listOp, line);
  }
  return parseAttribute(r, custom, variability, line);
}

function parseAttribute(
  r: TokenReader,
  custom: boolean,
  variability: Variability,
  line: number,
): AttributeSpec {
  const typeName = r.expectIdent();
  let isArray = false;
  if (r.accept("lbracket")) {
    r.expect("rbracket");
    isArray = true;
  }
  const name = r.expectIdent();

  const attr: AttributeSpec = {
    kind: "attribute",
    name,
    typeName,
    isArray,
    variability,
    custom,
    metadata: {},
    line,
  };

  // `.connect` / `.timeSamples` suffix, or a default value.
  if (r.accept("dot")) {
    const suffix = r.expectIdent();
    r.expect("equals");
    if (suffix === "connect") {
      attr.connections = parseTargetList(r);
    } else if (suffix === "timeSamples") {
      attr.timeSamples = parseTimeSamples(r, typeName, isArray);
    } else {
      throw r.error(`unsupported attribute qualifier .${suffix}`);
    }
  } else if (r.accept("equals")) {
    if (r.is("lbrace")) {
      attr.timeSamples = parseTimeSamples(r, typeName, isArray);
    } else {
      attr.value = parseTypedValue(r, typeName, isArray);
    }
  }

  if (r.is("lparen")) attr.metadata = parseMetadataBlock(r);
  return attr;
}

function parseRelationship(
  r: TokenReader,
  custom: boolean,
  listOp: ListOp,
  line: number,
): RelationshipSpec {
  const name = r.expectIdent();
  let targets: SdfPath[] = [];
  if (r.accept("equals")) {
    targets = parseTargetList(r);
  }
  const metadata = r.is("lparen") ? parseMetadataBlock(r) : {};
  return { kind: "relationship", name, custom, listOp, targets, metadata, line };
}

/** Parse `None`, a single `<path>`, or a `[<path>, ...]` list of targets. */
function parseTargetList(r: TokenReader): SdfPath[] {
  if (r.acceptIdent("None") || r.acceptIdent("none")) return [];
  if (r.is("path")) return [r.next().value];
  if (r.accept("lbracket")) {
    const targets: SdfPath[] = [];
    while (!r.is("rbracket") && !r.atEnd()) {
      targets.push(r.expect("path").value);
      if (!r.accept("comma")) break;
    }
    r.expect("rbracket");
    return targets;
  }
  throw r.error("expected a relationship/connection target path");
}

function parseTimeSamples(
  r: TokenReader,
  typeName: string,
  isArray: boolean,
): Map<number, UsdValue> {
  r.expect("lbrace");
  const samples = new Map<number, UsdValue>();
  while (!r.is("rbrace") && !r.atEnd()) {
    const time = r.expect("number").num ?? Number(r.peek().value);
    r.expect("colon");
    samples.set(time, parseTypedValue(r, typeName, isArray));
    if (!r.accept("comma")) break;
  }
  r.expect("rbrace");
  return samples;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function parseMetadataBlock(r: TokenReader): MetadataMap {
  r.expect("lparen");
  const meta: MetadataMap = {};
  while (!r.is("rparen") && !r.atEnd()) {
    // A bare string is the prim/layer documentation.
    if (r.is("string") && !r.is("equals", 1)) {
      meta.doc = r.next().value;
      continue;
    }

    // Optional list-op qualifier before the key.
    if (r.is("ident") && LIST_OPS.has(r.peek().value as ListOp)) r.next();

    const key = r.expectIdent();
    r.expect("equals");
    meta[key] = parseMetadataValue(r);
  }
  r.expect("rparen");
  return meta;
}

function parseMetadataValue(r: TokenReader): UsdValue {
  if (r.is("lbrace")) return parseDictionary(r);
  if (r.is("lbracket")) return parseMetadataList(r);

  const raw = parseLiteral(r);
  // Composition arc: `@asset@</PrimPath>` (single reference/payload form).
  if (raw.t === "asset" && r.is("path")) {
    const arc: CompositionArc = { assetPath: raw.v, primPath: r.next().value };
    return arc;
  }
  if (raw.t === "asset") {
    return raw.v; // bare asset path
  }
  return rawToUsdValue(raw);
}

/**
 * Parse a bracketed metadata list. Elements may be composition arcs
 * (`@asset@` optionally followed by `</PrimPath>`), bare assets, or plain
 * scalars (e.g. `apiSchemas = ["A", "B"]`).
 */
function parseMetadataList(r: TokenReader): UsdValue {
  r.expect("lbracket");
  const items: UsdValue[] = [];
  while (!r.is("rbracket") && !r.atEnd()) {
    if (r.is("asset")) {
      const assetPath = new AssetPath(r.next().value);
      if (r.is("path")) {
        const arc: CompositionArc = { assetPath, primPath: r.next().value };
        items.push(arc);
      } else {
        items.push(assetPath);
      }
    } else {
      items.push(rawToUsdValue(parseLiteral(r)));
    }
    if (!r.accept("comma")) break;
  }
  r.expect("rbracket");
  return items;
}

function parseDictionary(r: TokenReader): UsdDictionary {
  r.expect("lbrace");
  const dict: UsdDictionary = {};
  while (!r.is("rbrace") && !r.atEnd()) {
    // Entry: `TYPE[opt][] KEY = VALUE`. Skip the type token and optional `[]`.
    r.expectIdent();
    if (r.accept("lbracket")) r.expect("rbracket");
    const key = r.is("string") ? r.next().value : r.expectIdent();
    r.expect("equals");
    dict[key] = parseMetadataValue(r);
  }
  r.expect("rbrace");
  return dict;
}
