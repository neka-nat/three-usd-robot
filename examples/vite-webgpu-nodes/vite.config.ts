import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Resolve the library straight from source so the example tracks local changes.
const root = fileURLToPath(new URL(".", import.meta.url));
const src = (p: string) => resolve(root, "../../src", p);

export default defineConfig({
  // WebGPU + top-level await want a modern baseline.
  build: { target: "esnext" },
  resolve: {
    alias: [
      { find: "three-usd-robot/nodes", replacement: src("nodes.ts") },
      { find: "three-usd-robot/core", replacement: src("core.ts") },
      { find: "three-usd-robot", replacement: src("index.ts") },
    ],
  },
});
