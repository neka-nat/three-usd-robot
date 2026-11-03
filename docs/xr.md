# WebXR

Showing a robot or a whole cell in a headset at real scale: the rendering
path, how the XR origin relates to the application world (Y-up or Z-up), link
picking from a controller ray, and how to check all of it without a headset.

**Status (M35):** the XR pieces ship as `three-usd-robot/xr` — the origin
rig, controller-ray picking and the grip binding of the TCP target handle —
on top of the input-agnostic ones in `three-usd-robot/helpers`
([Picking & TCP target handle](./runtime.md#picking--tcp-target-handle)),
which the entry re-exports. It depends on `three` alone: no addons, no
React. Session UI, locomotion policy and spatial UI stay with the
application — three's `VRButton` or `@react-three/xr` fit alongside.

```ts
import { XrOriginRig, XrRayPicker, bindXrGrab, TcpTargetHandle } from "three-usd-robot/xr";

renderer.xr.enabled = true;
const rig = new XrOriginRig(renderer, camera, { worldUp: "Z" }); // camera + controller spaces
scene.add(rig);
const picker = new XrRayPicker(rig.controllers[0], () => robots);
picker.addEventListener("hover", ({ hit }) => highlight(hit?.link.primPath));
picker.addEventListener("select", ({ hit }) => select(hit.link.primPath)); // trigger

const handle = new TcpTargetHandle(robot, "tool0");
scene.add(handle);
handle.addEventListener("change", ({ pose }) => solveIk(pose));
bindXrGrab(handle, rig.grips[1], { maxDistance: 0.15 }); // squeeze near it to grab

renderer.xr.addEventListener("sessionstart", () => (pendingRecenter = true));
renderer.setAnimationLoop(() => {
  if (renderer.xr.isPresenting && pendingRecenter && ++frames > 1) {
    rig.recenter(standAt, lookAt); // once the XR camera pose is valid
    pendingRecenter = false;
  }
  picker.update();
  renderer.render(scene, camera);
});
```

| Export | Role |
| --- | --- |
| `xrOriginQuaternion(worldUp)` | The origin rotation for a `"Y"` (identity) or `"Z"` (+90° about X) world |
| `xrOriginPlacement({ worldUp, standAt, lookAt, head, playerScale })` | The origin `position` / `quaternion` that stands the player at a point facing a target — the rig's `recenter` math, for an origin owned by a framework (`<XROrigin>`) |
| `XrOriginRig` | Group holding the camera and the controller / grip / hand spaces; `recenter`, `teleport`, `playerScale`, `yaw`, `toWorld`, handedness lookup (`controller("left")`, `grip("right")`, `handednessOf`) |
| `XrRayPicker` | `pickLink` along a controller's −Z every `update()`; `hover` / `select` events, `maxDistance`, scenery / `occluders` blocking |
| `bindXrGrab(handle, grip, options)` | Grip button → `handle.grab(grip)` / `release()`; `maxDistance` and `when` gates; returns the unbind |
| `onXrInput(space, type, listener)` | Typed subscription to three's `select*` / `squeeze*` / `connected` events on any controller space |

## Rendering path

WebXR renders straight into the session's layer, so the plain WebGL path is
the one to use: `renderer.xr.enabled = true`, the usual
[`applyRenderDefaults`](./lighting.md#render-defaults) (tone mapping applies
to the XR layer like to the screen), lights and shadows as bound by the
loader, no post stack. Two details that bite:

- Create the canvas with `antialias: true` — the XR layer inherits the canvas
  attributes, and aliasing is far more visible in a headset than on a monitor.
- Use `VRButton`, not `XRButton`: a Quest 3 also offers `immersive-ar`, which
  `XRButton` picks first; a robot cell wants the opaque VR session.

Custom HDR render targets + `OutputPass` chains (and the TSL post stack of the
WebGPU example) bypass the XR layer and are not used while presenting.

## Coordinate contract

```txt
XR reference space ("local-floor": Y-up, metres, origin on the floor)
  └─ XrOriginRig (Group)                ← quaternion = xrOriginQuaternion(worldUp), position = stand point,
       ├─ camera                          scale = playerScale; three composes it into the XR camera and
       └─ controller / grip / hand spaces  controller poses, so their matrixWorld is in application world
application world (Y-up or Z-up, metres)
  └─ ThreeUsdRobot                      ← the loader's worldUp / metersPerUnit normalization
       └─ links (stage units)
```

The content is never rotated for XR. A Z-up application world (`worldUp:
"Z"`, the robotics convention) rotates the *origin* by +90° about X
(`xrOriginQuaternion("Z")`): the headset's up becomes world +Z, and controller
poses, ray hits and teleport targets are already in application coordinates
— no conversion layer between the scene graph and XR. `XrOriginRig.recenter`
/ `teleport` place the player's feet (the head's floor projection, not the rig
origin) at a world point; `playerScale > 1` makes the player a giant for a
tabletop view while every measurement stays in model units.

Scaling the origin has one rendering caveat: three's `Sprite` shader takes the
sprite's size from its *world* scale but positions it through the scaled view
matrix, so sprites attached to the rig render `playerScale` times too large.
Rig-attached labels are plain quads (`TextLabel`) for that reason; mesh
geometry, shadows and the floor grid are unaffected.

## Picking

`resolveLink(robot, object)` walks from any hit object up to its `LinkObject`
(every mesh the loader binds carries `userData.primPath` / `userData.kind`);
`pickLink(robots, raycaster)` returns the nearest visible visual mesh's link
along a ray, blocked by static scenery and by any `occluders` you pass — both
from `three-usd-robot/helpers`. `XrRayPicker` runs that along a controller's
target ray every frame and raises `hover` / `select` (the WebXR `select`
event — trigger). The same helpers serve a mouse raycast, which is the point:
the inspector example drives a `TcpTargetHandle` with a `TransformControls`,
the XR viewer drives the same handle with a controller grip (`bindXrGrab`).

## The example

`examples/vite-xr-viewer` — vanilla three, `VRButton`,
`XRControllerModelFactory` models, a floor grid at the XR floor, the loader's
lights (or the fallback rig), HDRI domes as the background.

| Input | Action |
| --- | --- |
| desktop drag | orbit (outside a session) |
| point a controller at a link | its name on the controller; the link tints yellow |
| trigger | select / deselect the link (red) |
| left grip | toggle the tabletop view (`playerScale`, `?scale=`, default 5) |
| right grip near the TCP handle | grab the handle (`bindXrGrab`); it follows the hand and snaps back to the link on release — there is no IK in the viewer |
| right grip near a link | turn the joint above that link like a lever (green; red at a limit) |
| right grip elsewhere | teleport to where the ray meets the floor |
| A / B (right) | record a waypoint (a ghost stays, the tool path grows) / undo the last one |
| X / Y (left) | play or pause the taught loop / clear the waypoints |

**Teaching (stage 1, no IK).** Grabbing a link turns the first articulated
joint above it: a revolute joint by the angle the hand sweeps around the joint
axis, a prismatic one by the travel along it — you move your hand, not your
wrist. Recorded waypoints are baked into the robot description as joint
`valueSamples` (0.5–4 s per segment from the largest joint move, the loop
closed back to the first pose), so `setTime` plays them and
`exportThreeUsdRobot` writes them as USD `timeSamples`: the `.usda` button
(or `E`) downloads a file that plays in Isaac Sim or back in this viewer. On
the desktop the same actions are `R` / `U` / `P` / `C` / `E` and the panel
buttons. An asset's own animation pauses while waypoints exist and returns on
clear. The logic lives in `src/teach.ts`.

`?asset=<url>` / `?isaac=<path>` load any asset like the other examples;
`?up=Z` switches to a Z-up world; `?anim=0` freezes time-sampled animation;
`?emulate=1` installs the headset emulator (below). The HUD and a label on the
left controller show frame time, draw calls and triangles against the 72 Hz
budget (13.9 ms).

WebXR needs a secure context. `localhost` qualifies, so `npm run dev` is
enough on the desktop; a headset on the LAN needs HTTPS — `npm run dev:https`
serves a self-signed certificate on all interfaces (accept the warning once in
the headset's browser). The deployed inspector also hosts the viewer at
[`/xr/`](https://three-usd-robot.vercel.app/xr/).

## React Three Fiber (`@react-three/xr`)

`@react-three/xr` owns the session, the origin and the input in a React app;
the library pieces slot in underneath (`examples/vite-xr-r3f` is the full
wiring, on three r169 and a Z-up world):

```tsx
const store = createXRStore({ emulate: false, controller: { grabPointer: false } }); // grip reserved for the handle

<Canvas camera={{ up: [0, 0, 1] }}>
  <XR store={store}>
    <XROrigin ref={origin} quaternion={xrOriginQuaternion("Z")} />  {/* Z-up: rotate the origin, not the content */}
    <UsdRobot url={url} loaderOptions={{ worldUp: "Z" }} onLoad={setRobot}
      onPointerMove={(e) => setHovered(resolveLink(robot, e.object)?.link.primPath ?? null)}
      onPointerDown={(e) => select(resolveLink(robot, e.object))} />   {/* mouse and controller ray alike */}
    <primitive object={handle} />                                      {/* a TcpTargetHandle */}
  </XR>
</Canvas>;

// Stand in front of the robot once the XR camera pose is valid (2nd frame of the session):
const { position, quaternion } = xrOriginPlacement({ worldUp: "Z", standAt, lookAt,
  head: { position: camera.position, quaternion: camera.quaternion } }); // camera = the XR camera under <XR>
origin.current.position.copy(position);
origin.current.quaternion.copy(quaternion);

// Grab with the right grip. An <XRSpace> under <XROrigin> tracks the grip space:
const right = useXRInputSourceState("controller", "right");
<XROrigin>{right && <XRSpace space={right.inputSource.gripSpace!} ref={gripRef} />}</XROrigin>;
useXRInputSourceEvent(right?.inputSource, "squeezestart", () => gripRef.current && handle.grab(gripRef.current), [right]);
useXRInputSourceEvent(right?.inputSource, "squeezeend", () => handle.release(), [right]);
```

`XrOriginRig` / `XrRayPicker` / `bindXrGrab` are for apps that drive three's
WebXR manager themselves; under `@react-three/xr` the equivalents are the
`<XROrigin>` + `xrOriginPlacement`, R3F's pointer events + `resolveLink`,
and `useXRInputSourceEvent` + `handle.grab`. Create the store with
`emulate: false` when you install the IWER emulator yourself — the store
would otherwise inject a second runtime (and its dev UI) on localhost — and
switch the default controllers' grab pointer off when the grip drives the
handle, or a squeeze near the robot also arrives as pointer events on its
meshes. Select on `onPointerDown`: pointer-events only reports a `click`
when press and release fall within 300 ms.

## Checking without a headset

[IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) (Meta's
Immersive Web Emulation Runtime) emulates a Quest 3 behind `navigator.xr`,
stereo views included, and takes scripted controller input. `?emulate=1`
installs it before the VR button is created (the button checks `navigator.xr`
once; headless Chromium ships a device-less `navigator.xr`, so the runtime is
installed with `forceInstall`).

`scripts/xr-capture.py` drives the example through Playwright: waits for the
asset, clicks the VR button, waits for rendered XR frames, then optionally
aims an emulated controller at the links and pulls the trigger (`--select`),
squeezes the left grip (`--tabletop`), grabs the TCP handle with the right
grip (`--grab`), or runs the teaching loop — turns a joint, records two
waypoints, plays, exports and re-parses the USDA (`--teach`) — and prints the
viewer's `report()` (head height, the robot's floor contact, hover /
selection, the handle's and the teaching session's state, draw calls,
triangles) and saves a stereo screenshot:

```sh
cd examples/vite-xr-viewer && npm run dev -- --port 5175   # in one terminal
python3 scripts/xr-capture.py "http://127.0.0.1:5175/?emulate=1&asset=/factory.usda" out.png \
    --aim right --select --profile /tmp/pw-profile
python3 scripts/xr-capture.py "http://127.0.0.1:5175/?emulate=1&up=Z" zup.png --aim right
python3 scripts/xr-capture.py "http://127.0.0.1:5175/?emulate=1" tabletop.png --tabletop
python3 scripts/xr-capture.py "http://127.0.0.1:5175/?emulate=1&asset=/arm_anim.usda" grab.png --grab
python3 scripts/xr-capture.py "http://127.0.0.1:5175/?emulate=1&asset=/arm_anim.usda&anim=0" teach.png --teach
```

Frame times from a software-GL browser say nothing about a headset; draw
calls and triangle counts do. Measured through the emulator (2026-11):

| Asset | Draw calls | Triangles |
| --- | ---: | ---: |
| Franka Panda (Isaac CDN) | 156 | 260k |
| Factory cell (`factory.usda`) | 1,535 | 44k |
| Animated arm (`arm_anim.usda`) | 46 | 18k |

A Quest-class headset at 72 Hz is comfortable with a few hundred draw calls
per eye; the cell's count (one mesh per gprim) is the thing to bring down —
per-link / per-material merging is the candidate. The viewer itself has been
confirmed on a Quest 3 (real scale, floor, controllers) over a LAN HTTPS dev
server; see [the example's README](../examples/README.md) for the headset
setup.
