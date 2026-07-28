/**
 * Convert a USD file to ASCII USDA (a browser-free `usdcat`-alike, M12).
 * Reads binary crate (`.usd`/`.usdc`), ASCII (`.usda`), or the root layer of a
 * `.usdz` package, and writes the serialized USDA next to it (or to the given
 * output path):
 *   npx tsx scripts/usdc-to-usda.ts data/torobo2_standard_planar_move.usd [out.usda]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseUsda } from "../src/parser/parseUsda.js";
import { CrateReader } from "../src/usd/crate/CrateReader.js";
import { crateToUsdaFile } from "../src/usd/crate/toUsdaFile.js";
import { openUsdz } from "../src/usd/usdz.js";
import { serializeUsda } from "../src/writer/writeUsda.js";
import type { UsdaFile } from "../src/parser/ast.js";

const input = process.argv[2];
if (!input) {
  console.error("usage: npx tsx scripts/usdc-to-usda.ts <input.usd|usdc|usda|usdz> [output.usda]");
  process.exit(1);
}
const output = process.argv[3] ?? input.replace(/\.(usdz|usdc|usda|usd)$/i, "") + ".converted.usda";

let bytes = new Uint8Array(readFileSync(input));
if (/\.usdz$/i.test(input)) {
  const pkg = openUsdz(bytes);
  console.log(`usdz root entry: ${pkg.rootEntry}`);
  bytes = await pkg.resolver.fetchBytes(pkg.rootEntry);
}

const file: UsdaFile = CrateReader.isCrate(bytes)
  ? { ...crateToUsdaFile(new CrateReader(bytes)), version: "1.0" } // crate versions are not usda magic numbers
  : parseUsda(new TextDecoder().decode(bytes));

writeFileSync(output, serializeUsda(file));
console.log(`wrote ${output}`);
