/**
 * Loads texture image assets referenced by `UsdShade` materials.
 *
 * A {@link TextureProvider} maps an authored asset path to a `THREE.Texture`.
 * The default provider resolves the path against the layer base URL and loads it
 * with `THREE.TextureLoader` (so it works for textures served alongside the USD
 * on the web). Textures load asynchronously and update the material when ready.
 */

import * as THREE from "three";
import type { AssetResolver } from "../usd/AssetResolver.js";

/** Resolve an authored texture asset path to a `THREE.Texture` (or `null`). */
export type TextureProvider = (assetPath: string) => THREE.Texture | null;

/**
 * A {@link TextureProvider} backed by `THREE.TextureLoader`, resolving paths via
 * `resolver` against `baseUrl`. Results are cached per resolved URL and tagged
 * as sRGB color textures.
 */
export function createTextureProvider(resolver: AssetResolver, baseUrl: string): TextureProvider {
  const loader = new THREE.TextureLoader();
  const cache = new Map<string, THREE.Texture>();
  return (assetPath: string) => {
    let url: string;
    try {
      url = resolver.resolve(assetPath, baseUrl);
    } catch {
      return null;
    }
    const cached = cache.get(url);
    if (cached) return cached;

    const texture = loader.load(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    cache.set(url, texture);
    return texture;
  };
}
