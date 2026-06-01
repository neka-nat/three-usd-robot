import type { MetadataMap, PrimSpec, UsdValue, UsdaFile } from "../parser/ast.js";

/** A parsed USDA layer (`SdfLayer`-like, read-only). */
export class Layer {
  constructor(private readonly _file: UsdaFile) {}

  GetVersion(): string {
    return this._file.version;
  }

  GetPseudoRootMetadata(): MetadataMap {
    return this._file.metadata;
  }

  GetMetadata(key: string): UsdValue | undefined {
    return this._file.metadata[key];
  }

  GetDefaultPrimName(): string | undefined {
    const v = this._file.metadata.defaultPrim;
    return typeof v === "string" ? v : undefined;
  }

  GetRootPrimSpecs(): PrimSpec[] {
    return this._file.prims;
  }
}
