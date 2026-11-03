import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

// Resolve the library straight from source so the example tracks local changes.
const root = fileURLToPath(new URL(".", import.meta.url));
const src = (p: string) => resolve(root, "../../src", p);

// WebXR needs a secure context. `localhost` counts, so plain `vite` is enough
// for desktop + the IWER emulator; a headset on the LAN needs HTTPS —
// `npm run dev:https` (self-signed cert, accept the warning once on the Quest).
const https = process.env.HTTPS === "1";
// `NESTED=1` (root `npm run demo:build`) builds under the inspector's dist at
// /xr/ so one deploy serves both; the shared public assets then come from the
// inspector's root rather than being copied twice.
const nested = process.env.NESTED === "1";

export default defineConfig({
  base: nested ? "/xr/" : "/",
  plugins: https ? [basicSsl()] : [],
  // Share the inspector's sample assets (factory cell, sample arm).
  publicDir: nested ? false : resolve(root, "../vite-usd-inspector/public"),
  build: nested ? { outDir: resolve(root, "../vite-usd-inspector/dist/xr"), emptyOutDir: true } : {},
  resolve: {
    // The aliased library source resolves `three` from the repo root while the
    // example resolves its own copy — collapse them to one instance.
    dedupe: ["three"],
    alias: [
      { find: "three-usd-robot/helpers", replacement: src("helpers.ts") },
      { find: "three-usd-robot/rendering", replacement: src("rendering.ts") },
      { find: "three-usd-robot/core", replacement: src("core.ts") },
      { find: "three-usd-robot", replacement: src("index.ts") },
    ],
  },
});
