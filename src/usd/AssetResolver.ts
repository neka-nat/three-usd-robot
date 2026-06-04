/**
 * Resolves USD asset paths (from references / payloads / sublayers) to URLs and
 * fetches their text. Composition (`composition.ts`) is I/O-agnostic and goes
 * through an {@link AssetResolver}, so the same engine works in the browser, in
 * Node, or against an in-memory file map in tests.
 */

export interface AssetResolver {
  /** Resolve an authored asset path against the layer's base URL to an absolute key. */
  resolve(assetPath: string, baseUrl: string): string;
  /** Fetch the text of a resolved asset; rejects if it cannot be read. */
  fetchText(url: string): Promise<string>;
  /** Fetch the raw bytes of a resolved asset (for binary USDC / USDZ). Optional. */
  fetchBytes?(url: string): Promise<Uint8Array>;
}

/** URL-based resolver using the global `fetch` (browser / Node 18+). */
export class DefaultAssetResolver implements AssetResolver {
  resolve(assetPath: string, baseUrl: string): string {
    try {
      return new URL(assetPath, baseUrl || undefined).href;
    } catch {
      return joinPosix(baseUrl, assetPath);
    }
  }

  async fetchText(url: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.text();
  }

  async fetchBytes(url: string): Promise<Uint8Array> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/**
 * Resolver over an in-memory `{ path: contents }` map (text or bytes), with
 * posix-style joins. Useful for tests and bundled assets.
 */
export function createMemoryResolver(files: Record<string, string | Uint8Array>): AssetResolver {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return {
    resolve(assetPath, baseUrl) {
      return joinPosix(baseUrl, assetPath);
    },
    fetchText(url) {
      const v = files[url];
      if (v === undefined) return Promise.reject(new Error(`asset not found: ${url}`));
      return Promise.resolve(typeof v === "string" ? v : decoder.decode(v));
    },
    fetchBytes(url) {
      const v = files[url];
      if (v === undefined) return Promise.reject(new Error(`asset not found: ${url}`));
      return Promise.resolve(typeof v === "string" ? encoder.encode(v) : v);
    },
  };
}

/** Resolve `rel` against `baseUrl` using posix semantics, normalizing `.`/`..`. */
export function joinPosix(baseUrl: string, rel: string): string {
  if (rel.startsWith("/")) return normalizePosix(rel);
  const dir = baseUrl.slice(0, baseUrl.lastIndexOf("/") + 1);
  return normalizePosix(dir + rel);
}

function normalizePosix(path: string): string {
  const isAbsolute = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}
