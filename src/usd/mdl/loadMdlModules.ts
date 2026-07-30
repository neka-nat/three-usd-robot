/**
 * Prefetches and parses the `.mdl` modules referenced by a stage's MDL shaders.
 *
 * Shaders authored from MDL (`info:mdl:sourceAsset`) often carry **no** USD
 * inputs at all — their look lives in a wrapper module shipped next to the
 * asset (`export material X(*) = OmniPBR(...)`). Fetching those modules up
 * front lets {@link resolveBoundMaterial} read the wrapper arguments and
 * declaration defaults. Modules that can't be fetched (typically the
 * Omniverse-core `OmniPBR.mdl`, which lives in the DCC's search path, not next
 * to the asset) are skipped silently — resolution then falls back to authored
 * inputs plus the name-based family mapping.
 */

import { AssetPath } from "../../parser/ast.js";
import type { AssetResolver } from "../AssetResolver.js";
import type { Stage } from "../Stage.js";
import { type MdlModule, type MdlModuleProvider, parseMdl } from "./parseMdl.js";

/** Authored `info:mdl:sourceAsset` paths of every MDL shader on the stage. */
export function collectMdlAssetPaths(stage: Stage): string[] {
  const paths = new Set<string>();
  for (const prim of stage.Traverse()) {
    if (prim.GetTypeName() !== "Shader") continue;
    const asset = prim.GetAttribute("info:mdl:sourceAsset").Get();
    if (asset instanceof AssetPath && asset.path) paths.add(asset.path);
  }
  return [...paths];
}

/**
 * Fetch + parse each referenced `.mdl` module through the resolver, keyed by
 * the **authored** asset path. Returns `undefined` when the stage references
 * no MDL modules or none could be fetched.
 */
export async function loadMdlModules(
  stage: Stage,
  resolver: AssetResolver,
  baseUrl: string,
): Promise<MdlModuleProvider | undefined> {
  const paths = collectMdlAssetPaths(stage);
  if (paths.length === 0) return undefined;
  const modules = new Map<string, MdlModule>();
  await Promise.all(
    paths.map(async (path) => {
      try {
        const module = parseMdl(await resolver.fetchText(resolver.resolve(path, baseUrl)));
        if (module.materials.size > 0) modules.set(path, module);
      } catch {
        // Unfetchable module — authored inputs still apply.
      }
    }),
  );
  if (modules.size === 0) return undefined;
  return (assetPath) => modules.get(assetPath);
}
