# three-usd-robot

> **Kinematic OpenUSD robot loader for Three.js.**
> Load Isaac Sim / OpenUSD robot assets, extract joints and links, and control
> articulations directly in the browser — no physics engine required.

Think of it as a **USD version of [`urdf-loader`](https://www.npmjs.com/package/urdf-loader)**:
it reads the link / joint / xform / mesh structure out of `UsdPhysics` robot assets
and drives forward kinematics on a Three.js `Object3D` hierarchy.

> 🚧 **Status: v0.3.** Loads **ASCII `.usda`**, **binary `.usdc` / `.usd`
> (crate)**, and **`.usdz`** robots — including **multi-file assets** via
> references / payloads / sublayers (resolved across `.usda` *and* binary layers,
> with relationship-path remapping), **variant selections**, and **instanceable**
> prims — drives forward kinematics with meshes, applies flat **`UsdShade`
> material colors** (UsdPreviewSurface / OmniPBR constants) and **diffuse
> textures** (`UsdUVTexture`), normalizes up-axis & units, seeds the initial
> pose, and **plays back time-sampled joint trajectories**. The crate reader is a
> from-scratch TypeScript implementation (no OpenUSD/WASM dependency). Not yet:
> time samples and variant *selection* stored inside binary crate.

```ts
// .usda / .usdc / binary .usd / .usdz are all auto-detected:
const robot = await new ThreeUsdRobotLoader().loadAsync("/assets/robot.usd");
// or from bytes you already have:
const robot = await new ThreeUsdRobotLoader().parseCrate(usdcBytes);
```

## Install

```sh
npm install three-usd-robot three
```

`three` is a **peer dependency** (`>=0.160.0`).

## Usage

```ts
import { ThreeUsdRobotLoader } from "three-usd-robot";

const robot = await new ThreeUsdRobotLoader().loadAsync("/assets/arm.usda");
scene.add(robot);

// Drive joints (revolute/continuous in radians, prismatic in stage units).
robot.setJointValues({ joint1: 0.4, joint2: -0.2 });

// Forward kinematics falls out of the Three.js scene graph.
const handMatrix = robot.getLinkWorldMatrix("tool0"); // THREE.Matrix4
const handPos = robot.getLinkWorldPosition("tool0"); // THREE.Vector3

robot.getJointNames(); // controllable joints
robot.getKinematicTree(); // root, ordering, loopJoints, ...
```

### Viewer toggles & helpers

```ts
robot.showVisual = true;
robot.showCollision = false;
robot.showJointAxes = true; // built-in axes gizmos on each joint
robot.showLinkFrames = false;

import { addJointLimitHelpers } from "three-usd-robot/helpers";
addJointLimitHelpers(robot); // arc (revolute) / segment (prismatic) per joint
```

### Joint slider panel (lil-gui)

```ts
import GUI from "lil-gui";
import { createJointSliderPanel } from "three-usd-robot/extras";

createJointSliderPanel(robot, new GUI()); // one slider per articulated joint
```

The `extras` panel takes the GUI instance from you, so the library never bundles
`lil-gui`. See [`examples/`](./examples) for runnable Vite demos.

### Animation playback

If the asset has time-sampled joint trajectories (joint-state or drive-target
time samples), the robot plays them back:

```ts
if (robot.hasAnimation()) {
  const { start, end } = robot.getTimeRange()!;
  const fps = robot.getTimeCodesPerSecond();
  // in your render loop, advance a time code and sample:
  robot.setTime(t); // interpolates every animated joint and updates FK
}
```

### React Three Fiber

`three-usd-robot/react` provides a declarative `<UsdRobot>` for R3F (`react` and
`@react-three/fiber` are **optional** peer deps):

```tsx
import { Canvas } from "@react-three/fiber";
import { Suspense } from "react";
import { UsdRobot } from "three-usd-robot/react";

<Canvas camera={{ position: [2, 2, 2] }}>
  <Suspense fallback={null}>
    <UsdRobot
      url="/robot.usda"
      jointValues={{ joint1: 0.4 }} // controlled
      showJointAxes
      animate // play time-sampled trajectories
      onLoad={(robot) => console.log(robot.getJointNames())}
    />
  </Suspense>
  <ambientLight />
</Canvas>;
```

Also exported: `useUsdRobot(url)` (Suspense loader), `useRobotAnimation(robot)`
(per-frame playback), `preloadUsdRobot`, `clearUsdRobotCache`. Pass a `ref` to
`<UsdRobot>` for the imperative `ThreeUsdRobot` API.

### Inspect without Three.js

```ts
import { parseUsda, Stage, extractRobotDescription } from "three-usd-robot/core";

const desc = extractRobotDescription(Stage.OpenFromString(usdaText));
console.log(desc.rootLink, Object.keys(desc.joints));
```

### Export — write USD back out

The loader's inverse: serialize what you loaded (or built) to USDA / USDZ.

```ts
import {
  exportThreeUsdRobot,
  RobotBuilder,
  serializeUsda,
  writeUsdz,
} from "three-usd-robot";

// Re-export a loaded robot (meshes harvested from the scene):
const usda = serializeUsda(exportThreeUsdRobot(robot));

// Flatten anything loadable (usda/usdc/usdz → composed single-layer USDA):
const flat = stage.ExportToString(); // `usdcat --flatten`-like

// Author a robot from Three.js objects — the build-time arrangement is the
// zero pose; each joint takes ONE world-space frame:
const builder = new RobotBuilder({ name: "my_robot" }); // Z-up, meters
builder.addLink({ name: "base", visuals: [baseMesh] });
builder.addLink({ name: "arm", frame: armFrame, visuals: [armMesh] });
builder.addFixedJoint({ name: "root_joint", child: "base" });
builder.addRevoluteJoint({
  name: "j1", parent: "base", child: "arm",
  frame: jointFrame, axis: "Z", lower: -Math.PI, upper: Math.PI,
});
const file = builder.toUsda(); // validated UsdaFile AST

// Package as USDZ (stored zip, 64-byte aligned; bundle texture bytes too):
const usdz = writeUsdz({ "robot.usda": serializeUsda(file), "textures/a.png": pngBytes });
```

Joints export as `UsdPhysics` prims (limits re-authored in degrees), links at
their **zero-pose** placement with the initial pose as `PhysicsJointStateAPI`
(so re-imports apply it exactly once), and `MeshStandardMaterial` constants as
a bound `UsdPreviewSurface` — texture asset paths ride along as a
`UsdUVTexture` network; supply the image bytes to `writeUsdz` yourself.

Command line: `npx tsx scripts/usdc-to-usda.ts robot.usd` converts binary
crate / usdz packages to ASCII USDA.

Simulation-ready extras: per-link **mass properties** (`inertial` →
`PhysicsMassAPI`), **physics materials** (`material:binding:physics`) and
**collision approximations** (`PhysicsMeshCollisionAPI`) on collision meshes,
plus opt-in `enabledSelfCollisions` (PhysX) and `isaacRobotSchema`
(`IsaacRobotAPI` / `IsaacLinkAPI` / `IsaacJointAPI`) export options. Check a
robot before exporting with:

```ts
import { validateRobotDescription } from "three-usd-robot/core";
const issues = validateRobotDescription(desc, { geometry }); // errors + warnings
```

**Verifying an export**: `pip install usd-core`, then
`python scripts/pxr-validate.py robot.usda robot.usdz` runs pxr's full
UsdValidation suite (incl. the usdPhysics checkers); in Isaac Sim, File → Open.
Manual smoke steps live in [`docs/export-design.md`](./docs/export-design.md).

**Full sample**: `npx tsx scripts/demo-factory.ts` authors a complete robot
cell — a 7-DOF arm with a parallel gripper, a roller conveyor with a prismatic
belt, a continuous turntable, and scenery (floor markings, walls, wire-mesh
guarding with a gate, control cabinet, pallet racking, workbench, overhead
lighting, pallets and free crates) plus a `PhysicsScene` — and exports it as
`out/factory.usda` / `.usdz`, ready to open in Isaac Sim.

`scripts/render-preview.ts` renders any exported scene to a PNG with no GPU:
software rasterizer with a shadow map, ambient occlusion, PBR-ish shading from
the USD `metallic`/`roughness` inputs and 2× supersampling.

```sh
npx tsx scripts/render-preview.ts out/factory.usda out/factory.png
# frame a subject and hide foreground guarding:
npx tsx scripts/render-preview.ts out/factory.usda out/arm.png 1400 1000 \
  --target=0.75,-0.35,1.0 --radius=1.7 --dir=-1,-1.3,0.55 --clip=1.7
```

## Package entry points

| Import | Contents |
| --- | --- |
| `three-usd-robot` | Three.js runtime — `ThreeUsdRobotLoader`, `ThreeUsdRobot`, `RobotBuilder`, `exportThreeUsdRobot` |
| `three-usd-robot/core` | Three.js-independent USDA parser **& writer**, robot IR + exporter (`serializeUsda`, `exportRobotUsda`, `writeUsdz`), forward-kinematics math |
| `three-usd-robot/helpers` | Viewer helpers (joint axes, link frames, joint limits) |
| `three-usd-robot/extras` | Heavier convenience utilities (e.g. joint slider panel) |
| `three-usd-robot/react` | React Three Fiber `<UsdRobot>` component + hooks (optional `react` / `@react-three/fiber` peers) |

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # tsup -> dist/
npm run check       # biome lint + format (autofix)
```

## License

MIT
