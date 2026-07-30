/**
 * Reader for the OpenUSD binary "crate" format (`.usdc` / binary `.usd`).
 *
 * Built incrementally (M10): bootstrap header + table of contents + the TOKENS
 * section first; STRINGS/FIELDS/FIELDSETS/PATHS/SPECS and value reps follow.
 * References pxr `Usd/crateFile.cpp`. This is a from-scratch TS reader — not a
 * binding to OpenUSD.
 */

import {
  AssetPath,
  type CompositionArc,
  Quat,
  type UsdDictionary,
  UsdMatrix,
  type UsdValue,
  type Vec3,
} from "../../parser/ast.js";
import { decodeIntegers32 } from "./integerCompression.js";
import { fastDecompress } from "./lz4.js";
import { CrateType, ListOpBits, decodeRepBits, halfToFloat } from "./valueTypes.js";

const MAGIC = "PXR-USDC";

/** Scratch view for reinterpreting inlined float/double bits. */
const scratch = new DataView(new ArrayBuffer(8));

/** Sentinel separating entries in the FIELDSETS array (max uint32 → -1 signed). */
const FIELDSET_END = -1;

/** pxr writes arrays below this element count raw, even with the compressed bit. */
const MIN_COMPRESSED_ARRAY_SIZE = 16;

/** Sign-extended int8 components from an inlined vec/matrix payload's low bytes. */
function inlineInt8s(low: number, n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = (((low >>> (i * 8)) & 0xff) << 24) >> 24;
  return out;
}

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

  /**
   * Decode a `timeSamples` field (a {@link CrateType.TimeSamples} rep) into
   * parallel times/values arrays; `undefined` if `rep` is some other type.
   *
   * Layout (pxr `crateFile.cpp`, `Write(TimeSamples)`): an `int64` offset —
   * relative to its own position — jumps over the recursively-written times
   * data to the times `ValueRep` (a `DoubleVector`); a second such offset
   * jumps over the samples' data to `[u64 count][count × ValueRep]`. Sample
   * reps decode through {@link getValue}, so every scalar/array type works.
   */
  getTimeSamples(rep: bigint): { times: number[]; values: (UsdValue | undefined)[] } | undefined {
    const b = decodeRepBits(rep);
    if (b.type !== CrateType.TimeSamples || b.isArray || b.isInlined) return undefined;
    const off = Number(b.payload);

    let p = off + Number(this.i64(off));
    const times = this.getValue(this.view.getBigUint64(p, true));
    p += 8;
    if (!Array.isArray(times) || !times.every((t) => typeof t === "number")) return undefined;

    p += Number(this.i64(p));
    const count = this.u64(p);
    p += 8;
    const values = new Array<UsdValue | undefined>(count);
    for (let i = 0; i < count; i++) {
      values[i] = this.getValue(this.view.getBigUint64(p + i * 8, true));
    }
    return { times: times as number[], values };
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
      // Vectors whose components are all small integers are inlined as one
      // int8 per component in the payload's low bytes (crateValueInliners.h).
      case CrateType.Vec2i:
      case CrateType.Vec2h:
      case CrateType.Vec2f:
      case CrateType.Vec2d:
        return inlineInt8s(low, 2);
      case CrateType.Vec3i:
      case CrateType.Vec3h:
      case CrateType.Vec3f:
      case CrateType.Vec3d:
        return inlineInt8s(low, 3) as Vec3;
      case CrateType.Vec4i:
      case CrateType.Vec4h:
      case CrateType.Vec4f:
      case CrateType.Vec4d:
        return inlineInt8s(low, 4);
      // Matrices inline when off-diagonal is zero and the diagonal fits int8.
      case CrateType.Matrix3d: {
        const [a, b, c] = inlineInt8s(low, 3);
        // biome-ignore format: keep matrix layout readable
        return new UsdMatrix([
          a!, 0, 0,
          0, b!, 0,
          0, 0, c!,
        ], 3);
      }
      case CrateType.Matrix4d: {
        const [a, b, c, d] = inlineInt8s(low, 4);
        // biome-ignore format: keep matrix layout readable
        return new UsdMatrix([
          a!, 0, 0, 0,
          0, b!, 0, 0,
          0, 0, c!, 0,
          0, 0, 0, d!,
        ], 4);
      }
      // Only the empty dictionary is inlined.
      case CrateType.Dictionary:
        return {};
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
      case CrateType.UChar:
        return v.getUint8(off);
      case CrateType.Int64:
        return Number(v.getBigInt64(off, true));
      case CrateType.UInt64:
        return Number(v.getBigUint64(off, true));
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
      case CrateType.Vec2h:
        return this.readHalfs(off, 2);
      case CrateType.Vec3h:
        return this.readHalfs(off, 3);
      case CrateType.Vec4h:
        return this.readHalfs(off, 4);
      case CrateType.Vec2i:
        return this.readInt32s(off, 2);
      case CrateType.Vec3i:
        return this.readInt32s(off, 3);
      case CrateType.Vec4i:
        return this.readInt32s(off, 4);
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
      case CrateType.ReferenceListOp:
        return this.readArcListOp(off, true);
      case CrateType.PayloadListOp:
        return this.readArcListOp(off, false);
      case CrateType.TokenVector:
        return this.readIndexVector(off, "token").items;
      case CrateType.PathVector:
        return this.readIndexVector(off, "path").items;
      case CrateType.StringVector:
        return this.readIndexVector(off, "string").items;
      case CrateType.VariantSelectionMap:
        return this.readVariantSelectionMap(off);
      case CrateType.DoubleVector: {
        // `std::vector<double>`: `[u64 count][count × f64]` (e.g. shared
        // timeSamples times).
        const count = this.u64(off);
        return this.readFloat64s(off + 8, count);
      }
      case CrateType.Dictionary:
        return this.readDictionary(off, 0);
      default:
        return undefined;
    }
  }

  /** Array headers store a u32 count before crate 0.7.0, a u64 from 0.7.0 on. */
  private arrayHeader(off: number): { count: number; next: number } {
    if (this.version[0] === 0 && this.version[1] < 7) {
      return { count: this.view.getUint32(off, true), next: off + 4 };
    }
    return { count: this.u64(off), next: off + 8 };
  }

  private readArray(type: number, off: number, compressed: boolean): UsdValue | undefined {
    if (off === 0) return []; // inlined empty array
    const { count, next: p } = this.arrayHeader(off);
    if (count === 0) return [];
    if (compressed) return this.readCompressedArray(type, p, count);

    const v = this.view;
    switch (type) {
      case CrateType.Bool: {
        const out = new Array<boolean>(count);
        for (let i = 0; i < count; i++) out[i] = this.bytes[p + i] !== 0;
        return out;
      }
      case CrateType.UChar: {
        const out = new Array<number>(count);
        for (let i = 0; i < count; i++) out[i] = this.bytes[p + i]!;
        return out;
      }
      case CrateType.Int:
      case CrateType.UInt: {
        const out = new Array<number>(count);
        for (let i = 0; i < count; i++) out[i] = v.getInt32(p + i * 4, true);
        return out;
      }
      case CrateType.Int64: {
        const out = new Array<number>(count);
        for (let i = 0; i < count; i++) out[i] = Number(v.getBigInt64(p + i * 8, true));
        return out;
      }
      case CrateType.UInt64: {
        const out = new Array<number>(count);
        for (let i = 0; i < count; i++) out[i] = Number(v.getBigUint64(p + i * 8, true));
        return out;
      }
      case CrateType.Half:
        return this.readHalfs(p, count);
      case CrateType.Float:
        return this.readFloat32s(p, count);
      case CrateType.Double:
        return this.readFloat64s(p, count);
      case CrateType.Token: {
        const out = new Array<string>(count);
        for (let i = 0; i < count; i++) out[i] = this.getToken(v.getUint32(p + i * 4, true));
        return out;
      }
      case CrateType.String: {
        const out = new Array<string>(count);
        for (let i = 0; i < count; i++) {
          out[i] = this.getToken(this.getStrings()[v.getUint32(p + i * 4, true)] ?? 0);
        }
        return out;
      }
      case CrateType.AssetPath: {
        const out = new Array<AssetPath>(count);
        for (let i = 0; i < count; i++) {
          out[i] = new AssetPath(
            this.getToken(this.getStrings()[v.getUint32(p + i * 4, true)] ?? 0),
          );
        }
        return out;
      }
      case CrateType.Vec2f:
        return this.readTupleArray(p, count, 2, "f32");
      case CrateType.Vec3f:
        return this.readTupleArray(p, count, 3, "f32");
      case CrateType.Vec4f:
        return this.readTupleArray(p, count, 4, "f32");
      case CrateType.Vec2d:
        return this.readTupleArray(p, count, 2, "f64");
      case CrateType.Vec3d:
        return this.readTupleArray(p, count, 3, "f64");
      case CrateType.Vec4d:
        return this.readTupleArray(p, count, 4, "f64");
      case CrateType.Vec2h:
        return this.readTupleArray(p, count, 2, "f16");
      case CrateType.Vec3h:
        return this.readTupleArray(p, count, 3, "f16");
      case CrateType.Vec4h:
        return this.readTupleArray(p, count, 4, "f16");
      case CrateType.Vec2i:
        return this.readTupleArray(p, count, 2, "i32");
      case CrateType.Vec3i:
        return this.readTupleArray(p, count, 3, "i32");
      case CrateType.Vec4i:
        return this.readTupleArray(p, count, 4, "i32");
      case CrateType.Quatf: {
        const out = new Array<Quat>(count);
        for (let i = 0; i < count; i++) {
          const q = this.readFloat32s(p + i * 16, 4);
          out[i] = new Quat(q[3]!, [q[0]!, q[1]!, q[2]!]);
        }
        return out;
      }
      case CrateType.Quatd: {
        const out = new Array<Quat>(count);
        for (let i = 0; i < count; i++) {
          const q = this.readFloat64s(p + i * 32, 4);
          out[i] = new Quat(q[3]!, [q[0]!, q[1]!, q[2]!]);
        }
        return out;
      }
      case CrateType.Matrix3d: {
        const out = new Array<UsdMatrix>(count);
        for (let i = 0; i < count; i++) out[i] = new UsdMatrix(this.readFloat64s(p + i * 72, 9), 3);
        return out;
      }
      case CrateType.Matrix4d: {
        const out = new Array<UsdMatrix>(count);
        for (let i = 0; i < count; i++)
          out[i] = new UsdMatrix(this.readFloat64s(p + i * 128, 16), 4);
        return out;
      }
      default:
        return undefined;
    }
  }

  /**
   * Decode an array whose rep has the compressed bit. Int arrays are
   * integer-compressed; half/float/double arrays (crate 0.6.0+) carry a code
   * byte — `'i'` when every value is integral, `'t'` for a lookup table +
   * compressed indexes. Arrays under {@link MIN_COMPRESSED_ARRAY_SIZE} elements
   * are stored raw even when the bit is set (mirrors pxr's writer).
   */
  private readCompressedArray(type: number, start: number, count: number): UsdValue | undefined {
    let p = start;
    switch (type) {
      case CrateType.Int:
      case CrateType.UInt: {
        if (count < MIN_COMPRESSED_ARRAY_SIZE) {
          const out = new Array<number>(count);
          for (let i = 0; i < count; i++) out[i] = this.view.getInt32(p + i * 4, true);
          return out;
        }
        return this.readCompressedInts(p, count).values;
      }
      case CrateType.Half:
      case CrateType.Float:
      case CrateType.Double: {
        const readRaw = (off: number, n: number): number[] =>
          type === CrateType.Double
            ? this.readFloat64s(off, n)
            : type === CrateType.Float
              ? this.readFloat32s(off, n)
              : this.readHalfs(off, n);
        if (count < MIN_COMPRESSED_ARRAY_SIZE) return readRaw(p, count);
        const code = this.bytes[p]!;
        p += 1;
        if (code === 0x69 /* 'i': every value is an integer */) {
          return this.readCompressedInts(p, count).values;
        }
        if (code === 0x74 /* 't': lookup table + indexes */) {
          const lutSize = this.view.getUint32(p, true);
          p += 4;
          const lut = readRaw(p, lutSize);
          p += lutSize * (type === CrateType.Double ? 8 : type === CrateType.Float ? 4 : 2);
          return this.readCompressedInts(p, count).values.map((i) => lut[i] ?? 0);
        }
        return undefined; // corrupt stream
      }
      default:
        // 64-bit integer compression is not implemented (unseen in practice).
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

  private readHalfs(off: number, n: number): number[] {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = halfToFloat(this.view.getUint16(off + i * 2, true));
    return out;
  }

  private readInt32s(off: number, n: number): number[] {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = this.view.getInt32(off + i * 4, true);
    return out;
  }

  /** Read `count` fixed-size `n`-tuples (vec2/3/4 of the given element kind). */
  private readTupleArray(
    off: number,
    count: number,
    n: number,
    kind: "f32" | "f64" | "f16" | "i32",
  ): number[][] {
    const elemSize = kind === "f64" ? 8 : kind === "f16" ? 2 : 4;
    const out = new Array<number[]>(count);
    for (let i = 0; i < count; i++) {
      const o = off + i * n * elemSize;
      out[i] =
        kind === "f64"
          ? this.readFloat64s(o, n)
          : kind === "f32"
            ? this.readFloat32s(o, n)
            : kind === "f16"
              ? this.readHalfs(o, n)
              : this.readInt32s(o, n);
    }
    return out;
  }

  /**
   * Read a `VtDictionary`: `[u64 count]`, then per entry a string index (key)
   * followed by a recursive VtValue — an `int64` offset (relative to its own
   * position) over the value's data to an 8-byte `ValueRep`.
   */
  private readDictionary(off: number, depth: number): UsdDictionary {
    const out: UsdDictionary = {};
    if (depth > 16) return out; // corrupt-file recursion guard
    const count = this.u64(off);
    let p = off + 8;
    for (let i = 0; i < count; i++) {
      const key = this.getToken(this.getStrings()[this.view.getUint32(p, true)] ?? 0);
      p += 4;
      const repPos = p + Number(this.i64(p));
      const rep = this.view.getBigUint64(repPos, true);
      const b = decodeRepBits(rep);
      const value =
        b.type === CrateType.Dictionary && !b.isInlined && !b.isArray
          ? this.readDictionary(Number(b.payload), depth + 1)
          : this.getValue(rep);
      if (key && value !== undefined) out[key] = value;
      p = repPos + 8;
    }
    return out;
  }

  /**
   * Read an `SdfVariantSelectionMap`: `[u64 count]` then `count` pairs of
   * string indexes (`variantSetName → variantName`). Surfaces as a dictionary
   * so it maps straight onto the USDA `variants = { ... }` metadatum.
   */
  private readVariantSelectionMap(off: number): UsdDictionary {
    const count = this.u64(off);
    const strings = this.getStrings();
    const out: UsdDictionary = {};
    let p = off + 8;
    for (let i = 0; i < count; i++) {
      const key = this.getToken(strings[this.view.getUint32(p, true)] ?? 0);
      const value = this.getToken(strings[this.view.getUint32(p + 4, true)] ?? 0);
      if (key) out[key] = value;
      p += 8;
    }
    return out;
  }

  /** Read a `[u64 count][count × uint32|int32 index]` vector → resolved strings. */
  private readIndexVector(
    off: number,
    kind: "token" | "path" | "string",
  ): { items: string[]; next: number } {
    const count = this.u64(off);
    let p = off + 8;
    const items = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      const idx = this.view.getInt32(p, true);
      items[i] =
        kind === "token"
          ? this.getToken(idx)
          : kind === "string"
            ? this.getToken(this.getStrings()[idx] ?? 0)
            : (this.getPaths()[idx] ?? "");
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

  /**
   * Read a Reference/Payload list-op into composition arcs. Each item is
   * `[assetPath: string-index][primPath: path-index][layerOffset: 2 doubles]`,
   * and a Reference additionally carries a (usually empty) customData dict.
   */
  private readArcListOp(off: number, isReference: boolean): CompositionArc[] {
    const bits = this.bytes[off]!;
    let p = off + 1;
    const out: CompositionArc[] = [];

    const readList = (collect: boolean) => {
      const count = this.u64(p);
      p += 8;
      for (let i = 0; i < count; i++) {
        const assetStrIndex = this.view.getUint32(p, true);
        p += 4;
        const primPathIndex = this.view.getInt32(p, true);
        p += 4;
        p += 16; // SdfLayerOffset: offset + scale (two doubles)
        if (isReference) p += 8; // customData dict count (assumed empty)
        if (!collect) continue;
        const assetPath = this.getToken(this.getStrings()[assetStrIndex] ?? -1);
        const primPath = this.getPaths()[primPathIndex] ?? "";
        const arc: CompositionArc = { assetPath: new AssetPath(assetPath) };
        if (primPath) arc.primPath = primPath;
        out.push(arc);
      }
    };

    // Read order matches the writer: explicit, added, prepended, appended, deleted, ordered.
    if (bits & ListOpBits.HasExplicit) readList(true);
    if (bits & ListOpBits.HasAdded) readList(true);
    if (bits & ListOpBits.HasPrepended) readList(true);
    if (bits & ListOpBits.HasAppended) readList(true);
    if (bits & ListOpBits.HasDeleted) readList(false);
    if (bits & ListOpBits.HasOrdered) readList(false);
    return out;
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
