import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Resolve the library straight from source so the example tracks local changes.
const root = fileURLToPath(new URL(".", import.meta.url));
const src = (p: string) => resolve(root, "../../src", p);

export default defineConfig({
  // WebGPU + top-level await want a modern baseline.
  build: { target: "esnext" },
  // Share the inspector's sample assets (factory cell, sample arm, textures).
  publicDir: resolve(root, "../vite-usd-inspector/public"),
  resolve: {
    // The aliased library source resolves `three` from the repo root while the
    // example resolves its own copy — collapse them to one instance.
    dedupe: ["three"],
    alias: [
      { find: "three-usd-robot/extras", replacement: src("extras.ts") },
      { find: "three-usd-robot/helpers", replacement: src("helpers.ts") },
      { find: "three-usd-robot/rendering", replacement: src("rendering.ts") },
      { find: "three-usd-robot/nodes", replacement: src("nodes.ts") },
      { find: "three-usd-robot/core", replacement: src("core.ts") },
      { find: "three-usd-robot", replacement: src("index.ts") },
    ],
  },
});
