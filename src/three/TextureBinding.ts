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

/**
 * Color space to interpret a texture in. Color/albedo and emissive maps are
 * `"srgb"`; data maps (normal, roughness, metalness, occlusion) are `"linear"`.
 */
export type TextureColorSpace = "srgb" | "linear";

/**
 * Resolve an authored texture asset path to a `THREE.Texture` (or `null`).
 * `colorSpace` defaults to `"srgb"` so existing diffuse callers are unchanged.
 */
export type TextureProvider = (
  assetPath: string,
  colorSpace?: TextureColorSpace,
) => THREE.Texture | null;

/**
 * A {@link TextureProvider} backed by `THREE.TextureLoader`, resolving paths via
 * `resolver` against `baseUrl`. Results are cached per resolved URL **and color
 * space** (the same image may be sampled as both sRGB color and linear data).
 */
export function createTextureProvider(resolver: AssetResolver, baseUrl: string): TextureProvider {
  const loader = new THREE.TextureLoader();
  const cache = new Map<string, THREE.Texture>();
  return (assetPath: string, colorSpace: TextureColorSpace = "srgb") => {
    let url: string;
    try {
      url = resolver.resolve(assetPath, baseUrl);
    } catch {
      return null;
    }
    const key = `${colorSpace}:${url}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const texture = loader.load(url);
    texture.colorSpace = colorSpace === "linear" ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    cache.set(key, texture);
    return texture;
  };
}
