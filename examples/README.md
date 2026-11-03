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
- **vite-xr-viewer** — the **WebXR viewer** on `three-usd-robot/xr`: walk
  around a robot or a cell at real scale in a headset (`VRButton`, controller
  models, a floor grid at the XR floor). Point a controller at a link to see
  its name, trigger to select it, left grip for a tabletop view, right grip
  near the TCP handle to grab it (it snaps back on release — no IK here),
  near a link to **turn its joint like a lever**, or elsewhere to teleport.
  **Teaching**: A records a waypoint (a ghost stays behind, the tool path
  grows), B undoes, X plays the taught loop, Y clears, and the panel exports
  the trajectory as a `.usda` with `timeSamples` (`R` / `U` / `P` / `C` / `E`
  on the desktop). `?up=Z` for a Z-up world, `?emulate=1` for the IWER
  headset emulator (headless checks via `scripts/xr-capture.py`). For a
  headset on the LAN: `npm run dev:https`, open the printed `Network:` URL in
  the headset's browser and accept the self-signed certificate once; or
  `adb reverse tcp:5173 tcp:5173` and open `http://localhost:5173/`. See
  [docs/xr.md](../docs/xr.md).
- **vite-xr-r3f** — the same XR viewer on **React Three Fiber +
  `@react-three/xr`** with a **Z-up world** and **three r169** — botrail's
  stack, as a rehearsal for its integration: `<XROrigin>` carries
  `xrOriginQuaternion("Z")` and `xrOriginPlacement` stands the player in
  front of the robot; `<UsdRobot>`'s pointer events (mouse and controller ray
  alike) resolve to links with `resolveLink`; the right grip grabs a
  `TcpTargetHandle` through `useXRInputSourceEvent` + `handle.grab(gripObject)`.
  Its typecheck compiles the library's built `.d.ts` against `@types/three`
  r169 (`npm run build` at the root first). `?emulate=1` and
  `scripts/xr-capture.py` work the same as for `vite-xr-viewer`.
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
