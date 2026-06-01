/**
 * LZ4 block decompression and the OpenUSD `TfFastCompression` wrapper used by
 * the USDC (crate) format. Pure TypeScript — no LZ4 dependency.
 */

/** OpenUSD's per-chunk limit; buffers above it are split (`TfFastCompression`). */
const MAX_CHUNK_INPUT = 0x7e000000;

/**
 * Decompress a raw LZ4 block from `src` into `dst`. `dst` must be sized to the
 * known decompressed length. Returns the number of bytes written.
 */
export function lz4DecompressBlock(src: Uint8Array, dst: Uint8Array): number {
  let s = 0;
  let d = 0;
  const n = src.length;

  while (s < n) {
    const token = src[s++]!;

    // Literals.
    let literals = token >> 4;
    if (literals === 0xf) {
      let add: number;
      do {
        add = src[s++]!;
        literals += add;
      } while (add === 0xff);
    }
    for (let i = 0; i < literals; i++) dst[d++] = src[s++]!;

    if (s >= n) break; // last sequence: literals only

    // Match.
    const offset = src[s++]! | (src[s++]! << 8);
    let matchLen = token & 0xf;
    if (matchLen === 0xf) {
      let add: number;
      do {
        add = src[s++]!;
        matchLen += add;
      } while (add === 0xff);
    }
    matchLen += 4;

    let m = d - offset;
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++]!;
  }
  return d;
}

/**
 * Decompress a buffer produced by OpenUSD's `TfFastCompression`, given the known
 * decompressed size.
 *
 * Layout: 1 byte = number of *whole* `MAX_CHUNK_INPUT`-sized chunks (almost
 * always 0), each prefixed by an `int32` compressed size, then a final partial
 * chunk (the remainder) as a plain LZ4 block with no size prefix.
 */
export function fastDecompress(src: Uint8Array, decompressedSize: number): Uint8Array {
  const out = new Uint8Array(decompressedSize);
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);

  const numWholeChunks = src[0]!;
  let s = 1;
  let d = 0;
  for (let c = 0; c < numWholeChunks; c++) {
    const chunkCompressedSize = view.getInt32(s, true);
    s += 4;
    lz4DecompressBlock(
      src.subarray(s, s + chunkCompressedSize),
      out.subarray(d, d + MAX_CHUNK_INPUT),
    );
    s += chunkCompressedSize;
    d += MAX_CHUNK_INPUT;
  }
  if (d < decompressedSize) {
    lz4DecompressBlock(src.subarray(s), out.subarray(d));
  }
  return out;
}
