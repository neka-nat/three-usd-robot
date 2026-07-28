/**
 * USDZ package writer (M15) — the write-direction counterpart of `openUsdz`.
 *
 * A `.usdz` is a **stored** (uncompressed) zip whose entries' file data must
 * start on 64-byte boundaries; alignment is achieved with padding placed in a
 * local-header extra field (the fflate-sanctioned trick, as used by Three.js's
 * USDZExporter). The first entry is the package's root USD layer — `openUsdz`
 * and other USDZ readers open that one.
 */

import { type Zippable, strToU8, zipSync } from "fflate";

const USD_ENTRY = /\.(usda|usdc|usd)$/i;
/** Private extra-field id used purely as alignment padding. */
const PAD_EXTRA_ID = 12345;
/** Bytes of a zip local file header before the name/extra fields. */
const LOCAL_HEADER_SIZE = 30;
/** An extra field costs 4 header bytes (id + size) plus its data. */
const EXTRA_HEADER_SIZE = 4;

/**
 * Pack entries into USDZ bytes. `entries` maps archive paths to file contents
 * (strings are UTF-8 encoded — pass the `serializeUsda` output directly). One
 * entry must be a USD layer (`.usda`/`.usdc`/`.usd`); the first such entry
 * becomes the package root and is moved to the front of the archive.
 */
export function writeUsdz(entries: Record<string, Uint8Array | string>): Uint8Array {
  const names = Object.keys(entries);
  const root = names.find((n) => USD_ENTRY.test(n));
  if (!root) {
    throw new Error("writeUsdz: entries must include a root USD layer (.usda/.usdc/.usd)");
  }
  const ordered = [root, ...names.filter((n) => n !== root)];

  const files: Zippable = {};
  let offset = 0;
  for (const name of ordered) {
    const raw = entries[name]!;
    const data = typeof raw === "string" ? strToU8(raw) : raw;
    const nameLength = strToU8(name).length;

    // Where this entry's data would start without an extra field.
    const dataStart = offset + LOCAL_HEADER_SIZE + nameLength;
    if ((dataStart & 63) === 0) {
      files[name] = data;
      offset = dataStart + data.length;
    } else {
      // Pad so the data starts on the next 64-byte boundary past the 4-byte
      // extra-field header.
      const padLength = (64 - ((dataStart + EXTRA_HEADER_SIZE) & 63)) & 63;
      files[name] = [data, { extra: { [PAD_EXTRA_ID]: new Uint8Array(padLength) } }];
      offset = dataStart + EXTRA_HEADER_SIZE + padLength + data.length;
    }
  }

  return zipSync(files, { level: 0 });
}
