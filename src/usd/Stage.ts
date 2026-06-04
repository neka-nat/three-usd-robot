import type { PrimSpec, UsdValue, UsdaFile } from "../parser/ast.js";
import { parseUsda } from "../parser/parseUsda.js";
import { Layer } from "./Layer.js";
import { Prim } from "./Prim.js";

/** OpenUSD's fallback stage linear unit when `metersPerUnit` is unauthored. */
export const DEFAULT_METERS_PER_UNIT = 0.01;

export type UpAxis = "Y" | "Z";

/**
 * A composed USD stage (`UsdStage`-like) backed by a single in-memory USDA
 * layer. Multi-layer composition (sublayers / references / payloads) arrives in
 * M8; for now a stage wraps exactly one parsed layer.
 */
export class Stage {
  private readonly _layer: Layer;
  private readonly _byPath = new Map<string, Prim>();
  private readonly _pseudoRoot: Prim;

  private constructor(file: UsdaFile) {
    this._layer = new Layer(file);
    this._pseudoRoot = new Prim(this, null, "/", null);
    this._byPath.set("/", this._pseudoRoot);
    for (const spec of file.prims) this.buildPrim(spec, this._pseudoRoot);
  }

  /** Parse and open a stage from USDA source text. */
  static OpenFromString(usda: string): Stage {
    return new Stage(parseUsda(usda));
  }

  /** Open a stage from an already-parsed layer. */
  static OpenFromFile(file: UsdaFile): Stage {
    return new Stage(file);
  }

  private buildPrim(spec: PrimSpec, parent: Prim): void {
    const path = parent.IsPseudoRoot() ? `/${spec.name}` : `${parent.GetPath()}/${spec.name}`;
    const prim = new Prim(this, spec, path, parent);
    this._byPath.set(path, prim);
    parent._addChild(prim);
    for (const child of spec.children) this.buildPrim(child, prim);
  }

  GetRootLayer(): Layer {
    return this._layer;
  }

  GetPseudoRoot(): Prim {
    return this._pseudoRoot;
  }

  /** Returns the prim at the absolute path, or `null` if none exists. */
  GetPrimAtPath(path: string): Prim | null {
    return this._byPath.get(path) ?? null;
  }

  /** The stage's default prim (from layer `defaultPrim` metadata), if any. */
  GetDefaultPrim(): Prim | null {
    const name = this._layer.GetDefaultPrimName();
    return name ? this.GetPrimAtPath(`/${name}`) : null;
  }

  /** Depth-first traversal of all prims (excludes the pseudo-root). */
  Traverse(): Prim[] {
    const out: Prim[] = [];
    const visit = (prim: Prim) => {
      for (const child of prim.GetChildren()) {
        out.push(child);
        visit(child);
      }
    };
    visit(this._pseudoRoot);
    return out;
  }

  GetMetadata(key: string): UsdValue | undefined {
    return this._layer.GetMetadata(key);
  }

  /** Stage up axis (`upAxis` metadata); defaults to `"Y"` per OpenUSD. */
  GetUpAxis(): UpAxis {
    return this._layer.GetMetadata("upAxis") === "Z" ? "Z" : "Y";
  }

  /** Stage linear unit (`metersPerUnit` metadata); defaults to {@link DEFAULT_METERS_PER_UNIT}. */
  GetMetersPerUnit(): number {
    const v = this._layer.GetMetadata("metersPerUnit");
    return typeof v === "number" ? v : DEFAULT_METERS_PER_UNIT;
  }

  /** Animation start time code, if authored. */
  GetStartTimeCode(): number | undefined {
    const v = this._layer.GetMetadata("startTimeCode");
    return typeof v === "number" ? v : undefined;
  }

  /** Animation end time code, if authored. */
  GetEndTimeCode(): number | undefined {
    const v = this._layer.GetMetadata("endTimeCode");
    return typeof v === "number" ? v : undefined;
  }

  /** Time codes per second for playback; defaults to 24. */
  GetTimeCodesPerSecond(): number {
    const v =
      this._layer.GetMetadata("timeCodesPerSecond") ?? this._layer.GetMetadata("framesPerSecond");
    return typeof v === "number" && v > 0 ? v : 24;
  }
}
