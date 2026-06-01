/**
 * Tokenizer for the USDA (ASCII USD) format.
 *
 * Produces a flat token stream consumed by `parseUsda`. Comments (`#...`) are
 * stripped. Paths (`<...>`) and asset paths (`@...@` / `@@@...@@@`) are scanned
 * as whole tokens because their interior characters are otherwise significant.
 */

export type TokenType =
  | "lbrace" // {
  | "rbrace" // }
  | "lparen" // (
  | "rparen" // )
  | "lbracket" // [
  | "rbracket" // ]
  | "equals" // =
  | "comma" // ,
  | "colon" // : (only as a standalone separator, e.g. timeSamples key)
  | "dot" // . (e.g. attr.connect)
  | "number"
  | "string"
  | "ident"
  | "path" // <...>
  | "asset" // @...@
  | "eof";

export type Token = {
  type: TokenType;
  /** Raw lexeme / decoded value. For `number` this is the original text. */
  value: string;
  /** Decoded numeric value for `number` tokens. */
  num?: number;
  /** 1-based line number where the token starts. */
  line: number;
  col: number;
};

export class TokenizeError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`USDA tokenize error (line ${line}:${col}): ${message}`);
    this.name = "TokenizeError";
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CONT = /[A-Za-z0-9_:]/;
// Matches a numeric literal incl. scientific notation; sign handled by caller.
const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;
const INF_NAN_RE = /^[-+]?(?:inf|nan)\b/i;

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;

  const col = () => i - lineStart + 1;
  const push = (type: TokenType, value: string, startCol: number, num?: number) => {
    tokens.push(
      num === undefined
        ? { type, value, line, col: startCol }
        : { type, value, num, line, col: startCol },
    );
  };

  while (i < n) {
    const c = src[i]!;

    // Newlines
    if (c === "\n") {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    // Whitespace (incl. CR, tabs)
    if (c === " " || c === "\t" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    // Line comment
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }

    const startCol = col();

    // Single-char punctuation
    const punct = PUNCT[c];
    if (punct) {
      push(punct, c, startCol);
      i++;
      continue;
    }

    // Triple-quoted string """ ... """
    if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      const { value, advanced } = readTripleString(src, i, line, startCol);
      push("string", value, startCol);
      i = advanced;
      continue;
    }
    // Regular string
    if (c === '"' || c === "'") {
      const { value, advanced } = readString(src, i, c, line, startCol);
      push("string", value, startCol);
      i = advanced;
      continue;
    }

    // Asset path: @@@ ... @@@ (allows interior @) or @ ... @
    if (c === "@") {
      const triple = src[i + 1] === "@" && src[i + 2] === "@";
      const { value, advanced } = readAsset(src, i, triple, line, startCol);
      push("asset", value, startCol);
      i = advanced;
      continue;
    }

    // Namespace path: < ... >
    if (c === "<") {
      const { value, advanced } = readPath(src, i, line, startCol);
      push("path", value, startCol);
      i = advanced;
      continue;
    }

    // inf / nan / -inf etc. as numbers
    const infMatch = INF_NAN_RE.exec(src.slice(i));
    if (infMatch) {
      const text = infMatch[0];
      const lower = text.toLowerCase();
      const num = lower.includes("nan")
        ? Number.NaN
        : lower.startsWith("-")
          ? Number.NEGATIVE_INFINITY
          : Number.POSITIVE_INFINITY;
      push("number", text, startCol, num);
      i += text.length;
      continue;
    }

    // Numbers (also handles leading sign). A bare `-`/`+` not followed by a
    // digit/dot falls through to ident handling (there are no such USDA tokens,
    // so this becomes an error below).
    if (
      /[0-9]/.test(c) ||
      ((c === "-" || c === "+" || c === ".") && /[0-9.]/.test(src[i + 1] ?? ""))
    ) {
      const m = NUMBER_RE.exec(src.slice(i));
      if (m) {
        const text = m[0];
        push("number", text, startCol, Number(text));
        i += text.length;
        continue;
      }
    }

    // Dot (e.g. attr.connect) — only reached when not part of a number.
    if (c === ".") {
      push("dot", ".", startCol);
      i++;
      continue;
    }

    // Identifiers / keywords (incl. namespaced names with ':')
    if (IDENT_START.test(c)) {
      const start = i;
      i++;
      while (i < n && IDENT_CONT.test(src[i]!)) i++;
      push("ident", src.slice(start, i), startCol);
      continue;
    }

    throw new TokenizeError(`unexpected character ${JSON.stringify(c)}`, line, startCol);
  }

  tokens.push({ type: "eof", value: "", line, col: col() });
  return tokens;
}

const PUNCT: Record<string, TokenType | undefined> = {
  "{": "lbrace",
  "}": "rbrace",
  "(": "lparen",
  ")": "rparen",
  "[": "lbracket",
  "]": "rbracket",
  "=": "equals",
  ",": "comma",
  ":": "colon",
};

function readString(
  src: string,
  start: number,
  quote: string,
  line: number,
  startCol: number,
): { value: string; advanced: number } {
  let i = start + 1;
  let out = "";
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\") {
      const next = src[i + 1];
      out += ESCAPES[next ?? ""] ?? next ?? "";
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { value: out, advanced: i + 1 };
    }
    if (ch === "\n") break;
    out += ch;
    i++;
  }
  throw new TokenizeError("unterminated string literal", line, startCol);
}

function readTripleString(
  src: string,
  start: number,
  line: number,
  startCol: number,
): { value: string; advanced: number } {
  let i = start + 3;
  let out = "";
  while (i < src.length) {
    if (src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      return { value: out, advanced: i + 3 };
    }
    out += src[i];
    i++;
  }
  throw new TokenizeError("unterminated triple-quoted string", line, startCol);
}

function readAsset(
  src: string,
  start: number,
  triple: boolean,
  line: number,
  startCol: number,
): { value: string; advanced: number } {
  const delimLen = triple ? 3 : 1;
  let i = start + delimLen;
  let out = "";
  while (i < src.length) {
    if (triple) {
      if (src[i] === "@" && src[i + 1] === "@" && src[i + 2] === "@") {
        return { value: out, advanced: i + 3 };
      }
    } else if (src[i] === "@") {
      return { value: out, advanced: i + 1 };
    }
    if (src[i] === "\n") break;
    out += src[i];
    i++;
  }
  throw new TokenizeError("unterminated asset path", line, startCol);
}

function readPath(
  src: string,
  start: number,
  line: number,
  startCol: number,
): { value: string; advanced: number } {
  let i = start + 1;
  let out = "";
  while (i < src.length) {
    if (src[i] === ">") {
      return { value: out, advanced: i + 1 };
    }
    if (src[i] === "\n") break;
    out += src[i];
    i++;
  }
  throw new TokenizeError("unterminated path <...>", line, startCol);
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  '"': '"',
  "'": "'",
  "\\": "\\",
};
