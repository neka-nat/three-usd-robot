/** OpenUSD crate `TypeEnum` values (`crateDataTypes.h` order). */
export const CrateType = {
  Invalid: 0,
  Bool: 1,
  UChar: 2,
  Int: 3,
  UInt: 4,
  Int64: 5,
  UInt64: 6,
  Half: 7,
  Float: 8,
  Double: 9,
  String: 10,
  Token: 11,
  AssetPath: 12,
  Matrix2d: 13,
  Matrix3d: 14,
  Matrix4d: 15,
  Quatd: 16,
  Quatf: 17,
  Quath: 18,
  Vec2d: 19,
  Vec2f: 20,
  Vec2h: 21,
  Vec2i: 22,
  Vec3d: 23,
  Vec3f: 24,
  Vec3h: 25,
  Vec3i: 26,
  Vec4d: 27,
  Vec4f: 28,
  Vec4h: 29,
  Vec4i: 30,
  Dictionary: 31,
  TokenListOp: 32,
  StringListOp: 33,
  PathListOp: 34,
  ReferenceListOp: 35,
  IntListOp: 36,
  Int64ListOp: 37,
  UIntListOp: 38,
  UInt64ListOp: 39,
  PathVector: 40,
  TokenVector: 41,
  Specifier: 42,
  Permission: 43,
  Variability: 44,
  VariantSelectionMap: 45,
  TimeSamples: 46,
  Payload: 47,
  DoubleVector: 48,
  LayerOffsetVector: 49,
  StringVector: 50,
  ValueBlock: 51,
  Value: 52,
  UnregisteredValue: 53,
  UnregisteredValueListOp: 54,
  PayloadListOp: 55,
  TimeCode: 56,
} as const;

/** `_ListOpHeader` bit flags. */
export const ListOpBits = {
  IsExplicit: 1 << 0,
  HasExplicit: 1 << 1,
  HasAdded: 1 << 2,
  HasDeleted: 1 << 3,
  HasOrdered: 1 << 4,
  HasPrepended: 1 << 5,
  HasAppended: 1 << 6,
} as const;

/** Decompose a packed `ValueRep` uint64. */
export function decodeRepBits(rep: bigint): {
  isArray: boolean;
  isInlined: boolean;
  isCompressed: boolean;
  type: number;
  payload: bigint;
} {
  return {
    isArray: (rep & (1n << 63n)) !== 0n,
    isInlined: (rep & (1n << 62n)) !== 0n,
    isCompressed: (rep & (1n << 61n)) !== 0n,
    type: Number((rep >> 48n) & 0xffn),
    payload: rep & ((1n << 48n) - 1n),
  };
}

/** Half-precision float → number. */
export function halfToFloat(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  let value: number;
  if (exp === 0) value = frac / 1024;
  else if (exp === 0x1f) value = frac ? Number.NaN : Number.POSITIVE_INFINITY;
  else return (sign ? -1 : 1) * 2 ** (exp - 15) * (1 + frac / 1024);
  return (sign ? -1 : 1) * (exp === 0 ? 2 ** -14 * value : value);
}
