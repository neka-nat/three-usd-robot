/**
 * OpenUSD `Usd_IntegerCompression` decoder (32-bit).
 *
 * The encoded buffer (itself wrapped by {@link fastDecompress}) is:
 *   [commonDelta : int32] [codes : 2 bits/int] [variable-width deltas]
 * Values are **delta-encoded**: each entry's stored value is a signed delta from
 * the previous integrated value (`out[i] = prev += delta`), and the 2-bit code
 * selects the delta source — 0 = the common delta, 1/2/3 = a 1/2/4-byte signed
 * delta. Integration keeps "unsigned" arrays (path/field/spec indexes)
 * non-negative even though the deltas are signed.
 */

import { fastDecompress } from "./lz4.js";

/** Decode `numInts` 32-bit integers from a `TfFastCompression`-wrapped buffer. */
export function decodeIntegers32(compressed: Uint8Array, numInts: number): number[] {
  if (numInts === 0) return [];

  const codeBytes = Math.ceil(numInts / 4);
  const worstCase = 4 + codeBytes + numInts * 4;
  const encoded = fastDecompress(compressed, worstCase);
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);

  const commonDelta = view.getInt32(0, true);
  const codesStart = 4;
  let p = codesStart + codeBytes;

  const out = new Array<number>(numInts);
  let prev = 0;
  for (let i = 0; i < numInts; i++) {
    const code = (encoded[codesStart + (i >> 2)]! >> ((i & 3) * 2)) & 0x3;
    let delta: number;
    if (code === 0) {
      delta = commonDelta;
    } else if (code === 1) {
      delta = view.getInt8(p);
      p += 1;
    } else if (code === 2) {
      delta = view.getInt16(p, true);
      p += 2;
    } else {
      delta = view.getInt32(p, true);
      p += 4;
    }
    prev += delta;
    out[i] = prev;
  }
  return out;
}
