import type { Token, TokenType } from "./tokenize.js";

export class ParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`USDA parse error (line ${line}:${col}): ${message}`);
    this.name = "ParseError";
  }
}

/** Cursor over a token stream with lookahead and typed consumption helpers. */
export class TokenReader {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  peek(ahead = 0): Token {
    return this.tokens[Math.min(this.pos + ahead, this.tokens.length - 1)]!;
  }

  next(): Token {
    const t = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  atEnd(): boolean {
    return this.peek().type === "eof";
  }

  is(type: TokenType, ahead = 0): boolean {
    return this.peek(ahead).type === type;
  }

  /** True when the lookahead token is an identifier with the given text. */
  isIdent(value: string, ahead = 0): boolean {
    const t = this.peek(ahead);
    return t.type === "ident" && t.value === value;
  }

  expect(type: TokenType): Token {
    const t = this.peek();
    if (t.type !== type) {
      throw new ParseError(
        `expected ${type} but found ${t.type} ${JSON.stringify(t.value)}`,
        t.line,
        t.col,
      );
    }
    return this.next();
  }

  /** Consume an identifier token (any value) and return its text. */
  expectIdent(): string {
    return this.expect("ident").value;
  }

  /** Consume the given token type if present; return whether it was consumed. */
  accept(type: TokenType): boolean {
    if (this.is(type)) {
      this.next();
      return true;
    }
    return false;
  }

  /** Consume an identifier with the exact text if present. */
  acceptIdent(value: string): boolean {
    if (this.isIdent(value)) {
      this.next();
      return true;
    }
    return false;
  }

  error(message: string): ParseError {
    const t = this.peek();
    return new ParseError(message, t.line, t.col);
  }
}
