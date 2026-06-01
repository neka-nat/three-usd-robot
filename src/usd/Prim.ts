import type {
  AttributeSpec,
  MetadataMap,
  PrimSpec,
  RelationshipSpec,
  Specifier,
  UsdValue,
} from "../parser/ast.js";
import { Attribute, Relationship } from "./Attribute.js";
import type { Stage } from "./Stage.js";

/**
 * A composed prim on a {@link Stage} (`UsdPrim`-like).
 *
 * The pseudo-root (path `/`) is represented by a Prim with a `null` spec; its
 * children are the stage's root prims.
 */
export class Prim {
  private readonly _children: Prim[] = [];
  private _attributes?: Map<string, AttributeSpec>;
  private _relationships?: Map<string, RelationshipSpec>;

  constructor(
    private readonly _stage: Stage,
    private readonly _spec: PrimSpec | null,
    private readonly _path: string,
    private readonly _parent: Prim | null,
  ) {}

  /** @internal Used by {@link Stage} while building the prim tree. */
  _addChild(child: Prim): void {
    this._children.push(child);
  }

  GetStage(): Stage {
    return this._stage;
  }

  IsValid(): boolean {
    return true;
  }

  IsPseudoRoot(): boolean {
    return this._spec === null;
  }

  GetName(): string {
    return this._spec?.name ?? "";
  }

  GetPath(): string {
    return this._path;
  }

  GetTypeName(): string {
    return this._spec?.typeName ?? "";
  }

  GetSpecifier(): Specifier | null {
    return this._spec?.specifier ?? null;
  }

  GetParent(): Prim | null {
    return this._parent;
  }

  GetChildren(): Prim[] {
    return this._children;
  }

  GetChild(name: string): Prim | null {
    return this._children.find((c) => c.GetName() === name) ?? null;
  }

  // -- Attributes ----------------------------------------------------------

  private attrMap(): Map<string, AttributeSpec> {
    if (!this._attributes) {
      this._attributes = new Map();
      for (const p of this._spec?.properties ?? []) {
        if (p.kind === "attribute") this._attributes.set(p.name, p);
      }
    }
    return this._attributes;
  }

  /** Always returns an Attribute; check {@link Attribute.IsValid}. */
  GetAttribute(name: string): Attribute {
    return new Attribute(this, name, this.attrMap().get(name) ?? null);
  }

  HasAttribute(name: string): boolean {
    return this.attrMap().has(name);
  }

  GetAttributes(): Attribute[] {
    return [...this.attrMap().values()].map((spec) => new Attribute(this, spec.name, spec));
  }

  // -- Relationships -------------------------------------------------------

  private relMap(): Map<string, RelationshipSpec> {
    if (!this._relationships) {
      this._relationships = new Map();
      for (const p of this._spec?.properties ?? []) {
        if (p.kind === "relationship") this._relationships.set(p.name, p);
      }
    }
    return this._relationships;
  }

  /** Always returns a Relationship; check {@link Relationship.IsValid}. */
  GetRelationship(name: string): Relationship {
    return new Relationship(this, name, this.relMap().get(name) ?? null);
  }

  HasRelationship(name: string): boolean {
    return this.relMap().has(name);
  }

  GetRelationships(): Relationship[] {
    return [...this.relMap().values()].map((spec) => new Relationship(this, spec.name, spec));
  }

  // -- Metadata / schemas --------------------------------------------------

  GetMetadata(key: string): UsdValue | undefined {
    return this._spec?.metadata[key];
  }

  GetAllMetadata(): MetadataMap {
    return this._spec?.metadata ?? {};
  }

  /** Applied API schema names from `apiSchemas` (e.g. `PhysicsArticulationRootAPI`). */
  GetAppliedSchemas(): string[] {
    const raw = this._spec?.metadata.apiSchemas;
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const v of raw) {
      if (typeof v === "string") out.push(v);
    }
    return out;
  }

  /**
   * Whether the given API schema is applied. Matches the bare schema name as
   * well as multi-apply instances (e.g. `HasAPI("PhysicsDriveAPI")` is true for
   * an applied `PhysicsDriveAPI:angular`).
   */
  HasAPI(schemaName: string): boolean {
    return this.GetAppliedSchemas().some((s) => s === schemaName || s.startsWith(`${schemaName}:`));
  }
}
