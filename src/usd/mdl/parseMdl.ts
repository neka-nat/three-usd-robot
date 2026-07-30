/**
 * Minimal `.mdl` **declaration** parser (M20) — reads material signatures, not
 * the MDL language.
 *
 * USD stores only the *overridden* inputs of an MDL shader; every other
 * parameter value lives in the referenced `.mdl` module. Two declaration
 * shapes carry the values we can recover without executing MDL:
 *
 * - parameter defaults —
 *   `export material OmniPBR(color diffuse_color_constant = color(0.2), …)`
 * - wrapper materials (the usual shape of per-asset `Materials/*.mdl`) —
 *   `export material Steel(*) = OmniPBR::OmniPBR(diffuse_color_constant: color(…), …);`
 *
 * Only literal values are extracted: numbers, bools, strings, `color(…)` /
 * `floatN(…)` vectors, and `texture_2d("path", ::tex::gamma_*)`. Defaults that
 * are expressions, function calls, or cross-module references are skipped, as
 * are comments and `[[ … ]]` annotation blocks. Executing MDL stays out of
 * scope — this is a fidelity aid, not an interpreter.
 */

/** A literal value read from an MDL declaration. */
export type MdlValue = number | boolean | string | number[] | MdlTextureValue;

/** A `texture_2d("path", ::tex::gamma_*)` literal. */
export interface MdlTextureValue {
  /** Path as written in the module — relative paths anchor at the `.mdl` file. */
  assetPath: string;
  /** From the gamma argument: `gamma_srgb` → `"sRGB"`, `gamma_linear` → `"raw"`. */
  sourceColorSpace?: "sRGB" | "raw";
}

/** Narrow an {@link MdlValue} to a texture literal. */
export function isMdlTexture(value: MdlValue | undefined): value is MdlTextureValue {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && "assetPath" in value
  );
}

/** One `export material` declaration. */
export interface MdlMaterialDecl {
  name: string;
  /** Literal defaults from the declaration's own parameter list (empty for `(*)`). */
  defaults: Map<string, MdlValue>;
  /** Base material of the wrapper form `X(…) = Base(args…)` (last `::` segment). */
  base?: string;
  /** Literal named arguments of the wrapper's base call. */
  args: Map<string, MdlValue>;
}

/** The exported material declarations of one `.mdl` file. */
export interface MdlModule {
  materials: Map<string, MdlMaterialDecl>;
}

/**
 * Look up the parsed module for an authored `info:mdl:sourceAsset` path.
 * Returning `undefined` means "module unavailable" — resolution then falls
 * back to authored USD inputs alone.
 */
export type MdlModuleProvider = (assetPath: string) => MdlModule | undefined;

/** Parse the `export material` declarations of an `.mdl` module's source text. */
export function parseMdl(text: string): MdlModule {
  const src = stripNoise(text);
  const materials = new Map<string, MdlMaterialDecl>();
  const declRe = /\bexport\s+material\s+([A-Za-z_]\w*)\s*\(/g;
  let match = declRe.exec(src);
  while (match) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(src, open);
    if (close === -1) break;
    const decl: MdlMaterialDecl = {
      name: match[1] as string,
      defaults: parseParamDefaults(src.slice(open + 1, close - 1)),
      args: new Map(),
    };
    let next = close;
    let i = close;
    while (i < src.length && /\s/.test(src[i] as string)) i++;
    if (src[i] === "=") {
      const end = statementEnd(src, i + 1);
      const body = parseWrapperBody(src.slice(i + 1, end));
      if (body.base) decl.base = body.base;
      decl.args = body.args;
      next = end;
    }
    materials.set(decl.name, decl);
    declRe.lastIndex = next;
    match = declRe.exec(src);
  }
  return { materials };
}

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?$/;
const CALL_RE = /^(?:::)?([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/;
const VECTOR_RE = /^(?:color|(?:float|double|int)([234]))$/;
const IDENTIFIER_RE = /^[A-Za-z_]\w*$/;

/**
 * Evaluate one MDL literal expression, or `undefined` for anything beyond the
 * supported literal subset (identifiers, arithmetic, function calls, …).
 */
export function parseMdlLiteral(src: string): MdlValue | undefined {
  const s = src.trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (NUMBER_RE.test(s)) return Number.parseFloat(s.replace(/[fFdD]$/, ""));
  if (s.startsWith('"')) {
    if (skipString(s, 0) !== s.length) return undefined;
    return s.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  const call = CALL_RE.exec(s);
  if (!call) return undefined;
  const open = call[0].length - 1;
  if (matchParen(s, open) !== s.length) return undefined;
  const name = (call[1] as string).split("::").pop() as string;
  const args = splitTopLevel(s.slice(open + 1, s.length - 1), ",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (name === "texture_2d") {
    const path = args[0] === undefined ? undefined : parseMdlLiteral(args[0]);
    // `texture_2d()` (the empty default) carries no path — same as absent.
    if (typeof path !== "string" || path.length === 0) return undefined;
    const texture: MdlTextureValue = { assetPath: path };
    const gamma = args.slice(1).join(",");
    if (gamma.includes("gamma_srgb")) texture.sourceColorSpace = "sRGB";
    else if (gamma.includes("gamma_linear")) texture.sourceColorSpace = "raw";
    return texture;
  }
  const vector = VECTOR_RE.exec(name);
  if (vector) {
    const width = vector[1] ? Number(vector[1]) : 3;
    const values = args.map((a) => parseMdlLiteral(a));
    if (values.length === 0 || !values.every((v) => typeof v === "number")) return undefined;
    // A single argument broadcasts (`color(0.2)`, `float2(4.0)`).
    if (values.length === 1) return new Array<number>(width).fill(values[0] as number);
    return values.length === width ? (values as number[]) : undefined;
  }
  return undefined;
}

/** Literal defaults of a parameter list (`type name = literal, …`); `*` ⇒ none. */
function parseParamDefaults(src: string): Map<string, MdlValue> {
  const defaults = new Map<string, MdlValue>();
  const body = src.trim();
  if (body === "" || body === "*") return defaults;
  for (const param of splitTopLevel(src, ",")) {
    const assign = topLevelAssign(param);
    if (assign === -1) continue;
    // The name is the last bare token before `=` (`uniform color diffuse_tint`).
    const name = param.slice(0, assign).trim().split(/\s+/).pop();
    if (!name || !IDENTIFIER_RE.test(name)) continue;
    const value = parseMdlLiteral(param.slice(assign + 1));
    if (value !== undefined) defaults.set(name, value);
  }
  return defaults;
}

/**
 * Parse the body after `=`: a single `Base(name: value, …)` call yields the
 * wrapper base + args; anything else (a `let … in material(…)` definition, a
 * direct `material(…)`) yields neither.
 */
function parseWrapperBody(src: string): { base?: string; args: Map<string, MdlValue> } {
  const args = new Map<string, MdlValue>();
  const body = src.trim();
  const call = CALL_RE.exec(body);
  if (!call) return { args };
  const open = call[0].length - 1;
  if (matchParen(body, open) !== body.length) return { args };
  const base = (call[1] as string).split("::").pop() as string;
  if (base === "material") return { args };
  for (const arg of splitTopLevel(body.slice(open + 1, body.length - 1), ",")) {
    const colon = topLevelColon(arg);
    if (colon === -1) continue;
    const name = arg.slice(0, colon).trim();
    if (!IDENTIFIER_RE.test(name)) continue;
    const value = parseMdlLiteral(arg.slice(colon + 1));
    if (value !== undefined) args.set(name, value);
  }
  return { base, args };
}

/** Remove comments and `[[ … ]]` annotation blocks, keeping string literals. */
function stripNoise(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      out += " ";
    } else if (c === "[" && src[i + 1] === "[") {
      i = skipAnnotation(src, i);
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Skip a string literal; `i` is the opening quote. Returns the index after it. */
function skipString(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") j += 2;
    else if (src[j] === '"') return j + 1;
    else j++;
  }
  return j;
}

/** Skip a `[[ … ]]` annotation block (may nest); `i` is the first `[`. */
function skipAnnotation(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    if (src[j] === '"') {
      j = skipString(src, j);
    } else if (src[j] === "[" && src[j + 1] === "[") {
      depth++;
      j += 2;
    } else if (src[j] === "]" && src[j + 1] === "]") {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else {
      j++;
    }
  }
  return j;
}

/** Index just past the `)` matching the `(` at `open`, or `-1`. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return -1;
}

function isOpener(c: string): boolean {
  return c === "(" || c === "[" || c === "{";
}

function isCloser(c: string): boolean {
  return c === ")" || c === "]" || c === "}";
}

/** Split on `separator` at bracket depth 0, respecting string literals. */
function splitTopLevel(src: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (isOpener(c)) depth++;
    else if (isCloser(c)) depth--;
    else if (c === separator && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(src.slice(start));
  return parts;
}

/** Depth-0 index of the statement-terminating `;` at/after `from`, else `src.length`. */
function statementEnd(src: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (isOpener(c)) depth++;
    else if (isCloser(c)) depth--;
    else if (c === ";" && depth === 0) return i;
    i++;
  }
  return src.length;
}

/** Depth-0 index of a single `=` (not `==` / `<=` / `>=` / `!=`), or `-1`. */
function topLevelAssign(src: string): number {
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (isOpener(c)) depth++;
    else if (isCloser(c)) depth--;
    else if (c === "=" && depth === 0 && src[i + 1] !== "=" && !"<>!=".includes(src[i - 1] ?? "")) {
      return i;
    }
    i++;
  }
  return -1;
}

/** Depth-0 index of a single `:` (not the `::` scope operator), or `-1`. */
function topLevelColon(src: string): number {
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '"') {
      i = skipString(src, i);
      continue;
    }
    if (isOpener(c)) depth++;
    else if (isCloser(c)) depth--;
    else if (c === ":" && depth === 0) {
      if (src[i + 1] === ":") {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}
