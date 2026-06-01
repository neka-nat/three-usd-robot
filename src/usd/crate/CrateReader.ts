/**
 * Reader for the OpenUSD binary "crate" format (`.usdc` / binary `.usd`).
 *
 * Built incrementally (M10): bootstrap header + table of contents + the TOKENS
 * section first; STRINGS/FIELDS/FIELDSETS/PATHS/SPECS and value reps follow.
 * References pxr `Usd/crateFile.cpp`. This is a from-scratch TS reader — not a
 * binding to OpenUSD.
 */

import { AssetPath, Quat, UsdMatrix, type UsdValue, type Vec3 } from "../../parser/ast.js";
import { decodeIntegers32 } from "./integerCompression.js";
import { fastDecompress } from "./lz4.js";
import { CrateType, ListOpBits, decodeRepBits, halfToFloat } from "./valueTypes.js";

const MAGIC = "PXR-USDC";

/** Scratch view for reinterpreting inlined float/double bits. */
const scratch = new DataView(new ArrayBuffer(8));

/** Sentinel separating entries in the FIELDSETS array (max uint32 → -1 signed). */
const FIELDSET_END = -1;

export type CrateSection = {
  name: string;
  start: number;
  size: number;
};

export type CrateField = {
  /** Field name (token index). */
  nameIndex: number;
  /** Packed `ValueRep` (decoded in M10c). */
  rep: bigint;
};

export type CrateSpec = {
  pathIndex: number;
  fieldSetIndex: number;
  specType: number;
};

export class CrateReader {
  readonly version: readonly [number, number, number];
  readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly sections = new Map<string, CrateSection>();

  private _tokens?: string[];
  private _strings?: number[];
  private _fields?: CrateField[];
  private _fieldSets?: number[];
  private _paths?: string[];
  private _specs?: CrateSpec[];

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    const magic = asciiAt(bytes, 0, 8);
    if (magic !== MAGIC) {
      throw new Error(`not a USDC crate file (magic ${JSON.stringify(magic)})`);
    }
    this.version = [bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0];

    const tocOffset = this.u64(16);
    this.readToc(tocOffset);
  }

  /** True if `bytes` begins with the crate magic. */
  static isCrate(bytes: Uint8Array): boolean {
    return asciiAt(bytes, 0, 8) === MAGIC;
  }

  getSection(name: string): CrateSection | undefined {
    return this.sections.get(name);
  }

  /** Read a little-endian uint64 as a JS number (safe for crate-sized files). */
  u64(offset: number): number {
    return Number(this.view.getBigUint64(offset, true));
  }

  i64(offset: number): bigint {
    return this.view.getBigInt64(offset, true);
  }

  private readToc(offset: number): void {
    const count = this.u64(offset);
    let p = offset + 8;
    for (let i = 0; i < count; i++) {
      const name = asciiAt(this.bytes, p, 16).replace(/\0+$/, "");
      const start = this.u64(p + 16);
      const size = this.u64(p + 24);
      this.sections.set(name, { name, start, size });
      p += 32;
    }
  }

  // --- TOKENS -------------------------------------------------------------

  getTokens(): string[] {
    if (!this._tokens) this._tokens = this.readTokens();
    return this._tokens;
  }

  getToken(index: number): string {
    return this.getTokens()[index] ?? "";
  }

  private readTokens(): string[] {
    const section = this.sections.get("TOKENS");
    if (!section) return [];
    let p = section.start;
    const numTokens = this.u64(p);
    p += 8;
    const uncompressedSize = this.u64(p);
    p += 8;
    const compressedSize = this.u64(p);
    p += 8;

    const compressed = this.bytes.subarray(p, p + compressedSize);
    const buffer = fastDecompress(compressed, uncompressedSize);

    // Null-separated UTF-8 strings.
    const tokens: string[] = [];
    const decoder = new TextDecoder();
    let start = 0;
    for (let i = 0; i < buffer.length && tokens.length < numTokens; i++) {
      if (buffer[i] === 0) {
        tokens.push(decoder.decode(buffer.subarray(start, i)));
        start = i + 1;
      }
    }
    return tokens;
  }

  // --- STRINGS ------------------------------------------------------------

  /** String values are token indices. */
  getStrings(): number[] {
    if (!this._strings) this._strings = this.readStrings();
    return this._strings;
  }

  private readStrings(): number[] {
    const section = this.sections.get("STRINGS");
    if (!section) return [];
    const count = this.u64(section.start);
    const out = new Array<number>(count);
    let p = section.start + 8;
    for (let i = 0; i < count; i++) {
      out[i] = this.view.getUint32(p, true);
      p += 4;
    }
    return out;
  }

  /** Read a `TfFastCompression`-wrapped, delta+integer-compressed array of `count` ints. */
  private readCompressedInts(p: number, count: number): { values: number[]; next: number } {
    const compressedSize = this.u64(p);
    const dataStart = p + 8;
    const buf = this.bytes.subarray(dataStart, dataStart + compressedSize);
    return { values: decodeIntegers32(buf, count), next: dataStart + compressedSize };
  }

  // --- FIELDS -------------------------------------------------------------

  getFields(): CrateField[] {
    if (!this._fields) this._fields = this.readFields();
    return this._fields;
  }

  private readFields(): CrateField[] {
    const section = this.sections.get("FIELDS");
    if (!section) return [];
    let p = section.start;
    const numFields = this.u64(p);
    p += 8;

    const names = this.readCompressedInts(p, numFields);
    p = names.next;

    // Reps: a TfFastCompression-wrapped contiguous array of uint64.
    const repsCompressedSize = this.u64(p);
    p += 8;
    const repsBuf = this.bytes.subarray(p, p + repsCompressedSize);
    const repBytes = fastDecompress(repsBuf, numFields * 8);
    const repView = new DataView(repBytes.buffer, repBytes.byteOffset, repBytes.byteLength);

    const fields = new Array<CrateField>(numFields);
    for (let i = 0; i < numFields; i++) {
      fields[i] = { nameIndex: names.values[i]!, rep: repView.getBigUint64(i * 8, true) };
    }
    return fields;
  }

  // --- FIELDSETS ----------------------------------------------------------

  getFieldSets(): number[] {
    if (!this._fieldSets) this._fieldSets = this.readFieldSets();
    return this._fieldSets;
  }

  private readFieldSets(): number[] {
    const section = this.sections.get("FIELDSETS");
    if (!section) return [];
    const numFieldSets = this.u64(section.start);
    return this.readCompressedInts(section.start + 8, numFieldSets).values;
  }

  /** The field indices of the field set starting at `index` (until the sentinel). */
  getFieldSet(index: number): number[] {
    const all = this.getFieldSets();
    const out: number[] = [];
    for (let i = index; i < all.length && all[i] !== FIELDSET_END; i++) {
      out.push(all[i]!);
    }
    return out;
  }

  // --- PATHS --------------------------------------------------------------

  getPaths(): string[] {
    if (!this._paths) this._paths = this.readPaths();
    return this._paths;
  }

  private readPaths(): string[] {
    const section = this.sections.get("PATHS");
    if (!section) return [];
    let p = section.start;
    const numPaths = this.u64(p);
    p += 8;
    // pxr writes the count again before the compressed arrays.
    const numEncoded = this.u64(p);
    p += 8;

    const pathIndexes = this.readCompressedInts(p, numEncoded);
    p = pathIndexes.next;
    const elementTokenIndexes = this.readCompressedInts(p, numEncoded);
    p = elementTokenIndexes.next;
    const jumps = this.readCompressedInts(p, numEncoded);

    const paths = new Array<string>(numPaths).fill("");
    this.buildPaths(pathIndexes.values, elementTokenIndexes.values, jumps.values, 0, "", paths);
    return paths;
  }

  /** Reconstruct path strings from the compressed path tree (pxr `_BuildDecompressedPathsImpl`). */
  private buildPaths(
    pathIndexes: number[],
    elementTokenIndexes: number[],
    jumps: number[],
    startIndex: number,
    parentPath: string,
    paths: string[],
  ): void {
    let curIndex = startIndex;
    let parent = parentPath;
    let hasChild = false;
    let hasSibling = false;
    do {
      const thisIndex = curIndex++;
      const pathIdx = pathIndexes[thisIndex]!;
      if (parent === "") {
        paths[pathIdx] = "/";
        parent = "/";
      } else {
        let tokenIndex = elementTokenIndexes[thisIndex]!;
        const isProperty = tokenIndex < 0;
        if (tokenIndex < 0) tokenIndex = -tokenIndex;
        const elem = this.getToken(tokenIndex);
        paths[pathIdx] = appendElement(parent, elem, isProperty);
      }

      const jump = jumps[thisIndex]!;
      hasChild = jump > 0 || jump === -1;
      hasSibling = jump >= 0;

      if (hasChild) {
        if (hasSibling) {
          this.buildPaths(pathIndexes, elementTokenIndexes, jumps, thisIndex + jump, parent, paths);
        }
        parent = paths[pathIdx]!;
      }
    } while (hasChild || hasSibling);
  }

  // --- SPECS --------------------------------------------------------------

  getSpecs(): CrateSpec[] {
    if (!this._specs) this._specs = this.readSpecs();
    return this._specs;
  }

  private readSpecs(): CrateSpec[] {
    const section = this.sections.get("SPECS");
    if (!section) return [];
    let p = section.start;
    const numSpecs = this.u64(p);
    p += 8;

    const pathIndexes = this.readCompressedInts(p, numSpecs);
    p = pathIndexes.next;
    const fieldSetIndexes = this.readCompressedInts(p, numSpecs);
    p = fieldSetIndexes.next;
    const specTypes = this.readCompressedInts(p, numSpecs);

    const specs = new Array<CrateSpec>(numSpecs);
    for (let i = 0; i < numSpecs; i++) {
      specs[i] = {
        pathIndex: pathIndexes.values[i]!,
        fieldSetIndex: fieldSetIndexes.values[i]!,
        specType: specTypes.values[i]!,
      };
    }
    return specs;
  }

  // --- Values -------------------------------------------------------------

  /** Decode a `ValueRep` into a {@link UsdValue} (or `undefined` if unsupported). */
  getValue(rep: bigint): UsdValue | undefined {
    const b = decodeRepBits(rep);
    if (b.isArray) return this.readArray(b.type, Number(b.payload), b.isCompressed);
    if (b.isInlined) return this.readInlined(b.type, b.payload);
    return this.readScalar(b.type, Number(b.payload));
  }

  private readInlined(type: number, payload: bigint): UsdValue | undefined {
    const low = Number(payload & 0xffffffffn);
    switch (type) {
      case CrateType.Bool:
        return payload !== 0n;
      case CrateType.UChar:
        return low & 0xff;
      case CrateType.Int:
      case CrateType.Int64:
        return low | 0;
      case CrateType.UInt:
      case CrateType.UInt64:
        return low >>> 0;
      case CrateType.Half:
        return halfToFloat(low & 0xffff);
      case CrateType.Float:
      case CrateType.Double:
        // Inlined floats and doubles both store float32 bits in the low word.
        scratch.setUint32(0, low >>> 0, true);
        return scratch.getFloat32(0, true);
      case CrateType.Token:
        return this.getToken(low);
      case CrateType.String:
        return this.getToken(this.getStrings()[low] ?? 0);
      case CrateType.AssetPath:
        return new AssetPath(this.getToken(low));
      case CrateType.Specifier:
      case CrateType.Permission:
      case CrateType.Variability:
        return low;
      default:
        return undefined;
    }
  }

  private readScalar(type: number, off: number): UsdValue | undefined {
    const v = this.view;
    switch (type) {
      case CrateType.Float:
        return v.getFloat32(off, true);
      case CrateType.Double:
        return v.getFloat64(off, true);
      case CrateType.Half:
        return halfToFloat(v.getUint16(off, true));
      case CrateType.Int:
        return v.getInt32(off, true);
      case CrateType.UInt:
        return v.getUint32(off, true);
      case CrateType.Token:
        return this.getToken(v.getUint32(off, true));
      case CrateType.String:
        return this.getToken(this.getStrings()[v.getUint32(off, true)] ?? 0);
      case CrateType.AssetPath:
        return new AssetPath(this.getToken(v.getUint32(off, true)));
      case CrateType.Vec2f:
        return this.readFloat32s(off, 2);
      case CrateType.Vec3f:
        return this.readFloat32s(off, 3);
      case CrateType.Vec4f:
        return this.readFloat32s(off, 4);
      case CrateType.Vec2d:
        return this.readFloat64s(off, 2);
      case CrateType.Vec3d:
        return this.readFloat64s(off, 3);
      case CrateType.Vec4d:
        return this.readFloat64s(off, 4);
      case CrateType.Quatf: {
        const q = this.readFloat32s(off, 4);
        return new Quat(q[3]!, [q[0]!, q[1]!, q[2]!]);
      }
      case CrateType.Quatd: {
        const q = this.readFloat64s(off, 4);
        return new Quat(q[3]!, [q[0]!, q[1]!, q[2]!]);
      }
      case CrateType.Matrix4d:
        return new UsdMatrix(this.readFloat64s(off, 16), 4);
      case CrateType.Matrix3d:
        return new UsdMatrix(this.readFloat64s(off, 9), 3);
      case CrateType.TokenListOp:
      case CrateType.IntListOp:
        return this.readListOp(off, "token");
      case CrateType.PathListOp:
        return this.readListOp(off, "path");
      case CrateType.TokenVector:
        return this.readIndexVector(off, "token").items;
      case CrateType.PathVector:
        return this.readIndexVector(off, "path").items;
      default:
        return undefined;
    }
  }

  private readArray(type: number, off: number, compressed: boolean): UsdValue | undefined {
    if (off === 0) return []; // inlined empty array
    const count = this.u64(off);
    let p = off + 8;

    if (compressed) {
      const compressedSize = this.u64(p);
      p += 8;
      return decodeIntegers32(this.bytes.subarray(p, p + compressedSize), count);
    }

    const v = this.view;
    switch (type) {
      case CrateType.Int:
      case CrateType.UInt: {
        const out = new Array<number>(count);
        for (let i = 0; i < count; i++) out[i] = v.getInt32(p + i * 4, true);
        return out;
      }
      case CrateType.Float: {
        const out = new Array<number>(count);
        for (let i = 0; i < count; i++) out[i] = v.getFloat32(p + i * 4, true);
        return out;
      }
      case CrateType.Token: {
        const out = new Array<string>(count);
        for (let i = 0; i < count; i++) out[i] = this.getToken(v.getUint32(p + i * 4, true));
        return out;
      }
      case CrateType.Vec3f:
        return this.readVec3fArray(p, count, false);
      case CrateType.Vec3d:
        return this.readVec3fArray(p, count, true);
      default:
        return undefined;
    }
  }

  private readFloat32s(off: number, n: number): number[] {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.view.getFloat32(off + i * 4, true);
    return out;
  }

  private readFloat64s(off: number, n: number): number[] {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.view.getFloat64(off + i * 8, true);
    return out;
  }

  private readVec3fArray(off: number, count: number, double: boolean): Vec3[] {
    const out = new Array<Vec3>(count);
    const stride = double ? 24 : 12;
    for (let i = 0; i < count; i++) {
      const o = off + i * stride;
      out[i] = double
        ? [
            this.view.getFloat64(o, true),
            this.view.getFloat64(o + 8, true),
            this.view.getFloat64(o + 16, true),
          ]
        : [
            this.view.getFloat32(o, true),
            this.view.getFloat32(o + 4, true),
            this.view.getFloat32(o + 8, true),
          ];
    }
    return out;
  }

  /** Read a `[u64 count][count × uint32|int32 index]` vector → resolved strings. */
  private readIndexVector(off: number, kind: "token" | "path"): { items: string[]; next: number } {
    const count = this.u64(off);
    let p = off + 8;
    const items = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      const idx = this.view.getInt32(p, true);
      items[i] = kind === "token" ? this.getToken(idx) : (this.getPaths()[idx] ?? "");
      p += 4;
    }
    return { items, next: p };
  }

  /** Read an SdfListOp; returns the effective (explicit ∪ prepended ∪ added ∪ appended) items. */
  private readListOp(off: number, kind: "token" | "path"): string[] {
    const bits = this.bytes[off]!;
    let p = off + 1;
    const explicit: string[] = [];
    const prepended: string[] = [];
    const added: string[] = [];
    const appended: string[] = [];
    const read = (target: string[]) => {
      const r = this.readIndexVector(p, kind);
      target.push(...r.items);
      p = r.next;
    };
    if (bits & ListOpBits.HasExplicit) read(explicit);
    if (bits & ListOpBits.HasAdded) read(added);
    if (bits & ListOpBits.HasPrepended) read(prepended);
    if (bits & ListOpBits.HasAppended) read(appended);
    // (deleted / ordered are read for cursor correctness but ignored)
    if (bits & ListOpBits.HasDeleted) read([]);
    if (bits & ListOpBits.HasOrdered) read([]);
    return [...explicit, ...prepended, ...added, ...appended];
  }
}

/** Append a prim child (`/elem`) or property (`.elem`) to a path. */
function appendElement(parent: string, elem: string, isProperty: boolean): string {
  if (isProperty) return `${parent}.${elem}`;
  if (elem.startsWith("{")) return `${parent}${elem}`; // variant selection
  return parent === "/" ? `/${elem}` : `${parent}/${elem}`;
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const c = bytes[offset + i];
    if (c === undefined) break;
    out += String.fromCharCode(c);
  }
  return out;
}
