# Examples

Runnable Vite demos. Each example aliases `three-usd-robot` directly
to the library source (see its `vite.config.ts`), so it always reflects local
changes — no build step needed.

```sh
cd examples/vite-usd-inspector   # or vite-basic-viewer
npm install
npm run dev
```

- **vite-usd-inspector** — loads the sample 3-link arm (`public/robot.usda`),
  shows the composed **USD prim tree** with an attribute inspector (click a prim
  to select it, click an object to reveal its prim), lets you move whole objects
  with a **transform gizmo** (translate / rotate / scale — the robot moves as
  one rigid unit), exposes a `lil-gui` slider per joint (via
  `three-usd-robot/extras`), and shows joint-axis helpers. Load any other asset
  with `?asset=<url>` (`.usda`/`.usdc`/
  binary `.usd`/`.usdz` are auto-detected) — e.g. `?asset=/arm_anim.usda` shows
  the **animation playback** controls (a play toggle + time slider),
  `?asset=/textured_quad.usda` for a **textured** material (`UsdUVTexture`), or
  `?asset=/pbr_panel.usda` for a full **PBR** material (diffuse + normal +
  roughness + metallic maps via `UsdPreviewSurface`), or
  `?asset=/tiled_panel.usdz` for a **USDZ-embedded** texture tiled 4×4 with a
  `UsdTransform2d` (`wrapS`/`wrapT` + `st` transform), or
  `?asset=/cutout_panel.usda` for an **alpha-clip** cutout (opacity from the
  texture's alpha + `opacityThreshold`).
- **vite-basic-viewer** — a **React Three Fiber** viewer: `<UsdRobot>` from
  `three-usd-robot/react` inside a `<Canvas>`, with drei `OrbitControls` / `Grid`
  / `Bounds` (auto-frame). Also accepts `?asset=<url>`.
- **vite-webgpu-nodes** — MaterialX (`ND_*`) procedural graphs executed as TSL
  node materials on `WebGPURenderer` (`three-usd-robot/nodes`).
- **vite-webgpu-viewer** — the **RTX-style viewer**: `WebGPURenderer` with a
  TSL post stack (GTAO or SSGI, screen-space reflections, TRAA, bloom, depth
  of field) for interaction, and a progressive **path tracer**
  (three-gpu-pathtracer, WebGPU only) for stills — Isaac Sim's "RTX –
  Real-Time" and "RTX – Interactive" modes, side by side. Same presets and
  `?asset=` / `?isaac=` switches as the inspector; without WebGPU it falls back
  to WebGL 2 with the post stack and no path tracing.

The loader normalizes up-axis and units, so assets appear upright with no manual
rotation. `public/arm_anim.usda` is the arm with time-sampled joint drives,
included to demo playback.
