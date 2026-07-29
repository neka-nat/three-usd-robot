/**
 * In-memory input normalization for the loader entry points. Callers hold USD
 * content in many shapes — a `fetch` response's `ArrayBuffer`, a `Uint8Array`
 * (or any typed-array view), a dropped `File` / `Blob` — and every byte-eating
 * API here funnels through {@link toBytes} so all of them are accepted.
 */

/** Binary USD content: an `ArrayBuffer`, any typed-array view, or a `Blob`/`File`. */
export type BinarySource = ArrayBuffer | ArrayBufferView | Blob;

/** In-memory USD content: USDA source text, or {@link BinarySource} bytes. */
export type UsdSource = string | BinarySource;

/** Normalize a {@link BinarySource} to bytes, honoring a view's offset/length. */
export async function toBytes(data: BinarySource): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // Blob / File — duck-typed so objects from another realm (iframe, worker) work.
  if (typeof (data as Blob).arrayBuffer === "function") {
    return new Uint8Array(await (data as Blob).arrayBuffer());
  }
  return new Uint8Array(data as ArrayBuffer);
}
