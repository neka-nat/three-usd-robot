/**
 * AST and value types for the USDA (ASCII USD) format.
 *
 * The parser (`parseUsda`) produces a {@link UsdaFile}. The USD-conformant
 * runtime layer (`usd/Stage.ts` etc.) wraps this AST to expose a pxr-USD-style
 * API (`GetPrimAtPath`, `GetAttribute`, `Get`, `GetTargets`, ...).
 */

// ---------------------------------------------------------------------------
// Value types
// ---------------------------------------------------------------------------

/** Fixed-length numeric tuples, mirroring `GfVec2/3/4`. */
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

/**
 * A quaternion, mirroring `GfQuatf/d/h`.
 *
 * USDA authors quats as `(w, x, y, z)` — real part first. We keep the real and
 * imaginary parts explicit so downstream code never has to guess the component
 * order (Three.js, by contrast, uses `(x, y, z, w)`).
 */
export class Quat {
  constructor(
    readonly real: number,
    readonly imaginary: Vec3,
  ) {}

  /** Components in Three.js order `[x, y, z, w]`. */
  toXYZW(): Vec4 {
    return [this.imaginary[0], this.imaginary[1], this.imaginary[2], this.real];
  }

  static identity(): Quat {
    return new Quat(1, [0, 0, 0]);
  }
}

/**
 * A square matrix (`GfMatrix3d`/`GfMatrix4d`), stored flat in **row-major**
 * order exactly as authored in USD (USD matrices are row-major).
 */
export class UsdMatrix {
  constructor(
    readonly values: number[],
    readonly dim: 3 | 4,
  ) {}

  static identity4(): UsdMatrix {
    // biome-ignore format: keep matrix layout readable
    return new UsdMatrix([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ], 4);
  }
}

/** An asset reference (`SdfAssetPath`), e.g. `@./meshes/link0.usd@`. */
export class AssetPath {
  constructor(readonly path: string) {}
}

/**
 * A namespace path into a stage (`SdfPath`), e.g. `/World/robot/link0` or a
 * property path `/World/robot.xformOp:translate`. Stored as the authored
 * string; relationship/connection resolution happens in the runtime layer.
 */
export type SdfPath = string;

/** A reference / payload composition arc as authored (resolved in M8). */
export type CompositionArc = {
  assetPath?: AssetPath;
  primPath?: SdfPath;
};

/** Any value an attribute or metadatum can hold. */
export type UsdValue =
  | number
  | boolean
  | string
  | null
  | Vec2
  | Vec3
  | Vec4
  | Quat
  | UsdMatrix
  | AssetPath
  | SdfPath
  | CompositionArc
  | UsdValue[]
  | UsdDictionary;

/** A nested metadata dictionary (`customData`, `assetInfo`, ...). */
export type UsdDictionary = { [key: string]: UsdValue };

// ---------------------------------------------------------------------------
// AST nodes
// ---------------------------------------------------------------------------

export type Specifier = "def" | "over" | "class";

export type Variability = "varying" | "uniform";

/** List-editing qualifier on relationships and list-op metadata. */
export type ListOp = "explicit" | "prepend" | "append" | "add" | "delete" | "reorder";

export type MetadataMap = { [key: string]: UsdValue };

/** A parsed `.usda` layer. */
export type UsdaFile = {
  /** Version from the `#usda X.Y` magic line. */
  version: string;
  /** Layer-level metadata (`defaultPrim`, `upAxis`, `metersPerUnit`, ...). */
  metadata: MetadataMap;
  /** Root prims, in authored order. */
  prims: PrimSpec[];
};

export type PrimSpec = {
  specifier: Specifier;
  /** Schema type, e.g. `Xform`, `Mesh`, `PhysicsRevoluteJoint`. Empty if typeless. */
  typeName: string;
  name: string;
  metadata: MetadataMap;
  properties: PropertySpec[];
  children: PrimSpec[];
  /** Authored variant sets (`variantSet "name" = { ... }`), if any. */
  variantSets?: VariantSetMap;
  /** 1-based source line of the prim declaration (for diagnostics). */
  line: number;
};

/** The opinions a single variant contributes when selected. */
export type VariantContent = {
  properties: PropertySpec[];
  children: PrimSpec[];
};

/** `variantSetName → variantName → content`. */
export type VariantSetMap = { [setName: string]: { [variantName: string]: VariantContent } };

export type PropertySpec = AttributeSpec | RelationshipSpec;

export type AttributeSpec = {
  kind: "attribute";
  name: string;
  /** USD type name without the `[]` suffix, e.g. `float3`, `token`, `quatf`. */
  typeName: string;
  isArray: boolean;
  variability: Variability;
  custom: boolean;
  /** Default (time-independent) value, if authored. */
  value?: UsdValue;
  /** Time samples keyed by time code, if authored as `{ t: v, ... }`. */
  timeSamples?: Map<number, UsdValue>;
  /** Connection target paths (`attr.connect = <path>`), if authored. */
  connections?: SdfPath[];
  metadata: MetadataMap;
  line: number;
};

export type RelationshipSpec = {
  kind: "relationship";
  name: string;
  custom: boolean;
  listOp: ListOp;
  /** Target paths; empty when authored as `None`. */
  targets: SdfPath[];
  metadata: MetadataMap;
  line: number;
};
