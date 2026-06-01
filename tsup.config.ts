import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "src/core.ts",
    helpers: "src/helpers.ts",
    extras: "src/extras.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  // `three` is a peer dependency; never bundle it into dist.
  external: ["three"],
});
