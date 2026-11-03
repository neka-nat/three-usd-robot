import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import basicSsl from "@vitejs/plugin-basic-ssl";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Resolve the library straight from source so the example tracks local changes.
const root = fileURLToPath(new URL(".", import.meta.url));
const src = (p: string) => resolve(root, "../../src", p);

// `npm run dev:https` for a headset on the LAN (see examples/README.md).
const https = process.env.HTTPS === "1";

export default defineConfig({
  plugins: [react(), ...(https ? [basicSsl()] : [])],
  // Share the inspector's sample assets (factory cell, sample arm).
  publicDir: resolve(root, "../vite-usd-inspector/public"),
  resolve: {
    // The aliased library source resolves `three` from the repo root while the
    // example resolves its own copy (r169, botrail's) — collapse them to one.
    dedupe: ["three", "react", "react-dom", "@react-three/fiber"],
    alias: [
      { find: "three-usd-robot/xr", replacement: src("xr.ts") },
      { find: "three-usd-robot/react", replacement: src("react.tsx") },
      { find: "three-usd-robot/helpers", replacement: src("helpers.ts") },
      { find: "three-usd-robot/rendering", replacement: src("rendering.ts") },
      { find: "three-usd-robot/core", replacement: src("core.ts") },
      { find: "three-usd-robot", replacement: src("index.ts") },
    ],
  },
});
