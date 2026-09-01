/**
 * Loads texture image assets referenced by `UsdShade` materials.
 *
 * A {@link TextureProvider} maps an authored asset path (plus sampler/transform
 * options) to a `THREE.Texture`. The default provider fetches the image **bytes**
 * through the {@link AssetResolver} and decodes them via a blob URL — so it works
 * uniformly for textures served over HTTP and for images embedded inside a
 * `.usdz` package (whose resolver serves zip entries, not real URLs). Decoded
 * images are cached per resolved URL and shared across every texture that uses
 * them; each `THREE.Texture` carries its own color space / wrap / transform.
 */

import * as THREE from "three";
import type { AssetResolver } from "../usd/AssetResolver.js";
import type { TextureTransform, TextureWrap } from "./MaterialBinding.js";

/**
 * Color space to interpret a texture in. Color/albedo and emissive maps are
 * `"srgb"`; data maps (normal, roughness, metalness, occlusion) are `"linear"`.
 */
export type TextureColorSpace = "srgb" | "linear";

/** Per-use sampler state applied to the returned `THREE.Texture`. */
export type TextureOptions = {
  /** Defaults to `"srgb"`. */
  colorSpace?: TextureColorSpace;
  wrapS?: TextureWrap;
  wrapT?: TextureWrap;
  transform?: TextureTransform;
  /** UV channel index (0 = `uv`, 1 = `uv1`, …) for multi-UV-set meshes. */
  channel?: number;
};

/** Resolve an authored texture asset path to a `THREE.Texture` (or `null`). */
export type TextureProvider = (assetPath: string, options?: TextureOptions) => THREE.Texture | null;

const DEG2RAD = Math.PI / 180;

/**
 * A {@link TextureProvider} backed by the {@link AssetResolver}, resolving paths
 * against `baseUrl`. Image bytes are fetched once per URL (works for HTTP and
 * `.usdz` entries alike) and the decoded image is shared; each call returns a
 * distinct `THREE.Texture` carrying the requested color space / wrap / transform.
 *
 * `<UDIM>` paths resolve to their first tile (1001) with a one-time `onWarn`
 * diagnostic — full UDIM sets are out of scope (M26).
 */
export function createTextureProvider(
  resolver: AssetResolver,
  baseUrl: string,
  onWarn?: (message: string) => void,
): TextureProvider {
  const images = new Map<string, Promise<TexImageSource>>();
  let warnedUdim = false;

  const imageFor = (url: string): Promise<TexImageSource> => {
    let p = images.get(url);
    if (!p) {
      p = loadImage(resolver, url);
      images.set(url, p);
    }
    return p;
  };

  return (assetPath: string, options: TextureOptions = {}) => {
    let path = assetPath;
    if (/<UDIM>/i.test(path)) {
      path = path.replace(/<UDIM>/gi, "1001");
      if (!warnedUdim) {
        warnedUdim = true;
        onWarn?.(`UDIM texture sets are not supported; using tile 1001 only (e.g. ${path})`);
      }
    }
    let url: string;
    try {
      url = resolver.resolve(path, baseUrl);
    } catch {
      return null;
    }

    const texture = new THREE.Texture();
    texture.colorSpace =
      options.colorSpace === "linear" ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    texture.wrapS = toThreeWrap(options.wrapS);
    texture.wrapT = toThreeWrap(options.wrapT);
    if (options.channel !== undefined) texture.channel = options.channel;
    applyTransform(texture, options.transform);

    imageFor(url)
      .then((image) => {
        texture.image = image;
        texture.needsUpdate = true;
      })
      .catch(() => {
        /* leave the texture blank if the image can't be decoded */
      });
    return texture;
  };
}

/**
 * Fetch image bytes through the resolver and decode them via a blob URL into an
 * `HTMLImageElement` (so three's default `flipY = true` orients USD's bottom-left
 * `st` origin correctly, matching the prior `TextureLoader` HTTP path).
 */
async function loadImage(resolver: AssetResolver, url: string): Promise<TexImageSource> {
  const bytes = resolver.fetchBytes
    ? await resolver.fetchBytes(url)
    : new TextEncoder().encode(await resolver.fetchText(url));
  const blob = new Blob([bytes as BlobPart], { type: mimeOf(url) });
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`failed to decode texture: ${url}`));
      img.src = objectUrl;
    });
  } finally {
    // The decoded image keeps its pixels; the blob URL can be released.
    URL.revokeObjectURL(objectUrl);
  }
}

function toThreeWrap(wrap: TextureWrap | undefined): THREE.Wrapping {
  switch (wrap) {
    case "clamp":
    case "black": // three has no border color; clamp is the closest mode
      return THREE.ClampToEdgeWrapping;
    case "mirror":
      return THREE.MirroredRepeatWrapping;
    default:
      return THREE.RepeatWrapping;
  }
}

/** Map a `UsdTransform2d` onto a texture's offset / repeat / rotation. */
function applyTransform(texture: THREE.Texture, t: TextureTransform | undefined): void {
  if (!t) return;
  if (t.scale) texture.repeat.set(t.scale[0], t.scale[1]);
  if (t.translation) texture.offset.set(t.translation[0], t.translation[1]);
  if (t.rotation !== undefined) {
    texture.rotation = t.rotation * DEG2RAD;
    texture.center.set(0, 0); // UsdTransform2d rotates about the origin
  }
}

function mimeOf(url: string): string {
  if (/\.jpe?g$/i.test(url)) return "image/jpeg";
  if (/\.webp$/i.test(url)) return "image/webp";
  return "image/png";
}
