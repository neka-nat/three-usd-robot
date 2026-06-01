# Examples

Runnable Vite demos. Each example aliases `three-usd-robot` directly
to the library source (see its `vite.config.ts`), so it always reflects local
changes — no build step needed.

```sh
cd examples/vite-joint-slider   # or vite-basic-viewer
npm install
npm run dev
```

- **vite-joint-slider** — loads the sample arm and exposes a `lil-gui` slider per
  joint (via `three-usd-robot/extras`), with joint-axis helpers on.
- **vite-basic-viewer** — minimal load-and-pose viewer.

Both load `public/robot.usda` (a copy of `test-assets/two_link_arm.usda`). The
sample is Z-up, so the examples rotate the robot into the Y-up scene until the
M9 up-axis conversion lands.
