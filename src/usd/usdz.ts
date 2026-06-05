/**
 * USDZ (zipped USD package) support.
 *
 * A `.usdz` is an uncompressed zip whose entries are USD layers + textures.
 * {@link openUsdz} unzips it (via `fflate`) and returns the root layer entry
 * plus an {@link AssetResolver} that serves the package's other entries, so
 * references inside the package resolve through the normal composition path.
 * USDC (binary crate) entries are not decodable yet (M10).
 */

import { unzipSync } from "fflate";
import { type AssetResolver, joinPosix } from "./AssetResolver.js";

const USD_ENTRY = /\.(usda|usdc|usd)$/i;

export type UsdzPackage = {
  /** Archive path of the root layer to open. */
  rootEntry: string;
  /** Resolver over the package's entries. */
  resolver: AssetResolver;
};

/** Unzip a `.usdz` package and build a resolver over its entries. */
export function openUsdz(bytes: Uint8Array): UsdzPackage {
  const entries = unzipSync(bytes);
  const names = Object.keys(entries);
  const rootEntry = names.find((n) => USD_ENTRY.test(n)) ?? names[0];
  if (!rootEntry) throw new Error("usdz package contains no entries");

  const decoder = new TextDecoder();
  const entryBytes = (url: string): Uint8Array | undefined =>
    entries[url] ?? entries[url.replace(/^\/+/, "")];
  const resolver: AssetResolver = {
    resolve(assetPath, baseUrl) {
      return joinPosix(baseUrl, assetPath);
    },
    fetchText(url) {
      const data = entryBytes(url);
      if (!data) return Promise.reject(new Error(`not found in usdz: ${url}`));
      if (/\.usdc$/i.test(url)) {
        return Promise.reject(
          new Error(`USDC (binary crate) entries are not supported yet (M10): ${url}`),
        );
      }
      return Promise.resolve(decoder.decode(data));
    },
    // Serve raw entry bytes so embedded textures decode through the same path.
    fetchBytes(url) {
      const data = entryBytes(url);
      if (!data) return Promise.reject(new Error(`not found in usdz: ${url}`));
      return Promise.resolve(data);
    },
  };

  return { rootEntry, resolver };
}
