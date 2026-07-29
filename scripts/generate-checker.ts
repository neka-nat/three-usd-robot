/** Generate a checker PNG into the usd-inspector example for the texture demo. */
import { mkdirSync, writeFileSync } from "node:fs";
import { zlibSync } from "fflate";

const SIZE = 256;
const TILE = 32;
const A = [222, 110, 75]; // orange
const B = [60, 70, 90]; // slate

// Raw RGB scanlines, each prefixed by a 0 (no-filter) byte.
const raw = new Uint8Array(SIZE * (1 + SIZE * 3));
for (let y = 0; y < SIZE; y++) {
  let p = y * (1 + SIZE * 3);
  raw[p++] = 0;
  for (let x = 0; x < SIZE; x++) {
    const c = (Math.floor(x / TILE) + Math.floor(y / TILE)) % 2 === 0 ? A : B;
    raw[p++] = c[0]!;
    raw[p++] = c[1]!;
    raw[p++] = c[2]!;
  }
}

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, typeBytes.length);
  dv.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

const ihdr = new Uint8Array(13);
const idv = new DataView(ihdr.buffer);
idv.setUint32(0, SIZE);
idv.setUint32(4, SIZE);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type RGB
const idat = zlibSync(raw);

const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
const total = png.reduce((n, c) => n + c.length, 0);
const out = new Uint8Array(total);
let o = 0;
for (const c of png) {
  out.set(c, o);
  o += c.length;
}

mkdirSync("examples/vite-usd-inspector/public/textures", { recursive: true });
writeFileSync("examples/vite-usd-inspector/public/textures/checker.png", out);
console.log(`wrote checker.png (${out.length} bytes)`);
