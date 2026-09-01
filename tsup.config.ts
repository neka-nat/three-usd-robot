import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "src/core.ts",
    helpers: "src/helpers.ts",
    extras: "src/extras.ts",
    nodes: "src/nodes.ts",
    rendering: "src/rendering.ts",
    react: "src/react.tsx",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
  // Peer dependencies — never bundle these into dist. The regex keeps the
  // `three/webgpu` / `three/tsl` / `three/addons` subpaths external too (M22).
  external: [/^three(\/|$)/, "react", "react-dom", "react/jsx-runtime", "@react-three/fiber"],
});
