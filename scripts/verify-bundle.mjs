/**
 * M22 bundle-isolation check, run after every build: the WebGL core entries
 * (`.` / `./core` / `./helpers` / `./extras` / `./react` / `./xr`) must not —
 * transitively through their chunks — reference `three/webgpu`, `three/tsl`,
 * or `three/addons`. Those imports belong to the `./nodes` and `./rendering`
 * (M26) entries alone. The `./xr` entry (M35) additionally imports nothing
 * but `three` itself — no React, no addons.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const dist = new URL("../dist/", import.meta.url);
const FORBIDDEN = /["']three\/(webgpu|tsl|addons)/;

function read(file) {
  const src = readFileSync(new URL(file, dist), "utf8");
  const local = [...src.matchAll(/from\s*["'](\.\/[^"']+)["']/g)].map((m) =>
    path.posix.normalize(m[1]),
  );
  return { src, local };
}

for (const entry of ["index", "core", "helpers", "extras", "react", "xr"]) {
  const seen = new Set();
  const queue = [`${entry}.js`];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const { src, local } = read(file);
    const hit = src.match(FORBIDDEN);
    if (hit) {
      console.error(
        `dist/${file} (reached from the "${entry}" entry) references ${hit[0].slice(1)} — WebGPU/TSL imports must stay in the nodes entry`,
      );
      process.exit(1);
    }
    queue.push(...local);
  }
}

{
  const seen = new Set();
  const queue = ["xr.js"];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const { src, local } = read(file);
    const externals = [...src.matchAll(/from\s*["']([^."'][^"']*)["']/g)].map((m) => m[1]);
    const stray = externals.find((name) => name !== "three");
    if (stray) {
      console.error(`dist/${file} (reached from the "xr" entry) imports "${stray}" — the xr entry depends on three alone`);
      process.exit(1);
    }
    queue.push(...local);
  }
}

if (!FORBIDDEN.test(read("nodes.js").src)) {
  console.error("dist/nodes.js does not reference three/webgpu or three/tsl — entry wiring looks broken");
  process.exit(1);
}
if (!/["']three\/addons/.test(read("rendering.js").src)) {
  console.error("dist/rendering.js does not reference three/addons — entry wiring looks broken");
  process.exit(1);
}
console.log("bundle check: core entries are free of three/webgpu / three/tsl / three/addons; xr depends on three alone");
