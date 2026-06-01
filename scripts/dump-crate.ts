/**
 * Scratch validator for the crate reader. Run against a real USDC file:
 *   npx tsx scripts/dump-crate.ts data/torobo2_standard_planar_move.usd
 */
import { readFileSync } from "node:fs";
import { CrateReader } from "../src/usd/crate/CrateReader.js";

const path = process.argv[2] ?? "data/torobo2_standard_planar_move.usd";
const bytes = new Uint8Array(readFileSync(path));
const crate = new CrateReader(bytes);

console.log("file:", path);
console.log("version:", crate.version.join("."));
console.log("sections:");
for (const name of ["TOKENS", "STRINGS", "FIELDS", "FIELDSETS", "PATHS", "SPECS"]) {
  const s = crate.getSection(name);
  console.log(`  ${name.padEnd(10)} ${s ? `start=${s.start} size=${s.size}` : "(missing)"}`);
}

const tokens = crate.getTokens();
console.log(`\ntokens: ${tokens.length}`);
console.log("first 40:", tokens.slice(0, 40));
console.log(
  "physics-ish tokens:",
  tokens.filter((t) => /physics:|xformOp|PhysicsRevolute|points|faceVertex/.test(t)).slice(0, 30),
);
