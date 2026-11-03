# WebXR

Showing a robot or a whole cell in a headset at real scale: the rendering
path, how the XR origin relates to the application world (Y-up or Z-up), link
picking from a controller ray, and how to check all of it without a headset.

**Status (M34):** the input-agnostic pieces — `resolveLink` / `pickLink` and
the `TcpTargetHandle` — ship in `three-usd-robot/helpers` (see
[Picking & TCP target handle](./runtime.md#picking--tcp-target-handle)). The
XR-specific pieces still live in
[`examples/vite-xr-viewer/src/xr/`](../examples/vite-xr-viewer/src/xr) in the
shape planned for a future `three-usd-robot/xr` entry — `xrOriginQuaternion`
/ `XrOriginRig` / `XrRayPicker` — and move in once validated on a headset.

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
the XR viewer will drive it with a controller grip (M35).

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
| right grip | teleport to where the ray meets the floor |

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

## Checking without a headset

[IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) (Meta's
Immersive Web Emulation Runtime) emulates a Quest 3 behind `navigator.xr`,
stereo views included, and takes scripted controller input. `?emulate=1`
installs it before the VR button is created (the button checks `navigator.xr`
once; headless Chromium ships a device-less `navigator.xr`, so the runtime is
installed with `forceInstall`).

`scripts/xr-capture.py` drives the example through Playwright: waits for the
asset, clicks the VR button, waits for rendered XR frames, optionally aims an
emulated controller at the links and pulls the trigger or squeezes the left
grip, then prints the viewer's `report()` (head height, the robot's floor
contact, hover / selection, draw calls, triangles) and saves a stereo
screenshot:

```sh
cd examples/vite-xr-viewer && npm run dev -- --port 5175   # in one terminal
python3 scripts/xr-capture.py "http://127.0.0.1:5175/?emulate=1&asset=/factory.usda" out.png \
    --aim right --select --profile /tmp/pw-profile
python3 scripts/xr-capture.py "http://127.0.0.1:5175/?emulate=1&up=Z" zup.png --aim right
python3 scripts/xr-capture.py "http://127.0.0.1:5175/?emulate=1" tabletop.png --tabletop
```

Frame times from a software-GL browser say nothing about a headset; draw
calls and triangle counts do. Measured through the emulator (2026-11):

| Asset | Draw calls | Triangles |
| --- | ---: | ---: |
| Franka Panda (Isaac CDN) | 156 | 260k |
| Factory cell (`factory.usda`) | 1,535 | 44k |
| Animated arm (`arm_anim.usda`) | 46 | 18k |

A Quest-class headset at 72 Hz is comfortable with a few hundred draw calls
per eye; the cell's count (one mesh per gprim) is the thing to bring down
before a real-device verdict — per-link / per-material merging is the
candidate.
