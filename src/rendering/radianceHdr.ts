/**
 * Radiance `.hdr` (RGBE) decoder (M29) — the DomeLight HDRI path used to go
 * through three's `RGBELoader`, which r180 renamed to `HDRLoader` (the old
 * name survives as a warning shim). The format is 30 years old and small, so
 * decoding it here keeps the `rendering` entry working on every supported
 * three release without touching that moving target.
 *
 * Output matches `RGBELoader` with its default `HalfFloatType`: RGBA
 * half-floats, rows in file order (top-down), to be used with
 * `texture.flipY = true`, and the same `mantissa × 2^(e − 128) / 255`
 * conversion.
 */

import * as THREE from "three";

export type RadianceHdrImage = {
  width: number;
  height: number;
  /** RGBA half-floats, `width × height × 4`, top row first. */
  data: Uint16Array;
};

/** Decode a Radiance RGBE file (`#?RADIANCE` / `#?RGBE`, 32-bit_rle_rgbe). */
export function decodeRadianceHdr(bytes: Uint8Array): RadianceHdrImage {
  let pos = 0;
  const readLine = (): string => {
    let end = pos;
    while (end < bytes.length && bytes[end] !== 0x0a) end++;
    if (end >= bytes.length) throw new Error("Radiance HDR: truncated header");
    const line = new TextDecoder().decode(bytes.subarray(pos, end));
    pos = end + 1;
    return line.replace(/\r$/, "");
  };

  const magic = readLine();
  if (!magic.startsWith("#?")) throw new Error("Radiance HDR: missing #? signature");

  let format: string | undefined;
  for (;;) {
    const line = readLine();
    if (line === "") break;
    if (line.startsWith("FORMAT=")) format = line.slice("FORMAT=".length).trim();
  }
  if (format !== undefined && format !== "32-bit_rle_rgbe") {
    throw new Error(`Radiance HDR: unsupported FORMAT ${format}`);
  }

  const resolution = /^-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/.exec(readLine());
  if (!resolution) throw new Error("Radiance HDR: only the -Y +X orientation is supported");
  const height = Number(resolution[1]);
  const width = Number(resolution[2]);
  if (width <= 0 || height <= 0) throw new Error("Radiance HDR: empty image");

  const rgbe = new Uint8Array(width * height * 4);
  const scanline = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    const rle =
      width >= 8 &&
      width <= 0x7fff &&
      pos + 4 <= bytes.length &&
      bytes[pos] === 2 &&
      bytes[pos + 1] === 2 &&
      ((bytes[pos + 2] as number) & 0x80) === 0;
    if (!rle) {
      // Flat (uncompressed or old-style) scanline: width RGBE quadruples.
      if (pos + width * 4 > bytes.length) throw new Error("Radiance HDR: truncated pixel data");
      rgbe.set(bytes.subarray(pos, pos + width * 4), row);
      pos += width * 4;
      continue;
    }
    const encodedWidth = ((bytes[pos + 2] as number) << 8) | (bytes[pos + 3] as number);
    if (encodedWidth !== width) throw new Error("Radiance HDR: scanline width mismatch");
    pos += 4;
    // New-style RLE: the four channels are stored planar, each as runs.
    for (let channel = 0; channel < 4; channel++) {
      let x = 0;
      while (x < width) {
        if (pos >= bytes.length) throw new Error("Radiance HDR: truncated RLE scanline");
        let count = bytes[pos++] as number;
        if (count > 128) {
          count -= 128;
          if (x + count > width || pos >= bytes.length) {
            throw new Error("Radiance HDR: bad RLE run");
          }
          const value = bytes[pos++] as number;
          scanline.fill(value, channel * width + x, channel * width + x + count);
          x += count;
        } else {
          if (count === 0 || x + count > width || pos + count > bytes.length) {
            throw new Error("Radiance HDR: bad RLE literal");
          }
          scanline.set(bytes.subarray(pos, pos + count), channel * width + x);
          pos += count;
          x += count;
        }
      }
    }
    for (let x = 0; x < width; x++) {
      rgbe[row + x * 4] = scanline[x] as number;
      rgbe[row + x * 4 + 1] = scanline[width + x] as number;
      rgbe[row + x * 4 + 2] = scanline[2 * width + x] as number;
      rgbe[row + x * 4 + 3] = scanline[3 * width + x] as number;
    }
  }

  const data = new Uint16Array(width * height * 4);
  const one = THREE.DataUtils.toHalfFloat(1);
  for (let i = 0; i < width * height; i++) {
    const e = rgbe[i * 4 + 3] as number;
    const scale = e === 0 ? 0 : 2 ** (e - 128) / 255;
    data[i * 4] = THREE.DataUtils.toHalfFloat(Math.min((rgbe[i * 4] as number) * scale, 65504));
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(
      Math.min((rgbe[i * 4 + 1] as number) * scale, 65504),
    );
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(
      Math.min((rgbe[i * 4 + 2] as number) * scale, 65504),
    );
    data[i * 4 + 3] = one;
  }
  return { width, height, data };
}
