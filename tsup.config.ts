import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "src/core.ts",
    helpers: "src/helpers.ts",
    extras: "src/extras.ts",
    react: "src/react.tsx",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  // Peer dependencies — never bundle these into dist.
  external: ["three", "react", "react-dom", "react/jsx-runtime", "@react-three/fiber"],
});
