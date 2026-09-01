# Runtime guide

Everything around loading and driving a robot at runtime: input sources,
addressing, mimic joints, viewer helpers, static scenes, React, and using the
core without Three.js. For materials see [materials.md](./materials.md), for
animation and recorded playback see
[recorded-playback.md](./recorded-playback.md), for writing USD back out see
[export.md](./export.md).

## Input sources

`loadAsync(url)` fetches and composes multi-file assets. `parse` also takes
in-memory content: USDA source text, or an `ArrayBuffer` / typed array / `Blob`
holding any supported format — the zip / crate magic is sniffed, so a dropped
`File` or a response body works as-is:

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

## World up-axis & units

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
counter-rotating per asset. The older option `upAxisConversion` remains as a
deprecated alias (`"auto"` ≡ `worldUp: "Y"`, `"none"` ≡ `"keep"`).

## Stable addressing (naming contract)

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

## Mimic joints (coupled DOFs)

Joints carrying a mimic constraint follow their leader automatically —
`follower = multiplier · leader + offset` — so a gripper closes from one
value. Both authoring forms are read: **`NewtonMimicAPI`** (what Isaac Sim 6 /
Newton and the official URDF importer write) and the legacy PhysX
`PhysxMimicJointAPI` (its `q + gearing·q_ref + offset = 0` convention is
sign-normalized). Followers are driven by their leader only: they drop out of
`getJointNames()`, and direct sets on them are ignored with a one-time warning.

```ts
robot.setJointValue("finger_joint", 0.02); // the mimicking finger mirrors it
robot.getMimicJointNames(); // ["right_finger_joint"]
robot.getJointObject("right_finger_joint")?.mimic; // { joint, multiplier, offset } (SI)
```

The PhysX form is keyed by dof on both ends — the `PhysxMimicJointAPI:<dof>`
instance names the dof of the *follower* being constrained, and
`referenceJointAxis` the leader's dof it reads. A revolute or prismatic joint
moves about exactly one dof, so a constraint naming any other one asks for a
degree of freedom the joint does not have: it is reported and the joints stay
independent, as the physics engines read it. (Isaac's Franka authors
`physxMimicJoint:rotX` on its prismatic finger, which is why that asset loads
with both fingers separately drivable.)

Chained mimics propagate; cycles and kind mismatches (angular vs linear) are
diagnosed by `validateRobotDescription` (`mimic-*` codes) and dropped with a
warning at extraction. `RobotBuilder.addRevolute/PrismaticJoint` take a
`mimic: { joint, multiplier?, offset? }` option, and export writes the
constraint back as `NewtonMimicAPI`.

## Viewer toggles & helpers

```ts
robot.showVisual = true;
robot.showCollision = false;
robot.showJointAxes = true; // built-in axes gizmos on each joint
robot.showLinkFrames = false;

import { addJointLimitHelpers } from "three-usd-robot/helpers";
addJointLimitHelpers(robot); // arc (revolute) / segment (prismatic) per joint
```

## Link highlighting & ghosts

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

## Static scene geometry

Loading a whole cell rather than a bare robot? Pass
`{ loadSceneGeometry: true }` to the loader to draw the static environment
(floor, guarding, racking, …) around the machines. A stage with **no
articulation at all** — a plain static USD scene — is detected and rendered as
scene geometry automatically, with the same unit / up-axis normalization; pass
`loadSceneGeometry: false` to opt out.

## Lights (UsdLux)

`UsdLux` lights bind by default — independently of `loadSceneGeometry`, since
they light the robot — and land on `robot.lights` (DomeLights on
`robot.domeLights`), attached so link-mounted lights move with the joints.
Shadows come preconfigured; Omniverse-authored stages usually want
`lightIntensityScale: 0.001`. A DomeLight becomes HDRI environment lighting
with one call — `applyUsdEnvironment(robot, scene)` from
`three-usd-robot/rendering`. Details, mappings and calibration guidance in
[Lighting](./lighting.md).

## Cameras (UsdGeomCamera)

`Camera` prims bind by default onto `robot.cameras` (`loadCameras: false` to
opt out), placed in the hierarchy so a wrist or sensor camera follows the
joints. USD and Three.js share the −Z-forward / +Y-up camera frame; film-back
metrics (`focalLength` / apertures, in mm) become the FOV and aspect,
clipping range and focus distance are normalized to world units like
everything else, and `projection = "orthographic"` maps to an
`OrthographicCamera` (apertures are tenths of a stage unit there). Fit a
bound camera to your canvas with
`conformCameraAspect(camera, width / height, policy?)` — the UsdRender
conform policies, `"expandAperture"` by default — and for authored-exposure
workflows feed `computeCameraExposureScale(camera.userData.usdCamera)` (the
USD 24.11 linear exposure formula; unauthored cameras yield `2^exposure`)
into `renderer.toneMappingExposure`. Depth of field is not simulated —
`fStop` / `focusDistance` are surfaced on `userData.usdCamera` (and
`camera.focus`) for your own bokeh pass.

## Joint slider panel (lil-gui)

```ts
import GUI from "lil-gui";
import { createJointSliderPanel } from "three-usd-robot/extras";

createJointSliderPanel(robot, new GUI()); // one slider per articulated joint
```

The panel takes the GUI instance from you, so the library never bundles
`lil-gui`.

## React Three Fiber

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
