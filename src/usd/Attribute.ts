import type {
  AttributeSpec,
  RelationshipSpec,
  SdfPath,
  UsdValue,
  Variability,
} from "../parser/ast.js";
import type { Prim } from "./Prim.js";
import { splitName } from "./names.js";

/**
 * A typed attribute on a prim (`UsdAttribute`-like).
 *
 * Mirrors the pxr USD API: `GetAttribute` always returns an `Attribute` object;
 * call {@link Attribute.IsValid} to check whether the attribute is actually
 * authored on the prim.
 */
export class Attribute {
  constructor(
    private readonly _prim: Prim,
    private readonly _name: string,
    private readonly _spec: AttributeSpec | null,
  ) {}

  IsValid(): boolean {
    return this._spec !== null;
  }

  GetPrim(): Prim {
    return this._prim;
  }

  GetName(): string {
    return this._name;
  }

  GetBaseName(): string {
    return splitName(this._name).baseName;
  }

  GetNamespace(): string {
    return splitName(this._name).namespace;
  }

  /** Scalar type name (without the `[]` suffix); pair with {@link IsArray}. */
  GetTypeName(): string {
    return this._spec?.typeName ?? "";
  }

  IsArray(): boolean {
    return this._spec?.isArray ?? false;
  }

  GetVariability(): Variability {
    return this._spec?.variability ?? "varying";
  }

  IsCustom(): boolean {
    return this._spec?.custom ?? false;
  }

  /** True if a default value or any time sample is authored. */
  HasValue(): boolean {
    return this.HasAuthoredValue();
  }

  HasAuthoredValue(): boolean {
    if (!this._spec) return false;
    return this._spec.value !== undefined || (this._spec.timeSamples?.size ?? 0) > 0;
  }

  /**
   * Resolve the attribute value. With no `time`, returns the default value (or
   * the earliest time sample if only samples are authored). With a `time`,
   * returns the exact sample if present, else the default, else the earliest
   * sample. Returns `undefined` when nothing is authored.
   */
  Get(time?: number): UsdValue | undefined {
    const spec = this._spec;
    if (!spec) return undefined;
    if (time !== undefined && spec.timeSamples?.has(time)) {
      return spec.timeSamples.get(time);
    }
    if (spec.value !== undefined) return spec.value;
    if (spec.timeSamples && spec.timeSamples.size > 0) {
      const firstKey = [...spec.timeSamples.keys()].sort((a, b) => a - b)[0]!;
      return spec.timeSamples.get(firstKey);
    }
    return undefined;
  }

  GetTimeSamples(): Map<number, UsdValue> {
    return this._spec?.timeSamples ?? new Map();
  }

  GetConnections(): SdfPath[] {
    return this._spec?.connections ?? [];
  }
}

/** A relationship on a prim (`UsdRelationship`-like). */
export class Relationship {
  constructor(
    private readonly _prim: Prim,
    private readonly _name: string,
    private readonly _spec: RelationshipSpec | null,
  ) {}

  IsValid(): boolean {
    return this._spec !== null;
  }

  GetPrim(): Prim {
    return this._prim;
  }

  GetName(): string {
    return this._name;
  }

  GetBaseName(): string {
    return splitName(this._name).baseName;
  }

  GetNamespace(): string {
    return splitName(this._name).namespace;
  }

  IsCustom(): boolean {
    return this._spec?.custom ?? false;
  }

  GetTargets(): SdfPath[] {
    return this._spec?.targets ?? [];
  }
}
