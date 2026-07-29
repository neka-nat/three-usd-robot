# three-usd-robot

> **Kinematic OpenUSD robot loader — and exporter — for Three.js.**
> Load Isaac Sim / OpenUSD robot assets, control their joints in the browser,
> and write scenes back out as USD. No physics engine, no OpenUSD/WASM
> dependency.

Think of it as a **USD version of [`urdf-loader`](https://www.npmjs.com/package/urdf-loader)**:
it reads the link / joint / xform / mesh structure out of `UsdPhysics` assets
and drives forward kinematics on a Three.js `Object3D` hierarchy.

**[▶ Live demo](https://three-usd-robot.vercel.app)** — stock Isaac Sim robots
streamed from NVIDIA's asset CDN, joints driven from a slider panel, and
exported back to `.usda` / `.usdz` in the browser.

![A franka panda loaded in the browser](assets/franka.png)
![A robot cell loaded in the browser](assets/threejs.png)

## Features

- **Formats** — ASCII `.usda`, binary `.usdc` / `.usd`, and `.usdz`, auto-detected.
  Multi-file assets (references / payloads / sublayers), variant selections and
  instanceable prims are composed for you.
- **Robots** — links, joints (fixed / revolute / continuous / prismatic), limits,
  drives and the initial pose become a `setJointValue`-able hierarchy.
- **Rendering** — meshes and solid gprims (`Cube` / `Sphere` / `Cylinder` /
  `Capsule` / `Cone`) with `UsdShade` materials (UsdPreviewSurface / OmniPBR)
  and textures; up-axis and units normalized automatically. Articulation-free
  stages load as static scenes.
- **Animation** — plays back time-sampled joint trajectories.
- **Export** — write robots and whole cells back to `.usda` / `.usdz`,
  simulation-ready for Isaac Sim.
- **React** — declarative `<UsdRobot>` for React Three Fiber.

Stock Isaac Sim robot assets load straight from their public CDN — Franka
Panda, UR10e, Fanuc CRX-10iA/L, Kuka KR210, Shadow Hand, Unitree H1/Go2 and
friends all compose from their variant-driven, multi-layer form:

```ts
const ROOT = "https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1";
const franka = await new ThreeUsdRobotLoader()
  .loadAsync(`${ROOT}/Isaac/Robots/FrankaRobotics/FrankaPanda/franka.usd`);

franka.setJointValues({ panda_joint2: -0.785, panda_joint4: -2.356, panda_joint6: 1.571 });
franka.getLinkWorldPosition("panda_hand"); // (0.307, 0, 0.590) — the documented ready pose
```

The CDN is public and CORS-enabled, so this works in the browser too. Try
`npx tsx scripts/demo-franka.ts` for a console walkthrough (articulation table,
FK check, and a re-export to one self-contained file), or open the Vite example
and pick a robot from the preset list.

Not yet supported: time samples stored inside binary crate files, point/curve
gprims (`Points`, `BasisCurves`, …), and full material/shader fidelity.

## Install

```sh
npm install three-usd-robot three
```

`three` is a **peer dependency** (`>=0.160.0`).

## Quick start

```ts
import { ThreeUsdRobotLoader } from "three-usd-robot";

// .usda / .usdc / binary .usd / .usdz are all auto-detected.
const robot = await new ThreeUsdRobotLoader().loadAsync("/assets/arm.usda");
scene.add(robot);

// Drive joints (revolute/continuous in radians, prismatic in stage units).
robot.setJointValues({ joint1: 0.4, joint2: -0.2 });

// Forward kinematics falls out of the Three.js scene graph.
const handMatrix = robot.getLinkWorldMatrix("tool0"); // THREE.Matrix4
const handPos = robot.getLinkWorldPosition("tool0"); // THREE.Vector3

robot.getJointNames(); // controllable joints
robot.getKinematicTree(); // root, ordering, loop joints, ...
```

No URL? `parse` also takes in-memory content: USDA source text, or an
`ArrayBuffer` / typed array / `Blob` holding any supported format — the zip /
crate magic is sniffed, so a dropped `File` or a response body works as-is:

```ts
const loader = new ThreeUsdRobotLoader();
await loader.parse(usdaText); // USDA source string
await loader.parse(file); // File / Blob from drag & drop or <input type="file">
await loader.parse(await res.arrayBuffer()); // a fetch you did yourself
```

`parseUsdz(data)` / `parseCrate(data, baseUrl)` stay as explicit-format entries,
and `parseRobotDescription(data)` returns the Three.js-independent IR. Pass a
`baseUrl` as the second `parse` argument if the layer has relative references
or texture paths to resolve.

### World up-axis & units

Stages load normalized: `metersPerUnit` scales the root, and the authored
`upAxis` (`"Y"` or `"Z"`) is rotated into your world convention via `worldUp`:

```ts
new ThreeUsdRobotLoader(); // default: "Y" — upright in a stock three.js scene
new ThreeUsdRobotLoader({ worldUp: "Z" }); // robotics-style Z-up world
new ThreeUsdRobotLoader({ worldUp: "keep" }); // leave the authored orientation

robot.upAxis; // authored stage value ("Y" | "Z"), independent of normalization
robot.metersPerUnit; // authored stage scale (already applied to the root)
```

Isaac Sim assets are Z-up, so the default makes them stand upright in a plain
three.js scene; a Z-up app (ROS-style) passes `worldUp: "Z"` once instead of
counter-rotating per asset. The M9 option `upAxisConversion` remains as a
deprecated alias (`"auto"` ≡ `worldUp: "Y"`, `"none"` ≡ `"keep"`).

### Stable addressing (naming contract)

Joints and links are keyed by their prim's **leaf name** while it is unique
across the robot; on a collision (say, two arms each with a `seg` link) the
colliding entries are keyed by their **full prim path** instead —
deterministically. Every accessor also takes the full prim path directly, so
tooling can pin exact prims no matter how the asset is named:

```ts
robot.setJointValue("/World/armL/j1", 0.4); // same joint as its key
robot.getLinkWorldMatrix("/World/armL/seg");
robot.getLinkObjectsByPath(); // Map<primPath, LinkObject>
robot.getJointObjectsByPath(); // Map<primPath, JointObject>
```

`LinkObject.primPath` / `JointObject.primPath` carry the reverse direction.

### Viewer toggles & helpers

```ts
robot.showVisual = true;
robot.showCollision = false;
robot.showJointAxes = true; // built-in axes gizmos on each joint
robot.showLinkFrames = false;

import { addJointLimitHelpers } from "three-usd-robot/helpers";
addJointLimitHelpers(robot); // arc (revolute) / segment (prismatic) per joint
```

### Link highlighting & ghosts

Per-link appearance helpers cover the common viewer chores — flagging
colliding links, material swaps, and translucent "ghost" pose previews:

```ts
import {
  createGhostRobot,
  highlightLink,
  restoreLinkMaterials,
  setLinkMaterial,
} from "three-usd-robot/helpers";

highlightLink(robot, "link1"); // emissive red tint; maps/colors kept
highlightLink(robot, "/World/armL/seg", { color: 0xffaa00, opacity: 0.6 });
setLinkMaterial(robot, "link2", new THREE.MeshBasicMaterial({ wireframe: true }));
restoreLinkMaterials(robot, "link1"); // exact original materials back

const ghost = createGhostRobot(robot, { jointValues: { joint1: 1.2 } });
scene.add(ghost); // translucent copy previewing the target pose
ghost.setJointValues(ikSolution); // a full ThreeUsdRobot, driveable like the source
```

Highlights never stack (each call re-tints from the originals), and ghosts
share the source's geometry — cloning is cheap enough for onion-skinning.

Loading a whole cell rather than a bare robot? Pass
`{ loadSceneGeometry: true }` to the loader to draw the static environment
(floor, guarding, racking, …) around the machines. A stage with **no
articulation at all** — a plain static USD scene — is detected and rendered as
scene geometry automatically, with the same unit / up-axis normalization; pass
`loadSceneGeometry: false` to opt out.

### Joint slider panel (lil-gui)

```ts
import GUI from "lil-gui";
import { createJointSliderPanel } from "three-usd-robot/extras";

createJointSliderPanel(robot, new GUI()); // one slider per articulated joint
```

The panel takes the GUI instance from you, so the library never bundles
`lil-gui`.

### Animation playback

If the asset has time-sampled joint trajectories, the robot plays them back:

```ts
const range = robot.getTimeRange();
if (range) {
  // in your render loop, advance a time code between range.start and range.end:
  robot.setTime(t); // interpolates every animated joint and updates FK
}
```

### React Three Fiber

`three-usd-robot/react` provides a declarative `<UsdRobot>` (`react` and
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

Also exported: `useUsdRobot(url)` (Suspense loader), `useRobotAnimation(robot)`,
`preloadUsdRobot`, `clearUsdRobotCache`. Pass a `ref` to `<UsdRobot>` for the
imperative API.

## Export USD

The loader's inverse: re-export something you loaded, or author a robot from
Three.js objects and open the result in Isaac Sim.

![The exported cell opened in Isaac Sim](assets/isaacsim.png)

```ts
import {
  exportThreeUsdRobot,
  RobotBuilder,
  serializeUsda,
  writeUsdz,
} from "three-usd-robot";

// Re-export a loaded robot (meshes harvested from the Three.js scene):
const usda = serializeUsda(exportThreeUsdRobot(robot));

// …or build one from Three.js meshes. Z-up and metres by default; each joint
// takes ONE world-space frame, and the build-time arrangement is the zero pose.
const builder = new RobotBuilder({ name: "my_robot" });
builder.addLink({ name: "base", visuals: [baseMesh] });
builder.addLink({ name: "arm", frame: armFrame, visuals: [armMesh] });
builder.addFixedJoint({ name: "root_joint", child: "base" });
builder.addRevoluteJoint({
  name: "j1", parent: "base", child: "arm",
  frame: jointFrame, axis: "Z", lower: -Math.PI, upper: Math.PI,
});

const file = builder.toUsda();
writeFileSync("robot.usda", serializeUsda(file));
writeFileSync("robot.usdz", writeUsdz({ "robot.usda": serializeUsda(file) }));
```

Joints export as `UsdPhysics` prims with their limits, drives and initial pose.
For a simulation-ready asset, links also take mass properties, and collision
meshes take physics materials and a collision approximation:

```ts
builder.addLink({
  name: "arm",
  visuals: [armMesh],
  collisions: [armCollisionMesh],
  inertial: { mass: 2.5, centerOfMass: [0, 0, 0.2], diagonalInertia: [0.02, 0.02, 0.004] },
  collisionApproximation: "convexHull",
  physicsMaterial: { name: "steel", staticFriction: 0.6, dynamicFriction: 0.5 },
});
```

Both screenshots above come from `npx tsx scripts/demo-factory.ts`, which
authors a complete robot cell — a 7-DOF arm with a gripper, a conveyor, a
turntable and the surrounding scenery — and exports it to
`out/factory.usda` / `.usdz`.

## Use it without Three.js

`three-usd-robot/core` is a standalone USD parser, writer and robot IR — handy
for server-side validation or asset tooling:

```ts
import { parseUsda, Stage, extractRobotDescription } from "three-usd-robot/core";

const desc = extractRobotDescription(Stage.OpenFromString(usdaText));
console.log(desc.rootLink, Object.keys(desc.joints));
```

Command line: `npx tsx scripts/usdc-to-usda.ts robot.usd` converts binary crate
and `.usdz` packages to ASCII USDA.

## Examples

[`examples/`](./examples) holds runnable Vite demos:

- **`vite-usd-inspector`** — the [live demo](https://three-usd-robot.vercel.app):
  vanilla Three.js + `lil-gui`, with a robot picker, a USD structure panel
  (prim tree + attribute inspector), a transform gizmo, joint sliders,
  animation playback and USD export.
- **`vite-basic-viewer`** — the same thing through React Three Fiber.

Both take `?asset=<url>` for any asset, or `?isaac=<path under Isaac/>` to pull
one straight from NVIDIA's CDN. `npm run demo:build` generates the factory cell
and builds the deployable site.

## Package entry points

| Import | Contents |
| --- | --- |
| `three-usd-robot` | Three.js runtime — `ThreeUsdRobotLoader`, `ThreeUsdRobot`, `RobotBuilder`, export helpers |
| `three-usd-robot/core` | Three.js-independent USD parser & writer, robot IR, forward-kinematics math |
| `three-usd-robot/helpers` | Viewer helpers (joint axes, link frames, joint limits) |
| `three-usd-robot/extras` | Joint slider panel (bring your own `lil-gui`) |
| `three-usd-robot/react` | React Three Fiber `<UsdRobot>` component + hooks |

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
