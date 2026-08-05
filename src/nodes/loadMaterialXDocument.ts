import type { LoadingManager } from "three";
import type { MeshPhysicalNodeMaterial } from "three/webgpu";

/**
 * Load an external `.mtlx` document with three's official `MaterialXLoader`
 * (`three/addons`) — the delegation path for UsdMtlx-style file references,
 * which this library does not parse (M22). Returns the document's surface
 * materials by name, ready to assign to meshes (WebGPURenderer required).
 * The loader is imported on demand so bundles only pay for it when used.
 */
export async function loadMaterialXDocument(
  url: string,
  manager?: LoadingManager,
): Promise<Record<string, MeshPhysicalNodeMaterial>> {
  const { MaterialXLoader } = await import("three/addons/loaders/MaterialXLoader.js");
  const { materials } = await new MaterialXLoader(manager).loadAsync(url);
  return materials;
}
