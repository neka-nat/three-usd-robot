# Examples

Runnable Vite demos. Each example aliases `three-usd-robot` directly
to the library source (see its `vite.config.ts`), so it always reflects local
changes — no build step needed.

```sh
cd examples/vite-joint-slider   # or vite-basic-viewer
npm install
npm run dev
```

- **vite-joint-slider** — loads the sample 3-link arm (`public/robot.usda`),
  exposes a `lil-gui` slider per joint (via `three-usd-robot/extras`), and shows
  joint-axis helpers. Load any other asset with `?asset=<url>` (`.usda`/`.usdc`/
  binary `.usd`/`.usdz` are auto-detected) — e.g. `?asset=/arm_anim.usda` shows
  the **animation playback** controls (a play toggle + time slider),
  `?asset=/textured_quad.usda` for a **textured** material (`UsdUVTexture`), or
  `?asset=/pbr_panel.usda` for a full **PBR** material (diffuse + normal +
  roughness + metallic maps via `UsdPreviewSurface`).
- **vite-basic-viewer** — a **React Three Fiber** viewer: `<UsdRobot>` from
  `three-usd-robot/react` inside a `<Canvas>`, with drei `OrbitControls` / `Grid`
  / `Bounds` (auto-frame). Also accepts `?asset=<url>`.

The loader normalizes up-axis and units, so assets appear upright with no manual
rotation. `public/arm_anim.usda` is the arm with time-sampled joint drives,
included to demo playback.
